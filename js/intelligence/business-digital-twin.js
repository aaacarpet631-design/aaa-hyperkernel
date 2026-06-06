/*
 * AAA Business Digital Twin — a model of the business for executive planning.
 *
 * Not 3D graphics — a BUSINESS twin. It builds a baseline model from historical
 * outcomes (win rate, average job value, margin, monthly throughput, leads), then
 * deterministically projects the effect of a strategic lever over a horizon:
 *   hiring / add_truck   → +capacity → +jobs (bounded by demand) − crew cost
 *   ads_spend            → +leads (ROI) → +wins → +revenue − spend
 *   price_change         → price × win-rate elasticity trade-off
 *   new_territory        → a ramping new market − fixed cost
 *
 * Every projection states its ASSUMPTIONS (rule 6: explainable) and is a model,
 * not a promise. It is read-only — it changes no price, budget, or record, and it
 * never acts; it's a planning surface for the owner. Assumptions are tunable via
 * config flags. Owner-only; deterministic; null-tolerant.
 */
;(function (global) {
  'use strict';

  const SCENARIOS = 'twin_scenarios';
  const LEVERS = ['hiring', 'add_truck', 'ads_spend', 'price_change', 'new_territory'];

  function cfg() { return global.AAA_CONFIG || {}; }
  function data() { return global.AAA_DATA; }
  function ids() { return global.AAA_ID_FACTORY; }
  function clock() { return global.AAA_RUNTIME_CLOCK; }
  function quotes() { return global.AAA_QUOTES; }
  function ws() { return cfg().workspaceId || 'default'; }
  function nowISO() { return clock() && clock().nowISO ? clock().nowISO() : new Date().toISOString(); }
  function mine(r) { return r && (r.workspaceId == null || r.workspaceId === ws()); }
  function newId(p) { return ids() ? ids().createId(p) : p + '_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7); }
  function num(v) { const n = Number(v); return isFinite(n) ? n : null; }
  function flag(k, d) { const v = cfg().flag ? cfg().flag(k, d) : d; const n = Number(v); return isFinite(n) ? n : d; }
  function round(n) { return Math.round(n); }
  function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }

  // Tunable model assumptions (all overridable by config flags).
  function A() {
    return {
      crewJobsPerMonth: flag('twinCrewJobsPerMonth', 12),     // throughput a new crew/truck adds
      crewMonthlyCost: flag('twinCrewMonthlyCost', 6000),     // loaded cost of a crew/truck per month
      leadsPerDollar: flag('twinLeadsPerDollar', 0.02),       // ~ $50 / qualified lead
      adsQualFactor: flag('twinAdsQualFactor', 0.8),          // ad leads convert a bit below organic
      priceElasticity: flag('twinPriceElasticity', 0.8),      // win-rate sensitivity to price change
      territoryFixedCost: flag('twinTerritoryMonthlyCost', 3500),
      territoryRampMonths: flag('twinTerritoryRamp', 6)
    };
  }

  const Twin = {
    SCENARIOS: SCENARIOS, LEVERS: LEVERS,

    /** Build the current-state model from history (overridable for what-ifs). */
    async baseline(override) {
      const o = override || {};
      const qs = (await listQuotes()).filter((q) => q.status === 'won' || q.status === 'lost');
      const wins = qs.filter((q) => q.status === 'won');
      const winValues = wins.map((q) => num(q.customerTotal)).filter((v) => v != null);
      const margins = wins.map((q) => num(q.marginPct)).filter((v) => v != null);
      const months = monthsSpan(qs);
      const winRate = qs.length ? wins.length / qs.length : null;
      const avgJobValue = winValues.length ? Math.round(winValues.reduce((a, b) => a + b, 0) / winValues.length) : (o.avgJobValue || 1500);
      const avgMargin = margins.length ? Math.round(margins.reduce((a, b) => a + b, 0) / margins.length) : (o.avgMargin || 30);
      const monthlyWins = wins.length ? Math.max(1, Math.round((wins.length / months) * 10) / 10) : (o.monthlyWins || 0);
      const monthlyLeads = qs.length ? Math.max(monthlyWins, Math.round(qs.length / months)) : (o.monthlyLeads || 0);
      const base = {
        sample: qs.length, months: months,
        winRate: o.winRate != null ? o.winRate : (winRate != null ? Math.round(winRate * 100) / 100 : 0.5),
        avgJobValue: o.avgJobValue != null ? o.avgJobValue : avgJobValue,
        avgMargin: o.avgMargin != null ? o.avgMargin : avgMargin,
        monthlyWins: o.monthlyWins != null ? o.monthlyWins : monthlyWins,
        monthlyLeads: o.monthlyLeads != null ? o.monthlyLeads : monthlyLeads,
        capacityUtil: o.capacityUtil != null ? o.capacityUtil : flag('twinCapacityUtil', 80)
      };
      base.monthlyRevenue = round(base.monthlyWins * base.avgJobValue);
      base.monthlyProfit = round(base.monthlyRevenue * (base.avgMargin / 100));
      return base;
    },

    /** Project a lever over a horizon. Returns before/after + monthly path + net. */
    async simulate(scenario, baseOverride) {
      const s = scenario || {};
      if (LEVERS.indexOf(s.lever) === -1) return { ok: false, error: 'UNKNOWN_LEVER' };
      const base = await this.baseline(baseOverride);
      const horizon = clamp(num(s.horizonMonths) || 12, 1, 60);
      const a = A();
      const assumptions = [];
      const path = [];
      let projected = { monthlyRevenue: base.monthlyRevenue, monthlyProfit: base.monthlyProfit, monthlyWins: base.monthlyWins, addedCostPerMonth: 0 };

      if (s.lever === 'hiring' || s.lever === 'add_truck') {
        const units = Math.max(1, num(s.magnitude) || 1);
        const capacityAdded = units * a.crewJobsPerMonth;
        // demand headroom = leads we win but can't yet serve vs. could serve more if we marketed.
        const demandFactor = clamp((base.capacityUtil / 100) * (base.winRate / 0.5), 0, 1); // tight capacity + healthy win rate → fills it
        const addedJobs = Math.round(capacityAdded * demandFactor);
        const cost = units * a.crewMonthlyCost;
        projected.monthlyWins = base.monthlyWins + addedJobs;
        projected.monthlyRevenue = round(projected.monthlyWins * base.avgJobValue);
        projected.monthlyProfit = round(projected.monthlyRevenue * (base.avgMargin / 100) - cost);
        projected.addedCostPerMonth = cost;
        assumptions.push('A new crew/truck adds ~' + a.crewJobsPerMonth + ' jobs/mo at ~$' + a.crewMonthlyCost + '/mo loaded cost.');
        assumptions.push('Demand fills ' + Math.round(demandFactor * 100) + '% of new capacity (from ' + base.capacityUtil + '% utilization + win rate ' + Math.round(base.winRate * 100) + '%).');
      } else if (s.lever === 'ads_spend') {
        const spend = Math.max(0, num(s.magnitude) || 0);
        const addedLeads = spend * a.leadsPerDollar;
        const addedWins = addedLeads * base.winRate * a.adsQualFactor;
        const revDelta = addedWins * base.avgJobValue;
        projected.monthlyWins = Math.round((base.monthlyWins + addedWins) * 10) / 10;
        projected.monthlyRevenue = round(base.monthlyRevenue + revDelta);
        projected.monthlyProfit = round(projected.monthlyRevenue * (base.avgMargin / 100) - spend);
        projected.addedCostPerMonth = spend;
        assumptions.push('$' + spend + '/mo buys ~' + Math.round(addedLeads) + ' leads (@ ~$' + Math.round(1 / a.leadsPerDollar) + '/lead), converting at ' + Math.round(base.winRate * a.adsQualFactor * 100) + '%.');
      } else if (s.lever === 'price_change') {
        const pct = num(s.magnitude) || 0; // e.g. +0.1 = +10%
        const newPrice = Math.round(base.avgJobValue * (1 + pct));
        const newWinRate = clamp(base.winRate * (1 - a.priceElasticity * pct), 0.01, 0.99);
        // margin moves with the price change (cost roughly fixed): margin points shift ~ pct of price.
        const newMargin = clamp(base.avgMargin + Math.round(pct * (100 - base.avgMargin)), 0, 95);
        const newMonthlyWins = Math.round(base.monthlyLeads * newWinRate * 10) / 10;
        projected.monthlyWins = newMonthlyWins;
        projected.monthlyRevenue = round(newMonthlyWins * newPrice);
        projected.monthlyProfit = round(projected.monthlyRevenue * (newMargin / 100));
        assumptions.push('A ' + (pct >= 0 ? '+' : '') + Math.round(pct * 100) + '% price moves win rate to ' + Math.round(newWinRate * 100) + '% (elasticity ' + a.priceElasticity + ') and margin to ~' + newMargin + '%.');
      } else if (s.lever === 'new_territory') {
        const steadyLeads = Math.max(0, num(s.magnitude) || base.monthlyLeads);
        const steadyWins = steadyLeads * base.winRate;
        assumptions.push('A new territory ramps to ~' + Math.round(steadyLeads) + ' leads/mo over ' + a.territoryRampMonths + ' months at $' + a.territoryFixedCost + '/mo fixed cost.');
        projected.addedCostPerMonth = a.territoryFixedCost;
        projected.monthlyWins = Math.round((base.monthlyWins + steadyWins) * 10) / 10; // steady-state
        projected.monthlyRevenue = round(projected.monthlyWins * base.avgJobValue);
        projected.monthlyProfit = round(projected.monthlyRevenue * (base.avgMargin / 100) - a.territoryFixedCost);
      }

      // Build the monthly path (territory ramps; others step to steady-state).
      let netProfit = 0;
      for (let mth = 1; mth <= horizon; mth++) {
        let ramp = 1;
        if (s.lever === 'new_territory') ramp = clamp(mth / Math.max(1, A().territoryRampMonths), 0, 1);
        const wins = base.monthlyWins + (projected.monthlyWins - base.monthlyWins) * ramp;
        const revenue = base.monthlyRevenue + (projected.monthlyRevenue - base.monthlyRevenue) * ramp;
        const profit = base.monthlyProfit + (projected.monthlyProfit - base.monthlyProfit) * ramp;
        netProfit += (profit - base.monthlyProfit);
        path.push({ month: mth, wins: Math.round(wins * 10) / 10, revenue: round(revenue), profit: round(profit) });
      }

      const confidence = clamp(35 + Math.min(40, base.sample * 3) + (base.sample >= 10 ? 10 : 0), 0, 90);
      return {
        ok: true, lever: s.lever, magnitude: s.magnitude, horizonMonths: horizon,
        baseline: { monthlyRevenue: base.monthlyRevenue, monthlyProfit: base.monthlyProfit, monthlyWins: base.monthlyWins, winRate: base.winRate, avgJobValue: base.avgJobValue, avgMargin: base.avgMargin },
        projected: projected,
        delta: { monthlyRevenue: projected.monthlyRevenue - base.monthlyRevenue, monthlyProfit: projected.monthlyProfit - base.monthlyProfit, monthlyWins: Math.round((projected.monthlyWins - base.monthlyWins) * 10) / 10 },
        netProfitImpact: round(netProfit), path: path, assumptions: assumptions, confidence: confidence,
        note: 'Model projection from ' + base.sample + ' historical jobs — a planning estimate, not a guarantee.'
      };
    },

    /** Run several scenarios and rank by net profit impact. */
    async compare(scenarios, baseOverride) {
      const out = [];
      for (const s of (scenarios || [])) { const r = await this.simulate(s, baseOverride); if (r.ok) out.push(r); }
      out.sort((a, b) => b.netProfitImpact - a.netProfitImpact);
      return { ok: true, ranked: out };
    },

    async save(scenario, result, opts) {
      const o = opts || {};
      const rec = { id: newId('twin'), workspaceId: ws(), name: o.name || (scenario && scenario.lever) || 'scenario', scenario: scenario || null, result: result || null, savedBy: o.actor || null, createdAt: nowISO() };
      await put(rec); return { ok: true, scenario: rec };
    },
    async list() { return (await data().list(SCENARIOS)).filter(mine).sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || ''))); }
  };

  function monthsSpan(qs) {
    const ts = qs.map((q) => Date.parse(q.resolvedAt || q.sentAt || '')).filter((t) => isFinite(t));
    if (ts.length < 2) return 1;
    const span = (Math.max.apply(null, ts) - Math.min.apply(null, ts)) / (30 * 86400000);
    return Math.max(1, Math.round(span * 10) / 10);
  }
  async function listQuotes() { try { if (quotes() && quotes().list) return (await quotes().list()).filter(mine); return (await data().list('quotes')).filter(mine); } catch (_) { return []; } }
  async function put(rec) { await data().put(SCENARIOS, rec.id, rec); try { if (data().cloudReady && data().cloudReady() && global.AAA_CLOUD) global.AAA_CLOUD.upsertEntity(SCENARIOS, rec.id, rec); } catch (_) {} }

  global.AAA_DIGITAL_TWIN = Twin;
})(typeof window !== 'undefined' ? window : this);
