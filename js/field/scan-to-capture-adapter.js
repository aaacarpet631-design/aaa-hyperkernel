/*
 * AAA Scan-to-Capture Adapter — fold a scanned polygon into the SAME capture
 * truth ledger as manual entry and the Bluetooth laser. One estimating path.
 *
 * Two modes:
 *   - create a room from the polygon's bounding box (when there's no room yet)
 *   - attach to an existing room (when manual/laser already measured it)
 *
 * When attaching to an existing room it COMPARES the polygon's bounding box to
 * the room's manual/laser dimensions: if they disagree beyond tolerance it
 * records a CONFLICT, preserves BOTH (the laser/manual dims are never
 * overwritten), and marks the polygon needsReview. The full polygon is stored
 * as an overlay (room-polygon-store). It never runs the optimizer or mutates a
 * quote. Deterministic.
 */
;(function (global) {
  'use strict';

  function cfg() { return global.AAA_CONFIG || {}; }
  function capture() { return global.AAA_FIELD_CAPTURE_SESSION; }
  function polyStore() { return global.AAA_ROOM_POLYGON_STORE; }
  function num(v) { const n = Number(v); return isFinite(n) ? n : null; }
  function tol() { const v = cfg().flag ? cfg().flag('scanConflictTolFt', 0.5) : 0.5; const n = Number(v); return isFinite(n) ? n : 0.5; }

  // Compare two [a,b] dimension pairs (order-independent) → conflict + deltas.
  function compareDims(polyBbox, room) {
    const pl = num(polyBbox && polyBbox.lengthFt), pw = num(polyBbox && polyBbox.widthFt);
    const rl = num(room && room.length), rw = num(room && room.width);
    if (pl == null || pw == null || rl == null || rw == null) return { comparable: false };
    const p = [Math.min(pl, pw), Math.max(pl, pw)];
    const r = [Math.min(rl, rw), Math.max(rl, rw)];
    const dMin = Math.abs(p[0] - r[0]), dMax = Math.abs(p[1] - r[1]);
    const t = tol();
    const conflict = dMin > Math.max(t, 0.05 * r[0]) || dMax > Math.max(t, 0.05 * r[1]);
    return { comparable: true, conflict: conflict, deltaShortFt: Math.round(dMin * 100) / 100, deltaLongFt: Math.round(dMax * 100) / 100, scan: p, existing: r };
  }

  const Adapter = {
    /**
     * Attach a captured polygon to the session. opts.roomId attaches to an
     * existing room (conflict-checked, non-destructive); otherwise a room is
     * created from the polygon's bounding box.
     */
    async attach(sessionId, polygon, opts) {
      const o = opts || {};
      if (!polygon || !polygon.bbox) return { ok: false, error: 'INVALID_POLYGON' };
      if (!capture()) return { ok: false, error: 'CAPTURE_SESSION_UNAVAILABLE' };
      const sess = await capture().get(sessionId);
      if (!sess) return { ok: false, error: 'SESSION_NOT_FOUND' };

      let roomId = o.roomId || polygon.roomId || null;
      let conflict = null, needsReview = !!polygon.needsReview, created = false, preserved = null;

      if (roomId) {
        // Attach to an existing manual/laser room — never overwrite its dimensions.
        const rooms = await capture().rooms(sessionId);
        const room = rooms.filter(function (r) { return r.id === roomId; })[0];
        if (!room) return { ok: false, error: 'ROOM_NOT_FOUND' };
        const cmp = compareDims(polygon.bbox, room);
        if (cmp.comparable && cmp.conflict) {
          conflict = { kind: 'scan_vs_measured', scanDims: cmp.scan, measuredDims: cmp.existing, deltaShortFt: cmp.deltaShortFt, deltaLongFt: cmp.deltaLongFt, note: 'Scan disagrees with laser/manual measurement — both preserved for review.' };
          needsReview = true;
        }
        preserved = { length: room.length, width: room.width, source: room.source || 'manual' };
      } else {
        // No room yet → create one from the polygon bounding box.
        const added = await capture().addRoom(sessionId, { roomName: polygon.roomName || 'Scanned Room', length: polygon.bbox.lengthFt, width: polygon.bbox.widthFt, source: 'room_scan' });
        if (!added || !added.ok) return { ok: false, error: (added && added.error) || 'ADD_ROOM_FAILED' };
        roomId = added.room.id; created = true;
      }

      const stored = await polyStore().record(Object.assign({}, polygon, { sessionId: sessionId, roomId: roomId, conflicts: conflict ? [conflict] : [], needsReview: needsReview }));
      return { ok: true, polygon: stored, roomId: roomId, created: created, conflict: conflict, needsReview: needsReview, preservedMeasurement: preserved };
    },

    /** The stored polygon overlay for a room (latest), if any. */
    async polygonForRoom(sessionId, roomId) { return polyStore() ? polyStore().latestForRoom(sessionId, roomId) : null; }
  };

  global.AAA_SCAN_TO_CAPTURE_ADAPTER = Adapter;
})(typeof window !== 'undefined' ? window : this);
