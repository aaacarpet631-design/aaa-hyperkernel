/* Goal-Capability Bridge — the self-assembling loop: a teleological goal's
 * unmet delta becomes a capability gap, Genesis spawns + executes the missing
 * capability under governance, the Capability Economy measures it, and a
 * promoted capability permanently closes the gap. No production mutation. */
'use strict';
const { makeRunner, setupEnv, load } = require('../helpers/harness');

function loadAll() {
  ['js/core/aaa-events.js', 'js/core/aaa-event-bus.js', 'js/governance/audit-ledger.js', 'js/governance/governance-engine.js',
   // Genesis Foundry + Capability Economy
   'js/genesis/agent-template-schema.js', 'js/genesis/capability-registry.js', 'js/genesis/capability-gap-detector.js', 'js/genesis/agent-factory.js', 'js/genesis/spawn-policy.js', 'js/genesis/tool-forge.js', 'js/genesis/ephemeral-agent-runtime.js',
   'js/genesis/capability-ledger.js', 'js/genesis/capability-roi-engine.js', 'js/genesis/failure-pattern-detector.js', 'js/genesis/capability-reputation-store.js', 'js/genesis/banned-capability-registry.js', 'js/genesis/promotion-scorer.js', 'js/genesis/capability-marketplace-dashboard.js', 'js/genesis/promotion-engine.js', 'js/genesis/termination-engine.js', 'js/genesis/genesis-council.js',
   // Teleological + bridge
   'js/intelligence/teleological-schema.js', 'js/intelligence/goal-engine.js',
   'js/genesis/goal-capability-bridge.js'].forEach(load);
}

const GOAL = {
  goalId: 'goal_commercial_25',
  targetVector: { grossMargin: 0.55, reviewVelocity: 12, crewUtilization: 0.85, materialYield: 0.9, customerSentiment: 0.9, riskExposure: 0.1 },
  weights: { grossMargin: 0.5, reviewVelocity: 0.1, crewUtilization: 0.1, materialYield: 0.1, customerSentiment: 0.1, riskExposure: 0.1 },
  boundaries: { minimumAcceptableMargin: 0.4, maxOvertimeHoursPerCrew: 12, maxAllowedRisk: 0.3 },
  expiresAt: new Date(Date.now() + 1e9).toISOString()
};
const CURRENT = { grossMargin: 0.42, reviewVelocity: 11, crewUtilization: 0.84, materialYield: 0.9, customerSentiment: 0.9, riskExposure: 0.1 };

const MOCK = { name: 'mock', run: async () => ({ ok: true, output: { result: 'commercial permit verified', confidence: 88 }, costUsd: 0.01 }) };

module.exports = async function run() {
  const t = makeRunner('goal-capability-bridge');
  const { G, data } = setupEnv();
  loadAll();
  const BRIDGE = G.AAA_GOAL_CAPABILITY_BRIDGE, RT = G.AAA_EPHEMERAL_RUNTIME, REG = G.AAA_CAPABILITY_REGISTRY;
  const LEDGER = G.AAA_CAPABILITY_LEDGER, PROMO = G.AAA_PROMOTION_ENGINE;
  RT.setExecutor(MOCK);

  // ===== largest weighted gap is the low-margin dimension =====
  const gap = BRIDGE.largestGap(GOAL, CURRENT);
  t.eq('largest weighted gap is grossMargin (weight 0.5)', gap.dimension, 'grossMargin');

  // ===== a requirement the company already employs is NOT a gap =====
  const handled = await BRIDGE.detectGap({ action: 'analyze', entity: 'quote' });
  t.ok('an existing capability resolves with no gap', handled.gap === false && !!handled.handler);

  // ===== a novel requirement IS a gap → Genesis spawns it =====
  const need = { action: 'verify', entity: 'permit', context: 'commercial', domain: 'operations' };
  t.ok('commercial-permit capability is missing (gap)', (await BRIDGE.detectGap(need)).gap === true);
  const prodBefore = JSON.stringify({ quotes: data._store.quotes || {}, jobs: data._store.jobs || {} });
  const pursue = await BRIDGE.pursue(need, { goalId: GOAL.goalId, payload: { permitId: 'p1' } });
  t.ok('CAPABILITY_GAP_DETECTED is emitted', (await G.AAA_EVENT_BUS.log()).some((e) => e.type === 'capability.gap_detected' && e.payload.entity === 'permit'));
  t.ok('Genesis spawned an ephemeral agent to fill the gap', pursue.gap === true && pursue.genesis && pursue.genesis.spawned === true);
  t.eq('the spawned agent ran the one task successfully', pursue.genesis.run.status, 'succeeded');
  t.ok('the run was recorded in the Capability Economy ledger', (await LEDGER.entries()).some((e) => e.capabilityDNA.action === 'verify' && e.capabilityDNA.entity === 'permit'));

  // ===== the loop measures + compounds: 5 clean runs → promotion → gap closed =====
  const agentName = pursue.genesis.spec.name;
  t.eq('the spawned agent is the commercial-permit verifier', agentName, 'commercial-permit-verification-agent');
  await LEDGER.linkOutcome(pursue.genesis.run.id, { result: 'won', roi: { savedMs: 1800000, savedUsd: 50 } }); // the first run
  for (let i = 0; i < 4; i++) {
    const r = await BRIDGE.pursue(need, { goalId: GOAL.goalId, payload: { permitId: 'p' + i } });
    await LEDGER.linkOutcome(r.genesis.run.id, { result: 'won', roi: { savedMs: 1800000, savedUsd: 50 } });
  }
  const evald = await PROMO.evaluate(agentName);
  t.ok('after >=5 measured runs the capability is promotion-eligible', evald.eligible === true);
  const prop = await PROMO.propose(agentName, need);
  const appr = await PROMO.approve(prop.proposal.id, { reason: 'Commercial permit verification proven across five clean runs.' });
  t.ok('governance-approved promotion registers the capability', appr.ok && (await REG.canHandle('verify', 'permit', 'commercial')) !== null);
  t.eq('the gap is now permanently CLOSED (no respawn needed)', (await BRIDGE.detectGap(need)).gap, false);

  // ===== end-to-end from a goal object =====
  const fromGoal = await BRIDGE.pursueGoal(GOAL, { current: CURRENT, context: 'commercial' });
  t.ok('pursueGoal derives the requirement from the goal delta', fromGoal.dimension === 'grossMargin' && !!fromGoal.requirement);

  // ===== production isolation =====
  t.eq('the whole self-assembling loop mutated no production state', JSON.stringify({ quotes: data._store.quotes || {}, jobs: data._store.jobs || {} }), prodBefore);

  // ===== high-risk gaps remain governed (held, not auto-run) =====
  const risky = await BRIDGE.pursue({ action: 'verify', entity: 'invoice', context: 'over 10000', domain: 'finance' }, {});
  t.ok('a high-risk capability spawn is held for approval, never auto-run', risky.genesis && (risky.genesis.held || risky.genesis.spawned === false));

  return t.report();
};
