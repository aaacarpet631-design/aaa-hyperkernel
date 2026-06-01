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

  // The content-safety classifier this engine screens AI drafts against. Only
  // used for logging/provenance — the actual call is made by AAA_CONTENT_SAFETY.
  const SAFETY_MODEL = 'nvidia/nemotron-3-content-safety';

  function template(job) {
    const biz = cfg().businessName || 'AAA Carpet';
    const url = cfg().reviewUrl;
    return 'Hi ' + firstName(job.customerName) + ', thank you for choosing ' + biz +
      '! It was a pleasure working with you. If you have a moment, a quick review would mean a lot' +
      (url ? ': ' + url : '.');
  }

  // Returns { text, source: 'ai'|'template', prompt }. `source` drives whether
  // the content-safety guardrail screens it: only AI-drafted text is screened
  // (templates are deterministic and human-authored). `prompt` is the context
  // the AI saw, passed to the guardrail's response check.
  async function generateMessage(job) {
    const prompt =
      'Customer first name: ' + firstName(job.customerName) +
      '. Work done: ' + (job.notes || 'carpet service') + '. ' +
      (cfg().reviewUrl ? 'Include this review link: ' + cfg().reviewUrl : 'No review link available — invite them to leave a review.');
    try {
      if (data() && data().callAgent) {
        const biz = cfg().businessName || 'AAA Carpet';
        const res = await data().callAgent({
          agent: 'customer_success', model: 'claude-sonnet-4-6', max_tokens: 200,
          system: 'You write short, warm, professional review-request SMS messages for ' + biz +
            ', a carpet cleaning & repair company. One or two sentences with a clear, friendly ask for a review. Output ONLY the message text — no quotes, no preamble.',
          messages: [{ role: 'user', content: prompt }]
        });
        if (res && res.ok && res.text && res.text.trim()) return { text: res.text.trim(), source: 'ai', prompt: prompt };
      }
    } catch (_) { /* fall through to template */ }
    return { text: template(job), source: 'template', prompt: prompt };
  }

  // Screen an AI draft through the content-safety guardrail. Fail-closed: a
  // clean "safe" verdict is the ONLY path to a normal send; anything else
  // (unsafe → block; unknown / unreadable / proxy error / guardrail
  // unavailable → queue) keeps the message out of the auto-send flow for a
  // human to review. Templates (source !== 'ai') are passed through unscreened.
  async function screen(gen, contextId) {
    const at = clock() ? clock().now() : Date.now();
    const base = { screened: false, decision: 'allow', source: gen.source, model: SAFETY_MODEL, messageContextId: contextId, checkedAt: at };
    if (gen.source !== 'ai') return Object.assign(base, { reason: 'not_ai_drafted' });

    const guard = global.AAA_CONTENT_SAFETY;
    if (!guard || !guard.isReady || !guard.isReady()) {
      return Object.assign(base, { decision: 'queue', verdict: 'unknown', safe: null, categories: [], error: 'SAFETY_UNAVAILABLE' });
    }
    let res;
    try { res = await guard.checkResponse(gen.prompt, gen.text); }
    catch (e) { res = { ok: false, error: 'SAFETY_EXCEPTION', message: String((e && e.message) || e) }; }

    if (!res || res.ok === false) {
      return Object.assign(base, { screened: true, decision: 'queue', verdict: 'unknown', safe: null, categories: [], error: (res && res.error) || 'SAFETY_FAILED' });
    }
    const out = Object.assign(base, {
      screened: true, verdict: res.verdict, safe: res.safe,
      categories: Array.isArray(res.categories) ? res.categories : [],
      raw: res.raw, usage: res.usage
    });
    out.decision = res.safe === true ? 'allow' : (res.safe === false ? 'block' : 'queue');
    return out;
  }

  // Map a safety decision to the persisted review-request status.
  function statusForDecision(decision) {
    if (decision === 'block') return 'blocked';
    if (decision === 'queue') return 'queued';
    return 'pending'; // allow / unscreened template
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
      const gen = await generateMessage(job);
      const id = ids() ? ids().createId('rev') : String(Date.now());

      // Gate AI-drafted outbound text through the content-safety guardrail.
      const safety = await screen(gen, id);
      const status = statusForDecision(safety.decision);

      // Register the decision with the Governance Engine (content-safety is its
      // first consumer). Held drafts become overridable cases; the returned
      // case id is stored so the UI can open the review/override flow.
      if (safety.source === 'ai') {
        try {
          if (global.AAA_GOVERNANCE && global.AAA_GOVERNANCE.record) {
            const gc = await global.AAA_GOVERNANCE.record({
              domain: 'content_safety', guardrail: SAFETY_MODEL, model: safety.model,
              subjectType: 'review_request', subjectId: id, messageContextId: id,
              decision: safety.decision, verdict: safety.verdict,
              categories: safety.categories, raw: safety.raw, draft: gen.text
            });
            if (gc && gc.ok) safety.governanceCaseId = gc.case.id;
          }
        } catch (_) { /* governance is additive; never blocks preparing the record */ }
      }

      const rec = {
        id: id,
        jobId: jobId, customerId: job.customerId || null,
        customerName: job.customerName || null,
        phone: (customer && customer.phone) || null,
        email: (customer && customer.email) || null,
        message: gen.text, link: cfg().reviewUrl || null,
        channel: null, status: status,
        safety: safety,            // verdict, category, raw, model, timestamp, contextId
        createdAt: clock() ? clock().now() : Date.now()
      };
      await data().put('review_requests', rec.id, rec);
      await cloudUpsert(rec);
      // Log the verdict, category, raw response, model, timestamp, and the
      // message context id (policy: full audit trail for every screened draft).
      try {
        if (data().logAgent) {
          data().logAgent('customer_success', 'Review request ' + status + ' for ' + (job.customerName || 'customer'), {
            jobId: jobId, reviewId: id,
            decision: safety.decision, verdict: safety.verdict || null,
            categories: safety.categories || [], error: safety.error || null,
            raw: safety.raw != null ? safety.raw : null,
            model: safety.model, checkedAt: safety.checkedAt, messageContextId: safety.messageContextId
          });
        }
      } catch (_) {}
      return { ok: true, review: rec, blocked: status === 'blocked', queued: status === 'queued' };
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
