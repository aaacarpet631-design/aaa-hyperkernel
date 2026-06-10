/*
 * AAA Teleological Goal Engine — the shift from "If X → Do Y" to
 * "Target Outcome → synthesize the path that closes the delta".
 *
 * It measures the weighted distance between the current system-state vector and
 * a goal's target vector, and evaluates any proposed path by its TOTAL SYSTEM
 * EFFECT — does it move the whole ecosystem closer, without breaching a hard
 * boundary (e.g. margin floor, max risk)? Boundaries are un-bypassable: a path
 * that violates one is rejected regardless of how attractive its score.
 *
 * Integration (the bridge): currentVector() reads the World Model (honest —
 * missing signals are flagged assumed, lowering confidence); pursue() scores
 * proposals, lets the Resource Allocator pick the affordable winners, runs the
 * chosen path through the Simulation Council, and routes a recommendation into
 * Council Governance — never mutating production, always human-approved.
 *
 * Append-only goals (teleological_goals). Pure math; deterministic.
 */
;(function (global) {
  'use strict';

  const GOALS = 'teleological_goals';

  function cfg() { return global.AAA_CONFIG || {}; }
  function data() { return global.AAA_DATA; }
  function ids() { return global.AAA_ID_FACTORY; }
  function clock() { return global.AAA_RUNTIME_CLOCK; }
  function schema() { return global.AAA_TELEOLOGICAL_SCHEMA; }
  function world() { return global.AAA_WORLD_MODEL; }
  function reputation() { return global.AAA_REPUTATION_ENGINE; }
  function runner() { return global.AAA_COUNTERFACTUAL_RUNNER; }
  function governance() { return global.AAA_COUNCIL_GOVERNANCE; }
  function ws() { return cfg().workspaceId || 'default'; }
  function nowMs() { return clock() && clock().now ? clock().now() : Date.now(); }
  function nowISO() { return clock() && clock().nowISO ? clock().nowISO() : new Date().toISOString(); }
  function newId(p) { return ids() ? ids().createId(p) : p + '_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7); }
  function num(v, d) { const n = Number(v); return isFinite(n) ? n : d; }
  function flag(k, d) { return cfg().flag ? num(cfg().flag(k, d), d) : d; }

  const Engine = {
    GOALS: GOALS,

    /** Weighted distance between two vectors (risk term inverted, per design). */
    calculateStateDelta(current, goal) {
      const t = goal.targetVector; const w = goal.weights; const c = current;
      const sq = (x) => x * x;
      const d =
        sq((t.grossMargin - c.grossMargin) * w.grossMargin) +
        sq((t.reviewVelocity - c.reviewVelocity) * w.reviewVelocity) +
        sq((t.crewUtilization - c.crewUtilization) * w.crewUtilization) +
        sq((t.materialYield - c.materialYield) * w.materialYield) +
        sq((t.customerSentiment - c.customerSentiment) * w.customerSentiment) +
        sq((c.riskExposure - t.riskExposure) * w.riskExposure);
      return Math.sqrt(d);
    },

    /**
     * Evaluate a proposed path's total system effect.
     * → { strategicScore, violatesBoundaries, actionPayload, simulatedState }.
     * Positive strategicScore = the ecosystem moves closer to target.
     */
    evaluateTotalSystemEffect(current, projectedImpact, goal) {
      const p = projectedImpact || {};
      const simulatedState = {
        grossMargin: p.grossMargin !== undefined ? p.grossMargin : current.grossMargin,
        reviewVelocity: p.reviewVelocity !== undefined ? p.reviewVelocity : current.reviewVelocity,
        crewUtilization: p.crewUtilization !== undefined ? p.crewUtilization : current.crewUtilization,
        materialYield: p.materialYield !== undefined ? p.materialYield : current.materialYield,
        customerSentiment: p.customerSentiment !== undefined ? p.customerSentiment : current.customerSentiment,
        riskExposure: p.riskExposure !== undefined ? p.riskExposure : current.riskExposure
      };
      const b = goal.boundaries || {};
      const violatesBoundaries = (b.minimumAcceptableMargin != null && simulatedState.grossMargin < b.minimumAcceptableMargin) ||
        (b.maxAllowedRisk != null && simulatedState.riskExposure > b.maxAllowedRisk);
      const strategicScore = this.calculateStateDelta(current, goal) - this.calculateStateDelta(simulatedState, goal);
      let actionPayload = 'MAINTAIN_CURRENT_STATE';
      if (violatesBoundaries) actionPayload = 'REJECT_CRITICAL_BOUNDARY_VIOLATION';
      else if (strategicScore > 0) actionPayload = 'OPTIMAL_PATH_DETECTED_FORWARD_TO_SIMULATION';
      return { strategicScore: Math.round(strategicScore * 1e6) / 1e6, violatesBoundaries: violatesBoundaries, actionPayload: actionPayload, simulatedState: simulatedState };
    },

    /**
     * Resolve the current SystemStateVector from the World Model + reputation.
     * Honest: a dimension with no live signal is filled from a labeled
     * assumption and named in `assumed[]` (never silently fabricated).
     */
    async currentVector(now) {
      const ref = now != null ? now : nowMs();
      const assumed = [];
      const fromSignal = async (type, fallbackFlag, fallbackDefault) => {
        if (world()) { const s = await world().signal(type, ref); if (s && s.value != null && (s.status === 'fresh' || s.status === 'degraded')) return s.value; }
        assumed.push(type); return flag(fallbackFlag, fallbackDefault);
      };
      let sentiment = null;
      if (reputation()) { try { const r = await reputation().assess(ref); if (r && r.reputationScore != null) sentiment = r.reputationScore; } catch (_) {} }
      if (sentiment == null) { assumed.push('customerSentiment'); sentiment = flag('teleoBaselineSentiment', 0.8); }
      const vector = {
        grossMargin: await fromSignal('gross_margin', 'simBaselineMargin', 0.45),
        reviewVelocity: await fromSignal('review_velocity', 'teleoBaselineReviewVelocity', 4),
        crewUtilization: await fromSignal('crew_utilization', 'simBaselineUtilization', 0.7),
        materialYield: flag('teleoBaselineMaterialYield', 0.88),
        customerSentiment: sentiment,
        riskExposure: flag('teleoBaselineRisk', 0.15)
      };
      if (assumed.indexOf('materialYield') === -1) assumed.push('materialYield'); // no live source yet
      if (assumed.indexOf('riskExposure') === -1) assumed.push('riskExposure');
      return { vector: vector, assumed: assumed, confidence: Math.max(0, 1 - assumed.length / 6) };
    },

    // ---- goal storage (append-only) ----
    async defineGoal(goal) {
      const v = schema() ? schema().validateGoal(goal) : { ok: true };
      if (!v.ok) return { ok: false, error: 'INVALID_GOAL', issues: v.issues };
      const id = goal.goalId || newId('goal');
      const rec = Object.assign({ goalId: id, workspaceId: ws(), createdAt: nowISO(), expiresAt: goal.expiresAt || new Date(nowMs() + 30 * 86400000).toISOString() }, goal, { goalId: id });
      await data().put(GOALS, id, rec);
      return { ok: true, goal: rec };
    },
    async getGoal(id) { const r = await data().get(GOALS, id); return r && (r.workspaceId == null || r.workspaceId === ws()) ? r : null; },

    /**
     * Pursue a goal: score proposals by total system effect, drop boundary
     * violators, let the allocator pick affordable winners, optionally simulate
     * the best, and PROPOSE it into governance. Read-only + governed — no
     * production mutation. opts: { current, resources, simulate, now }.
     */
    async pursue(goal, proposals, opts) {
      const o = opts || {};
      const g = typeof goal === 'string' ? await this.getGoal(goal) : goal;
      if (!g) return { ok: false, error: 'GOAL_NOT_FOUND' };
      const current = (o.current && o.current.vector) || o.current || (await this.currentVector(o.now)).vector;

      const evaluated = (Array.isArray(proposals) ? proposals : []).map((p) => {
        const eff = this.evaluateTotalSystemEffect(current, p.expectedImpact || {}, g);
        return Object.assign({}, p, { strategicScore: eff.strategicScore, violatesBoundaries: eff.violatesBoundaries, actionPayload: eff.actionPayload });
      });
      const viable = evaluated.filter((p) => !p.violatesBoundaries && p.strategicScore > 0).sort((a, b) => b.strategicScore - a.strategicScore);

      // Resource allocation among viable paths (if an allocator + resources given).
      let approvedIds = viable.map((p) => p.proposalId);
      if (o.resources && global.AAA_RESOURCE_ALLOCATOR) {
        approvedIds = global.AAA_RESOURCE_ALLOCATOR.allocateResourcesForGoal(o.resources, g, viable, current);
      }
      const chosen = viable.filter((p) => approvedIds.indexOf(p.proposalId) !== -1);

      // Optionally simulate the top chosen path, then propose it into governance.
      let proposal = null, simRunId = null;
      const top = chosen[0];
      if (top) {
        if (o.simulate && top.scenario && runner()) { try { const r = await runner().run({ kind: top.scenario.kind, params: top.scenario.params, seed: 'goal:' + (g.goalId || 'g'), n: o.n || 200 }); if (r.ok) simRunId = r.runId; } catch (_) {} }
        if (governance()) { const pr = await governance().propose('strategy', { council: 'teleological', action: top.action || top.proposalId, rationale: 'Closes ' + Math.round(top.strategicScore * 1e6) / 1e6 + ' of the goal delta without breaching boundaries.', simRunId: simRunId, confidence: top.confidence == null ? null : top.confidence }); proposal = pr.recommendation; }
      }
      return { ok: true, goalId: g.goalId, current: current, evaluated: evaluated, viable: viable, approvedIds: approvedIds, chosen: chosen, proposal: proposal, rejected: evaluated.filter((p) => p.violatesBoundaries).map((p) => p.proposalId) };
    }
  };

  global.AAA_TELEOLOGICAL_GOAL_ENGINE = Engine;
})(typeof window !== 'undefined' ? window : this);
