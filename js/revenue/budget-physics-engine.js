/*
 * AAA Budget Physics Engine — allocate spend where the next dollar earns most.
 *
 * Reads REAL per-channel close rates (AAA_MARKETING.channelStats) and allocates
 * a budget proportional to each channel's marginal value (close rate × deal
 * count weight), with diminishing returns so it never dumps everything into one
 * channel. Channels with no win/loss history get no allocation (unproven, not
 * guessed). True CAC needs a spend feed the kernel does not yet have → reported
 * insufficient_data alongside the proxy allocation. Deterministic; read-only.
 */
;(function (global) {
  'use strict';

  function marketing() { return global.AAA_MARKETING; }
  function num(v) { const n = Number(v); return isFinite(n) ? n : 0; }

  const Engine = {
    /**
     * Allocate `budget` across channels by marginal value with sqrt diminishing
     * returns. → { allocations:[{source, share, amount, closeRate}], status }.
     */
    async allocate(budget) {
      const b = num(budget) || 0;
      if (!marketing() || !marketing().channelStats) return { status: 'insufficient_data', allocations: [], note: 'marketing channel stats unavailable' };
      const stats = await marketing().channelStats();
      // Weight = closeRate × sqrt(deals) — value per channel with diminishing returns.
      const weighted = stats.map((s) => {
        const deals = (s.won || 0) + (s.lost || 0);
        const cr = s.closeRate;
        const weight = (cr == null || !deals) ? 0 : cr * Math.sqrt(deals);
        return { source: s.source, closeRate: cr, deals: deals, weight: weight };
      }).filter((w) => w.weight > 0);
      if (!weighted.length) return { status: 'insufficient_data', allocations: [], note: 'no channel has win/loss history yet' };
      const total = weighted.reduce((a, w) => a + w.weight, 0);
      const allocations = weighted.map((w) => ({ source: w.source, closeRate: Math.round(w.closeRate * 1000) / 1000, share: Math.round((w.weight / total) * 1000) / 1000, amount: b ? Math.round((w.weight / total) * b * 100) / 100 : null }))
        .sort((a, b2) => b2.share - a.share);
      return { status: 'derived', budget: b || null, allocations: allocations, cac: { value: null, status: 'insufficient_data', note: 'requires a spend feed' }, confidence: Math.min(0.85, weighted.length / 4) };
    }
  };

  global.AAA_BUDGET_PHYSICS_ENGINE = Engine;
})(typeof window !== 'undefined' ? window : this);
