/*
 * AAA Simulation Result Card — a "what happens if" answer as a rich card.
 *
 * Renders expected / best / worst revenue, confidence, assumptions, the
 * recommendation, and an explicit approvalRequired flag (acting on a simulation
 * is a protected change). If the scenario could not run it shows
 * insufficient_data — never invented numbers.
 */
;(function (global) {
  'use strict';

  function r0(n) { return n == null ? null : Math.round(n); }

  const Card = {
    build(answer) {
      const sim = (answer && answer.answer && answer.answer.simulation) || (answer && answer.simulation) || answer;
      if (!sim || sim.status !== 'simulated') {
        return { type: 'simulation', title: 'Simulation', status: 'insufficient_data', note: (sim && sim.note) || 'Could not run that scenario.' };
      }
      const e = sim.expected || {}, b = sim.best || {}, w = sim.worst || {};
      return {
        type: 'simulation', title: 'Simulation: ' + (sim.scenario ? sim.scenario.label : 'scenario'), status: 'simulated',
        cases: { expected: { revenue: r0(e.revenue), margin: e.margin }, best: { revenue: r0(b.revenue), margin: b.margin }, worst: { revenue: r0(w.revenue), margin: w.margin } },
        confidence: sim.confidence == null ? null : sim.confidence,
        assumptions: sim.assumptions || [],
        recommendation: sim.recommendation || '',
        approvalRequired: !!sim.approvalRequired,
        runId: sim.runId || null
      };
    }
  };

  global.AAA_SIMULATION_RESULT_CARD = Card;
})(typeof window !== 'undefined' ? window : this);
