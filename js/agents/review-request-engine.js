/*
 * AAA Review Request Engine.
 *
 * On a won/closed job it prepares a personalized review-request message
 * (AI-written through the proxy when configured, a solid template otherwise),
 * persists it to shared memory, and exposes device-native send links
 * (sms: / mailto:) so the technician sends it from their own phone — no SMS/
 * email provider required, nothing faked. Marking it sent updates the record.
 */
;(function (global) {
  'use strict';

  function data() { return global.AAA_DATA; }
  function cfg() { return global.AAA_CONFIG || {}; }
  function ids() { return global.AAA_ID_FACTORY; }
  function clock() { return global.AAA_RUNTIME_CLOCK; }

  function firstName(name) { return String(name || 'there').trim().split(/\s+/)[0] || 'there'; }

  function template(job) {
    const biz = cfg().businessName || 'AAA Carpet';
    const url = cfg().reviewUrl;
    return 'Hi ' + firstName(job.customerName) + ', thank you for choosing ' + biz +
      '! It was a pleasure working with you. If you have a moment, a quick review would mean a lot' +
      (url ? ': ' + url : '.');
  }

  async function generateMessage(job) {
    // AI-personalized when the proxy is configured; otherwise a clean template.
    try {
      if (data() && data().callAgent) {
        const biz = cfg().businessName || 'AAA Carpet';
        const res = await data().callAgent({
          agent: 'customer_success', model: 'claude-sonnet-4-6', max_tokens: 200,
          system: 'You write short, warm, professional review-request SMS messages for ' + biz +
            ', a carpet cleaning & repair company. One or two sentences with a clear, friendly ask for a review. Output ONLY the message text — no quotes, no preamble.',
          messages: [{ role: 'user', content:
            'Customer first name: ' + firstName(job.customerName) +
            '. Work done: ' + (job.notes || 'carpet service') + '. ' +
            (cfg().reviewUrl ? 'Include this review link: ' + cfg().reviewUrl : 'No review link available — invite them to leave a review.') }]
        });
        if (res && res.ok && res.text && res.text.trim()) return res.text.trim();
      }
    } catch (_) { /* fall through to template */ }
    return template(job);
  }

  async function cloudUpsert(rec) {
    try {
      if (data().cloudReady && data().cloudReady() && global.AAA_CLOUD) {
        await global.AAA_CLOUD.upsertEntity('review_requests', rec.id, rec);
      }
    } catch (_) {}
  }

  const engine = {
    /** Prepare (or reuse) a review request for a job. Does NOT send. */
    async requestReview(jobId) {
      if (!data()) return { ok: false, error: 'NO_DATA' };
      const job = await data().get('jobs', jobId);
      if (!job) return { ok: false, error: 'JOB_NOT_FOUND' };

      const existing = (await data().list('review_requests')).find((r) => r.jobId === jobId && r.status !== 'sent');
      if (existing) return { ok: true, review: existing, reused: true };

      const customer = job.customerId ? await data().get('customers', job.customerId) : null;
      const message = await generateMessage(job);
      const rec = {
        id: ids() ? ids().createId('rev') : String(Date.now()),
        jobId: jobId, customerId: job.customerId || null,
        customerName: job.customerName || null,
        phone: (customer && customer.phone) || null,
        email: (customer && customer.email) || null,
        message: message, link: cfg().reviewUrl || null,
        channel: null, status: 'pending',
        createdAt: clock() ? clock().now() : Date.now()
      };
      await data().put('review_requests', rec.id, rec);
      await cloudUpsert(rec);
      try { if (data().logAgent) data().logAgent('customer_success', 'Review request prepared for ' + (job.customerName || 'customer'), { jobId: jobId }); } catch (_) {}
      return { ok: true, review: rec };
    },

    /** Device-native send links (work on the tech's phone, no provider). */
    links(rec) {
      const body = encodeURIComponent(rec.message || '');
      return {
        sms: 'sms:' + (rec.phone || '') + '?&body=' + body,
        email: 'mailto:' + (rec.email || '') + '?subject=' + encodeURIComponent('Thank you from ' + (cfg().businessName || 'AAA Carpet')) + '&body=' + body
      };
    },

    async markSent(reviewId, channel) {
      const rec = await data().get('review_requests', reviewId);
      if (!rec) return null;
      rec.status = 'sent'; rec.channel = channel || null; rec.sentAt = clock() ? clock().now() : Date.now();
      await data().put('review_requests', reviewId, rec);
      await cloudUpsert(rec);
      return rec;
    },

    async list() { return data() ? data().list('review_requests') : []; },
    async pending() { return (await this.list()).filter((r) => r.status !== 'sent'); }
  };

  global.AAA_REVIEW_REQUEST_ENGINE = engine;
})(typeof window !== 'undefined' ? window : this);
