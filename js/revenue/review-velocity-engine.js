/*
 * AAA Review Velocity Engine — how fast reputation is compounding.
 *
 * Measures the real rate of reviews over recent windows (reviews per week) and
 * estimates the probability a given closed job will yield a review, from the
 * historical request→received conversion. No reviews → insufficient_data.
 * Read-only; deterministic.
 *
 * Output: { reviewProbability, velocityPerWeek, trend, confidence, status }.
 */
;(function (global) {
  'use strict';

  function data() { return global.AAA_DATA; }
  function clock() { return global.AAA_RUNTIME_CLOCK; }
  function nowMs() { return clock() && clock().now ? clock().now() : Date.now(); }
  function lc(v) { return String(v == null ? '' : v).toLowerCase(); }
  async function list(c) { try { return (await data().list(c)) || []; } catch (_) { return []; } }

  const Engine = {
    async assess(now) {
      const ref = now != null ? now : nowMs();
      const reviews = await list('review_requests');
      const jobs = await list('jobs');
      if (!reviews.length) return { reviewProbability: jobs.length ? 0 : null, velocityPerWeek: jobs.length ? 0 : null, trend: null, confidence: 0, status: 'insufficient_data' };
      const received = reviews.filter((r) => lc(r.status) === 'received' || r.rating != null || r.text);
      const reviewProbability = jobs.length ? Math.round((received.length / jobs.length) * 1000) / 1000 : null;

      const week = 604800000;
      const stamp = (r) => Date.parse(r.receivedAt || r.createdAt || r.updatedAt);
      const last4 = received.filter((r) => { const t = stamp(r); return isFinite(t) && t >= ref - 4 * week; }).length;
      const prev4 = received.filter((r) => { const t = stamp(r); return isFinite(t) && t < ref - 4 * week && t >= ref - 8 * week; }).length;
      const velocityPerWeek = Math.round((last4 / 4) * 100) / 100;
      const trend = prev4 ? Math.round(((last4 - prev4) / prev4) * 1000) / 1000 : null;

      return { reviewProbability: reviewProbability, velocityPerWeek: velocityPerWeek, trend: trend, confidence: Math.min(0.9, received.length / 20), status: 'derived' };
    }
  };

  global.AAA_REVIEW_VELOCITY_ENGINE = Engine;
})(typeof window !== 'undefined' ? window : this);
