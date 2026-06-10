/*
 * AAA Copilot Goal Interface — "add $50k/month" → the Teleological Engine.
 *
 * Parses an owner goal into a target nudge on the system-state vector, defines
 * it (append-only), and returns target / current delta / capability gaps /
 * recommended experiments / governance requirements. It NEVER auto-executes —
 * pursuing the goal proposes paths into governance, and applying anything needs
 * human approval. Honest: with no goal engine it returns unavailable.
 */
;(function (global) {
  'use strict';

  function goalEngine() { return global.AAA_TELEOLOGICAL_GOAL_ENGINE; }
  function bridge() { return global.AAA_GOAL_CAPABILITY_BRIDGE; }
  function discovery() { return global.AAA_SCIENTIFIC_DISCOVERY_COUNCIL; }
  function num(s, d) { const m = String(s).match(/-?\d+(?:\.\d+)?/); return m ? Number(m[0]) : d; }

  // Map an owner phrase → which vector dimension to lift and by how much.
  function parse(text) {
    const t = String(text == null ? '' : text).toLowerCase();
    if (/close rate|win more|close more/.test(t)) return { dimension: 'closeRate', nudge: 0.1, label: 'increase close rate' };
    if (/callback|rework|redo/.test(t)) return { dimension: 'riskExposure', nudge: -0.05, label: 'reduce callbacks/risk' };
    if (/review|reputation/.test(t)) return { dimension: 'reviewVelocity', nudge: 5, label: 'increase review velocity' };
    if (/margin|profit/.test(t)) return { dimension: 'grossMargin', nudge: 0.05, label: 'increase gross margin' };
    if (/\$|revenue|money|per month|grow/.test(t)) return { dimension: 'grossMargin', nudge: 0.05, label: 'grow revenue (via margin + close rate)', amount: num(t, null) };
    return null;
  }

  const Interface = {
    parse: parse,

    /** Translate an owner goal into a governed plan. No execution. */
    async createGoal(text, opts) {
      const o = opts || {};
      if (!goalEngine()) return { status: 'unavailable' };
      const p = o.parsed || parse(text);
      if (!p) return { status: 'insufficient_data', note: 'Could not map that to a goal. Try "increase close rate" or "add $50k/month".' };
      const cv = await goalEngine().currentVector(o.now);
      const current = cv.vector;
      // Build a target vector that nudges the chosen dimension toward health.
      const target = Object.assign({}, current);
      target[p.dimension] = p.dimension === 'riskExposure' ? Math.max(0, current[p.dimension] + p.nudge) : current[p.dimension] + p.nudge;
      const weights = { grossMargin: 0.2, reviewVelocity: 0.15, crewUtilization: 0.15, materialYield: 0.1, customerSentiment: 0.15, riskExposure: 0.25 };
      weights[p.dimension] = 0.5; // emphasize the owner's chosen dimension
      const goal = { targetVector: target, weights: weights, boundaries: { minimumAcceptableMargin: 0.4, maxOvertimeHoursPerCrew: 12, maxAllowedRisk: 0.3 }, expiresAt: o.expiresAt || null };
      const def = await goalEngine().defineGoal(goal);
      if (!def.ok) return { status: 'invalid_goal', issues: def.issues };

      const delta = goalEngine().calculateStateDelta(current, def.goal);
      // Capability gaps for this goal (via the self-assembling bridge).
      let capabilityGaps = [];
      if (bridge()) { const req = bridge().requirementFor(def.goal, current, o.context); if (req) { const g = await bridge().detectGap(req); capabilityGaps.push({ requirement: req, gap: g.gap, handledBy: g.handler || null }); } }
      // Recommended experiments (suggested, NOT auto-run).
      let recommendedExperiments = [];
      if (discovery()) { const agenda = await discovery().researchAgenda(o.now); recommendedExperiments = (agenda.questions || []).slice(0, 3).map(function (q) { return q.question; }); }

      return {
        status: 'planned',
        goalId: def.goal.goalId,
        target: { dimension: p.dimension, label: p.label, from: current[p.dimension], to: target[p.dimension], amount: p.amount || null },
        currentDelta: Math.round(delta * 1e4) / 1e4,
        resourcesNeeded: 'Run a governed pursuit to size cash/crew/inventory (Resource Allocator).',
        recommendedExperiments: recommendedExperiments,
        capabilityGaps: capabilityGaps,
        governanceRequirements: 'Any path that changes pricing, spend, scheduling, or capability promotion requires human approval before it is applied.'
      };
    }
  };

  global.AAA_COPILOT_GOAL_INTERFACE = Interface;
})(typeof window !== 'undefined' ? window : this);
