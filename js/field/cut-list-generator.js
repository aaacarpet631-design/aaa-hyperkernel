/*
 * AAA Cut List Generator — Passes 2 & 3: roll-width boxing + fill harvesting.
 *
 * Lays each captured room onto the conceptual 12-ft roll (constraint engine
 * boxes it, never rotating), tracking the running roll position so every cut
 * carries sourceRollStartFt/EndFt. Wide rooms (> 12 ft) need a fill strip:
 * Pass 3 tries to HARVEST that fill from a leftover strip already produced by a
 * narrower room's drop — but only when the nap matches (it always does — we
 * never rotate), the dimensions fit, and the strip is above the minimum
 * practical width. A harvested fill consumes no fresh roll (waste ↓); an
 * un-harvestable fill orders fresh roll at the same nap.
 *
 * Pure + deterministic (rooms processed largest-first for stable packing).
 */
;(function (global) {
  'use strict';

  function engine() { return global.AAA_LAYOUT_CONSTRAINT_ENGINE; }
  function ids() { return global.AAA_ID_FACTORY; }
  function newId(p) { return ids() ? ids().createId(p) : p + '_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6); }
  function round(n) { return Math.round(n * 100) / 100; }

  const Generator = {
    /**
     * @param rooms  measurement sessions (roomName, length, width, ...)
     * @param nap    'LENGTHWISE'|'WIDTHWISE'|'UNKNOWN'
     * @returns { ok, cuts[], totalLinearFeetOrdered, usedSquareFeet, harvested, unboxable[] }
     */
    generate(rooms, nap) {
      const E = engine();
      if (!E) return { ok: false, error: 'CONSTRAINT_ENGINE_UNAVAILABLE' };
      const list = Array.isArray(rooms) ? rooms.slice() : [];
      // Largest area first → bigger drops produce the leftover strips fills harvest from.
      const boxed = list.map(function (r) { return { room: r, box: E.boxRoom(r, nap) }; });
      const unboxable = boxed.filter(function (b) { return !b.box; }).map(function (b) { return (b.room && b.room.roomName) || 'room'; });
      const usable = boxed.filter(function (b) { return b.box; }).sort(function (a, b) { return b.box.area - a.box.area; });

      const cuts = [];
      const leftovers = [];           // { widthFt, lengthFt, fromCutId }
      const pendingFills = [];        // { cut, need } — resolved after all drops exist
      let rollPos = 0;                // running linear feet ordered (fresh roll)
      let used = 0;
      let harvested = 0;

      // Phase A — lay every main drop, collect leftovers + fill needs.
      usable.forEach(function (entry) {
        const room = entry.room; const box = entry.box;
        const label = room.roomName || 'Room';
        used += box.area;
        const startFt = round(rollPos);
        rollPos += box.main.lengthFt;
        const cut = {
          cutId: newId('cut'), label: label,
          dimensions: box.main.widthFt + 'ft × ' + box.main.lengthFt + 'ft',
          widthFt: box.main.widthFt, lengthFt: box.main.lengthFt,
          sourceRollStartFt: startFt, sourceRollEndFt: round(rollPos),
          roomTargets: [label], subCuts: [], seamNotes: [], riskFlags: []
        };
        if (box.leftover) leftovers.push({ widthFt: box.leftover.widthFt, lengthFt: box.leftover.lengthFt, fromCutId: cut.cutId });
        if (box.fill) pendingFills.push({ cut: cut, need: box.fill });
        cuts.push(cut);
      });

      // Phase B — assign each fill to ANY compatible leftover (order-independent),
      // else order fresh roll at the SAME nap (never rotated).
      pendingFills.forEach(function (pf) {
        const need = pf.need; const cut = pf.cut;
        const idx = leftovers.findIndex(function (lo) { return E.fillFits(need, lo); });
        if (idx !== -1) {
          const lo = leftovers[idx];
          cut.subCuts.push({ kind: 'fill', widthFt: need.widthFt, lengthFt: need.lengthFt, harvestedFromCutId: lo.fromCutId, rotated: false });
          cut.seamNotes.push('Fill ' + need.widthFt + 'ft strip harvested from leftover of cut ' + lo.fromCutId + ' (nap preserved, not rotated).');
          lo.lengthFt = round(lo.lengthFt - need.lengthFt);
          if (lo.lengthFt < E.minFillWidthFt()) leftovers.splice(idx, 1);
          harvested += need.widthFt * need.lengthFt;
        } else {
          const fStart = round(rollPos);
          rollPos += need.lengthFt;
          cut.subCuts.push({ kind: 'fill', widthFt: need.widthFt, lengthFt: need.lengthFt, sourceRollStartFt: fStart, sourceRollEndFt: round(rollPos), rotated: false });
          cut.seamNotes.push('Fill ' + need.widthFt + 'ft strip ordered fresh at the same nap (room exceeds 12ft roll width).');
        }
      });

      return { ok: true, cuts: cuts, totalLinearFeetOrdered: round(rollPos), usedSquareFeet: round(used), harvestedSquareFeet: round(harvested), unboxable: unboxable };
    }
  };

  global.AAA_CUT_LIST_GENERATOR = Generator;
})(typeof window !== 'undefined' ? window : this);
