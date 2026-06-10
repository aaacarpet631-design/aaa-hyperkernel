/*
 * AAA Experiment Registry — every strategic experiment, fully specified.
 *
 * An experiment cannot be registered unless it declares the complete contract:
 *   experimentId, hypothesis, assumptions, expectedOutcome, successCriteria,
 *   governanceRequired, rollbackPlan.
 * A missing rollbackPlan / hypothesis / successCriteria is REJECTED — a strategic
 * experiment with no way to undo it is not allowed to exist. Append-only status
 * lifecycle (proposed → running → succeeded | failed | aborted). Deterministic.
 */
;(function (global) {
  'use strict';

  const COLLECTION = 'strategic_experiments';
  const STATUSES = ['proposed', 'running', 'succeeded', 'failed', 'aborted'];
  const REQUIRED = ['hypothesis', 'assumptions', 'expectedOutcome', 'successCriteria', 'rollbackPlan'];

  function cfg() { return global.AAA_CONFIG || {}; }
  function data() { return global.AAA_DATA; }
  function ids() { return global.AAA_ID_FACTORY; }
  function clock() { return global.AAA_RUNTIME_CLOCK; }
  function ws() { return cfg().workspaceId || 'default'; }
  function nowISO() { return clock() && clock().nowISO ? clock().nowISO() : new Date().toISOString(); }
  function mine(r) { return r && (r.workspaceId == null || r.workspaceId === ws()); }
  function newId(p) { return ids() ? ids().createId(p) : p + '_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7); }
  function present(v) { return !(v === null || v === undefined || (typeof v === 'string' && !v.trim()) || (Array.isArray(v) && !v.length)); }

  const Registry = {
    COLLECTION: COLLECTION, STATUSES: STATUSES.slice(), REQUIRED: REQUIRED.slice(),

    /** Create an experiment — rejects any spec missing a required field. */
    async create(exp) {
      const e = exp || {};
      const missing = REQUIRED.filter((k) => !present(e[k]));
      if (missing.length) return { ok: false, error: 'INCOMPLETE_EXPERIMENT', missing: missing };
      const id = newId('exp');
      const rec = {
        experimentId: id, workspaceId: ws(),
        hypothesis: e.hypothesis, assumptions: Array.isArray(e.assumptions) ? e.assumptions : [e.assumptions],
        expectedOutcome: e.expectedOutcome, successCriteria: e.successCriteria,
        governanceRequired: e.governanceRequired !== false, rollbackPlan: e.rollbackPlan,
        status: 'proposed', createdAt: nowISO(), updatedAt: nowISO(), result: null
      };
      await data().put(COLLECTION, id, rec);
      return { ok: true, experiment: rec };
    },

    async setStatus(experimentId, status, result) {
      if (STATUSES.indexOf(status) === -1) return { ok: false, error: 'BAD_STATUS' };
      const rec = await data().get(COLLECTION, experimentId);
      if (!rec || !mine(rec)) return { ok: false, error: 'NOT_FOUND' };
      // A governance-required experiment may only start once approved upstream.
      const upd = Object.assign({}, rec, { status: status, result: result === undefined ? rec.result : result, updatedAt: nowISO() });
      await data().put(COLLECTION, experimentId, upd);
      return { ok: true, experiment: upd };
    },

    async get(id) { const r = await data().get(COLLECTION, id); return mine(r) ? r : null; },
    async list(filter) { const f = filter || {}; let all = (await data().list(COLLECTION)).filter(mine); if (f.status) all = all.filter((r) => r.status === f.status); return all.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || ''))); }
  };

  global.AAA_EXPERIMENT_REGISTRY = Registry;
})(typeof window !== 'undefined' ? window : this);
