/*
 * AAA Tool Store — equipment tracking with check-out / check-in.
 *
 * Tracks the real gear a flooring crew loses and breaks: Crain knee kickers,
 * Duo-Fast staplers, power stretchers, seam irons, rollers, and any specialty
 * equipment. Each tool has a status (available / checked_out / maintenance /
 * damaged), a check-out history, and optional maintenance records. Local-first,
 * workspace-isolated, cloud-mirrored — same contract as the other stores.
 */
;(function (global) {
  'use strict';

  const TOOLS = 'tools';

  function data() { return global.AAA_DATA; }
  function cfg() { return global.AAA_CONFIG || {}; }
  function ids() { return global.AAA_ID_FACTORY; }
  function clock() { return global.AAA_RUNTIME_CLOCK; }
  function ws() { return cfg().workspaceId || 'default'; }
  function nowISO() { return clock() && clock().nowISO ? clock().nowISO() : new Date().toISOString(); }
  function mine(r) { return r && !r.deleted && (r.workspaceId == null || r.workspaceId === ws()); }

  const STATUSES = ['available', 'checked_out', 'maintenance', 'damaged'];

  // Common carpet/flooring tools offered as quick-add presets.
  const PRESETS = ['Crain Knee Kicker', 'Duo-Fast Stapler', 'Power Stretcher', 'Seam Iron', 'Carpet Roller', 'Knee Pads', 'Carpet Trimmer', 'Stair Tool'];

  /**
   * @typedef {Object} Tool
   * @property {string} id
   * @property {string} name
   * @property {string} category
   * @property {'available'|'checked_out'|'maintenance'|'damaged'} status
   * @property {string|null} heldBy            crew member id when checked_out
   * @property {string|null} heldByName
   * @property {Array} history                 [{action, by, at, note}]
   * @property {Array} maintenance             [{at, note}]
   * @property {string} workspaceId
   */

  const Store = {
    COLLECTION: TOOLS,
    STATUSES: STATUSES,
    PRESETS: PRESETS,

    async list() { return (await data().list(TOOLS)).filter(mine).sort((a, b) => String(a.name).localeCompare(String(b.name))); },
    async get(id) { const r = await data().get(TOOLS, id); return mine(r) ? r : null; },

    async add(input) {
      const i = input || {};
      const rec = {
        id: i.id || (ids() ? ids().createId('tool') : 'tool_' + Date.now()),
        name: String(i.name || 'Tool'),
        category: String(i.category || 'General'),
        status: STATUSES.indexOf(i.status) !== -1 ? i.status : 'available',
        heldBy: null, heldByName: null,
        history: [], maintenance: [],
        workspaceId: ws(),
        createdAt: nowISO(), updatedAt: nowISO()
      };
      await data().put(TOOLS, rec.id, rec);
      mirror(rec);
      return rec;
    },

    async checkOut(id, memberId, memberName, note) {
      const t = await this.get(id);
      if (!t) return { ok: false, error: 'NOT_FOUND' };
      if (t.status === 'checked_out') return { ok: false, error: 'ALREADY_OUT', heldByName: t.heldByName };
      if (t.status === 'damaged') return { ok: false, error: 'DAMAGED' };
      return save(t, { status: 'checked_out', heldBy: memberId || null, heldByName: memberName || null },
        { action: 'check_out', by: memberName || memberId || null, at: nowISO(), note: note || null });
    },

    async checkIn(id, note, opts) {
      const t = await this.get(id);
      if (!t) return { ok: false, error: 'NOT_FOUND' };
      const o = opts || {};
      const status = o.damaged ? 'damaged' : 'available';
      return save(t, { status: status, heldBy: null, heldByName: null },
        { action: o.damaged ? 'check_in_damaged' : 'check_in', by: t.heldByName, at: nowISO(), note: note || null });
    },

    async setMaintenance(id, on, note) {
      const t = await this.get(id);
      if (!t) return { ok: false, error: 'NOT_FOUND' };
      const rec = Object.assign({}, t, {
        status: on ? 'maintenance' : 'available',
        maintenance: t.maintenance.concat([{ at: nowISO(), note: note || (on ? 'Sent to maintenance' : 'Returned from maintenance') }]),
        updatedAt: nowISO()
      });
      await data().put(TOOLS, id, rec); mirror(rec);
      return { ok: true, tool: rec };
    },

    async remove(id) {
      const t = await this.get(id);
      if (!t) return { ok: false };
      await data().put(TOOLS, id, Object.assign({}, t, { deleted: true, updatedAt: nowISO() }));
      return { ok: true };
    },

    /** Counts by status, for the crew dashboard. */
    async summary() {
      const all = await this.list();
      const by = { available: 0, checked_out: 0, maintenance: 0, damaged: 0 };
      all.forEach((t) => { by[t.status] = (by[t.status] || 0) + 1; });
      return { total: all.length, byStatus: by };
    }
  };

  async function save(tool, patch, historyEntry) {
    const rec = Object.assign({}, tool, patch, {
      history: tool.history.concat([historyEntry]),
      updatedAt: nowISO()
    });
    await data().put(TOOLS, tool.id, rec);
    mirror(rec);
    return { ok: true, tool: rec };
  }
  function mirror(rec) {
    try { if (data().cloudReady && data().cloudReady() && global.AAA_CLOUD) global.AAA_CLOUD.upsertEntity(TOOLS, rec.id, rec); } catch (_) {}
  }

  global.AAA_TOOL_STORE = Store;
})(typeof window !== 'undefined' ? window : this);
