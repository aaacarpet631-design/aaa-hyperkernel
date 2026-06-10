/*
 * AAA Venture Discovery Engine — find adjacent revenue before humans notice.
 *
 * Ranks adjacencies (from the Adjacency Mapper) into scored opportunities. The
 * score blends structural overlap, observed demand evidence, and the live
 * market score from the World Model. expectedMargin is anchored to the
 * company's REAL current gross margin (a conservative proxy for an adjacent
 * line), clearly flagged as an estimate — never a fabricated precise figure.
 * Discovered opportunities are registered (append-only). Read-only over the biz.
 *
 * Output per opportunity: { opportunity, expectedMargin, confidence, evidence }.
 */
;(function (global) {
  'use strict';

  function adjacency() { return global.AAA_ADJACENCY_MAPPER; }
  function market() { return global.AAA_MARKET_INTELLIGENCE; }
  function world() { return global.AAA_WORLD_MODEL; }
  function registry() { return global.AAA_OPPORTUNITY_REGISTRY; }
  function clock() { return global.AAA_RUNTIME_CLOCK; }
  function nowMs() { return clock() && clock().now ? clock().now() : Date.now(); }
  function r3(n) { return n == null ? null : Math.round(n * 1000) / 1000; }

  const Engine = {
    /** Score adjacencies into opportunities (does not register). */
    async discover(opts) {
      const o = opts || {};
      const now = o.now != null ? o.now : nowMs();
      const adj = adjacency() ? await adjacency().map() : [];
      let marketScore = null, mConf = 0;
      try { if (market()) { const m = await market().assess({ now: now }); marketScore = m.marketScore; mConf = m.confidence; } } catch (_) {}
      let baseMargin = null, marginConf = 0;
      if (world()) { const s = await world().signal('gross_margin', now); if (s && s.value != null && (s.status === 'fresh' || s.status === 'degraded')) { baseMargin = s.value; marginConf = s.confidence; } }

      return adj.map((a) => {
        // Opportunity score: overlap, lifted by observed demand + market pull.
        const demandLift = a.demandEvidence ? 0.15 : 0;
        const marketLift = marketScore == null ? 0 : 0.2 * marketScore;
        const score = r3(Math.max(0, Math.min(1, a.overlap * 0.7 + demandLift + marketLift)));
        // Expected margin: conservative anchor to current margin (flagged estimate).
        const expectedMargin = baseMargin == null ? null : r3(baseMargin * (a.adjacency === 'maintenance_programs' || a.adjacency === 'recurring_services' ? 1.1 : 0.95));
        const confidence = r3(Math.min(0.7, (a.overlap * 0.4) + (a.demandEvidence ? 0.15 : 0) + (mConf * 0.2) + (marginConf * 0.15)));
        return {
          opportunity: a.adjacency,
          score: score,
          expectedMargin: expectedMargin,
          expectedMarginStatus: expectedMargin == null ? 'insufficient_data' : 'estimate_from_current_margin',
          confidence: confidence,
          evidence: { overlap: a.overlap, reuses: a.reuses, demandEvidence: a.demandEvidence, evidenceStatus: a.evidenceStatus, marketScore: marketScore }
        };
      }).sort((x, y) => y.score - x.score);
    },

    /** Discover and register the top opportunities (append-only). */
    async discoverAndRegister(opts) {
      const o = opts || {};
      const found = await this.discover(o);
      const top = found.slice(0, o.limit || 3);
      const registered = [];
      if (registry()) for (const f of top) registered.push(await registry().register({ opportunity: f.opportunity, expectedMargin: f.expectedMargin, confidence: f.confidence, evidence: f.evidence }));
      return { discovered: found, registered: registered };
    }
  };

  global.AAA_VENTURE_DISCOVERY_ENGINE = Engine;
})(typeof window !== 'undefined' ? window : this);
