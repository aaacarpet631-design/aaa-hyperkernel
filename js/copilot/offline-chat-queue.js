/*
 * AAA Offline Chat Queue — local-first messaging that survives no signal.
 *
 * When the device is offline, outbound chat messages are queued (persisted to
 * AAA_DATA) and replayed in order when connectivity returns. Online detection
 * uses navigator.onLine when available, with an explicit setOnline() override
 * for tests and for app-driven connectivity events. Deterministic; append-only
 * queue with per-item status.
 */
;(function (global) {
  'use strict';

  const COLLECTION = 'chat_outbox';

  function cfg() { return global.AAA_CONFIG || {}; }
  function data() { return global.AAA_DATA; }
  function ids() { return global.AAA_ID_FACTORY; }
  function clock() { return global.AAA_RUNTIME_CLOCK; }
  function ws() { return cfg().workspaceId || 'default'; }
  function nowISO() { return clock() && clock().nowISO ? clock().nowISO() : new Date().toISOString(); }
  function mine(r) { return r && (r.workspaceId == null || r.workspaceId === ws()); }
  function newId() { return ids() ? ids().createId('outq') : 'outq_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7); }

  let ONLINE_OVERRIDE = null; // null → use navigator; true/false → forced

  const Queue = {
    COLLECTION: COLLECTION,

    /** Force connectivity state (tests / app online/offline events). */
    setOnline(v) { ONLINE_OVERRIDE = (v === true || v === false) ? v : null; return this.isOnline(); },
    isOnline() {
      if (ONLINE_OVERRIDE !== null) return ONLINE_OVERRIDE;
      if (typeof navigator !== 'undefined' && typeof navigator.onLine === 'boolean') return navigator.onLine;
      return true;
    },

    /** Queue an outbound message for later replay. */
    async enqueue(item) {
      const id = newId();
      const rec = { id: id, workspaceId: ws(), text: String((item && item.text) || ''), opts: (item && item.opts) || {}, status: 'queued', queuedAt: nowISO() };
      await data().put(COLLECTION, id, rec);
      return rec;
    },

    async pending() {
      const all = (await data().list(COLLECTION)).filter(mine).filter(function (q) { return q.status === 'queued'; });
      return all.sort(function (a, b) { return String(a.queuedAt || '').localeCompare(String(b.queuedAt || '')); });
    },

    /**
     * Replay all queued messages in order through `handler(text, opts)`. Each is
     * marked sent only after the handler resolves. Returns the count replayed.
     * No-op (returns 0) while offline.
     */
    async replay(handler) {
      if (!this.isOnline() || typeof handler !== 'function') return { replayed: 0, offline: !this.isOnline() };
      const items = await this.pending();
      let replayed = 0;
      for (const it of items) {
        try { await handler(it.text, it.opts); await data().put(COLLECTION, it.id, Object.assign({}, it, { status: 'sent', sentAt: nowISO() })); replayed++; }
        catch (_) { /* leave queued for the next replay */ }
      }
      return { replayed: replayed, offline: false };
    }
  };

  global.AAA_OFFLINE_CHAT_QUEUE = Queue;
})(typeof window !== 'undefined' ? window : this);
