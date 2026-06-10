/*
 * AAA Chat Message Store — the conversational thread, append-only.
 *
 * Stores user and assistant messages (with their attached rich-card model) so
 * the Chat Canvas can re-render the thread and survive reloads. Each message is
 * an immutable record; status transitions (queued → sent) are new writes keyed
 * by id. Workspace-scoped; deterministic ids; persists to AAA_DATA.
 */
;(function (global) {
  'use strict';

  const COLLECTION = 'chat_messages';

  function cfg() { return global.AAA_CONFIG || {}; }
  function data() { return global.AAA_DATA; }
  function ids() { return global.AAA_ID_FACTORY; }
  function clock() { return global.AAA_RUNTIME_CLOCK; }
  function ws() { return cfg().workspaceId || 'default'; }
  function nowISO() { return clock() && clock().nowISO ? clock().nowISO() : new Date().toISOString(); }
  function mine(r) { return r && (r.workspaceId == null || r.workspaceId === ws()); }
  function newId() { return ids() ? ids().createId('msg') : 'msg_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7); }

  const Store = {
    COLLECTION: COLLECTION,

    /** Append a message. role: 'user' | 'assistant'. Returns the stored record. */
    async add(msg) {
      const m = msg || {};
      const id = m.id || newId();
      const rec = { id: id, workspaceId: ws(), threadId: m.threadId || 'default', role: m.role || 'user', text: String(m.text == null ? '' : m.text), card: m.card || null, status: m.status || 'sent', at: nowISO() };
      await data().put(COLLECTION, id, rec);
      return rec;
    },

    /** Update a stored message (e.g. queued → sent, attach a card). */
    async update(id, patch) {
      const r = await data().get(COLLECTION, id);
      if (!r || !mine(r)) return null;
      const u = Object.assign({}, r, patch || {}, { updatedAt: nowISO() });
      await data().put(COLLECTION, id, u);
      return u;
    },

    /** The thread, oldest first. */
    async thread(threadId) {
      const all = (await data().list(COLLECTION)).filter(mine).filter(function (m) { return !threadId || m.threadId === threadId; });
      return all.sort(function (a, b) { return String(a.at || '').localeCompare(String(b.at || '')); });
    }
  };

  global.AAA_CHAT_MESSAGE_STORE = Store;
})(typeof window !== 'undefined' ? window : this);
