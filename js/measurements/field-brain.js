/*
 * AAA Field Brain — turn captured rooms into the numbers that build a quote.
 *
 * Pure, deterministic calculators that AGGREGATE a set of room measurement
 * sessions into the physical quantities a carpet job needs: total square feet,
 * linear feet, stairs, the 12-ft-wide material plan (running feet incl. waste),
 * and a labor-hour estimate. It computes only from what was captured — empty
 * rooms yield zeros with status 'insufficient_data', never invented sizes. It
 * does NOT price (that stays in AAA_MEASUREMENT_QUOTE, the single source of
 * pricing truth); it produces the inputs that pricing and the tech read.
 */
;(function (global) {
  'use strict';

  function cfg() { return global.AAA_CONFIG || {}; }
  function num(v) { const n = Number(v); return isFinite(n) ? n : 0; }
  function flag(k, d) { return cfg().flag ? (function () { const v = cfg().flag(k, d); const n = Number(v); return isFinite(n) ? n : d; })() : d; }
  function r2(n) { return Math.round(n * 100) / 100; }

  const Brain = {
    /** Aggregate physical quantities across room sessions. */
    aggregate(rooms) {
      const list = Array.isArray(rooms) ? rooms : [];
      if (!list.length) return { status: 'insufficient_data', roomCount: 0, totalSquareFeet: 0, totalLinearFeet: 0, totalStairs: 0 };
      let sq = 0, lin = 0, stairs = 0;
      list.forEach(function (s) {
        const a = num(s.squareFeet) || (num(s.length) && num(s.width) ? num(s.length) * num(s.width) : 0);
        sq += a; lin += num(s.linearFeet); stairs += num(s.stairsCount);
      });
      return { status: 'derived', roomCount: list.length, totalSquareFeet: r2(sq), totalLinearFeet: r2(lin), totalStairs: stairs };
    },

    /**
     * 12-ft-wide carpet material plan. Carpet comes on a fixed-width roll and is
     * sold by the running foot, so the real order quantity is linear feet of a
     * 12-ft roll, including a waste factor for cuts/seams.
     */
    materialPlan(totalSquareFeet, opts) {
      const o = opts || {};
      const sq = num(totalSquareFeet);
      if (sq <= 0) return { status: 'insufficient_data', linearFeet12ftRoll: 0 };
      const rollWidthFt = num(o.rollWidthFt) || flag('carpetRollWidthFt', 12);
      const wasteFactor = o.wasteFactor != null ? num(o.wasteFactor) : flag('wasteFactor', 0.10);
      const withWaste = sq * (1 + wasteFactor);
      const linearFeet = withWaste / rollWidthFt;
      const out = { status: 'derived', usableSquareFeet: r2(sq), wasteFactor: wasteFactor, rollWidthFt: rollWidthFt, squareFeetWithWaste: r2(withWaste), linearFeet12ftRoll: Math.ceil(linearFeet) };
      // If the owner stocks a standard roll length, also report whole rolls.
      const rollLen = num(o.rollLengthFt) || flag('carpetRollLengthFt', 0);
      if (rollLen > 0) out.rolls = Math.ceil(linearFeet / rollLen);
      return out;
    },

    /** Labor-hour estimate (configurable productivity). Clearly an estimate. */
    laborHours(totalSquareFeet, totalStairs, opts) {
      const o = opts || {};
      const sqftPerHour = num(o.sqftPerHour) || flag('installSqftPerHour', 60);
      const minutesPerStair = num(o.minutesPerStair) || flag('minutesPerStair', 5);
      const sq = num(totalSquareFeet), st = num(totalStairs);
      if (sq <= 0 && st <= 0) return { status: 'insufficient_data', hours: null };
      const hours = (sqftPerHour > 0 ? sq / sqftPerHour : 0) + (st * minutesPerStair) / 60;
      return { status: 'estimate', hours: r2(hours), basis: { sqftPerHour: sqftPerHour, minutesPerStair: minutesPerStair } };
    },

    /**
     * Build the pricing selections for AAA_MEASUREMENT_QUOTE from captured rooms:
     * the chosen area service over all rooms, plus a stairs line when any room
     * recorded stairs. Returns [] when there is nothing to price.
     */
    serviceSelections(rooms, opts) {
      const o = opts || {};
      const list = Array.isArray(rooms) ? rooms : [];
      if (!list.length) return [];
      const service = o.service || 'carpet_install';
      const sels = [{ serviceId: service, sessions: list }];
      if (list.some(function (s) { return num(s.stairsCount) > 0; })) sels.push({ serviceId: 'stairs', sessions: list });
      return sels;
    }
  };

  global.AAA_FIELD_BRAIN = Brain;
})(typeof window !== 'undefined' ? window : this);
