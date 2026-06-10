/*
 * AAA Layout Constraint Engine — the non-negotiable physics of carpet layout.
 *
 * Carpet is NOT square footage. It comes on a fixed 12-foot-wide roll, the nap
 * (pile direction) must stay consistent across a job, and a fill piece may NOT
 * be rotated to fake a waste saving (rotating flips the nap and shows as a light
 * mismatch). This engine encodes those rules as pure functions the rest of the
 * optimizer obeys:
 *
 *   resolveNap(rooms, opts) — global nap direction (or UNKNOWN → needsReview)
 *   boxRoom(room, nap)      — a room → a 12-ft main drop (+ fill strip if > 12 ft),
 *                             never rotated; reports the reusable leftover strip
 *   fillFits(need, leftover)— may a leftover strip supply a fill? (nap + size + min width)
 *
 * No I/O, no randomness; deterministic and honest (insufficient geometry is
 * reported, never guessed around).
 */
;(function (global) {
  'use strict';

  const ROLL_WIDTH_FT = 12;

  function cfg() { return global.AAA_CONFIG || {}; }
  function num(v) { const n = Number(v); return isFinite(n) ? n : null; }
  function flag(k, d) { const v = cfg().flag ? cfg().flag(k, d) : d; const n = Number(v); return isFinite(n) ? n : d; }
  function minFillWidthFt() { return flag('minFillWidthFt', 1.0); }     // below this, a fill strip is impractical
  function narrowFillFt() { return flag('narrowFillWarnFt', 2.0); }     // a fill this thin is a seam/visual risk

  // A room's two plan dimensions. We never invent a size; both must be present.
  function dims(room) {
    const r = room || {};
    const len = num(r.length); const wid = num(r.width); const sq = num(r.squareFeet);
    if (len != null && wid != null) return { a: len, b: wid, area: len * wid, exact: true };
    // Only a square-foot value (no shape) → not enough geometry to lay out.
    if (sq != null && sq > 0) return { a: null, b: null, area: sq, exact: false };
    return null;
  }

  const Engine = {
    ROLL_WIDTH_FT: ROLL_WIDTH_FT,
    minFillWidthFt: minFillWidthFt,
    narrowFillFt: narrowFillFt,
    dims: dims,

    /**
     * Resolve the global nap direction. A user-selected direction wins; a single
     * strongly-dominant long room is a weak hint; otherwise UNKNOWN (needsReview).
     * Returns { direction:'LENGTHWISE'|'WIDTHWISE'|'UNKNOWN', confidence, basis }.
     */
    resolveNap(rooms, opts) {
      const o = opts || {};
      if (o.napDirection === 'LENGTHWISE' || o.napDirection === 'WIDTHWISE') return { direction: o.napDirection, confidence: 0.95, basis: 'user_selected' };
      const list = (Array.isArray(rooms) ? rooms : []).map(dims).filter(function (d) { return d && d.exact; });
      if (!list.length) return { direction: 'UNKNOWN', confidence: 0, basis: 'no_geometry' };
      // Hallway hint: one long narrow room implies the nap runs down its length.
      const hall = list.find(function (d) { return Math.max(d.a, d.b) >= 3 * Math.min(d.a, d.b) && Math.min(d.a, d.b) <= ROLL_WIDTH_FT; });
      if (hall && list.length === 1) return { direction: hall.a >= hall.b ? 'LENGTHWISE' : 'WIDTHWISE', confidence: 0.5, basis: 'hallway_hint' };
      return { direction: 'UNKNOWN', confidence: 0, basis: 'unresolved_multi_room' };
    },

    /**
     * Box a room into roll-width pieces. With a known nap the orientation is
     * FIXED (no rotation): dropLength runs along the roll. With UNKNOWN nap we
     * pick the orientation that minimizes fresh fill (and the caller flags
     * needsReview). Returns { main, fill|null, leftover|null, area } in feet, or
     * null when geometry is insufficient.
     */
    boxRoom(room, nap) {
      const d = dims(room);
      if (!d || !d.exact) return null;
      let dropLen, dropWid;
      if (nap === 'LENGTHWISE') { dropLen = d.a; dropWid = d.b; }
      else if (nap === 'WIDTHWISE') { dropLen = d.b; dropWid = d.a; }
      else {
        // UNKNOWN: choose the orientation with the smaller fill area.
        const fillIfLenA = d.a > ROLL_WIDTH_FT ? (d.a - ROLL_WIDTH_FT) * d.b : 0; // roll length along b, width = a
        const fillIfLenB = d.b > ROLL_WIDTH_FT ? (d.b - ROLL_WIDTH_FT) * d.a : 0; // roll length along a, width = b
        if (fillIfLenB <= fillIfLenA) { dropLen = d.a; dropWid = d.b; } else { dropLen = d.b; dropWid = d.a; }
      }
      const mainWidth = Math.min(dropWid, ROLL_WIDTH_FT);
      const main = { widthFt: round(mainWidth), lengthFt: round(dropLen) };
      let fill = null, leftover = null;
      if (dropWid > ROLL_WIDTH_FT) {
        fill = { widthFt: round(dropWid - ROLL_WIDTH_FT), lengthFt: round(dropLen) };
      } else if (ROLL_WIDTH_FT - dropWid >= minFillWidthFt()) {
        leftover = { widthFt: round(ROLL_WIDTH_FT - dropWid), lengthFt: round(dropLen) };
      }
      return { main: main, fill: fill, leftover: leftover, area: round(d.area) };
    },

    /** Can a leftover strip supply a fill need without rotation? (nap implicit-match) */
    fillFits(need, leftover) {
      if (!need || !leftover) return false;
      return leftover.widthFt >= need.widthFt && leftover.lengthFt >= need.lengthFt && need.widthFt >= minFillWidthFt();
    }
  };

  function round(n) { return Math.round(n * 100) / 100; }

  global.AAA_LAYOUT_CONSTRAINT_ENGINE = Engine;
})(typeof window !== 'undefined' ? window : this);
