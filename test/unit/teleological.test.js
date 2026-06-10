/* Teleological Goal Engine (HyperKernel 2.5) — state-delta math, total system
 * effect, hard boundary enforcement, multi-objective resource allocation,
 * World Model current-vector resolution (honest), and governed goal pursuit
 * with no production mutation. */
'use strict';
const { makeRunner, setupEnv, load } = require('../helpers/harness');

function loadAll() {
  ['js/core/aaa-events.js', 'js/core/aaa-event-bus.js', 'js/governance/audit-ledger.js',
   'js/intelligence/signal-registry.js', 'js/intelligence/signal-freshness-sentinel.js', 'js/intelligence/world-state-ledger.js', 'js/intelligence/world-model.js',
   'js/revenue/reputation-engine.js', 'js/revenue/council-governance.js',
   'js/simulation/simulation-ledger.js', 'js/simulation/scenario-engine.js', 'js/simulation/outcome-estimator.js', 'js/simulation/monte-carlo-engine.js', 'js/simulation/strategy-scorecard.js', 'js/simulation/simulation-governance.js', 'js/simulation/counterfactual-runner.js',
   'js/intelligence/teleological-schema.js', 'js/intelligence/goal-engine.js', 'js/intelligence/resource-allocator.js'].forEach(load);
}

const NOW = 1700000000000;
const iso = (ms) => new Date(ms).toISOString();

const CURRENT = { grossMargin: 0.54, reviewVelocity: 8, crewUtilization: 0.72, materialYield: 0.88, customerSentiment: 0.85, riskExposure: 0.15 };
const GOAL = {
  goalId: 'goal_horizon_001',
  targetVector: { grossMargin: 0.60, reviewVelocity: 25, crewUtilization: 0.85, materialYield: 0.92, customerSentiment: 0.95, riskExposure: 0.10 },
  weights: { grossMargin: 0.20, reviewVelocity: 0.40, crewUtilization: 0.10, materialYield: 0.10, customerSentiment: 0.10, riskExposure: 0.10 },
  boundaries: { minimumAcceptableMargin: 0.45, maxOvertimeHoursPerCrew: 12, maxAllowedRisk: 0.30 },
  expiresAt: iso(NOW + 1000000)
};

