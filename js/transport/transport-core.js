/*
 * AAA Native Transport Core — the communication BRAIN AAA HyperKernel owns.
 *
 * AAA owns the intelligence; providers are dumb pipes. This core owns:
 *   - conversation threads (one per channel + peer), reconciled from app storage
 *   - the reply inbox (inbound messages) + reply routing to the right thread
 *   - owner notifications (a reply arrived / a message failed)
 *   - AI response SUGGESTIONS (recommendation-only; a person sends)
 *   - communication analytics (delivery / failure / response rates, by channel)
 *   - quote / job / customer linking on every message
 *   - the outbound + delivery path, delegated to the GOVERNED store
 *     (AAA_TRANSPORT) and the pluggable adapter chain (AAA_TRANSPORT_ADAPTERS)
 *
 * Governance is preserved end to end:
 *   - Outbound goes through AAA_TRANSPORT (AI may draft; a human approves; the
 *     gateway audits SEND_MESSAGE). The core NEVER bypasses that.
 *   - Inbound is recorded through the gateway (INBOUND_MESSAGE, audited) into
 *     app-owned storage with an immutable per-message history.
 *   - AI agents read/write customer communication ONLY through this core.
 *
 * Storage (app-owned): comm_threads, comm_inbound, comm_notifications.
 * Null-tolerant throughout; deterministic (no randomness in the brain).
 */
