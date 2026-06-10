/*
 * AAA Layout Risk Analyzer — Pass 4: where will this layout bite us?
 *
 * Annotates each cut with riskFlags and scores overall seam risk from what the
 * capture actually contains. It is honest about its blind spots: the field
 * capture does not yet record doorways, traffic paths, or light lines, so the
 * analyzer raises `missing_threshold_data` rather than pretending a seam is
 * safe — which keeps every layout review-gated until a human confirms seam
 * placement. Detectable-from-geometry risks (narrow fill strips, extreme
 * aspect ratios, unresolved/conflicting nap) are flagged directly.
 *
 * Pure + deterministic.
 */
;(function (global) {
  'use strict';

  function engine() { return global.AAA_LAYOUT_CONSTRAINT_ENGINE; }
  function num(v) { const n = Number(v); return isFinite(n) ? n : null; }

  // risk kind → weight toward the 0..1 score
  const WEIGHTS = {
    narrow_fill_strip: 0.2,
    missing_threshold_data: 0.25,
    multi_room_nap_conflict: 0.3,
    unusual_geometry: 0.15,
    seam_through_doorway: 0.3,
    high_traffic_seam: 0.3,
    light_line_seam: 0.2
  };

  const Analyzer = {
    WEIGHTS: WEIGHTS,

    /**
     * @param cuts   from the cut-list generator (mutated: riskFlags appended)
     * @param rooms  source measurement sessions
     * @param nap    resolved nap object { direction, confidence }
     * @param opts   optional { thresholds, trafficPaths } when the data exists
     * @returns { risk (0..1), warnings:[], flagsByKind:{} }
     */
    analyze(cuts, rooms, nap, opts) {
      const o = opts || {};
      const E = engine();
      const narrowFt = E ? E.narrowFillFt() : 2.0;
      const warnings = []; const kinds = {};
      function raise(kind, cut, detail) {
        kinds[kind] = (kinds[kind] || 0) + 1;
        if (cut) cut.riskFlags.push(kind);
        if (detail) warnings.push(detail);
      }

      (cuts || []).forEach(function (cut) {
        (cut.subCuts || []).forEach(function (sc) {
          if (sc.kind === 'fill' && num(sc.widthFt) != null && sc.widthFt < narrowFt) raise('narrow_fill_strip', cut, 'Narrow ' + sc.widthFt + 'ft fill strip in ' + cut.label + ' — visible seam / lift risk.');
        });
      });

      // Geometry-based risks.
      (Array.isArray(rooms) ? rooms : []).forEach(function (r) {
        const len = num(r.length), wid = num(r.width);
        if (len != null && wid != null) { const ar = Math.max(len, wid) / Math.max(1e-6, Math.min(len, wid)); if (ar > 5) raise('unusual_geometry', null, (r.roomName || 'A room') + ' has an extreme ' + Math.round(ar) + ':1 aspect ratio — confirm shape.'); }
      });

      // Nap risks.
      const roomCount = (Array.isArray(rooms) ? rooms : []).length;
      if (nap && nap.direction === 'UNKNOWN' && roomCount > 1) raise('multi_room_nap_conflict', null, 'Nap direction unresolved across ' + roomCount + ' rooms — set a single direction before cutting.');

      // Threshold / traffic / light data is not captured yet → cannot verify seam placement.
      if (!o.thresholds && !o.trafficPaths) raise('missing_threshold_data', null, 'No doorway / traffic / light-line data captured — seam placement must be confirmed on site.');
      else {
        // When the data exists, check seams against it (callers provide zones).
        (o.seamZoneHits || []).forEach(function (hit) { if (hit.kind && WEIGHTS[hit.kind]) raise(hit.kind, null, hit.detail || ('Seam risk: ' + hit.kind)); });
      }

      let score = 0; Object.keys(kinds).forEach(function (k) { score += (WEIGHTS[k] || 0.1) * Math.min(3, kinds[k]); });
      const risk = Math.min(1, Math.round(score * 1000) / 1000);
      return { risk: risk, warnings: warnings, flagsByKind: kinds };
    }
  };

  global.AAA_LAYOUT_RISK_ANALYZER = Analyzer;
})(typeof window !== 'undefined' ? window : this);
