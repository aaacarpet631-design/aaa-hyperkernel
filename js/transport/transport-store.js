/*
 * AAA Transport Store — governed customer messaging (SMS/email).
 *
 * The lifecycle: draft → pending_approval → (human approves) → queued →
 * sending → sent → delivered | failed | bounced, with retry. Governance is
 * enforced by code:
 *   - AI may DRAFT a message; it can never send. Approval routes through the
 *     Runtime Gateway (SEND_MESSAGE, human-only + audited).
 *   - The queue worker only ever sends ALREADY-APPROVED messages — there is no
 *     path from draft to the wire without a human approval.
 *   - Every transition (approve, send, delivery, failure, retry, bounce) is
 *     appended to an IMMUTABLE per-message history; sends/failures/retries are
 *     also logged. The communication record is never destructively edited.
 *   - Duplicate-send prevention: an identical message (channel+to+template+
 *     relatedId) already live within a window is blocked.
 *
 * Provider calls go through AAA_TRANSPORT_PROVIDERS (primary + fallback). No
 * secret ever touches the browser — the default provider posts to a server
 * function. Null-tolerant throughout.
 */
;(function (global) {
  'use strict';

  const COMMS = 'communications';

  const S = { DRAFT: 'draft', PENDING: 'pending_approval', QUEUED: 'queued', SENDING: 'sending', SENT: 'sent', DELIVERED: 'delivered', FAILED: 'failed', BOUNCED: 'bounced', DUPLICATE: 'duplicate', CANCELED: 'canceled' };

  function cfg() { return global.AAA_CONFIG || {}; }
  function data() { return global.AAA_DATA; }
  function ids() { return global.AAA_ID_FACTORY; }
  function clock() { return global.AAA_RUNTIME_CLOCK; }
  function gateway() { return global.AAA_RUNTIME_GATEWAY; }
  function templates() { return global.AAA_TEMPLATES; }
  function providers() { return global.AAA_TRANSPORT_PROVIDERS; }
  function events() { return global.AAA_EVENTS; }
  function ws() { return cfg().workspaceId || 'default'; }
  function nowISO() { return clock() && clock().nowISO ? clock().nowISO() : new Date().toISOString(); }
  function nowMs() { return clock() && clock().now ? clock().now() : Date.now(); }
  function mine(r) { return r && (r.workspaceId == null || r.workspaceId === ws()); }
  function num(v) { const n = Number(v); return isFinite(n) ? n : 0; }
  function newId(p) { return ids() ? ids().createId(p) : p + '_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7); }

  function T() {
    const f = (k, d) => (cfg().flag ? cfg().flag(k, d) : d);
    return { maxAttempts: num(f('transportMaxAttempts', 3)), dedupWindowMin: num(f('transportDedupMin', 60)), backoffMin: num(f('transportBackoffMin', 5)) };
  }

  const Store = {
    COMMS: COMMS, STATES: S,

    async list() { return (await data().list(COMMS)).filter(mine).sort(byNewest); },
    async get(id) { const r = await data().get(COMMS, id); return mine(r) ? r : null; },
    async pendingApproval() { return (await this.list()).filter((m) => m.status === S.PENDING); },
    async queue() { return (await this.list()).filter((m) => m.status === S.QUEUED); },

    /**
     * DRAFT a message (AI-allowed). Renders a template, captures recipient +
     * relation, and files it as pending_approval. Does NOT send. Blocks an
     * obvious duplicate.
     * @param {Object} input { templateId, to, channel?, vars?, relatedType?, relatedId?, customerId?, actor?, origin? }
     */
    async draft(input) {
      const i = input || {};
      if (!templates() || !templates().has(i.templateId)) return { ok: false, error: 'UNKNOWN_TEMPLATE' };
      if (!i.to) return { ok: false, error: 'NO_RECIPIENT', message: 'A phone number or email is required.' };
      const tplChannel = templates().channelOf(i.templateId);
      const channel = i.channel || (tplChannel === 'both' ? guessChannel(i.to) : tplChannel);
      if (channel !== 'sms' && channel !== 'email') return { ok: false, error: 'BAD_CHANNEL' };
      const rendered = templates().render(i.templateId, i.vars);
      if (!rendered.ok) return rendered;

      const fingerprint = [channel, String(i.to).toLowerCase(), i.templateId, i.relatedId || ''].join('|');
      const dup = await this._recentDuplicate(fingerprint);
      const id = newId('msg');
      const at = nowISO();
      const rec = {
        id: id, workspaceId: ws(), channel: channel, to: String(i.to),
        templateId: i.templateId, category: templates().categoryOf(i.templateId),
        subject: rendered.subject, body: rendered.body,
        relatedType: i.relatedType || null, relatedId: i.relatedId || null, customerId: i.customerId || null,
        status: dup ? S.DUPLICATE : S.PENDING, duplicateOf: dup ? dup.id : null, fingerprint: fingerprint,
        attempts: 0, providerId: null, provider: null, failureReason: null, bounceReason: null,
        approvedBy: null, approvedAt: null, sentAt: null, deliveredAt: null, nextAttemptAt: null,
        history: [evt('drafted', { by: i.actor || (i.origin === 'ai' ? 'ai' : null) })],
        createdAt: at, updatedAt: at
      };
      await put(rec);
      if (events()) events().emit('transport.drafted', { id: id, channel: channel });
      return { ok: true, message: rec, duplicate: !!dup };
    },

    /**
     * Human approval → move to the send queue. Routed through the gateway
     * (SEND_MESSAGE, human-only + audited). AI-origin callers are blocked here.
     * Duplicates require opts.overrideDuplicate.
     */
    async approve(id, opts) {
      const o = opts || {};
      const m = await this.get(id); if (!m) return { ok: false, error: 'NOT_FOUND' };
      if (m.status === S.QUEUED || m.status === S.SENT || m.status === S.DELIVERED) return { ok: true, already: true, message: m };
      if (m.status === S.DUPLICATE && !o.overrideDuplicate) return { ok: false, error: 'DUPLICATE', message: 'A matching message was sent recently. Confirm to send anyway.' };
      if (m.status !== S.PENDING && m.status !== S.DUPLICATE && m.status !== S.FAILED) return { ok: false, error: 'NOT_APPROVABLE' };
      const gw = gateway();
      if (!gw) return { ok: false, error: 'NO_GATEWAY' };
      const res = await gw.run({
        action: 'SEND_MESSAGE', origin: o.origin === 'ai' ? 'ai' : 'human', actor: o.actor || null,
        target: { type: 'message', id: id }, detail: { channel: m.channel, to: m.to, templateId: m.templateId },
        mutate: async () => {
          const rec = transition(m, S.QUEUED, evt('approved', { by: o.actor || null }), { approvedBy: o.actor || null, approvedAt: nowISO(), nextAttemptAt: nowISO() });
          await put(rec); return rec;
        }
      });
      if (!res.ok) return res;     // AI-origin / RBAC denial (audited)
      return { ok: true, message: res.result, auditId: res.auditId };
    },

    /** Cancel a not-yet-sent message. */
    async cancel(id, opts) {
      const m = await this.get(id); if (!m) return { ok: false, error: 'NOT_FOUND' };
      if ([S.SENT, S.DELIVERED].indexOf(m.status) !== -1) return { ok: false, error: 'ALREADY_SENT' };
      await put(transition(m, S.CANCELED, evt('canceled', { by: (opts || {}).actor || null })));
      return { ok: true };
    },

    /**
     * Process the send queue: send each due, approved message through the
     * provider chain (primary → fallback), recording every attempt. Retries up
     * to maxAttempts with backoff; marks failed after that. The worker only ever
     * touches ALREADY-APPROVED (queued) messages.
     */
    async processQueue(opts) {
      const o = opts || {};
      const th = T();
      const chain = (channel) => (o.providers ? (o.providers[channel] || []) : (providers() ? providers().for(channel) : []));
      const due = (await this.queue()).filter((m) => !m.nextAttemptAt || Date.parse(m.nextAttemptAt) <= nowMs());
      let sent = 0, failed = 0;
      for (const m of due) {
        const list = chain(m.channel);
        if (!list.length) { await put(transition(m, S.FAILED, evt('failed', { reason: 'NO_PROVIDER' }), { failureReason: 'NO_PROVIDER' })); failed++; continue; }
        let okRes = null, lastErr = null, usedProvider = null;
        let cur = transition(m, S.SENDING, evt('sending', { attempt: m.attempts + 1 }), { attempts: m.attempts + 1 });
        await put(cur);
        for (const p of list) {            // primary then fallback
          try { const r = await p.send({ channel: cur.channel, to: cur.to, subject: cur.subject, body: cur.body }); okRes = r; usedProvider = p.name; break; }
          catch (e) { lastErr = e; cur = appendHistory(cur, evt('provider_error', { provider: p.name, reason: String((e && e.message) || e) })); }
        }
        if (okRes) {
          await put(transition(cur, S.SENT, evt('sent', { provider: usedProvider, providerId: okRes.providerId, attempt: cur.attempts }), { provider: usedProvider, providerId: okRes.providerId || null, sentAt: nowISO(), nextAttemptAt: null }));
          sent++;
        } else {
          const canRetry = cur.attempts < th.maxAttempts;
          if (canRetry) {
            const next = new Date(nowMs() + th.backoffMin * 60000 * cur.attempts).toISOString();
            await put(transition(cur, S.QUEUED, evt('retry_scheduled', { attempt: cur.attempts, nextAttemptAt: next, reason: String((lastErr && lastErr.message) || lastErr) }), { nextAttemptAt: next, failureReason: String((lastErr && lastErr.message) || lastErr) }));
          } else {
            await put(transition(cur, S.FAILED, evt('failed', { reason: String((lastErr && lastErr.message) || lastErr), attempts: cur.attempts }), { failureReason: String((lastErr && lastErr.message) || lastErr), nextAttemptAt: null }));
            failed++;
          }
        }
      }
      return { ok: true, sent: sent, failed: failed, processed: due.length };
    },

    /** Delivery tracker (provider webhook → here). */
    async markDelivered(id, info) {
      const m = await this.get(id); if (!m) return { ok: false, error: 'NOT_FOUND' };
      await put(transition(m, S.DELIVERED, evt('delivered', info || {}), { deliveredAt: nowISO() }));
      return { ok: true };
    },
    /** Bounce handler (provider webhook → here). Immutable history records it. */
    async markBounced(id, reason) {
      const m = await this.get(id); if (!m) return { ok: false, error: 'NOT_FOUND' };
      await put(transition(m, S.BOUNCED, evt('bounced', { reason: reason || null }), { bounceReason: String(reason || '') }));
      return { ok: true };
    },
    /** Carrier/provider-reported failure AFTER send (distinct from queue exhaustion). */
    async markFailed(id, reason) {
      const m = await this.get(id); if (!m) return { ok: false, error: 'NOT_FOUND' };
      await put(transition(m, S.FAILED, evt('failed', { reason: reason || null, source: 'provider' }), { failureReason: String(reason || ''), nextAttemptAt: null }));
      return { ok: true };
    },

    /**
     * Normalize a raw provider webhook payload into a status event. Pure +
     * null-tolerant. Unmapped/intermediate statuses return status:'ignored'.
     * @param {'twilio'|'sendgrid'} provider
     * @param {Object} payload
     */
    normalizeProviderEvent(provider, payload) {
      const p = payload || {};
      if (provider === 'twilio') {
        const map = { delivered: 'delivered', undelivered: 'bounced', failed: 'failed' };
        const status = map[String(p.MessageStatus || '').toLowerCase()] || 'ignored';
        return { provider: 'twilio', providerId: p.MessageSid || p.SmsSid || null, status: status, reason: p.ErrorMessage || (p.ErrorCode ? 'code ' + p.ErrorCode : null) };
      }
      if (provider === 'sendgrid') {
        const map = { delivered: 'delivered', bounce: 'bounced', blocked: 'bounced', dropped: 'failed' };
        const status = map[String(p.event || '').toLowerCase()] || 'ignored';
        return { provider: 'sendgrid', providerId: p.sg_message_id || p.smtp_id || null, status: status, reason: p.reason || p.response || null };
      }
      return { provider: provider || null, providerId: null, status: 'ignored', reason: null };
    },

    /**
     * Apply a normalized status event to its message (by our id or providerId).
     * Idempotent + null-tolerant; never throws. Records the transition in the
     * immutable history. This is the "delivery truth" the webhook drives.
     * @param {Object} evt { messageId?, providerId?, status, reason? }
     */
    async applyStatusEvent(ev) {
      const e = ev || {};
      if (!e.status || e.status === 'ignored') return { ok: false, error: 'IGNORED' };
      let m = null;
      if (e.messageId) m = await this.get(e.messageId);
      if (!m && e.providerId) m = (await this.list()).find((x) => x.providerId && x.providerId === e.providerId) || null;
      if (!m) return { ok: false, error: 'NO_MATCH' };
      if (m.status === e.status) return { ok: true, message: m, noop: true };  // idempotent
      if (e.status === 'delivered') return this.markDelivered(m.id, { reason: e.reason || null, source: 'webhook' });
      if (e.status === 'bounced') return this.markBounced(m.id, e.reason || 'bounced');
      if (e.status === 'failed') return this.markFailed(m.id, e.reason || 'provider failure');
      return { ok: false, error: 'UNHANDLED_STATUS' };
    },


    async stats() {
      const all = await this.list();
      const by = (s) => all.filter((m) => m.status === s).length;
      return {
        total: all.length,
        pendingApproval: by(S.PENDING) + by(S.DUPLICATE),
        queued: by(S.QUEUED), sent: by(S.SENT), delivered: by(S.DELIVERED),
        failed: by(S.FAILED), bounced: by(S.BOUNCED), canceled: by(S.CANCELED),
        pendingRetry: all.filter((m) => m.status === S.QUEUED && m.attempts > 0).length
      };
    },

    // ---- internals ----
    async _recentDuplicate(fingerprint) {
      const windowMs = T().dedupWindowMin * 60000;
      const all = await this.list();
      return all.find((m) => m.fingerprint === fingerprint && [S.PENDING, S.QUEUED, S.SENDING, S.SENT, S.DELIVERED].indexOf(m.status) !== -1 && (nowMs() - Date.parse(m.createdAt || '') <= windowMs)) || null;
    }
  };

  // ---- pure helpers ----
  function byNewest(a, b) { return String(b.createdAt || '').localeCompare(String(a.createdAt || '')); }
  function evt(type, info) { return Object.assign({ type: type, at: nowISO() }, info || {}); }
  function appendHistory(m, e) { return Object.assign({}, m, { history: (m.history || []).concat([e]), updatedAt: nowISO() }); }
  function transition(m, status, e, fields) {
    return Object.assign({}, m, fields || {}, { status: status, history: (m.history || []).concat([e]), updatedAt: nowISO() });
  }
  function guessChannel(to) { return /@/.test(String(to)) ? 'email' : 'sms'; }
  async function put(rec) {
    await data().put(COMMS, rec.id, rec);
    try { if (data().cloudReady && data().cloudReady() && global.AAA_CLOUD) global.AAA_CLOUD.upsertEntity(COMMS, rec.id, rec); } catch (_) {}
    if (events()) events().emit('transport.' + rec.status, { id: rec.id });
  }

  global.AAA_TRANSPORT = Store;
})(typeof window !== 'undefined' ? window : this);
