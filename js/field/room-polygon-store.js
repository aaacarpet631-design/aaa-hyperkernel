/*
 * AAA Room Polygon Store — append-only ledger of scanned room polygons.
 *
 * A polygon is a capture-truth record (it can drive material + labor), so its
 * history is immutable: each scan is a new, deep-frozen record; the current
 * polygon for a room is the latest. It is an OVERLAY on the capture session —
 * it never overwrites the room's manual/laser length×width; those remain the
 * fallback. Workspace-scoped; deterministic ids.
 */
;(function (global) {
  'use strict';

  const COLLECTION = 'room_polygons';

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

    async record(polygon) {
      const id = (polygon && polygon.polygonId) || newId('poly');
      const rec = deepFreeze(Object.assign({}, polygon, { polygonId: id, workspaceId: ws(), recordedAt: nowISO() }));
      await data().put(COLLECTION, id, rec);
      return rec;
    },

    async get(id) { const r = await data().get(COLLECTION, id); return mine(r) ? r : null; },

    async list(filter) {
      const f = filter || {};
      let all = (await data().list(COLLECTION)).filter(mine);
      if (f.sessionId) all = all.filter(function (p) { return p.sessionId === f.sessionId; });
      if (f.roomId) all = all.filter(function (p) { return p.roomId === f.roomId; });
      return all.sort(function (a, b) { return String(b.recordedAt || '').localeCompare(String(a.recordedAt || '')); });
    },

    async latestForRoom(sessionId, roomId) { return (await this.list({ sessionId: sessionId, roomId: roomId }))[0] || null; }
  };

  global.AAA_ROOM_POLYGON_STORE = Store;
})(typeof window !== 'undefined' ? window : this);
