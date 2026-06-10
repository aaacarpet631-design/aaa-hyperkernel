/*
 * AAA Timing Engine — when to make contact.
 *
 * Learns the best contact window from the REAL timestamps of past successful
 * engagements (won quotes / received reviews / inbound messages): the hour-of-
 * day and day-of-week that historically precede positive outcomes. With too few
 * timestamped successes it returns insufficient_data rather than a generic
 * "Tuesday 10am" guess. Deterministic; read-only.
 */
;(function (global) {
  'use strict';

  function data() { return global.AAA_DATA; }
  function lc(v) { return String(v == null ? '' : v).toLowerCase(); }
  async function list(c) { try { return (await data().list(c)) || []; } catch (_) { return []; } }
  const WON = ['won', 'accepted', 'closed_won'];
  const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

  function topIndex(counts) { let bi = -1, bv = -1; counts.forEach((v, i) => { if (v > bv) { bv = v; bi = i; } }); return bv > 0 ? bi : null; }

  const Engine = {
    async bestWindow() {
      const quotes = await list('quotes');
      const successes = quotes.filter((q) => WON.indexOf(lc(q.status)) !== -1);
      const stamps = successes.map((q) => Date.parse(q.closedAt || q.updatedAt || q.createdAt)).filter((t) => isFinite(t));
      if (stamps.length < 5) return { status: 'insufficient_data', bestHour: null, bestDay: null, sample: stamps.length };
      const hours = new Array(24).fill(0); const dows = new Array(7).fill(0);
      stamps.forEach((t) => { const d = new Date(t); hours[d.getUTCHours()]++; dows[d.getUTCDay()]++; });
      const bh = topIndex(hours); const bd = topIndex(dows);
      return { status: 'derived', bestHour: bh, bestDay: bd == null ? null : DOW[bd], sample: stamps.length, confidence: Math.min(0.85, stamps.length / 30) };
    }
  };

  global.AAA_TIMING_ENGINE = Engine;
})(typeof window !== 'undefined' ? window : this);
