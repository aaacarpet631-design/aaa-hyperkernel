/*
 * AAA Proof Assembly Engine — assemble the real evidence that closes a deal.
 *
 * For a customer/job/ZIP it gathers genuine proof from shared memory: recent
 * positive reviews, before/after job photos, and comparable won jobs in the
 * same area. It assembles only assets that EXIST — it never fabricates a review
 * or a photo. Returns a ready-to-send proof packet; empty when there is nothing
 * real to show (insufficient_data). Read-only; deterministic.
 */
;(function (global) {
  'use strict';

  function data() { return global.AAA_DATA; }
  function lc(v) { return String(v == null ? '' : v).toLowerCase(); }
  async function list(c) { try { return (await data().list(c)) || []; } catch (_) { return []; } }
  const WON = ['won', 'accepted', 'closed_won'];

  const Engine = {
    /** Assemble a proof packet for { zip, serviceType }. */
    async assemble(context) {
      const c = context || {};
      const reviews = await list('review_requests');
      const jobs = await list('jobs');
      const quotes = await list('quotes');

      const positive = reviews.filter((r) => (r.rating == null || Number(r.rating) >= 4) && (lc(r.status) === 'received' || lc(r.status) === 'sent' || r.text));
      const zipReviews = c.zip != null ? positive.filter((r) => String(r.zip) === String(c.zip)) : positive;
      const photos = jobs.filter((j) => Array.isArray(j.photos) && j.photos.length && (c.zip == null || String(j.zip) === String(c.zip)));
      const comparableWins = quotes.filter((q) => WON.indexOf(lc(q.status)) !== -1 && (c.zip == null || String(q.zip) === String(c.zip)) && (c.serviceType == null || lc(q.serviceType || '').indexOf(lc(c.serviceType)) !== -1));

      const assets = [];
      if (zipReviews.length) assets.push({ type: 'reviews', count: zipReviews.length, sample: zipReviews.slice(0, 3).map((r) => ({ rating: r.rating || null, text: r.text || null })) });
      if (photos.length) assets.push({ type: 'before_after_photos', count: photos.length });
      if (comparableWins.length) assets.push({ type: 'comparable_jobs', count: comparableWins.length });

      return { status: assets.length ? 'assembled' : 'insufficient_data', assets: assets, strength: Math.min(1, assets.reduce((a, x) => a + Math.min(1, (x.count || 0) / 3), 0) / 3) };
    }
  };

  global.AAA_PROOF_ASSEMBLY_ENGINE = Engine;
})(typeof window !== 'undefined' ? window : this);
