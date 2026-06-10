/*
 * AAA Trust Gap Engine — what friction is costing us deals.
 *
 * Scans real signals of trust friction:
 *   - estimate abandonment (quotes sent/created but neither won nor lost)
 *   - thin social proof (few reviews relative to jobs)
 *   - slow response (response_time signal, when available)
 * and returns a trustScore (1 = no detected friction), the specific trustGaps,
 * and the proof assets that would close them. Honest: a gap is only reported
 * from real evidence; absent data lowers confidence, never invents a gap.
 *
 * Output: { trustScore, trustGaps, recommendedProofAssets, confidence }.
 */
;(function (global) {
  'use strict';

  function data() { return global.AAA_DATA; }
  function world() { return global.AAA_WORLD_MODEL; }
  function clock() { return global.AAA_RUNTIME_CLOCK; }
  function nowMs() { return clock() && clock().now ? clock().now() : Date.now(); }
  function lc(v) { return String(v == null ? '' : v).toLowerCase(); }
  async function list(c) { try { return (await data().list(c)) || []; } catch (_) { return []; } }
  const RESOLVED = ['won', 'accepted', 'closed_won', 'lost', 'rejected', 'closed_lost'];

  const Engine = {
    async assess(opts) {
      const o = opts || {};
      const now = o.now != null ? o.now : nowMs();
      const quotes = await list('quotes');
      const reviews = await list('review_requests');
      const jobs = await list('jobs');
      const gaps = []; const proof = []; let confidence = 0;

      if (quotes.length) {
        confidence = Math.max(confidence, Math.min(0.9, quotes.length / 20));
        const abandoned = quotes.filter((q) => RESOLVED.indexOf(lc(q.status)) === -1);
        const rate = abandoned.length / quotes.length;
        if (rate >= 0.25) { gaps.push({ gap: 'estimate_abandonment', rate: Math.round(rate * 1000) / 1000, detail: abandoned.length + ' of ' + quotes.length + ' estimates went cold' }); proof.push('itemized_estimate_walkthrough', 'workmanship_guarantee'); }
      }
      if (jobs.length) {
        const reviewRatio = reviews.length / jobs.length;
        if (reviewRatio < 0.5) { gaps.push({ gap: 'thin_social_proof', ratio: Math.round(reviewRatio * 1000) / 1000, detail: reviews.length + ' reviews across ' + jobs.length + ' jobs' }); proof.push('recent_5star_reviews', 'before_after_photos'); confidence = Math.max(confidence, 0.6); }
      }
      if (world()) {
        const rt = await world().signal('response_time', now);
        if (rt && rt.value != null && (rt.status === 'fresh' || rt.status === 'degraded') && rt.value > 24) { gaps.push({ gap: 'slow_response', hours: rt.value, detail: 'first response averages ' + rt.value + 'h' }); proof.push('fast_response_promise'); confidence = Math.max(confidence, rt.confidence); }
      }

      if (!quotes.length && !jobs.length) return { trustScore: null, trustGaps: [], recommendedProofAssets: [], confidence: 0, status: 'insufficient_data' };
      const trustScore = Math.round(Math.max(0, 1 - 0.2 * gaps.length) * 1000) / 1000;
      return { trustScore: trustScore, trustGaps: gaps, recommendedProofAssets: Array.from(new Set(proof)), confidence: Math.round(confidence * 1000) / 1000, status: 'derived' };
    }
  };

  global.AAA_TRUST_GAP_ENGINE = Engine;
})(typeof window !== 'undefined' ? window : this);
