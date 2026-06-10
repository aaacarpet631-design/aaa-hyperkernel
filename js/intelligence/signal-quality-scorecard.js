/*
 * AAA Signal Quality Scorecard — how good is the world model's input right now?
 *
 * Reads the current read model and reports coverage (how many registered signals
 * have a usable value), freshness (how many of those are fresh vs degraded), and
 * mean confidence — per type and overall. Honest: when nothing usable exists it
 * returns status 'insufficient_data', not a flattering zero-dressed-as-fine.
 */
;(function (global) {
  'use strict';

  function registry() { return global.AAA_SIGNAL_REGISTRY; }
  function ledger() { return global.AAA_WORLD_STATE_LEDGER; }
  function clock() { return global.AAA_RUNTIME_CLOCK; }
  function nowMs() { return clock() && clock().now ? clock().now() : Date.now(); }
  function round(n, p) { const f = Math.pow(10, p == null ? 4 : p); return n == null ? null : Math.round(n * f) / f; }

  const Card = {
    async score(now, opts) {
      const model = await ledger().deriveCurrentReadModel(now != null ? now : nowMs(), opts);
      const total = registry() ? registry().COUNT : Object.keys(model).length;
      const perType = {};
      let present = 0, fresh = 0, confSum = 0;
      Object.keys(model).forEach((type) => {
        const a = model[type];
        const usable = a.value !== null && (a.status === 'fresh' || a.status === 'degraded');
        perType[type] = { status: a.status, confidence: round(a.confidence || 0), usable: usable };
        if (usable) { present++; confSum += (a.confidence || 0); if (a.status === 'fresh') fresh++; }
      });
      if (present === 0) {
        return { status: 'insufficient_data', coverage: 0, freshness: null, avgConfidence: null, present: 0, total: total, perType: perType };
      }
      return {
        status: 'operational',
        coverage: round(present / total),
        freshness: round(fresh / present),
        avgConfidence: round(confSum / present),
        present: present, fresh: fresh, total: total, perType: perType
      };
    }
  };

  global.AAA_SIGNAL_QUALITY_SCORECARD = Card;
})(typeof window !== 'undefined' ? window : this);
