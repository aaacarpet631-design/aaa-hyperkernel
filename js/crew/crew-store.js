/*
 * AAA Crew Store — employees / contractors + job assignments + productivity.
 *
 * Local-first (same contract as customer-store): every record persists to
 * AAA_DATA → localStorage and mirrors to the cloud when configured. Workspace-
 * isolated. Productivity metrics are derived from REAL job data (jobs assigned,
 * jobs completed, outcomes), never fabricated.
 */
;(function (global) {
  'use strict';

  const MEMBERS = 'crew_members';

  function data() { return global.AAA_DATA; }
  function cfg() { return global.AAA_CONFIG || {}; }
  function ids() { return global.AAA_ID_FACTORY; }
  function clock() { return global.AAA_RUNTIME_CLOCK; }
  function ws() { return cfg().workspaceId || 'default'; }
  function nowISO() { return clock() && clock().nowISO ? clock().nowISO() : new Date().toISOString(); }
  function mine(r) { return r && !r.deleted && (r.workspaceId == null || r.workspaceId === ws()); }

  /**
   * @typedef {Object} CrewMember
   * @property {string} id
   * @property {string} name
   * @property {'employee'|'contractor'} kind
   * @property {string} role            free-text (installer, helper, stretcher…)
   * @property {string|null} phone
   * @property {boolean} active
   * @property {string} workspaceId
   * @property {string} createdAt
   * @property {string} updatedAt
   */

  const Store = {
    COLLECTION: MEMBERS,

    async list() { return (await data().list(MEMBERS)).filter(mine).sort((a, b) => String(a.name).localeCompare(String(b.name))); },
    async get(id) { const r = await data().get(MEMBERS, id); return mine(r) ? r : null; },

    async add(input) {
      const i = input || {};
      const rec = {
        id: i.id || (ids() ? ids().createId('crew') : 'crew_' + Date.now()),
        name: String(i.name || 'Unnamed'),
        kind: i.kind === 'contractor' ? 'contractor' : 'employee',
        role: String(i.role || ''),
        phone: i.phone ? String(i.phone) : null,
        active: i.active !== false,
        workspaceId: ws(),
        createdAt: i.createdAt || nowISO(),
        updatedAt: nowISO()
      };
      await data().put(MEMBERS, rec.id, rec);
      mirror(rec);
      return rec;
    },

    async update(id, patch) {
      const r = await this.get(id);
      if (!r) return { ok: false, error: 'NOT_FOUND' };
      const rec = Object.assign({}, r, patch || {}, { updatedAt: nowISO() });
      await data().put(MEMBERS, id, rec);
      mirror(rec);
      return { ok: true, member: rec };
    },

    async remove(id) {
      const r = await this.get(id);
      if (!r) return { ok: false };
      await data().put(MEMBERS, id, Object.assign({}, r, { deleted: true, updatedAt: nowISO() }));
      return { ok: true };
    },

    /**
     * Productivity from real job data. A job is "assigned" to a member when its
     * assigneeIds includes the member id; "completed" when the job is CLOSED.
     */
    async productivity() {
      const members = await this.list();
      const jobs = await data().listJobs();
      const byId = {};
      members.forEach((m) => { byId[m.id] = { id: m.id, name: m.name, assigned: 0, completed: 0 }; });
      jobs.forEach((j) => {
        const assignees = Array.isArray(j.assigneeIds) ? j.assigneeIds : [];
        assignees.forEach((aid) => {
          if (!byId[aid]) return;
          byId[aid].assigned++;
          if (j.currentState === 'CLOSED' || j.currentState === 'COMPLETED') byId[aid].completed++;
        });
      });
      return Object.values(byId).map((p) => ({
        id: p.id, name: p.name, assigned: p.assigned, completed: p.completed,
        completionRate: p.assigned ? Math.round((p.completed / p.assigned) * 100) : null
      }));
    }
  };

  function mirror(rec) {
    try {
      if (data().cloudReady && data().cloudReady() && global.AAA_CLOUD) {
        global.AAA_CLOUD.upsertEntity(MEMBERS, rec.id, rec);
      }
    } catch (_) {}
  }

  global.AAA_CREW_STORE = Store;
})(typeof window !== 'undefined' ? window : this);
