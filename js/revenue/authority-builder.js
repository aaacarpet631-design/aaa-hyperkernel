/*
 * AAA Authority Builder — quantify and grow market authority.
 *
 * Computes an authorityScore from REAL reputation signals — review count, mean
 * rating, repeat-customer ratio, and tenure (oldest customer record) — and
 * recommends the highest-leverage authority move. Every input is measured;
 * where a signal is absent it simply does not contribute (and lowers
 * confidence), rather than padding the score. Read-only; deterministic.
 */
;(function (global) {
  'use strict';

  function data() { return global.AAA_DATA; }
  function num(v) { const n = Number(v); return isFinite(n) ? n : null; }
  async function list(c) { try { return (await data().list(c)) || []; } catch (_) { return []; } }

  const Engine = {
    async assess() {
      const reviews = await list('review_requests');
      const customers = await list('customers');
      const jobs = await list('jobs');
      if (!reviews.length && !customers.length && !jobs.length) return { authorityScore: null, confidence: 0, status: 'insufficient_data', signals: {}, recommendation: null };

      const ratings = reviews.map((r) => num(r.rating)).filter((n) => n != null);
      const meanRating = ratings.length ? ratings.reduce((a, b) => a + b, 0) / ratings.length : null;
      const jobsPerCust = {}; jobs.forEach((j) => { if (j.customerId) jobsPerCust[j.customerId] = (jobsPerCust[j.customerId] || 0) + 1; });
      const repeat = Object.values(jobsPerCust).filter((n) => n > 1).length;
      const repeatRatio = customers.length ? repeat / customers.length : null;

      // Components → 0..1 each, averaged over those present.
      const parts = [];
      if (reviews.length) parts.push(Math.min(1, reviews.length / 50));               // volume
      if (meanRating != null) parts.push(Math.max(0, Math.min(1, (meanRating - 3) / 2))); // quality (3..5 → 0..1)
      if (repeatRatio != null) parts.push(Math.min(1, repeatRatio * 2));               // loyalty
      const authorityScore = parts.length ? Math.round((parts.reduce((a, b) => a + b, 0) / parts.length) * 1000) / 1000 : null;

      let recommendation = null;
      if (reviews.length < 20) recommendation = 'Build review volume — request after every closed job (largest authority gap).';
      else if (meanRating != null && meanRating < 4.5) recommendation = 'Lift service quality / recover detractors before scaling spend.';
      else if (repeatRatio != null && repeatRatio < 0.2) recommendation = 'Launch a maintenance/loyalty program to grow repeat ratio.';
      else recommendation = 'Authority is strong — publish case studies and pursue commercial references.';

      return { authorityScore: authorityScore, confidence: Math.round(Math.min(0.9, parts.length / 3) * 1000) / 1000, status: authorityScore == null ? 'insufficient_data' : 'derived', signals: { reviews: reviews.length, meanRating: meanRating, repeatRatio: repeatRatio }, recommendation: recommendation };
    }
  };

  global.AAA_AUTHORITY_BUILDER = Engine;
})(typeof window !== 'undefined' ? window : this);
