/*
 * AAA Scenario Engine — turns a business question into a structured, immutable
 * scenario, and computes the baseline reality it will be measured against.
 *
 * Each scenario kind declares its parameters, the human-readable ASSUMPTIONS it
 * encodes (so a recommendation is never a black box), and the estimator model
 * it drives. baseline(snapshot) derives the starting metrics from a READ-ONLY
 * graph snapshot — real figures where the data exists, clearly-labeled
 * assumptions where it does not (honest by construction: an assumed baseline
 * value carries its name in `assumed[]`).
 *
 * The six seed scenarios mirror the directive's questions:
 *   price_change · add_crew · drop_zip · fuel_change · ad_spend_change · disaster
 */
;(function (global) {
  'use strict';

  function cfg() { return global.AAA_CONFIG || {}; }
  function num(v, d) { const n = Number(v); return isFinite(n) ? n : d; }
  function flag(k, d) { return cfg().flag ? num(cfg().flag(k, d), d) : d; }
  function mean(a) { return a.length ? a.reduce((x, y) => x + y, 0) / a.length : null; }
  function pct(x) { return Math.round(x * 1000) / 10; }

  // kind → { label, params, build(params)→{levers, assumptions} }
  const KINDS = {
    price_change: {
      label: 'Raise/lower prices',
      params: ['pct'],
      build: function (p) {
        const v = num(p.pct, 0.07);
        return { params: { pct: v }, assumptions: ['Average ticket changes by ' + pct(v) + '%', 'Demand is price-elastic (close rate moves inversely)', 'Most of a price change flows to margin'] };
      }
    },
    add_crew: {
      label: 'Add/remove a crew',
      params: ['crews'],
      build: function (p) {
        const n = Math.round(num(p.crews, 1));
        return { params: { crews: n }, assumptions: [(n >= 0 ? 'Add ' : 'Remove ') + Math.abs(n) + ' crew(s)', 'Throughput is capacity-limited up to available demand', 'Added crew carries labor overhead (slight margin drag)'] };
      }
    },
    drop_zip: {
      label: 'Stop servicing a zip code',
      params: ['zip', 'share'],
      build: function (p) {
        return { params: { zip: String(p.zip || ''), share: num(p.share, null) }, assumptions: ['Volume from zip ' + (p.zip || '?') + ' is dropped', 'Reduced travel slightly improves margin on remaining work'] };
      }
    },
    fuel_change: {
      label: 'Fuel price shift',
      params: ['pct'],
      build: function (p) {
        const v = num(p.pct, 0.2);
        return { params: { pct: v }, assumptions: ['Fuel cost changes by ' + pct(v) + '%', 'Fuel is a fixed share of job cost (margin absorbs it)'] };
      }
    },
    ad_spend_change: {
      label: 'Change ad spend',
      params: ['pct'],
      build: function (p) {
        const v = num(p.pct, 1.0);
        return { params: { pct: v }, assumptions: ['Ad spend changes by ' + pct(v) + '%', 'Leads scale sub-linearly with spend', 'Incremental leads close at a slightly lower rate'] };
      }
    },
    disaster: {
      label: 'Disaster / demand shock',
      params: ['region', 'severity'],
      build: function (p) {
        const s = Math.max(0, Math.min(1, num(p.severity, 0.7)));
        return { params: { region: String(p.region || ''), severity: s }, assumptions: ['Demand spikes in ' + (p.region || 'region') + ' (severity ' + s + ')', 'Capacity is strained → response time and callbacks rise', 'Satisfaction dips under surge load'] };
      }
    }
  };

  const Engine = {
    KINDS: Object.keys(KINDS),
    kind(id) { return KINDS[id] || null; },

    /** Build an immutable scenario spec from a kind + params. */
    build(kind, params) {
      const k = KINDS[kind];
      if (!k) return { ok: false, error: 'UNKNOWN_SCENARIO', kind: kind };
      const b = k.build(params || {});
      return { ok: true, scenario: { kind: kind, label: k.label, params: b.params, assumptions: b.assumptions } };
    },

    /**
     * Baseline metrics from a read-only snapshot ({ source:{quotes,jobs,outcomes} }).
     * Real where derivable; assumed (and labeled) otherwise.
     */
    baseline(snapshot) {
      const src = (snapshot && snapshot.source) || {};
      const quotes = Array.isArray(src.quotes) ? src.quotes : [];
      const jobs = Array.isArray(src.jobs) ? src.jobs : [];
      const lc = (v) => String(v == null ? '' : v).toLowerCase();
      const won = quotes.filter((q) => ['won', 'accepted', 'closed_won'].indexOf(lc(q.status)) !== -1);
      const lost = quotes.filter((q) => ['lost', 'rejected', 'closed_lost'].indexOf(lc(q.status)) !== -1);
      const wonTotals = won.map((q) => num(q.total, 0)).filter((n) => n > 0);
      const margins = quotes.map((q) => num(q.margin, null)).filter((n) => n != null);

      const assumed = [];
      const volume = won.length || jobs.length || flag('simBaselineVolume', 100);
      if (!won.length && !jobs.length) assumed.push('volume');
      const avgTicket = wonTotals.length ? mean(wonTotals) : flag('simBaselineTicket', 1200);
      if (!wonTotals.length) assumed.push('avgTicket');
      const revenue = wonTotals.length ? wonTotals.reduce((a, b) => a + b, 0) : volume * avgTicket;
      const wl = won.length + lost.length;
      const closeRate = wl ? won.length / wl : flag('simBaselineCloseRate', 0.4);
      if (!wl) assumed.push('closeRate');
      const margin = margins.length ? mean(margins) : flag('simBaselineMargin', 0.45);
      if (!margins.length) assumed.push('margin');

      // Operational metrics: assumed defaults (labeled) until live ops data is wired.
      const crews = flag('simCrews', 2); assumed.push('crews');
      const utilization = flag('simBaselineUtilization', 0.7); assumed.push('utilization');
      const responseTime = flag('simBaselineResponseHours', 24); assumed.push('responseTime');
      const callbacks = flag('simBaselineCallbackRate', 0.08); assumed.push('callbacks');
      const csat = flag('simBaselineCsat', 0.9); assumed.push('csat');

      return {
        revenue: revenue, avgTicket: avgTicket, volume: volume, closeRate: closeRate, margin: margin,
        crews: crews, utilization: utilization, responseTime: responseTime, callbacks: callbacks, csat: csat,
        assumed: assumed
      };
    },

    /** Volume share of a zip from the snapshot (for drop_zip), or null. */
    zipShare(snapshot, zip) {
      const quotes = (snapshot && snapshot.source && snapshot.source.quotes) || [];
      if (!quotes.length || !zip) return null;
      const inZip = quotes.filter((q) => String(q.zip || '') === String(zip)).length;
      return inZip / quotes.length;
    }
  };

  global.AAA_SCENARIO_ENGINE = Engine;
})(typeof window !== 'undefined' ? window : this);
