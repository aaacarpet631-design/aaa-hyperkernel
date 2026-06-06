/*
 * AAA Provenance Store — the append-only ledger of WHY a recommendation exists.
 *
 * Every advisory artifact the system surfaces to a human (a pricing
 * recommendation, a council decision, a prediction closure, an estimate) can be
 * traced back to its origin: the source quotes it read, the outcomes it learned
 * from, the predictions and closures in its history, and the governed versions
 * (calibration / prompt / model) that were in force when it was produced.
 *
 * This module is ONLY storage. It records an immutable provenance snapshot and
 * reads it back. It mutates no quote, price, margin, prediction, or customer
 * record — exactly like the closure ledger. Records are append-only: a new
 * trace is a new document (its own id); an existing trace is never rewritten,
 * so "what did the system know at the time?" is always answerable.
 *
 * Owner-only: the collection is financial (it exposes margins / win rates),
 * enforced server-side by the Firestore rules. Null-tolerant throughout.
 */
;(function (global) {
  'use strict';

  const COLLECTION = 'provenance';

  function cfg() { return global.AAA_CONFIG || {}; }
  function data() { return global.AAA_DATA; }
  function ids() { return global.AAA_ID_FACTORY; }
  function clock() { return global.AAA_RUNTIME_CLOCK; }
  function ws() { return cfg().workspaceId || 'default'; }
  function nowISO() { return clock() && clock().nowISO ? clock().nowISO() : new Date().toISOString(); }
  function mine(r) { return r && (r.workspaceId == null || r.workspaceId === ws()); }
  function byNewest(a, b) { return String(b.createdAt || '').localeCompare(String(a.createdAt || '')); }

  const Store = {
    COLLECTION: COLLECTION,

    /**
     * Append an immutable provenance trace. Returns the stored record (with id).
     * Never overwrites an existing trace — each call writes a new document.
     * @param {Object} graph  a built provenance graph (see provenance-builder)
     */
    async record(graph) {
      const g = graph || {};
      const id = ids() ? ids().createId('prov') : 'prov_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
      const rec = Object.assign({}, g, {
        id: id,
        workspaceId: ws(),
        subjectType: g.subjectType || 'unknown',
        subjectId: g.subjectId != null ? g.subjectId : null,
        createdAt: nowISO()
      });
      await put(rec);
      return rec;
    },

    async get(id) { const r = await data().get(COLLECTION, id); return mine(r) ? r : null; },

    /** Every trace in this workspace, newest first. */
    async list() { return (await data().list(COLLECTION)).filter(mine).sort(byNewest); },

    /** All traces for one subject (newest first). */
    async forSubject(subjectType, subjectId) {
      return (await this.list()).filter((r) => r.subjectType === subjectType && String(r.subjectId) === String(subjectId));
    },

    /** The most recent trace for a subject, or null. */
    async latestFor(subjectType, subjectId) {
      const all = await this.forSubject(subjectType, subjectId);
      return all.length ? all[0] : null;
    }
  };

  async function put(rec) {
    await data().put(COLLECTION, rec.id, rec);
    try { if (data().cloudReady && data().cloudReady() && global.AAA_CLOUD) global.AAA_CLOUD.upsertEntity(COLLECTION, rec.id, rec); } catch (_) {}
  }

  global.AAA_PROVENANCE = Store;
})(typeof window !== 'undefined' ? window : this);