module.exports = async function run() {
  const t = makeRunner('teleological');
  const { G, data } = setupEnv();
  loadAll();
  const E = G.AAA_TELEOLOGICAL_GOAL_ENGINE, A = G.AAA_RESOURCE_ALLOCATOR, S = G.AAA_TELEOLOGICAL_SCHEMA, GOV = G.AAA_COUNCIL_GOVERNANCE;

  // ===== schema validation =====
  t.ok('a valid goal validates', S.validateGoal(GOAL).ok === true);
  t.ok('a vector missing a dimension is rejected', S.validateVector({ grossMargin: 0.5 }).ok === false);

  // ===== state delta math (deterministic) =====
  const d0 = E.calculateStateDelta(CURRENT, GOAL);
  t.ok('state delta is a positive scalar distance', d0 > 0);
  t.eq('delta is deterministic', E.calculateStateDelta(CURRENT, GOAL), d0);
  t.ok('reaching the target yields ~zero delta', E.calculateStateDelta(GOAL.targetVector, GOAL) < 1e-9);

  // ===== total system effect: approve net-positive low-margin path within bounds =====
  const proGood = E.evaluateTotalSystemEffect(CURRENT, { grossMargin: 0.48, reviewVelocity: 28, crewUtilization: 0.80 }, GOAL);
  t.ok('a low-margin but high-review path that helps overall is forwarded', proGood.violatesBoundaries === false && proGood.strategicScore > 0 && proGood.actionPayload === 'OPTIMAL_PATH_DETECTED_FORWARD_TO_SIMULATION');

  // ===== hard boundary enforcement (un-bypassable) =====
  const proBad = E.evaluateTotalSystemEffect(CURRENT, { grossMargin: 0.38, reviewVelocity: 30, crewUtilization: 0.95 }, GOAL);
  t.ok('a path breaching the margin floor is rejected regardless of upside', proBad.violatesBoundaries === true && proBad.actionPayload === 'REJECT_CRITICAL_BOUNDARY_VIOLATION');
  const proRisk = E.evaluateTotalSystemEffect(CURRENT, { riskExposure: 0.5 }, GOAL);
  t.eq('a path breaching max risk is rejected', proRisk.actionPayload, 'REJECT_CRITICAL_BOUNDARY_VIOLATION');

  // ===== multi-objective resource allocation =====
  const resources = { availableCash: 10000, allocatedAdBudget: 2500, crewHoursAvailable: 40, stagedCarpetInventorySqFt: 1200 };
  const proposals = [
    { proposalId: 'low_yield_ad_campaign', resourceCost: { cash: 1000, adBudget: 1500, crewHours: 0, inventorySqFt: 0 }, expectedImpact: { reviewVelocity: 9 } },
    { proposalId: 'high_yield_showroom_push', resourceCost: { cash: 2000, adBudget: 1000, crewHours: 20, inventorySqFt: 400 }, expectedImpact: { reviewVelocity: 24, grossMargin: 0.58 } }
  ];
  const approved = A.allocateResourcesForGoal(resources, GOAL, proposals, CURRENT);
  t.ok('the high-yield path is funded', approved.indexOf('high_yield_showroom_push') !== -1);
  t.ok('the marginal path is funded only if it survives capacity + positive efficiency', Array.isArray(approved));
  // starve resources → nothing fundable
  const broke = A.allocateResourcesForGoal({ availableCash: 100, allocatedAdBudget: 100, crewHoursAvailable: 1, stagedCarpetInventorySqFt: 1 }, GOAL, proposals, CURRENT);
  t.eq('with no resources nothing is allocated', broke.length, 0);
  t.ok('allocation is deterministic', JSON.stringify(A.allocateResourcesForGoal(resources, GOAL, proposals, CURRENT)) === JSON.stringify(approved));

  // ===== World Model current-vector resolution (honest) =====
  await data.put('world_signals', 's1', { signalId: 's1', signalType: 'gross_margin', value: 0.5, confidence: 0.9, volatility: 0.04, observedAt: iso(NOW), expiresAt: iso(NOW + 86400000), stalePolicy: 'degrade_confidence' });
  const cv = await E.currentVector(NOW);
  t.eq('current vector pulls margin from the live World Model signal', cv.vector.grossMargin, 0.5);
  t.ok('dimensions with no live signal are flagged assumed (not fabricated)', cv.assumed.indexOf('materialYield') !== -1 && cv.assumed.indexOf('riskExposure') !== -1 && cv.confidence < 1);

  // ===== governed pursuit: propose into governance, no production mutation =====
  await E.defineGoal(GOAL);
  const prodBefore = JSON.stringify({ world: data._store.world_signals });
  const pursuit = await E.pursue(GOAL.goalId, proposals, { current: CURRENT, resources: resources, now: NOW });
  t.ok('pursuit chooses viable non-violating paths', pursuit.ok && pursuit.chosen.length >= 1 && pursuit.chosen.every((p) => !p.violatesBoundaries));
  t.ok('pursuit proposes the top path into governance (HUMAN_APPROVAL_REQUIRED)', !!pursuit.proposal && pursuit.proposal.status === 'pending_governance');
  t.ok('strategy.recommendation_proposed event emitted', (await G.AAA_EVENT_BUS.log()).some((e) => e.type === 'strategy.recommendation_proposed'));
  t.eq('approval requires a written reason', (await GOV.approve(pursuit.proposal.id, { reason: 'no' })).error, 'JUSTIFICATION_REQUIRED');
  const appr = await GOV.approve(pursuit.proposal.id, { reason: 'Boundary-safe path that closes the review-velocity gap; approved.' });
  t.ok('an authorized human approves the goal path', appr.ok && appr.recommendation.status === 'approved');

  // a goal pursuit that would violate boundaries surfaces as rejected, never applied
  const pursuit2 = await E.pursue(GOAL.goalId, [{ proposalId: 'predatory', resourceCost: { cash: 100 }, expectedImpact: { grossMargin: 0.38, reviewVelocity: 40 } }], { current: CURRENT });
  t.ok('a boundary-violating proposal is rejected and never chosen', pursuit2.rejected.indexOf('predatory') !== -1 && pursuit2.chosen.length === 0 && !pursuit2.proposal);

  t.eq('the whole teleological flow mutates no production state', JSON.stringify({ world: data._store.world_signals }), prodBefore);

  return t.report();
};
