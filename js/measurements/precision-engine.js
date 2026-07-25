/*
 * AAA Measurement Precision Engine — type what the tape says.
 *
 * The single biggest source of manual-measurement error is unit conversion in
 * a tech's head: the tape reads 12′ 6″ but the form wants 12.5. This engine
 * makes the notation the machine's problem, not the human's:
 *
 *   parseLength('12\'6"')   → 12.5 ft     (also: 12ft 6in, 12 feet 6, 150",
 *   parseLength('3.8m')     → 12.467 ft    150 in, 380cm, plain 12.5)
 *   formatFeet(12.5)        → 12′ 6″      (nearest inch, for display)
 *   roomArea(sections)      → L-shaped / cut-out rooms as add/subtract
 *                             rectangles summed into one honest ft² figure
 *   check(room, {existing}) → delegates to AAA_MEASUREMENT_MODELS
 *                             .validateSession (misfire / unrealistic /
 *                             duplicate warnings) so thresholds live in ONE
 *                             place; degrades to a minimal check when the
 *                             models module is absent.
 *
 * Pure functions only — no storage, no DOM, no clock, deterministic. Feet are
 * kept to 3 decimals (≈1/32″); areas to 2, matching the models' rounding.
 */
;(function (global) {
  'use strict';

  const FT_PER_M = 3.2808399;

  function round(n, p) { const f = Math.pow(10, p || 0); return Math.round(n * f) / f; }
  function bad(error) { return { ok: false, error: error }; }

  // Notation patterns, tried in order. All case-insensitive, whitespace-tolerant.
  const FEET_INCHES = /^(\d+(?:\.\d+)?)\s*(?:'|′|ft\.?|feet|foot)\s*(?:(\d+(?:\.\d+)?)\s*(?:"|″|in\.?|inches|inch)?)?$/i;
  const INCHES_ONLY = /^(\d+(?:\.\d+)?)\s*(?:"|″|in\.?|inches|inch)$/i;
  const METERS = /^(\d+(?:\.\d+)?)\s*m(?:\.|eters?)?$/i;
  const CENTIMETERS = /^(\d+(?:\.\d+)?)\s*cm\.?$/i;
  const PLAIN = /^(\d+(?:\.\d+)?)$/;

  const Precision = {
    /**
     * Parse one linear dimension in field notation → decimal feet.
     * Returns { ok:true, feet, unit, display } or { ok:false, error }:
     * error 'EMPTY' (nothing entered — an omission, not a mistake) or
     * 'UNPARSEABLE' (something entered that isn't a measurement).
     */
    parseLength(input) {
      if (input == null) return bad('EMPTY');
      if (typeof input === 'number') {
        if (!isFinite(input)) return bad('UNPARSEABLE');
        return { ok: true, feet: round(input, 3), unit: 'ft', display: this.formatFeet(input) };
      }
      const s = String(input).trim();
      if (!s) return bad('EMPTY');
      let m;
      if ((m = s.match(INCHES_ONLY))) {
        return { ok: true, feet: round(Number(m[1]) / 12, 3), unit: 'in', display: this.formatFeet(Number(m[1]) / 12) };
      }
      if ((m = s.match(FEET_INCHES))) {
        const feet = Number(m[1]) + (m[2] != null ? Number(m[2]) / 12 : 0);
        if (m[2] != null && Number(m[2]) >= 12) return bad('UNPARSEABLE'); // 12'14" is a misread, not a measurement
        return { ok: true, feet: round(feet, 3), unit: 'ft-in', display: this.formatFeet(feet) };
      }
      if ((m = s.match(METERS))) {
        return { ok: true, feet: round(Number(m[1]) * FT_PER_M, 3), unit: 'm', display: this.formatFeet(Number(m[1]) * FT_PER_M) };
      }
      if ((m = s.match(CENTIMETERS))) {
        return { ok: true, feet: round((Number(m[1]) / 100) * FT_PER_M, 3), unit: 'cm', display: this.formatFeet((Number(m[1]) / 100) * FT_PER_M) };
      }
      if ((m = s.match(PLAIN))) {
        return { ok: true, feet: round(Number(m[1]), 3), unit: 'ft', display: this.formatFeet(Number(m[1])) };
      }
      return bad('UNPARSEABLE');
    },

    /** Decimal feet → tape notation at the nearest inch: 12.5 → «12′ 6″». */
    formatFeet(feet) {
      const n = Number(feet);
      if (!isFinite(n) || n < 0) return null;
      let ft = Math.floor(n);
      let inches = Math.round((n - ft) * 12);
      if (inches === 12) { ft += 1; inches = 0; }
      return inches ? ft + '′ ' + inches + '″' : ft + '′';
    },

    /** Parse a whole-number count (stairs). '' → null; junk/fractions → NaN sentinel via ok:false. */
    parseCount(input) {
      if (input == null || String(input).trim() === '') return { ok: true, count: null };
      const n = Number(String(input).trim());
      if (!isFinite(n) || n < 0 || n !== Math.floor(n)) return bad('UNPARSEABLE');
      return { ok: true, count: n };
    },

    /**
     * Multi-section room area: L-shapes, alcoves, and cut-outs as rectangles.
     * sections: [{ length, width, op?: 'add'|'subtract', label? }] — length and
     * width accept anything parseLength() accepts. Returns
     * { ok, squareFeet, sections: [{label, lengthFt, widthFt, op, squareFeet}] }
     * or { ok:false, error, index } naming the offending section. Subtracting
     * below zero is refused (NEGATIVE_AREA) — a cut-out bigger than the room
     * is a misread, never a measurement.
     */
    roomArea(sections) {
      if (!Array.isArray(sections) || !sections.length) return bad('NO_SECTIONS');
      const out = [];
      let total = 0;
      for (let i = 0; i < sections.length; i++) {
        const sec = sections[i] || {};
        const L = this.parseLength(sec.length);
        const W = this.parseLength(sec.width);
        if (!L.ok || !W.ok) return { ok: false, error: 'UNPARSEABLE_SECTION', index: i };
        if (L.feet <= 0 || W.feet <= 0) return { ok: false, error: 'INVALID_SECTION', index: i };
        const op = sec.op === 'subtract' ? 'subtract' : 'add';
        const area = round(L.feet * W.feet, 2);
        total += op === 'subtract' ? -area : area;
        out.push({ label: sec.label != null ? String(sec.label).slice(0, 60) : ('Section ' + (i + 1)), lengthFt: L.feet, widthFt: W.feet, op: op, squareFeet: area });
      }
      if (total <= 0) return bad('NEGATIVE_AREA');
      return { ok: true, squareFeet: round(total, 2), sections: out };
    },

    /**
     * Field-safety check for a room about to be saved. Delegates to
     * AAA_MEASUREMENT_MODELS.validateSession so misfire/unrealistic/duplicate
     * thresholds live in one place; pass opts.existing (sessions in the same
     * capture session) to get duplicate warnings. Minimal fallback when the
     * models module is absent. Never throws.
     */
    check(room, opts) {
      const r = room || {};
      const models = global.AAA_MEASUREMENT_MODELS;
      if (models && models.validateSession) {
        const probe = Object.assign({ roomName: r.roomName || 'Room' }, r);
        // Derive ft² like the models do, so duplicate matching (which compares
        // squareFeet) sees the probe the same way it sees saved sessions.
        if (probe.squareFeet == null && probe.length != null && probe.width != null) {
          probe.squareFeet = round(probe.length * probe.width, 2);
        }
        try { return models.validateSession(probe, opts || {}); } catch (_) { /* fall through */ }
      }
      const warnings = [];
      ['length', 'width'].forEach(function (k) {
        if (r[k] != null && r[k] > 200) warnings.push(k + ' over 200 ft — double-check the reading.');
        if (r[k] != null && r[k] > 0 && r[k] < 0.5) warnings.push(k + ' under 6 in — likely a misfire.');
      });
      return { ok: true, errors: [], warnings: warnings };
    }
  };

  global.AAA_MEASUREMENT_PRECISION = Precision;
})(typeof window !== 'undefined' ? window : this);
