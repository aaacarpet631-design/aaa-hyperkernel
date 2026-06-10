/*
 * AAA Scan Normalizer — turn a scanned room polygon into feet + real geometry.
 *
 * Pure geometry: normalize a list of perimeter points (in m / cm / mm / in / ft)
 * to feet, then compute area (shoelace), perimeter, and the axis-aligned
 * bounding box (length = longer side, width = shorter). It is honest — fewer
 * than 3 points is not a polygon → insufficient_data; it never invents vertices.
 * No I/O, deterministic.
 */
;(function (global) {
  'use strict';

  const TO_FT = { ft: 1, feet: 1, m: 3.28084, cm: 0.0328084, mm: 0.00328084, in: 1 / 12, inch: 1 / 12 };

  function num(v) { const n = Number(v); return isFinite(n) ? n : null; }
  function round(n, p) { const f = Math.pow(10, p == null ? 2 : p); return n == null ? null : Math.round(n * f) / f; }

  const Normalizer = {
    SUPPORTED_UNITS: Object.keys(TO_FT),

    /** Convert points to feet. Returns null when a point is malformed. */
    toFeet(points, units) {
      const k = TO_FT[String(units || 'ft').toLowerCase()];
      if (k == null) return null;
      const out = [];
      for (const p of (Array.isArray(points) ? points : [])) {
        const x = num(p && p.x), y = num(p && p.y);
        if (x == null || y == null) return null;
        out.push({ x: round(x * k, 3), y: round(y * k, 3) });
      }
      return out;
    },

    /** Shoelace area (absolute) for a closed polygon, in the points' units². */
    area(points) {
      const pts = Array.isArray(points) ? points : [];
      if (pts.length < 3) return null;
      let s = 0;
      for (let i = 0; i < pts.length; i++) { const a = pts[i], b = pts[(i + 1) % pts.length]; s += (a.x * b.y) - (b.x * a.y); }
      return Math.abs(s) / 2;
    },

    /** Closed-polygon perimeter. */
    perimeter(points) {
      const pts = Array.isArray(points) ? points : [];
      if (pts.length < 2) return null;
      let p = 0;
      for (let i = 0; i < pts.length; i++) { const a = pts[i], b = pts[(i + 1) % pts.length]; p += Math.sqrt(Math.pow(b.x - a.x, 2) + Math.pow(b.y - a.y, 2)); }
      return p;
    },

    /** Axis-aligned bounding box → { lengthFt (longer), widthFt (shorter) }. */
    boundingBox(points) {
      const pts = Array.isArray(points) ? points : [];
      if (!pts.length) return null;
      let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
      pts.forEach(function (p) { minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x); minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y); });
      const dx = maxX - minX, dy = maxY - minY;
      return { lengthFt: round(Math.max(dx, dy)), widthFt: round(Math.min(dx, dy)) };
    },

    /**
     * Full normalization. → { status, points(ft), areaSqFt, perimeterFt, bbox }
     * or { status:'insufficient_data' }.
     */
    normalize(points, units) {
      const ft = this.toFeet(points, units);
      if (!ft || ft.length < 3) return { status: 'insufficient_data', reason: ft ? 'need_at_least_3_points' : 'malformed_points' };
      return { status: 'normalized', points: ft, areaSqFt: round(this.area(ft)), perimeterFt: round(this.perimeter(ft)), bbox: this.boundingBox(ft) };
    }
  };

  global.AAA_SCAN_NORMALIZER = Normalizer;
})(typeof window !== 'undefined' ? window : this);
