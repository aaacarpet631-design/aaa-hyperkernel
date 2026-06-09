/*
 * AAA Transport Scheduler — time-based message DRAFTING (governance preserved).
 *
 * It automates the *timing* of recurring customer touchpoints, but it never
 * sends: every message it creates is a DRAFT in pending_approval, exactly like a
 * hand-written one. A person still approves before anything leaves. It is
 * idempotent — it will not re-draft a message that already exists for the same
 * job/template.
 *
 *   runReviewRequests()    — 24h review request + 7d reminder after a job closes
 *   acknowledgeMissedCall() — a missed-call text-back draft
 *
 * Read-only over jobs/customers; writes only DRAFT messages via AAA_TRANSPORT.
 */
;(function (global) {
  'use strict';

  const DAY = 86400000;

  function data() { return global.AAA_DATA; }
  function cfg() { return global.AAA_CONFIG || {}; }
  function clock() { return global.AAA_RUNTIME_CLOCK; }
  function tx() { return global.AAA_TRANSPORT; }
  function nowMs() { return clock() && clock().now ? clock().now() : Date.now(); }

  function contactFor(job, custMap) {
    if (job && job.customerPhone) return String(job.customerPhone);
    if (job && job.customerEmail) return String(job.customerEmail);
    const c = job && job.customerId ? custMap[job.customerId] : null;
    return (c && (c.phone || c.email)) || null;
  }
  function completionMs(job) {
    const t = Date.parse(job && (job.closedAt || job.completedAt || job.updatedAt) || '');
    return isFinite(t) ? t : null;
  }

  const Scheduler = {
    /**
     * Draft review requests for recently-closed jobs. 24h request + 7d reminder.
     * Idempotent (skips any job that already has that message). Drafts only —
     * never sends. @returns { ok, drafted, considered }
     */
    async runReviewRequests(opts) {
      const o = opts || {};
      if (!tx()) return { ok: false, error: 'NO_TRANSPORT' };
      const now = o.now != null ? o.now : nowMs();
      let jobs = []; try { jobs = await data().listJobs(); } catch (_) { jobs = []; }
      let customers = []; try { customers = await data().listCustomers(); } catch (_) { customers = []; }
      const custMap = {}; customers.forEach((c) => { if (c && c.id) custMap[c.id] = c; });
      const existing = await tx().list();
      const hasMsg = (jobId, tpl) => existing.some((m) => m.relatedId === jobId && m.templateId === tpl);
      const reviewUrl = cfg().reviewUrl || null;

      let drafted = 0, considered = 0;
      for (const job of jobs) {
        if (!job || (job.currentState || '') !== 'CLOSED') continue;
        const done = completionMs(job); if (done == null) continue;
        const to = contactFor(job, custMap); if (!to) continue;
        considered++;
        const age = now - done;
        const vars = { customerName: job.customerName || null, reviewUrl: reviewUrl };
        const base = { to: to, vars: vars, relatedType: 'job', relatedId: job.id, customerId: job.customerId || null, origin: 'ai', actor: 'scheduler' };
        if (age >= DAY && !hasMsg(job.id, 'review_request_24h')) { const r = await tx().draft(Object.assign({ templateId: 'review_request_24h' }, base)); if (r.ok) drafted++; }
        if (age >= 7 * DAY && !hasMsg(job.id, 'review_reminder_7d')) { const r = await tx().draft(Object.assign({ templateId: 'review_reminder_7d' }, base)); if (r.ok) drafted++; }
      }
      return { ok: true, drafted: drafted, considered: considered };
    },

    /**
     * Draft a missed-call text-back (pending approval). Idempotent within the
     * store's dedup window so the same number isn't acknowledged twice.
     * @param {Object} input { phone, customerId?, customerName? }
     */
    async acknowledgeMissedCall(input) {
      const i = input || {};
      if (!tx()) return { ok: false, error: 'NO_TRANSPORT' };
      if (!i.phone) return { ok: false, error: 'NO_PHONE' };
      return tx().draft({
        templateId: 'missed_call_textback', to: String(i.phone), channel: 'sms',
        vars: { customerName: i.customerName || null }, relatedType: 'lead', relatedId: 'missedcall_' + String(i.phone),
        customerId: i.customerId || null, origin: 'ai', actor: 'scheduler'
      });
    }
  };

  global.AAA_TRANSPORT_SCHEDULER = Scheduler;
})(typeof window !== 'undefined' ? window : this);
