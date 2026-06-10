/*
 * AAA Scan Confidence Engine — how much do we trust this scanned room?
 *
 * Confidence blends the source (a verified LiDAR scan beats a hand-traced
 * polygon beats a mock), the vertex count, whether the polygon closes cleanly,
 * and any device-reported confidence. Risk and needsReview also fold in the
 * captured anomalies: a HIGH-severity anomaly (or anything requiring a waiver /
 * manager review — e.g. moisture intrusion) forces needsReview regardless of
 * geometric confidence. Pure + deterministic; honest (no data → low confidence,
 * never a flattering default).
 */
;(function (global) {
  'use strict';

  function cfg() { return global.AAA_CONFIG || {}; }
  function flags() { return global.AAA_SCAN_ANOMALY_FLAGS; }
  function num(v, d) { const n = Number(v); return isFinite(n) ? n : d; }
  function reviewThreshold() { return num(cfg().flag ? cfg().flag('scanReviewConfidence', 0.7) : 0.7, 0.7); }
  function clamp01(x) { return Math.max(0, Math.min(1, x)); }

  // Base trust per capture source.
  const SOURCE_BASE = { lidar_scan: 0.85, roomplan_import: 0.8, camera_scan: 0.6, manual_polygon: 0.7, mock_scan: 0.5 };

  const Engine = {
    /**
     * @param input { source, points, closed, deviceConfidence, anomalies }
     * @returns { confidence, risk, needsReview, reasons, anomalySummary }
     */
    assess(input) {
      const i = input || {};
      const reasons = [];
      let conf = SOURCE_BASE[i.source] != null ? SOURCE_BASE[i.source] : 0.5;
      const pts = Array.isArray(i.points) ? i.points.length : 0;
      if (pts < 3) { conf = 0; reasons.push('insufficient_points'); }
      else if (pts >= 8) conf += 0.05;            // a richer polygon is more trustworthy
      if (i.closed === false) { conf -= 0.15; reasons.push('open_polygon'); }
      if (i.deviceConfidence != null) conf = (conf + clamp01(num(i.deviceConfidence, conf))) / 2;
      conf = Math.round(clamp01(conf) * 1000) / 1000;

      const anomalies = flags() ? flags().classify(i.anomalies) : [];
      const sum = flags() ? flags().summary(anomalies) : { maxSeverity: 'none', waiverRequired: false, managerReview: false };

      let needsReview = conf < reviewThreshold();
      if (needsReview) reasons.push('low_confidence');
      if (sum.maxSeverity === 'high') { needsReview = true; reasons.push('high_severity_anomaly'); }
      if (sum.waiverRequired) { needsReview = true; reasons.push('waiver_required'); }
      if (sum.managerReview) { needsReview = true; reasons.push('manager_review'); }

      // Risk band from anomaly severity + geometric confidence.
      let risk = 'low';
      if (sum.maxSeverity === 'high' || conf < 0.4) risk = 'high';
      else if (sum.maxSeverity === 'medium' || conf < reviewThreshold()) risk = 'medium';

      return { confidence: conf, risk: risk, needsReview: needsReview, reasons: reasons, anomalies: anomalies, anomalySummary: sum };
    }
  };

  global.AAA_SCAN_CONFIDENCE_ENGINE = Engine;
})(typeof window !== 'undefined' ? window : this);
