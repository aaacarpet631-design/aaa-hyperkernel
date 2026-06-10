/*
 * AAA Intelligence Scorecard — the World Model's self-assessment.
 *
 * Aggregates eight dimensions: signal coverage, freshness, confidence, causal
 * maturity, prediction accuracy, governance compliance, graph completeness, and
 * business impact. NO FLATTERING DEFAULTS — a dimension with no real basis is
 * reported `insufficient_data` (null), and the composite is computed ONLY over
 * the dimensions that have data, with weights renormalized. If too few
 * dimensions are available, the overall status is itself insufficient_data.
 */
;(function (global) {
  'use strict';

  function quality() { return global.AAA_SIGNAL_QUALITY_SCORECARD; }
  function causal() { return global.AAA_CAUSAL_HYPOTHESIS_STORE; }
  function comparator() { return global.AAA_PREDICTION_COMPARATOR; }
  function clock() { return global.AAA_RUNTIME_CLOCK; }
  function nowMs() { return clock() && clock().now ? clock().now() : Date.now(); }
  function round(n, p) { const f = Math.pow(10, p == null ? 4 : p); return n == null ? null : Math.round(n * f) / f; }

  // dimension → weight (renormalized over those with data)
  const WEIGHTS = { coverage: 0.18, freshness: 0.18, confidence: 0.14, causalMaturity: 0.12, predictionAccuracy: 0.16, governanceCompliance: 0.10, graphCompleteness: 0.06, businessImpact: 0.06 };

  async function governanceCompliance() {
    const g = global.AAA_GOVERNANCE_ENGINE;
    if (!g || typeof g.metrics !== 'function') return null;
    try { const m = await g.metrics(); if (m && typeof m.overrideRate === 'number') return Math.max(0, 1 - m.overrideRate); } catch (_) {}
    return null;
  }
  async function graphCompleteness() {
    const gr = global.AAA_GRAPH;
    if (!gr || typeof gr.stats !== 'function' || typeof gr.insights !== 'function') return null;
    try {
      const stats = await gr.stats(); const ins = await gr.insights();
      const jobs = (stats.byType && stats.byType.job) || 0;
      if (!jobs) return null;
      const noOutcome = ins.noOutcome || 0;
      return Math.max(0, Math.min(1, 1 - noOutcome / jobs));
    } catch (_) { return null; }
  }

  const Scorecard = {
    WEIGHTS: WEIGHTS,

    /** Full intelligence assessment with honest insufficient_data dimensions. */
    async evaluate(now, opts) {
      const ref = now != null ? now : nowMs();
      const q = quality() ? await quality().score(ref, opts) : null;
      const cm = causal() ? await causal().metrics() : null;
      const acc = comparator() ? await comparator().getAverageAccuracy() : null;

      const dims = {
        coverage: q && q.status === 'operational' ? q.coverage : null,
        freshness: q && q.status === 'operational' ? q.freshness : null,
        confidence: q && q.status === 'operational' ? q.avgConfidence : null,
        causalMaturity: cm ? cm.maturity : null,                 // null when no hypotheses
        predictionAccuracy: acc,                                  // null when no deltas
        governanceCompliance: await governanceCompliance(),       // null when no governance data
        graphCompleteness: await graphCompleteness(),             // null when not derivable
        businessImpact: null                                      // not derivable yet → honest null
      };

      let wSum = 0, acc2 = 0; const components = {};
      Object.keys(WEIGHTS).forEach((k) => {
        const v = dims[k];
        if (v == null) { components[k] = { value: null, status: 'insufficient_data' }; return; }
        components[k] = { value: round(v), status: 'ok' };
        wSum += WEIGHTS[k]; acc2 += WEIGHTS[k] * v;
      });

      const available = Object.keys(components).filter((k) => components[k].status === 'ok').length;
      if (available < 2 || wSum === 0) {
        return { status: 'insufficient_data', score: null, available: available, components: components };
      }
      const score = round((acc2 / wSum) * 100, 1);
      return {
        status: 'operational',
        score: score,
        grade: score >= 90 ? 'A' : score >= 80 ? 'B' : score >= 70 ? 'C' : score >= 60 ? 'D' : 'F',
        available: available,
        components: components
      };
    }
  };

  global.AAA_INTELLIGENCE_SCORECARD = Scorecard;
})(typeof window !== 'undefined' ? window : this);
