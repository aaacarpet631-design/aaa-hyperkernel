/*
 * AAA Agent Evaluation Lab — which agents actually create value?
 *
 * The platform tracks outcomes; this measures the PRODUCERS. For every
 * recommendation-producing agent it computes a scorecard from real records:
 *   - accuracy (closure validation) with a Wilson confidence interval,
 *   - false-positive / false-negative rates (confident-but-wrong / unsure-but-right),
 *   - adoption / acceptance rate (recommendations a human acted on),
 *   - revenue + margin influence and an ROI (from ADOPTED, job-linked work only —
 *     null and clearly labeled when attribution isn't yet measurable; no fabricated
 *     dollars),
 *   - customer / review / operational impact counters,
 *   - a composite value index when ROI isn't yet attributable.
 * Each number is explainable (cites its sample) and snapshots build a trend.
 *
 * Read-only/observational — writes only its own evaluation snapshots; changes no
 * business record. Reuses Prediction Closure, agent_decisions, pricing
 * recommendations, council sessions, quotes. Owner-only; deterministic; null-tolerant.
 */
;(function (global) {
  'use strict';

  const EVALS = 'agent_evaluations';

  function cfg() { return global.AAA_CONFIG || {}; }
  function data() { return global.AAA_DATA; }
  function ids() { return global.AAA_ID_FACTORY; }
  function clock() { return global.AAA_RUNTIME_CLOCK; }
  function closure() { return global.AAA_PREDICTION_CLOSURE; }
  function quotes() { return global.AAA_QUOTES; }
  function ws() { return cfg().workspaceId || 'default'; }
  function nowISO() { return clock() && clock().nowISO ? clock().nowISO() : new Date().toISOString(); }
  function mine(r) { return r && (r.workspaceId == null || r.workspaceId === ws()); }
  function newId(p) { return ids() ? ids().createId(p) : p + '_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7); }
  function num(v) { const n = Number(v); return isFinite(n) ? n : null; }
  function round(n) { return Math.round(n); }
  function pct(n, d) { return d > 0 ? Math.round((n / d) * 100) : null; }
  async function quiet(fn, d) { try { const r = await fn(); return r == null ? d : r; } catch (_) { return d; } }
  function costPerDecision() { return num(cfg().flag ? cfg().flag('evalCostPerDecision', 2) : 2) || 2; }

  // Wilson score interval for a binomial proportion (95%). Returns {low,high} in %.
  function wilson(success, n) {
    if (!n) return null;
    const z = 1.96, p = success / n;
    const denom = 1 + z * z / n;
    const center = (p + z * z / (2 * n)) / denom;
    const margin = (z * Math.sqrt((p * (1 - p) + z * z / (4 * n)) / n)) / denom;
    return { low: Math.max(0, round((center - margin) * 100)), high: Math.min(100, round((center + margin) * 100)) };
  }

  const Lab = {
    EVALS: EVALS,

    /** Every agent that has produced a decision/closure (for scorecards()). */
    async agents() {
      const set = {};
      (await quiet(() => data().list('agent_decisions'), [])).forEach((d) => { if (mine(d) && d.agent) set[d.agent] = true; });
      (await quiet(() => closure() && closure().closures ? closure().closures() : [], [])).forEach((c) => { if (mine(c) && c.agent) set[c.agent] = true; });
      return Object.keys(set);
    },

    /** Full scorecard for one agent (explainable, with a confidence interval). */
    async scorecard(agentId) {
      const decisions = (await quiet(() => data().list('agent_decisions'), [])).filter((d) => mine(d) && d.agent === agentId);
      const byPred = {}; decisions.forEach((d) => { byPred[d.id] = d; });
      const closures = (await quiet(() => closure() && closure().closures ? closure().closures() : [], [])).filter((c) => mine(c) && c.agent === agentId);

      const validated = closures.filter((c) => c.status === 'validated').length;
      const contradicted = closures.filter((c) => c.status === 'contradicted').length;
      const conclusive = validated + contradicted;
      const accuracy = pct(validated, conclusive);
      const accuracyCI = wilson(validated, conclusive);

      // FP/FN stratified by the original prediction's confidence.
      let fp = 0, fpN = 0, fn = 0, fnN = 0;
      closures.forEach((c) => {
        const d = byPred[c.predictionId]; const conf = d && d.confidence != null ? num(d.confidence) : null; if (conf == null) return;
        if (conf >= 50) { fpN++; if (c.status === 'contradicted') fp++; }      // confident → was it wrong?
        else { fnN++; if (c.status === 'validated') fn++; }                     // unsure → was it actually right?
      });

      // Adoption / acceptance from recommendation review state.
      const recs = (await quiet(() => data().list('pricing_recommendations'), [])).filter(mine);
      const agentRecs = agentId === 'pricing_optimizer' ? recs : [];
      const reviewed = agentRecs.filter((r) => r.status === 'reviewed').length;
      const decided = agentRecs.filter((r) => r.status === 'reviewed' || r.status === 'rejected').length;
      const adoptionRate = pct(reviewed, decided);

      // Revenue/margin influence from ADOPTED, job-linked work (council approvals).
      const attribution = await this._attribution(agentId);
      const cost = decisions.length * costPerDecision();
      const roi = (attribution.revenue != null && attribution.revenue > 0 && cost > 0) ? Math.round((attribution.revenue / cost) * 10) / 10 : null;

      // Domain impact counters (real where available, else null).
      const impact = await this._impact(agentId);

      // Composite value index (0-100) for ranking when ROI isn't yet attributable.
      const valueIndex = (accuracy != null) ? Math.min(100, round((accuracy / 100) * (0.5 + 0.5 * Math.min(1, conclusive / 10)) * (adoptionRate != null ? (0.5 + adoptionRate / 200) : 0.75) * 100)) : null;

      return {
        ok: true, agent: agentId,
        decisions: decisions.length, closures: { validated: validated, contradicted: contradicted, conclusive: conclusive },
        accuracy: accuracy, accuracyCI: accuracyCI,
        falsePositiveRate: pct(fp, fpN), falseNegativeRate: pct(fn, fnN),
        acceptanceRate: adoptionRate, adoptionRate: adoptionRate,
        revenueInfluence: attribution.revenue, marginInfluence: attribution.margin, cost: round(cost), roi: roi,
        customerImpact: impact.customer, reviewImpact: impact.review, operationalImpact: impact.operational,
        valueIndex: valueIndex,
        explain: {
          accuracy: accuracy == null ? 'No conclusive closures yet.' : validated + '/' + conclusive + ' predictions validated (95% CI ' + (accuracyCI ? accuracyCI.low + '–' + accuracyCI.high + '%' : '—') + ').',
          roi: roi == null ? 'Revenue not yet attributable to this agent — measured once adopted, job-linked work resolves.' : '$' + attribution.revenue + ' influenced revenue / $' + round(cost) + ' modeled cost.',
          adoption: adoptionRate == null ? 'No reviewed recommendations yet.' : reviewed + ' of ' + decided + ' decided recommendations were adopted.'
        }
      };
    },

    /** Scorecards for every agent, ranked by ROI then value index. */
    async scorecards() {
      const out = [];
      for (const a of await this.agents()) out.push(await this.scorecard(a));
      return out.sort((x, y) => (y.roi == null ? -1 : y.roi) - (x.roi == null ? -1 : x.roi) || (y.valueIndex == null ? -1 : y.valueIndex) - (x.valueIndex == null ? -1 : x.valueIndex));
    },

    /** Persist a snapshot of all scorecards (for the historical trend). */
    async evaluate() {
      const cards = await this.scorecards();
      const at = nowISO();
      for (const c of cards) await put({ id: newId('aeval'), workspaceId: ws(), agent: c.agent, at: at, accuracy: c.accuracy, roi: c.roi, valueIndex: c.valueIndex, adoptionRate: c.adoptionRate });
      return { ok: true, evaluated: cards.length, scorecards: cards };
    },
    async trend(agentId, limit) { return (await data().list(EVALS)).filter((r) => mine(r) && r.agent === agentId).sort((a, b) => String(a.at || '').localeCompare(String(b.at || ''))).slice(-(limit || 20)); },

    // ---- internals ----
    async _attribution(agentId) {
      // Revenue/margin from won jobs the agent's ADOPTED recommendations touched.
      let jobIds = {};
      if (agentId === 'agent_council') {
        (await quiet(() => data().list('council_sessions'), [])).forEach((s) => { if (mine(s) && s.status === 'reviewed' && s.ownerDecision === 'approve' && s.jobId) jobIds[s.jobId] = true; });
      }
      // generic: decisions explicitly flagged adopted + job-linked
      (await quiet(() => data().list('agent_decisions'), [])).forEach((d) => { if (mine(d) && d.agent === agentId && d.adopted && d.jobId) jobIds[d.jobId] = true; });
      const ids2 = Object.keys(jobIds);
      if (!ids2.length) return { revenue: null, margin: null };
      const qs = (await quiet(() => quotes() && quotes().list ? quotes().list() : data().list('quotes'), [])).filter((q) => mine(q) && q.status === 'won' && ids2.indexOf(q.jobId) !== -1);
      if (!qs.length) return { revenue: null, margin: null };
      const revenue = qs.reduce((s, q) => s + (num(q.customerTotal) || 0), 0);
      const margin = qs.reduce((s, q) => s + (num(q.customerTotal) || 0) * ((num(q.marginPct) || 0) / 100), 0);
      return { revenue: round(revenue), margin: round(margin) };
    },
    async _impact(agentId) {
      const evs = (await quiet(() => data().list('outcome_events'), [])).filter(mine);
      const review = agentId === 'review_request_engine' || agentId === 'customer_success' ? evs.filter((e) => e.type === 'review_received').length : null;
      const customer = evs.length ? evs.filter((e) => e.customerId).length : null;
      const operational = null;
      return { customer: customer, review: review, operational: operational };
    }
  };

  async function put(rec) { await data().put(EVALS, rec.id, rec); try { if (data().cloudReady && data().cloudReady() && global.AAA_CLOUD) global.AAA_CLOUD.upsertEntity(EVALS, rec.id, rec); } catch (_) {} }

  global.AAA_AGENT_EVAL = Lab;
})(typeof window !== 'undefined' ? window : this);