;(function (global) {
  'use strict';

  const THREADS = 'comm_threads';
  const INBOUND = 'comm_inbound';
  const NOTIF = 'comm_notifications';

  function cfg() { return global.AAA_CONFIG || {}; }
  function data() { return global.AAA_DATA; }
  function ids() { return global.AAA_ID_FACTORY; }
  function clock() { return global.AAA_RUNTIME_CLOCK; }
  function gateway() { return global.AAA_RUNTIME_GATEWAY; }
  function tx() { return global.AAA_TRANSPORT; }
  function adapters() { return global.AAA_TRANSPORT_ADAPTERS; }
  function templates() { return global.AAA_TEMPLATES; }
  function events() { return global.AAA_EVENTS; }
  function ws() { return cfg().workspaceId || 'default'; }
  function nowISO() { return clock() && clock().nowISO ? clock().nowISO() : new Date().toISOString(); }
  function mine(r) { return r && (r.workspaceId == null || r.workspaceId === ws()); }
  function newId(p) { return ids() ? ids().createId(p) : p + '_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7); }
  function peerKey(channel, peer) { return String(channel || '') + '::' + String(peer == null ? '' : peer).toLowerCase().trim(); }
  function evt(type, info) { return Object.assign({ type: type, at: nowISO() }, info || {}); }

  const Core = {
    THREADS: THREADS, INBOUND: INBOUND, NOTIF: NOTIF,

    // ---- OUTBOUND (governed; AI may draft, a human approves to send) --------
    /**
     * Draft a customer message through the GOVERNED store and link it to its
     * conversation thread. This is the ONLY write path AI agents use. It does
     * NOT send — AAA_TRANSPORT.approve (human + audited) does.
     */
    async send(input) {
      const i = input || {};
      if (!tx()) return { ok: false, error: 'NO_TRANSPORT' };
      const res = await tx().draft(i);
      if (!res.ok) return res;
      const thread = await this._attachOutbound(res.message);
      if (events()) events().emit('comm.outbound_drafted', { id: res.message.id, threadId: thread.id });
      return { ok: true, message: res.message, threadId: thread.id, duplicate: res.duplicate };
    },

    /** Deliver the approved queue through the pluggable adapter chain. */
    async dispatch(opts) {
      const o = opts || {};
      if (!tx()) return { ok: false, error: 'NO_TRANSPORT' };
      const chains = o.providers || (adapters() ? adapters().sendChains() : null);
      const res = await tx().processQueue(chains ? { providers: chains } : {});
      await this.reconcile();
      return res;
    },

    // ---- INBOUND (reply inbox + routing + owner notification) ---------------
    /**
     * Record an inbound customer message. Accepts an already-shaped message, or
     * a raw provider payload + adapter name (the adapter parses it). Creates/links
     * the thread, raises an owner notification, and audits the receipt
     * (INBOUND_MESSAGE). Returns { ok, inbound, threadId, notificationId }.
     */
    async receiveInbound(input) {
      const i = input || {};
      let shaped = { channel: i.channel || 'sms', from: i.from || null, body: i.body || '', providerId: i.providerId || null, adapter: i.adapter || null };
      if (i.raw && adapters()) {
        const a = adapters().inboundAdapter(shaped.channel, i.adapter);
        if (a && a.parseInbound) { const p = a.parseInbound(i.raw); if (p) shaped = Object.assign(shaped, p, { adapter: a.name }); }
      }
      if (!shaped.from) return { ok: false, error: 'NO_SENDER' };
      const gw = gateway();
      if (!gw) return { ok: false, error: 'NO_GATEWAY' };

      // Match an outbound message to this peer to inherit customer/job/quote links.
      const linked = await this._lastOutboundTo(shaped.channel, shaped.from);
      const thread = await this._threadFor(shaped.channel, shaped.from, {
        customerId: i.customerId || (linked && linked.customerId) || null,
        relatedType: i.relatedType || (linked && linked.relatedType) || null,
        relatedId: i.relatedId || (linked && linked.relatedId) || null
      });

      const res = await gw.run({
        action: 'INBOUND_MESSAGE', origin: i.origin === 'ai' ? 'ai' : (i.origin || 'human'), actor: i.actor || shaped.adapter || 'inbound',
        target: { type: 'inbound_message', id: thread.id }, detail: { channel: shaped.channel, from: shaped.from, adapter: shaped.adapter || null },
        mutate: async () => {
          const id = newId('in');
          const rec = {
            id: id, workspaceId: ws(), threadId: thread.id, direction: 'inbound',
            channel: shaped.channel, from: String(shaped.from), body: String(shaped.body || ''),
            customerId: thread.customerId || null, relatedType: thread.relatedType || null, relatedId: thread.relatedId || null,
            providerId: shaped.providerId || null, adapter: shaped.adapter || null,
            status: 'received', replyToMessageId: linked ? linked.id : null,
            history: [evt('received', { adapter: shaped.adapter || null })], createdAt: nowISO(), updatedAt: nowISO()
          };
          await put(INBOUND, rec);
          return rec;
        }
      });
      if (!res.ok) return res;
      const inbound = res.result;
      inbound.auditRef = res.auditId; await put(INBOUND, inbound);

      // Update the thread: unread + last-message snapshot + inbound ref.
      await this._touchThread(thread.id, { direction: 'inbound', preview: inbound.body, at: inbound.createdAt, inboundRef: inbound.id, unreadInc: 1 });
      // Owner notification.
      const notif = await this._notify('inbound', { threadId: thread.id, messageId: inbound.id, title: 'New reply from ' + shaped.from, body: (inbound.body || '').slice(0, 140) });
      if (events()) events().emit('comm.inbound', { id: inbound.id, threadId: thread.id });
      return { ok: true, inbound: inbound, threadId: thread.id, notificationId: notif ? notif.id : null, auditId: res.auditId };
    },

    // ---- THREADS / INBOX ----------------------------------------------------
    /** All conversations, newest activity first (reconciles app storage first). */
    async threads(filter) {
      await this.reconcile();
      const f = filter || {};
      let all = (await data().list(THREADS)).filter(mine);
      if (f.status) all = all.filter((t) => t.status === f.status);
      if (f.channel) all = all.filter((t) => t.channel === f.channel);
      if (f.customerId) all = all.filter((t) => t.customerId === f.customerId);
      return all.sort((a, b) => String(b.lastMessageAt || b.createdAt || '').localeCompare(String(a.lastMessageAt || a.createdAt || '')));
    },
    async thread(id) { const r = await data().get(THREADS, id); return mine(r) ? r : null; },

    /** The merged conversation: outbound (governed store) + inbound, in order. */
    async threadMessages(id) {
      const t = await this.thread(id);
      if (!t) return [];
      const out = tx() ? (await tx().list()).filter((m) => peerKey(m.channel, m.to) === t.key) : [];
      const inb = (await data().list(INBOUND)).filter((m) => mine(m) && m.threadId === id);
      const rows = out.map((m) => ({ direction: 'outbound', id: m.id, channel: m.channel, status: m.status, body: m.body, to: m.to, category: m.category, templateId: m.templateId, attempts: m.attempts, failureReason: m.failureReason, bounceReason: m.bounceReason, at: m.sentAt || m.createdAt }))
        .concat(inb.map((m) => ({ direction: 'inbound', id: m.id, channel: m.channel, status: m.status, body: m.body, from: m.from, at: m.createdAt })));
      return rows.sort((a, b) => String(a.at || '').localeCompare(String(b.at || '')));
    },

    async markThreadRead(id, opts) {
      const t = await this.thread(id); if (!t) return { ok: false, error: 'NOT_FOUND' };
      const rec = Object.assign({}, t, { unread: 0, history: (t.history || []).concat([evt('read', { by: (opts || {}).actor || null })]), updatedAt: nowISO() });
      await put(THREADS, rec);
      // Mark received inbound as read.
      const inb = (await data().list(INBOUND)).filter((m) => mine(m) && m.threadId === id && m.status === 'received');
      for (const m of inb) await put(INBOUND, Object.assign({}, m, { status: 'read', history: (m.history || []).concat([evt('read')]), updatedAt: nowISO() }));
      return { ok: true, thread: rec };
    },
    async closeThread(id, opts) { return this._setThreadStatus(id, 'closed', opts); },
    async reopenThread(id, opts) { return this._setThreadStatus(id, 'open', opts); },

    // ---- AI RESPONSE SUGGESTIONS (recommendation-only) ----------------------
    /**
     * Suggest replies to a thread's latest inbound message. Deterministic,
     * intent-based, and SAFE: it proposes drafts a person can send — it never
     * sends, and an opt-out request is surfaced, never auto-answered.
     */
    async suggestReply(threadId) {
      const t = await this.thread(threadId); if (!t) return { ok: false, error: 'NOT_FOUND' };
      const inb = (await data().list(INBOUND)).filter((m) => mine(m) && m.threadId === threadId)
        .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
      const last = inb[0];
      const text = String((last && last.body) || '').toLowerCase();
      const name = null;
      const suggestions = [];
      const add = (s) => suggestions.push(Object.assign({ requiresApproval: true, channel: t.channel, to: t.peer }, s));

      if (/\b(stop|unsubscribe|opt[\s-]?out|remove me|do not (text|email|contact))\b/.test(text)) {
        add({ intent: 'opt_out', label: 'Honor opt-out', text: null, reason: 'Customer asked to stop — do NOT auto-reply. Mark this contact opted-out.', action: 'opt_out' });
        return { ok: true, suggestions: suggestions, intent: 'opt_out' };
      }
      if (/\b(price|quote|cost|estimate|how much)\b/.test(text)) add({ intent: 'quote', templateId: 'quote_followup', label: 'Send quote follow-up', text: rendered('quote_followup', name), reason: 'They asked about pricing — follow up on the estimate.' });
      if (/\b(book|schedule|when can|availab|appointment|come out|set up)\b/.test(text)) add({ intent: 'schedule', label: 'Offer to schedule', text: 'Happy to get you on the schedule — what day works best for you? — ' + biz(), reason: 'They want to book — offer a time.' });
      if (/\b(thank|great|awesome|appreciate|love|perfect|amazing)\b/.test(text)) add({ intent: 'review', templateId: 'review_request_24h', label: 'Ask for a review', text: rendered('review_request_24h', name), reason: 'Positive sentiment — a good moment to ask for a review.' });
      if (/\b(reschedul|cancel|move|change)\b/.test(text)) add({ intent: 'reschedule', label: 'Help reschedule', text: 'No problem — what new day/time works and we’ll update your appointment. — ' + biz(), reason: 'They want to change the appointment.' });
      if (!suggestions.length) add({ intent: 'ack', label: 'Acknowledge', text: 'Thanks for your message! A team member will get right back to you. — ' + biz(), reason: 'No clear intent — acknowledge and route to a person.' });
      return { ok: true, suggestions: suggestions, intent: (suggestions[0] && suggestions[0].intent) || 'ack' };
    },

    // ---- FAILURES (visible + actionable) ------------------------------------
    async failures() {
      if (!tx()) return [];
      return (await tx().list()).filter((m) => m.status === 'failed' || m.status === 'bounced');
    },
    /** Re-queue a failed message for another send attempt (governed + audited). */
    async retryFailed(id, opts) {
      if (!tx()) return { ok: false, error: 'NO_TRANSPORT' };
      const m = await tx().get(id); if (!m) return { ok: false, error: 'NOT_FOUND' };
      if (m.status !== 'failed') return { ok: false, error: 'NOT_FAILED' };
      return tx().approve(id, opts || {});   // FAILED is approvable → re-queues; SEND_MESSAGE audited
    },

    /** Wrap the store's delivery-truth handler to raise failure notifications. */
    async applyStatusEvent(ev) {
      if (!tx()) return { ok: false, error: 'NO_TRANSPORT' };
      const res = await tx().applyStatusEvent(ev);
      if (res && res.ok && !res.noop && (ev.status === 'failed' || ev.status === 'bounced')) {
        const m = (ev.messageId && await tx().get(ev.messageId)) || null;
        const thread = m ? await this._threadFor(m.channel, m.to, {}) : null;
        await this._notify(ev.status === 'bounced' ? 'bounce' : 'failure', { threadId: thread ? thread.id : null, messageId: ev.messageId || null, title: 'Message ' + ev.status, body: (ev.reason || '') });
      }
      return res;
    },

    // ---- OWNER NOTIFICATIONS ------------------------------------------------
    async notifications(filter) {
      const f = filter || {};
      let all = (await data().list(NOTIF)).filter(mine);
      if (f.unread) all = all.filter((n) => !n.read);
      if (f.kind) all = all.filter((n) => n.kind === f.kind);
      return all.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
    },
    async unreadNotificationCount() { return (await this.notifications({ unread: true })).length; },
    async markNotificationRead(id) { const n = await data().get(NOTIF, id); if (!mine(n)) return { ok: false, error: 'NOT_FOUND' }; await put(NOTIF, Object.assign({}, n, { read: true, readAt: nowISO() })); return { ok: true }; },

    // ---- COMMUNICATION ANALYTICS -------------------------------------------
    async analytics() {
      const out = tx() ? await tx().list() : [];
      const inb = (await data().list(INBOUND)).filter(mine);
      const threads = (await data().list(THREADS)).filter(mine);
      const by = (s) => out.filter((m) => m.status === s).length;
      const sent = by('sent'), delivered = by('delivered'), failed = by('failed'), bounced = by('bounced');
      const attempted = sent + delivered + failed + bounced;
      const rate = (n, d) => (d > 0 ? Math.round((n / d) * 100) : null);
      const byChannel = group(out, (m) => m.channel);
      const byCategory = group(out, (m) => m.category || m.templateId || 'other');
      const repliedThreads = threads.filter((t) => (t.inboundRefs || []).length > 0).length;
      return {
        ok: true,
        outbound: out.length, inbound: inb.length, threads: threads.length, openThreads: threads.filter((t) => t.status !== 'closed').length,
        sent: sent, delivered: delivered, failed: failed, bounced: bounced,
        deliveryRate: rate(delivered, attempted), failureRate: rate(failed + bounced, attempted),
        responseRate: rate(repliedThreads, threads.length), unreadThreads: threads.filter((t) => (t.unread || 0) > 0).length,
        byChannel: byChannel, byCategory: byCategory
      };
    },

    // ---- reconciliation: every app-owned message belongs to a thread --------
    /** Idempotently fold outbound communications + inbound into threads. */
    async reconcile() {
      const out = tx() ? await tx().list() : [];
      for (const m of out) { if (m && m.to) await this._attachOutbound(m, true); }
      return { ok: true };
    },

    // ---- internals ----------------------------------------------------------
    async _attachOutbound(m, quiet) {
      const thread = await this._threadFor(m.channel, m.to, { customerId: m.customerId, relatedType: m.relatedType, relatedId: m.relatedId });
      if ((thread.outboundRefs || []).indexOf(m.id) !== -1) return thread; // idempotent
      const at = m.sentAt || m.createdAt || nowISO();
      const rec = Object.assign({}, thread, {
        outboundRefs: (thread.outboundRefs || []).concat([m.id]),
        lastDirection: 'outbound', lastPreview: (m.body || '').slice(0, 140), lastMessageAt: maxISO(thread.lastMessageAt, at),
        customerId: thread.customerId || m.customerId || null, relatedType: thread.relatedType || m.relatedType || null, relatedId: thread.relatedId || m.relatedId || null,
        updatedAt: nowISO()
      });
      await put(THREADS, rec);
      return rec;
    },
    async _threadFor(channel, peer, links) {
      const key = peerKey(channel, peer);
      const existing = (await data().list(THREADS)).find((t) => mine(t) && t.key === key);
      if (existing) {
        const l = links || {};
        if ((l.customerId && !existing.customerId) || (l.relatedId && !existing.relatedId)) {
          const upd = Object.assign({}, existing, { customerId: existing.customerId || l.customerId || null, relatedType: existing.relatedType || l.relatedType || null, relatedId: existing.relatedId || l.relatedId || null, updatedAt: nowISO() });
          await put(THREADS, upd); return upd;
        }
        return existing;
      }
      const id = newId('thr');
      const rec = {
        id: id, workspaceId: ws(), key: key, channel: channel, peer: String(peer),
        customerId: (links && links.customerId) || null, relatedType: (links && links.relatedType) || null, relatedId: (links && links.relatedId) || null,
        status: 'open', unread: 0, lastDirection: null, lastPreview: null, lastMessageAt: null,
        outboundRefs: [], inboundRefs: [], history: [evt('opened')], createdAt: nowISO(), updatedAt: nowISO()
      };
      await put(THREADS, rec);
      return rec;
    },
    async _touchThread(id, info) {
      const t = await this.thread(id); if (!t) return null;
      const i = info || {};
      const rec = Object.assign({}, t, {
        lastDirection: i.direction || t.lastDirection, lastPreview: i.preview != null ? String(i.preview).slice(0, 140) : t.lastPreview,
        lastMessageAt: maxISO(t.lastMessageAt, i.at || nowISO()),
        inboundRefs: i.inboundRef ? (t.inboundRefs || []).concat([i.inboundRef]) : (t.inboundRefs || []),
        unread: (t.unread || 0) + (i.unreadInc || 0), updatedAt: nowISO()
      });
      await put(THREADS, rec); return rec;
    },
    async _setThreadStatus(id, status, opts) {
      const t = await this.thread(id); if (!t) return { ok: false, error: 'NOT_FOUND' };
      const rec = Object.assign({}, t, { status: status, history: (t.history || []).concat([evt(status, { by: (opts || {}).actor || null })]), updatedAt: nowISO() });
      await put(THREADS, rec); return { ok: true, thread: rec };
    },
    async _lastOutboundTo(channel, peer) {
      if (!tx()) return null;
      const key = peerKey(channel, peer);
      return (await tx().list()).filter((m) => peerKey(m.channel, m.to) === key).sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')))[0] || null;
    },
    async _notify(kind, info) {
      const id = newId('cnotif');
      const rec = Object.assign({ id: id, workspaceId: ws(), kind: kind, read: false, createdAt: nowISO() }, info || {});
      await put(NOTIF, rec);
      if (events()) events().emit('comm.notification', { id: id, kind: kind });
      return rec;
    }
  };

  // ---- helpers ----
  function biz() { return (cfg().businessName) || 'AAA Carpet'; }
  function rendered(templateId, name) { if (!templates() || !templates().has(templateId)) return null; const r = templates().render(templateId, { customerName: name, reviewUrl: cfg().reviewUrl || null }); return r && r.ok ? r.body : null; }
  function group(list, keyFn) { const out = {}; (list || []).forEach((m) => { const k = keyFn(m) || 'other'; out[k] = (out[k] || 0) + 1; }); return out; }
  function maxISO(a, b) { if (!a) return b || null; if (!b) return a; return String(a).localeCompare(String(b)) >= 0 ? a : b; }
  async function put(c, rec) {
    await data().put(c, rec.id, rec);
    try { if (data().cloudReady && data().cloudReady() && global.AAA_CLOUD) global.AAA_CLOUD.upsertEntity(c, rec.id, rec); } catch (_) {}
  }

  global.AAA_TRANSPORT_CORE = Core;
})(typeof window !== 'undefined' ? window : this);
