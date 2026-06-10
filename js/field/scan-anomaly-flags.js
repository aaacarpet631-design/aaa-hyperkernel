/*
 * AAA Scan Anomaly Flags — the hidden variables a 20-year carpet veteran sees
 * that an average estimator misses.
 *
 * A catalog of the field anomalies that turn a profitable job into a callback,
 * warranty dispute, or failed install — with moisture intrusion FIRST, because
 * it most often causes exactly that. Each anomaly carries a deterministic labor
 * modifier and whether it requires a customer waiver / manager review.
 *
 * IMPORTANT — honest by construction: anomalies are CAPTURED inputs (a tech tap
 * today; a vision/thermal model later), never fabricated detections here. This
 * module only normalizes and scores what was reported. It records a
 * `laborModifier` for the Installation Twin to consume after review — it does
 * NOT apply labor to a price, generate a waiver, or mutate a quote. Pure.
 */
;(function (global) {
  'use strict';

  function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }
  // Normalize many severity vocabularies to low|medium|high.
  function sev(s) {
    const v = String(s == null ? 'medium' : s).toLowerCase();
    if (['light', 'low', 'minor'].indexOf(v) !== -1) return 'low';
    if (['heavy', 'extreme', 'high', 'severe'].indexOf(v) !== -1) return 'high';
    return 'medium';
  }

  // type → { label, labor: {low,medium,high} multiplier, waiverAt:[severities], managerAt:[severities], subtractsArea }
  const CATALOG = {
    moisture_intrusion: { label: 'Subfloor moisture intrusion', labor: { low: 1.2, medium: 1.5, high: 1.8 }, waiverAt: ['medium', 'high'], managerAt: ['high'], action: 'inspect_subfloor', subtractsArea: false },
    furniture_complexity: { label: 'Furniture complexity', labor: { low: 1.1, medium: 1.3, high: 1.6 }, waiverAt: [], managerAt: [], action: 'plan_furniture_moves' },
    stair_complexity: { label: 'Stair complexity', labor: { low: 1.2, medium: 1.5, high: 2.0 }, waiverAt: [], managerAt: ['high'], action: 'confirm_stair_pricing' },
    pattern_seam_risk: { label: 'Pattern / high-visibility seam risk', labor: { low: 1.15, medium: 1.35, high: 1.7 }, waiverAt: [], managerAt: ['high'], action: 'plan_seam_placement' },
    subfloor_integrity: { label: 'Subfloor integrity (rot/delamination)', labor: { low: 1.3, medium: 1.7, high: 2.2 }, waiverAt: ['low', 'medium', 'high'], managerAt: ['medium', 'high'], action: 'subfloor_remediation' },
    pet_urine_saturation: { label: 'Pet urine saturation', labor: { low: 1.2, medium: 1.5, high: 1.9 }, waiverAt: ['medium', 'high'], managerAt: ['high'], action: 'seal_and_treat_subfloor' },
    transition_complexity: { label: 'Transition complexity', labor: { low: 1.05, medium: 1.15, high: 1.3 }, waiverAt: [], managerAt: [], action: 'spec_transitions' },
    door_clearance_risk: { label: 'Door clearance risk', labor: { low: 1.05, medium: 1.1, high: 1.2 }, waiverAt: [], managerAt: [], action: 'check_door_undercut' },
    baseboard_damage_risk: { label: 'Baseboard damage risk', labor: { low: 1.05, medium: 1.1, high: 1.2 }, waiverAt: [], managerAt: [], action: 'protect_baseboards' },
    appliance_move_risk: { label: 'Appliance move risk', labor: { low: 1.1, medium: 1.25, high: 1.5 }, waiverAt: ['high'], managerAt: ['high'], action: 'plan_appliance_disconnect' }
  };

  const Flags = {
    TYPES: Object.keys(CATALOG),
    catalog: function () { return CATALOG; },

    /** Normalize reported anomalies → [{ type, label, severity, laborModifier, waiverRequired, managerReview, action }]. */
    classify(rawAnomalies) {
      const out = [];
      (Array.isArray(rawAnomalies) ? rawAnomalies : []).forEach(function (a) {
        const type = a && a.type;
        const spec = CATALOG[type];
        if (!spec) return; // unknown anomaly types are ignored, never invented
        const s = sev(a.severity);
        out.push({
          type: type, label: spec.label, severity: s,
          laborModifier: spec.labor[s],
          waiverRequired: spec.waiverAt.indexOf(s) !== -1,
          managerReview: spec.managerAt.indexOf(s) !== -1,
          recommendedAction: spec.action,
          affectedArea: a.affectedArea || null, estimatedSqFt: a.estimatedSqFt != null ? a.estimatedSqFt : null,
          confidence: a.confidence != null ? clamp(Number(a.confidence) || 0, 0, 1) : null, source: a.source || 'manual_tap'
        });
      });
      return out;
    },

    /** Aggregate effect across anomalies: compound labor, waiver/manager flags, max severity. */
    summary(anomalies) {
      const list = Array.isArray(anomalies) ? anomalies : [];
      if (!list.length) return { count: 0, compoundLaborModifier: 1, waiverRequired: false, managerReview: false, maxSeverity: 'none', recommendedActions: [] };
      let compound = 1, waiver = false, manager = false, maxSev = 'low';
      const rank = { low: 1, medium: 2, high: 3 };
      const actions = {};
      list.forEach(function (a) { compound *= (a.laborModifier || 1); if (a.waiverRequired) waiver = true; if (a.managerReview) manager = true; if (rank[a.severity] > rank[maxSev]) maxSev = a.severity; if (a.recommendedAction) actions[a.recommendedAction] = true; });
      return { count: list.length, compoundLaborModifier: Math.round(compound * 1000) / 1000, waiverRequired: waiver, managerReview: manager, maxSeverity: maxSev, recommendedActions: Object.keys(actions) };
    }
  };

  global.AAA_SCAN_ANOMALY_FLAGS = Flags;
})(typeof window !== 'undefined' ? window : this);
