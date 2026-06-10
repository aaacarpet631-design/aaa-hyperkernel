/*
 * AAA Teleological Schema — the structure for goal-directed optimization.
 *
 * The kernel's native realization of the HyperKernel 2.5 vectors (the reference
 * Zod/TS design, on this zero-dependency IIFE substrate). A SystemStateVector
 * is six normalized dimensions of enterprise health; an OperationalGoal is a
 * target vector + strategic weights + un-bypassable boundaries + an expiry.
 *
 *   SystemStateVector: grossMargin, reviewVelocity, crewUtilization,
 *                      materialYield, customerSentiment, riskExposure
 *
 * Validators are deterministic (the "Zod" of the kernel); an invalid goal is
 * rejected, never optimized toward.
 */
;(function (global) {
  'use strict';

  // dimension → { min, max } (reviewVelocity is an unbounded count → max:null)
  const DIMS = {
    grossMargin: { min: 0, max: 1 },
    reviewVelocity: { min: 0, max: null },
    crewUtilization: { min: 0, max: 1 },
    materialYield: { min: 0, max: 1 },
    customerSentiment: { min: 0, max: 1 },
    riskExposure: { min: 0, max: 1 }
  };
  const DIM_KEYS = Object.keys(DIMS);
  const BOUNDARY_KEYS = ['minimumAcceptableMargin', 'maxOvertimeHoursPerCrew', 'maxAllowedRisk'];

  function isNum(v) { return typeof v === 'number' && isFinite(v); }

  const Schema = {
    DIMS: DIM_KEYS.slice(),
    BOUNDARY_KEYS: BOUNDARY_KEYS.slice(),

    /** Validate a SystemStateVector. → { ok } | { ok:false, issues:[] }. */
    validateVector(v) {
      const issues = [];
      const o = v || {};
      DIM_KEYS.forEach((k) => {
        if (!isNum(o[k])) { issues.push('missing/NaN dimension: ' + k); return; }
        const d = DIMS[k];
        if (o[k] < d.min) issues.push(k + ' < ' + d.min);
        if (d.max != null && o[k] > d.max) issues.push(k + ' > ' + d.max);
      });
      return { ok: issues.length === 0, issues: issues };
    },

    /** Validate an OperationalGoal (targetVector + weights + boundaries + expiry). */
    validateGoal(g) {
      const issues = [];
      const o = g || {};
      const tv = this.validateVector(o.targetVector);
      if (!tv.ok) tv.issues.forEach((i) => issues.push('targetVector: ' + i));
      const w = o.weights || {};
      DIM_KEYS.forEach((k) => { if (!isNum(w[k]) || w[k] < 0 || w[k] > 1) issues.push('weight ' + k + ' must be 0..1'); });
      const b = o.boundaries || {};
      BOUNDARY_KEYS.forEach((k) => { if (!isNum(b[k])) issues.push('boundary ' + k + ' required'); });
      return { ok: issues.length === 0, issues: issues };
    },

    /** Equal-weight default for callers that just want distance. */
    defaultWeights() { const w = {}; DIM_KEYS.forEach((k) => { w[k] = 1 / DIM_KEYS.length; }); return w; }
  };

  global.AAA_TELEOLOGICAL_SCHEMA = Schema;
})(typeof window !== 'undefined' ? window : this);
