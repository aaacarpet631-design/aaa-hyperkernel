/*
 * AAA Strategy Scorecard — turns a distribution of futures into a decision.
 *
 * For one simulation it computes:
 *   upside     expected revenue gain vs baseline (and the best case)
 *   risk       downside exposure (worst-case loss + how wide the spread is)
 *   confidence how tight the outcome band is (narrow CI + adequate samples)
 *   score      upside discounted by risk, weighted by confidence
 *
 * dashboard() is the read model the directive asks for: highest upside,
 * highest risk, strongest confidence, failed assumptions, and simulation
 * accuracy over time (from the immutable actuals). Pure and read-only.
 */
;(function (global) {
  'use strict';

  function ledger() { return global.AAA_SIM_LEDGER; }
  function governance() { return global.AAA_SIM_GOVERNANCE; }
  function round(n, p) { const f = Math.pow(10, p == null ? 4 : p); return n == null ? null : Math.round(n * f) / f; }

  const Card = {
    /** Score one simulation result against its baseline. */
    score(baseline, outcomes) {
      const base = baseline.revenue || 0;
      const exp = outcomes.expected.revenue || 0;
      const worst = outcomes.worst.revenue || 0;
      const best = outcomes.best.revenue || 0;
      const ci = outcomes.ci.objective || {};
      const upside = exp - base;
      const downside = worst - base;                       // ≤ 0 is a loss
      const spread = (ci.p95 != null && ci.p05 != null) ? (ci.p95 - ci.p05) : (best - worst);
      // confidence: narrow band relative to the expected magnitude, more samples → tighter.
      const rel = exp ? Math.abs(spread / exp) : 1;
      const confidence = round(Math.max(0, Math.min(1, (1 - Math.min(1, rel)) * Math.min(1, (outcomes.samples || 0) / 1000))), 4);
      const risk = round(Math.max(0, -downside) + Math.abs(spread) * 0.25, 2);
      // score: expected upside, penalized by risk, scaled by confidence.
      const score = round((upside - 0.5 * Math.max(0, -downside)) * (0.5 + 0.5 * confidence), 2);
      return { baselineRevenue: round(base, 2), expectedRevenue: round(exp, 2), upside: round(upside, 2), downside: round(downside, 2), spread: round(spread, 2), risk: risk, confidence: confidence, score: score };
    },

    /** The simulation marketplace view. limit caps each list (default 5). */
    async dashboard(opts) {
      const o = opts || {};
      const n = o.limit || 5;
      const runs = await ledger().runs();
      const rows = runs.map((r) => ({ runId: r.id, kind: r.scenario ? r.scenario.kind : null, label: r.scenario ? r.scenario.label : null, assumptions: r.assumptions || [], card: r.scorecard || {}, createdAt: r.createdAt }));

      const byUpside = rows.slice().sort((a, b) => (b.card.upside || 0) - (a.card.upside || 0));
      const byRisk = rows.slice().sort((a, b) => (b.card.risk || 0) - (a.card.risk || 0));
      const byConfidence = rows.slice().sort((a, b) => (b.card.confidence || 0) - (a.card.confidence || 0));

      const acc = governance() ? await governance().accuracyOverTime() : { points: [], overall: null };

      return {
        totals: { simulations: rows.length, evaluatedAgainstReality: acc.points ? acc.points.length : 0 },
        highestUpside: byUpside.slice(0, n),
        highestRisk: byRisk.slice(0, n),
        strongestConfidence: byConfidence.slice(0, n),
        failedAssumptions: acc.failedAssumptions || [],
        accuracyOverTime: acc.points || [],
        overallAccuracy: acc.overall != null ? acc.overall : null
      };
    }
  };

  global.AAA_STRATEGY_SCORECARD = Card;
})(typeof window !== 'undefined' ? window : this);
