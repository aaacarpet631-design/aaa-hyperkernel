/*
 * AAA Measurement Parser — turn raw BLE frames into normalized feet.
 *
 * Most consumer laser measures expose their reading either as ASCII text
 * ("3.245 m", "10ft 6in", "12.5") or as a small binary frame. Brands differ,
 * so the generic parser handles the COMMON shapes and each device adapter can
 * supply its own parse() to override. Everything returns a normalized result
 * in FEET (the unit the quote engine uses), with the detected source unit and a
 * confidence score, or null when nothing parseable is present (never guesses).
 */
;(function (global) {
  'use strict';

  const M_TO_FT = 3.28083989501;
  const CM_TO_FT = 0.0328083989501;
  const MM_TO_FT = 0.00328083989501;
  const IN_TO_FT = 1 / 12;

  /**
   * @typedef {Object} ParsedReading
   * @property {number} feet            normalized to feet
   * @property {number} raw             the numeric value as sent
   * @property {string} unit            detected source unit: m|cm|mm|ft|in|unknown
   * @property {number} confidence      0..1
   * @property {string} via             'ascii' | 'binary'
   */

  const Parser = {
    M_TO_FT: M_TO_FT,

    /** Try ASCII first (most common), then a couple of binary heuristics. */
    parse(dataView) {
      if (!dataView || !dataView.byteLength) return null;
      const ascii = this._readAscii(dataView);
      const fromText = this.parseText(ascii);
      if (fromText) return Object.assign({ via: 'ascii' }, fromText);
      const fromBin = this._parseBinary(dataView);
      if (fromBin) return Object.assign({ via: 'binary' }, fromBin);
      return null;
    },

    /**
     * Parse a human/string reading into feet. Exposed for manual paste + tests.
     * Handles: "3.245 m", "324.5cm", "3245 mm", "12.5 ft", "10ft 6in",
     * "10' 6\"", and bare numbers (assumed meters — the laser default).
     * @param {string} text
     * @returns {ParsedReading|null}
     */
    parseText(text) {
      if (text == null) return null;
      const s = String(text).trim().toLowerCase().replace(/,/g, '.');
      if (!s) return null;

      // feet + inches: 10ft 6in | 10' 6" | 10 ft 6 in
      let m = s.match(/(-?\d+(?:\.\d+)?)\s*(?:'|ft|feet)\s*(\d+(?:\.\d+)?)\s*(?:"|in|inch|inches)?/);
      if (m) {
        const feet = Number(m[1]) + Number(m[2]) * IN_TO_FT;
        return ok(feet, Number(m[1]), 'ft', 0.95);
      }
      // single value + unit
      m = s.match(/(-?\d+(?:\.\d+)?)\s*(mm|cm|m|ft|feet|'|in|inch|inches|")/);
      if (m) {
        const v = Number(m[1]); const unit = m[2];
        if (unit === 'mm') return ok(v * MM_TO_FT, v, 'mm', 0.9);
        if (unit === 'cm') return ok(v * CM_TO_FT, v, 'cm', 0.9);
        if (unit === 'm') return ok(v * M_TO_FT, v, 'm', 0.9);
        if (unit === 'ft' || unit === 'feet' || unit === "'") return ok(v, v, 'ft', 0.95);
        return ok(v * IN_TO_FT, v, 'in', 0.9);   // in / inch / "
      }
      // bare number — most lasers default to meters; lower confidence, flagged.
      m = s.match(/^(-?\d+(?:\.\d+)?)$/);
      if (m) { const v = Number(m[1]); return ok(v * M_TO_FT, v, 'm', 0.5); }
      return null;
    },

    _readAscii(dv) {
      let s = '';
      try { for (let i = 0; i < dv.byteLength; i++) { const c = dv.getUint8(i); if (c) s += String.fromCharCode(c); } }
      catch (_) {}
      return s;
    },

    // Binary heuristic: many devices send a little-endian float32 or a
    // uint16/uint32 of millimeters. We try the interpretations that yield a
    // plausible room dimension (0.05–300 ft) and pick the best.
    _parseBinary(dv) {
      const candidates = [];
      try {
        if (dv.byteLength >= 4) {
          const f = dv.getFloat32(0, true);
          if (isFinite(f)) candidates.push({ feet: f * M_TO_FT, raw: f, unit: 'm', confidence: 0.4 });
          const u32 = dv.getUint32(0, true);
          candidates.push({ feet: u32 * MM_TO_FT, raw: u32, unit: 'mm', confidence: 0.35 });
        }
        if (dv.byteLength >= 2) {
          const u16 = dv.getUint16(0, true);
          candidates.push({ feet: u16 * MM_TO_FT, raw: u16, unit: 'mm', confidence: 0.35 });
        }
      } catch (_) {}
      const plausible = candidates.filter((c) => c.feet >= 0.05 && c.feet <= 300);
      if (!plausible.length) return null;
      plausible.sort((a, b) => b.confidence - a.confidence);
      return plausible[0];
    }
  };

  function ok(feet, raw, unit, confidence) {
    if (!isFinite(feet)) return null;
    return { feet: round(feet, 3), raw: raw, unit: unit, confidence: confidence };
  }
  function round(n, p) { const f = Math.pow(10, p || 0); return Math.round(n * f) / f; }

  global.AAA_MEASUREMENT_PARSER = Parser;
})(typeof window !== 'undefined' ? window : this);
