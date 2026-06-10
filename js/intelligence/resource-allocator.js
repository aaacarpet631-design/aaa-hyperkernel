/*
 * AAA Multi-Objective Resource Allocator — spend finite reality where it most
 * reduces the goal delta.
 *
 * Treats cash, ad budget, crew hours, and staged inventory as scarce variables
 * and allocates them across proposals by their teleological yield (how much
 * each path shrinks the weighted distance to the target vector). Greedy by
 * efficiency under hard resource caps; a proposal is funded only if it both
 * fits the remaining pool AND has positive efficiency. Pure; deterministic;
 * allocates nothing it cannot afford and recommends nothing it cannot justify.
 */
;(function (global) {
  'use strict';

  function goalEngine() { return global.AAA_TELEOLOGICAL_GOAL_ENGINE; }
  function num(v) { const n = Number(v); return isFinite(n) ? n : 0; }

  function distance(state, goal) {
    // Reuse the goal engine's weighted distance when present (single source of truth).
    if (goalEngine()) return goalEngine().calculateStateDelta(state, goal);
    const t = goal.targetVector, w = goal.weights, sq = (x) => x * x;
    return Math.sqrt(sq((t.grossMargin - state.grossMargin) * w.grossMargin) + sq((t.reviewVelocity - state.reviewVelocity) * w.reviewVelocity) + sq((t.crewUtilization - state.crewUtilization) * w.crewUtilization) + sq((t.materialYield - state.materialYield) * w.materialYield));
  }

  const Allocator = {
    /**
     * @param resources { availableCash, allocatedAdBudget, crewHoursAvailable, stagedCarpetInventorySqFt }
     * @param proposals [{ proposalId, resourceCost:{cash,adBudget,crewHours,inventorySqFt}, expectedImpact }]
     * @returns approvedProposalIds[] (in funding order)
     */
    allocateResourcesForGoal(resources, goal, proposals, currentReality) {
      const r = resources || {};
      let cash = num(r.availableCash), ad = num(r.allocatedAdBudget), crew = num(r.crewHoursAvailable), inv = num(r.stagedCarpetInventorySqFt);
      const currentDelta = distance(currentReality, goal);
      const scored = (Array.isArray(proposals) ? proposals : []).map((p) => {
        const sim = Object.assign({}, currentReality, p.expectedImpact || {});
        const efficiencyScore = currentDelta - distance(sim, goal);
        return Object.assign({}, p, { efficiencyScore: efficiencyScore });
      }).sort((a, b) => b.efficiencyScore - a.efficiencyScore);

      const approved = [];
      for (const p of scored) {
        const c = p.resourceCost || {};
        const cost = { cash: num(c.cash), ad: num(c.adBudget), crew: num(c.crewHours), inv: num(c.inventorySqFt) };
        if (p.efficiencyScore > 0 && cost.cash <= cash && cost.ad <= ad && cost.crew <= crew && cost.inv <= inv) {
          cash -= cost.cash; ad -= cost.ad; crew -= cost.crew; inv -= cost.inv;
          approved.push(p.proposalId);
        }
      }
      return approved;
    },

    /** Same allocation with the full scored detail (for dashboards / audit). */
    allocateDetailed(resources, goal, proposals, currentReality) {
      const approved = this.allocateResourcesForGoal(resources, goal, proposals, currentReality);
      const currentDelta = distance(currentReality, goal);
      const detail = (Array.isArray(proposals) ? proposals : []).map((p) => {
        const sim = Object.assign({}, currentReality, p.expectedImpact || {});
        return { proposalId: p.proposalId, efficiencyScore: Math.round((currentDelta - distance(sim, goal)) * 1e6) / 1e6, funded: approved.indexOf(p.proposalId) !== -1 };
      }).sort((a, b) => b.efficiencyScore - a.efficiencyScore);
      return { approved: approved, detail: detail };
    }
  };

  global.AAA_RESOURCE_ALLOCATOR = Allocator;
})(typeof window !== 'undefined' ? window : this);
