/*
 * AAA Goal Progress Card — an owner goal as a rich card.
 *
 * Shows the target, the current delta to it, capability gaps (from the
 * Goal-Capability Bridge), recommended experiments, and the governance
 * requirement. Nothing executes — the card is a plan, and acting on it needs
 * approval.
 */
;(function (global) {
  'use strict';

  const Card = {
    build(answer) {
      const g = (answer && answer.answer && answer.answer.goal) || (answer && answer.goal) || answer;
      if (!g || g.status !== 'planned') {
        return { type: 'goal', title: 'Goal', status: 'insufficient_data', note: (g && g.note) || 'Could not turn that into a goal.' };
      }
      return {
        type: 'goal', title: 'Goal: ' + (g.target ? g.target.label : 'objective'), status: 'planned',
        goalId: g.goalId,
        target: g.target, currentDelta: g.currentDelta,
        capabilityGaps: (g.capabilityGaps || []).map(function (c) { return { requirement: c.requirement, gap: c.gap }; }),
        recommendedExperiments: g.recommendedExperiments || [],
        resourcesNeeded: g.resourcesNeeded || null,
        governanceRequirements: g.governanceRequirements || 'Acting on this goal requires approval.',
        approvalRequired: true
      };
    }
  };

  global.AAA_GOAL_PROGRESS_CARD = Card;
})(typeof window !== 'undefined' ? window : this);
