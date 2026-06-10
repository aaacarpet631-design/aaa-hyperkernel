/*
 * AAA Layout Plan Store — append-only ledger of layout plans.
 *
 * A layout plan is quote-impacting, so its history must be immutable: each
 * optimize() run is a new, deep-frozen record (never an in-place edit), and the
 * current plan for a session is the latest record. Workspace-scoped;
 * deterministic ids; writes only its own collection.
 */
;(function (global) {
  'use strict';

  const COLLECTION = 'layout_plans';

  function cfg() { return global.AAA_CONFIG || {}; }
  function data() { return global.AAA_DATA; }
  function ids() { return global.AAA_ID_FACTORY; }
  function clock() { return global.AAA_RUNTIME_CLOCK; }
  function ws() { return cfg().workspaceId || 'default'; }
  function nowISO() { return clock() && clock().nowISO ? clock().nowISO() : new Date().toISOString(); }
  function mine(r) { return r && (r.workspaceId == null || r.workspaceId === ws()); }
  function newId(p) { return ids() ? ids().createId(p) : p + '_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7); }
  function deepFreeze(o) { if (o && typeof o === 'object' && !Object.isFrozen(o)) { Object.keys(o).forEach(function (k) { deepFreeze(o[k]); }); Object.freeze(o); } return o; }

  const Store = {
    COLLECTION: COLLECTION,

    /** Append an immutable layout plan. Returns the frozen, stored record. */
    async record(plan) {
      const id = (plan && plan.layoutPlanId) || newId('layout');
      const rec = deepFreeze(Object.assign({}, plan, { layoutPlanId: id, workspaceId: ws(), recordedAt: nowISO() }));
      await data().put(COLLECTION, id, rec);
      return rec;
    },

    async get(id) { const r = await data().get(COLLECTION, id); return mine(r) ? r : null; },

    async list(filter) {
      const f = filter || {};
      let all = (await data().list(COLLECTION)).filter(mine);
      if (f.sessionId) all = all.filter(function (p) { return p.sessionId === f.sessionId || p.sourceCaptureSessionId === f.sessionId; });
      return all.sort(function (a, b) { return String(b.recordedAt || '').localeCompare(String(a.recordedAt || '')); });
    },

    /** The latest plan for a capture session (the current one). */
    async latestForSession(sessionId) { return (await this.list({ sessionId: sessionId }))[0] || null; }
  };

  global.AAA_LAYOUT_PLAN_STORE = Store;
})(typeof window !== 'undefined' ? window : this);
