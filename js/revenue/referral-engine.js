/*
 * AAA Referral Engine — who is most likely to send the next customer.
 *
 * Scores a customer's referral probability from REAL loyalty signals: repeat
 * jobs, a positive review given, and recency of a good outcome. Surfaces the
 * best referral opportunities (high probability, not yet asked). It only scores
 * customers with real history; an unknown customer is insufficient_data, not a
 * hopeful default. Read-only; deterministic.
 *
 * Output: { referralProbability, opportunities, confidence, status }.
 */
;(function (global) {
  'use strict';

  function data() { return global.AAA_DATA; }
  function num(v) { const n = Number(v); return isFinite(n) ? n : null; }
  function lc(v) { return String(v == null ? '' : v).toLowerCase(); }
  async function list(c) { try { return (await data().list(c)) || []; } catch (_) { return []; } }

  const Engine = {
    /** Referral probability for one customer id. */
    async forCustomer(customerId) {
      const jobs = (await list('jobs')).filter((j) => j.customerId === customerId);
      const reviews = (await list('review_requests')).filter((r) => r.customerId === customerId);
      if (!jobs.length && !reviews.length) return { referralProbability: null, confidence: 0, status: 'insufficient_data' };
      const repeat = jobs.length > 1 ? 1 : 0;
      const gavePositive = reviews.some((r) => (num(r.rating) == null || num(r.rating) >= 4) && (lc(r.status) === 'received' || r.text)) ? 1 : 0;
      const completed = jobs.some((j) => lc(j.status) === 'completed' || j.finalBilling != null) ? 1 : 0;
      // Weighted blend of real loyalty signals.
      const p = Math.round((0.4 * gavePositive + 0.35 * repeat + 0.25 * completed) * 1000) / 1000;
      return { referralProbability: p, signals: { repeat: !!repeat, gavePositiveReview: !!gavePositive, completedJob: !!completed }, confidence: Math.min(0.85, (jobs.length + reviews.length) / 5), status: 'derived' };
    },

    /** Top referral opportunities across customers. */
    async opportunities(limit) {
      const customers = await list('customers');
      const out = [];
      for (const c of customers) { const r = await this.forCustomer(c.id); if (r.status === 'derived' && r.referralProbability >= 0.5) out.push({ customerId: c.id, name: c.name || null, referralProbability: r.referralProbability, signals: r.signals }); }
      return out.sort((a, b) => b.referralProbability - a.referralProbability).slice(0, limit || 10);
    }
  };

  global.AAA_REFERRAL_ENGINE = Engine;
})(typeof window !== 'undefined' ? window : this);
