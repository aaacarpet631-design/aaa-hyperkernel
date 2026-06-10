/*
 * AAA Neighborhood Opportunity Engine — where the next profitable job is.
 *
 * Per ZIP, from real quotes/outcomes/reviews:
 *   profitability  mean margin of won work
 *   winRate        won / (won+lost)
 *   saturation     our review density (proxy for how worked-over a ZIP is)
 *   volume         deal count
 * → opportunityIndex = winRate × normalized-margin × (1 − saturationPenalty),
 * higher where we win profitable work and are not yet saturated. Permit
 * activity / housing turnover are declared inputs with no live source yet →
 * reported insufficient_data, never invented. Deterministic; read-only.
 */
;(function (global) {
  'use strict';

  function data() { return global.AAA_DATA; }
  function num(v) { const n = Number(v); return isFinite(n) ? n : null; }
  function lc(v) { return String(v == null ? '' : v).toLowerCase(); }
  function mean(a) { return a.length ? a.reduce((x, y) => x + y, 0) / a.length : null; }
  async function list(c) { try { return (await data().list(c)) || []; } catch (_) { return []; } }
  const WON = ['won', 'accepted', 'closed_won']; const LOST = ['lost', 'rejected', 'closed_lost'];

  const Engine = {
    /** Per-ZIP rollup. */
    async byZip() {
      const quotes = await list('quotes');
      const reviews = await list('review_requests');
      if (!quotes.length) return { status: 'insufficient_data', zips: [] };
      const z = {};
      const bucket = (zip) => (z[zip] || (z[zip] = { zip: zip, won: 0, lost: 0, margins: [], reviews: 0 }));
      quotes.forEach((q) => { const b = bucket(String(q.zip || 'unknown')); const s = lc(q.status); if (WON.indexOf(s) !== -1) { b.won++; const m = num(q.margin); if (m != null) b.margins.push(m); } else if (LOST.indexOf(s) !== -1) b.lost++; });
      reviews.forEach((r) => { if (r.zip != null) bucket(String(r.zip)).reviews++; });
      const allMargins = quotes.map((q) => num(q.margin)).filter((m) => m != null);
      const globalMargin = mean(allMargins) || 0.45;
      const maxReviews = Math.max(1, ...Object.values(z).map((b) => b.reviews));
      const zips = Object.values(z).map((b) => {
        const wl = b.won + b.lost;
        const winRate = wl ? b.won / wl : null;
        const profitability = b.margins.length ? mean(b.margins) : null;
        const saturation = b.reviews / maxReviews;                  // 0..1 proxy
        const normMargin = profitability == null ? null : Math.max(0, Math.min(1, profitability / Math.max(globalMargin, 0.01) / 2));
        const opportunityIndex = (winRate == null || normMargin == null) ? null : Math.round(winRate * normMargin * (1 - 0.5 * saturation) * 1000) / 1000;
        return { zip: b.zip, deals: wl, winRate: winRate == null ? null : Math.round(winRate * 1000) / 1000, profitability: profitability == null ? null : Math.round(profitability * 1000) / 1000, saturation: Math.round(saturation * 1000) / 1000, opportunityIndex: opportunityIndex };
      }).sort((a, b) => (b.opportunityIndex || -1) - (a.opportunityIndex || -1));
      return { status: 'derived', zips: zips, externalSignals: { permitActivity: 'insufficient_data', housingTurnover: 'insufficient_data' } };
    },

    /** Aggregate opportunity index across ZIPs (mean of derivable indices). */
    async opportunityIndex() {
      const r = await this.byZip();
      if (r.status !== 'derived') return { value: null, confidence: 0, status: 'insufficient_data' };
      const idx = r.zips.map((z) => z.opportunityIndex).filter((v) => v != null);
      return { value: idx.length ? Math.round(mean(idx) * 1000) / 1000 : null, confidence: idx.length ? Math.min(0.9, idx.length / 10) : 0, status: idx.length ? 'derived' : 'insufficient_data', topZips: r.zips.slice(0, 5) };
    }
  };

  global.AAA_NEIGHBORHOOD_OPPORTUNITY_ENGINE = Engine;
})(typeof window !== 'undefined' ? window : this);
