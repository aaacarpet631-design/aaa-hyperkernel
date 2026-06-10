/*
 * AAA Margin Guardian — catch underpricing before it ships.
 *
 * Compares an estimate's implied margin (or price) against the real historical
 * margin distribution for comparable work (same service / price band). It flags
 * marginRisk when the estimate sits below the comparable median, and reports a
 * data-derived floor price. With no comparable margin history it returns
 * insufficient_data — it never asserts a floor it cannot justify. Deterministic.
 */
;(function (global) {
  'use strict';

  function data() { return global.AAA_DATA; }
  function num(v) { const n = Number(v); return isFinite(n) ? n : null; }
  function lc(v) { return String(v == null ? '' : v).toLowerCase(); }
  async function list(c) { try { return (await data().list(c)) || []; } catch (_) { return []; } }
  function svc(q) { const s = Array.isArray(q.serviceType) ? q.serviceType : (q.serviceType ? [q.serviceType] : []); return s.map(lc).sort().join('+') || 'unspecified'; }
  function median(a) { if (!a.length) return null; const s = a.slice().sort((x, y) => x - y); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; }

  const Engine = {
    /** @param estimate {serviceType, margin?, total} → {marginRisk, underpriced, floorMargin, status}. */
    async assess(estimate) {
      const e = estimate || {};
      const quotes = await list('quotes');
      const tSvc = svc(e);
      const comps = quotes.map((q) => ({ svc: svc(q), margin: num(q.margin) })).filter((q) => q.margin != null && q.svc === tSvc);
      const pool = comps.length >= 3 ? comps : quotes.map((q) => ({ margin: num(q.margin) })).filter((q) => q.margin != null);
      if (pool.length < 3) return { marginRisk: null, underpriced: null, floorMargin: null, confidence: 0, status: 'insufficient_data' };
      const med = median(pool.map((q) => q.margin));
      const p25 = median(pool.map((q) => q.margin).filter((m) => m <= med));   // lower-quartile-ish floor
      const estMargin = num(e.margin);
      let marginRisk, underpriced;
      if (estMargin == null) { marginRisk = null; underpriced = null; }
      else { underpriced = estMargin < p25; marginRisk = Math.max(0, Math.min(1, (med - estMargin) / Math.max(med, 0.01))); marginRisk = Math.round(marginRisk * 1000) / 1000; }
      return { marginRisk: marginRisk, underpriced: underpriced, floorMargin: Math.round((p25 == null ? med : p25) * 1000) / 1000, medianMargin: Math.round(med * 1000) / 1000, sample: pool.length, confidence: Math.min(0.9, pool.length / 15), status: estMargin == null ? 'no_estimate_margin' : 'derived' };
    }
  };

  global.AAA_MARGIN_GUARDIAN = Engine;
})(typeof window !== 'undefined' ? window : this);
