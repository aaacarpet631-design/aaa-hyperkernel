/*
 * AAA Opportunity Registry — append-only ledger of discovered ventures.
 *
 * Every opportunity the Innovation Council discovers is recorded here and moves
 * through a status lifecycle (discovered → simulating → validated | rejected).
 * History is append-only via a status-event log; the opportunity's current
 * status is a projection, so the discovery trail is never rewritten. Read/write
 * only its own collections. Deterministic.
 */
;(function (global) {
  'use strict';

  const OPP = 'innovation_opportunities';
  const EVT = 'innovation_opportunity_events';

  function cfg() { return global.AAA_CONFIG || {}; }
  function data() { return global.AAA_DATA; }
  function ids() { return global.AAA_ID_FACTORY; }
  function clock() { return global.AAA_RUNTIME_CLOCK; }
  function ws() { return cfg().workspaceId || 'default'; }
  function nowISO() { return clock() && clock().nowISO ? clock().nowISO() : new Date().toISOString(); }
  function mine(r) { return r && (r.workspaceId == null || r.workspaceId === ws()); }
  function newId(p) { return ids() ? ids().createId(p) : p + '_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7); }
  const STATUSES = ['discovered', 'simulating', 'validated', 'rejected'];

  const Registry = {
    OPP: OPP, STATUSES: STATUSES.slice(),

    async register(opp) {
      const o = opp || {};
      const id = newId('opp');
      const rec = { id: id, workspaceId: ws(), opportunity: o.opportunity || 'unnamed', expectedMargin: o.expectedMargin == null ? null : o.expectedMargin, confidence: o.confidence == null ? null : o.confidence, evidence: o.evidence || null, status: 'discovered', simRunId: o.simRunId || null, createdAt: nowISO(), updatedAt: nowISO() };
      await data().put(OPP, id, rec);
      await data().put(EVT, newId('oppe'), { id: newId('oppe'), workspaceId: ws(), opportunityId: id, status: 'discovered', at: nowISO() });
      return rec;
    },

    /** Transition status (append-only event + projected current state). */
    async setStatus(id, status, meta) {
      if (STATUSES.indexOf(status) === -1) return { ok: false, error: 'BAD_STATUS' };
      const rec = await data().get(OPP, id);
      if (!rec || !mine(rec)) return { ok: false, error: 'NOT_FOUND' };
      const eid = newId('oppe');
      await data().put(EVT, eid, { id: eid, workspaceId: ws(), opportunityId: id, status: status, meta: meta || null, at: nowISO() });
      const upd = Object.assign({}, rec, { status: status, simRunId: (meta && meta.simRunId) || rec.simRunId, updatedAt: nowISO() });
      await data().put(OPP, id, upd);
      return { ok: true, opportunity: upd };
    },

    async get(id) { const r = await data().get(OPP, id); return mine(r) ? r : null; },
    async history(id) { return (await data().list(EVT)).filter(mine).filter((e) => e.opportunityId === id).sort((a, b) => String(a.at).localeCompare(String(b.at))); },
    async list(filter) { const f = filter || {}; let all = (await data().list(OPP)).filter(mine); if (f.status) all = all.filter((r) => r.status === f.status); return all.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || ''))); }
  };

  global.AAA_OPPORTUNITY_REGISTRY = Registry;
})(typeof window !== 'undefined' ? window : this);
