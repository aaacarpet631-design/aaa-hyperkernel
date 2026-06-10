/*
 * AAA Copilot Simulation Interface — "what happens if…" → the Simulation Council.
 *
 * Parses a natural-language scenario into a Counterfactual Runner scenario,
 * runs it (read-only — sim ledger only, never production), and returns an
 * owner-level result: expected / best / worst / confidence / assumptions /
 * recommendation, and whether applying it would need approval (it always does —
 * acting on a simulation is a protected change). Honest: an unparseable or
 * unavailable scenario returns insufficient_data.
 */
;(function (global) {
  'use strict';

  function runner() { return global.AAA_COUNTERFACTUAL_RUNNER; }
  function num(s, d) { const m = String(s).match(/-?\d+(?:\.\d+)?/); return m ? Number(m[0]) : d; }

  // Map phrases → scenario {kind, params}.
  function parse(text) {
    const t = String(text == null ? '' : text).toLowerCase();
    if (/raise|increase/.test(t) && /pric/.test(t)) { const pct = (num(t, 5)) / (t.indexOf('%') !== -1 ? 100 : (num(t, 5) > 1 ? 100 : 1)); return { kind: 'price_change', params: { pct: Math.abs(pct) } }; }
    if (/lower|drop|cut/.test(t) && /pric/.test(t)) { const pct = (num(t, 5)) / 100; return { kind: 'price_change', params: { pct: -Math.abs(pct) } }; }
    if (/crew|hire/.test(t)) { return { kind: 'add_crew', params: { crews: Math.max(1, Math.round(num(t, 1))) } }; }
    if (/fuel/.test(t)) { const pct = /double/.test(t) ? 1.0 : (num(t, 20) / 100); return { kind: 'fuel_change', params: { pct: pct } }; }
    if (/cpc|ad spend|google|marketing/.test(t)) { const pct = /triple/.test(t) ? 2.0 : /double/.test(t) ? 1.0 : (num(t, 40) / 100); return { kind: 'ad_spend_change', params: { pct: pct } }; }
    if (/hurricane|storm|disaster|flood/.test(t)) { return { kind: 'disaster', params: { region: 'Houston', severity: 0.7 } }; }
    if (/zip|stop servicing/.test(t)) { return { kind: 'drop_zip', params: { zip: '' } }; }
    return null;
  }

  const Interface = {
    parse: parse,

    /** Run a "what happens if" question. → owner-level simulation result. */
    async run(text, opts) {
      const o = opts || {};
      if (!runner()) return { status: 'unavailable' };
      const scenario = o.scenario || parse(text);
      if (!scenario) return { status: 'insufficient_data', note: 'Could not map that to a scenario. Try "raise prices 5%" or "add a crew".' };
      const res = await runner().run({ kind: scenario.kind, params: scenario.params, seed: o.seed == null ? 'copilot:' + scenario.kind : o.seed, n: o.n || 300, useWorldModel: o.useWorldModel !== false });
      if (!res.ok) return { status: 'unavailable', error: res.error };
      const mc = res.outcomes; const card = res.scorecard || {};
      let recommendation = 'Review the downside before acting.';
      if (card.upside != null && card.downside != null) recommendation = card.upside > 0 && card.downside >= 0 ? 'Net positive with bounded downside — worth a governed test.' : (card.upside > 0 ? 'Upside exists but the worst case is a loss — test on a small cohort first.' : 'Expected to hurt the objective — not recommended.');
      return {
        status: 'simulated', scenario: res.scenario,
        expected: mc.expected, best: mc.best, worst: mc.worst,
        confidence: card.confidence == null ? null : card.confidence,
        assumptions: res.scenario.assumptions, recommendation: recommendation,
        approvalRequired: true, runId: res.runId
      };
    }
  };

  global.AAA_COPILOT_SIMULATION_INTERFACE = Interface;
})(typeof window !== 'undefined' ? window : this);
