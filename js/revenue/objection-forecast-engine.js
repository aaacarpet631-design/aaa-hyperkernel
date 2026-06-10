/*
 * AAA Objection Forecast Engine — what the customer will push back on.
 *
 * Deterministically forecasts likely objections from the estimate's own shape
 * and the live trust gaps: a high price band → "price/too expensive"; a thin
 * proof trust gap → "do I trust them"; slow response → "are they reliable"; a
 * commercial context → "terms/scheduling". Each objection carries a probability
 * and a grounded rebuttal. It only raises objections it has evidence for.
 */
;(function (global) {
  'use strict';

  function trust() { return global.AAA_TRUST_GAP_ENGINE; }
  function num(v) { const n = Number(v); return isFinite(n) ? n : null; }

  const Engine = {
    async forecast(estimate, opts) {
      const e = estimate || {};
      const objections = [];
      const total = num(e.total);
      if (total != null && total >= 2500) objections.push({ objection: 'price_too_high', probability: total >= 5000 ? 0.7 : 0.5, rebuttal: 'Lead with financing options and the cost of a cheaper redo; itemize value.' });
      else if (total != null && total < 800) objections.push({ objection: 'is_quality_real_at_this_price', probability: 0.35, rebuttal: 'Reassure with guarantee + recent reviews at this tier.' });

      let tg = null;
      try { if (trust()) tg = await trust().assess(opts); } catch (_) {}
      if (tg && Array.isArray(tg.trustGaps)) {
        if (tg.trustGaps.some((g) => g.gap === 'thin_social_proof')) objections.push({ objection: 'do_i_trust_this_company', probability: 0.5, rebuttal: 'Send the assembled proof packet (reviews + before/after) before the close call.' });
        if (tg.trustGaps.some((g) => g.gap === 'slow_response')) objections.push({ objection: 'are_they_responsive', probability: 0.4, rebuttal: 'Set a concrete response-time promise and confirm next contact in writing.' });
      }
      if (e.commercial || /commercial|office|building/i.test(String(e.context || ''))) objections.push({ objection: 'terms_and_scheduling', probability: 0.45, rebuttal: 'Offer net terms and a scheduled crew block; reference a comparable commercial job.' });

      objections.sort((a, b) => b.probability - a.probability);
      return { likelyObjections: objections, confidence: objections.length ? 0.6 : 0.4, status: 'derived' };
    }
  };

  global.AAA_OBJECTION_FORECAST_ENGINE = Engine;
})(typeof window !== 'undefined' ? window : this);
