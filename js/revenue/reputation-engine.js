/*
 * AAA Reputation Engine — a single reputation score with recency weighting.
 *
 * reputationScore blends review volume, mean rating, and recency (recent
 * reviews count more) from real review records. Distinct from the Authority
 * Builder (which weighs loyalty/tenure for strategy) — this is the live
 * reputation health number for the Review Flywheel. No reviews →
 * insufficient_data. Read-only; deterministic.
 */
;(function (global) {
  'use strict';

  function data() { return global.AAA_DATA; }
  function clock() { return global.AAA_RUNTIME_CLOCK; }
  function nowMs() { return clock() && clock().now ? clock().now() : Date.now(); }
  function num(v) { const n = Number(v); return isFinite(n) ? n : null; }
  async function list(c) { try { return (await data().list(c)) || []; } catch (_) { return []; } }

  const Engine = {
    async assess(now) {
      const ref = now != null ? now : nowMs();
      const reviews = (await list('review_requests')).filter((r) => r.rating != null || r.text);
      if (!reviews.length) return { reputationScore: null, meanRating: null, volume: 0, confidence: 0, status: 'insufficient_data' };
      const day = 86400000;
      let wSum = 0, w = 0; const ratings = [];
      reviews.forEach((r) => {
        const rating = num(r.rating);
        const t = Date.parse(r.receivedAt || r.createdAt || r.updatedAt);
        const ageDays = isFinite(t) ? Math.max(0, (ref - t) / day) : 365;
        const recency = Math.exp(-ageDays / 180);               // half-life ~ 4 months
        if (rating != null) { ratings.push(rating); wSum += rating * recency; w += recency; }
      });
      const meanRating = ratings.length ? ratings.reduce((a, b) => a + b, 0) / ratings.length : null;
      const recencyWeighted = w ? wSum / w : meanRating;
      // Score: recency-weighted rating mapped 3..5 → 0..1, scaled by volume confidence.
      const qual = recencyWeighted == null ? null : Math.max(0, Math.min(1, (recencyWeighted - 3) / 2));
      const volumeFactor = Math.min(1, reviews.length / 50);
      const reputationScore = qual == null ? null : Math.round((0.7 * qual + 0.3 * volumeFactor) * 1000) / 1000;
      return { reputationScore: reputationScore, meanRating: meanRating == null ? null : Math.round(meanRating * 100) / 100, volume: reviews.length, confidence: Math.min(0.9, reviews.length / 25), status: reputationScore == null ? 'insufficient_data' : 'derived' };
    }
  };

  global.AAA_REPUTATION_ENGINE = Engine;
})(typeof window !== 'undefined' ? window : this);
