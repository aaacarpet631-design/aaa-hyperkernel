/* Governed Model Router — routing, gateway gate, governance+enablement, provenance, fallback.
 * (Named ai-model-router to avoid colliding with the existing agents model-router suite.) */
'use strict';
const { makeRunner, setupEnv, load } = require('../helpers/harness');

async function provisionAndActivate(G, modelKey, opts) {
  const R = G.AAA_GOVERNED_MODEL_ROUTER, GOV = G.AAA_GOVERNANCE;
  const prov = await R.provision(modelKey, Object.assign({ actor: 'owner', modelId: 'nvidia/' + modelKey.split('.').pop(), verifiedId: true }, opts || {}));
  await GOV.approve(prov.governanceVersionId, { actor: 'owner' });
  await GOV.activate(prov.governanceVersionId, { actor: 'owner' });
  await R.setEnabled(modelKey, true, { actor: 'owner' });
  return prov;
}

module.exports = async function run() {
  const t = makeRunner('ai-model-router');
  const { G, data } = setupEnv();
  load('js/core/aaa-rbac.js');
  load('js/core/aaa-runtime-gateway.js');
  load('js/intelligence/provenance-store.js');
  load('js/intelligence/governance-registry.js');
  load('js/ai/model-registry.js');
  load('js/ai/model-call-provenance.js');
  load('js/ai/providers/nvidia-nemotron-adapter.js');
  load('js/ai/model-router.js');
  const R = G.AAA_GOVERNED_MODEL_ROUTER;
  const REG = G.AAA_MODEL_REGISTRY;
  const GW = G.AAA_RUNTIME_GATEWAY;
  const MCP = G.AAA_MODEL_CALL_PROVENANCE;
  const RB = G.AAA_RBAC;
  RB.setRole('owner');

  // ===== registry routing =====
  t.eq('task routes to Instruct', REG.modelForTask('draft_customer_message'), 'nvidia.nemotron4_340b_instruct');
  t.eq('task routes to Base', REG.modelForTask('scenario_generation'), 'nvidia.nemotron4_340b_base');
  t.eq('task routes to Reward', REG.modelForTask('agent_output_score'), 'nvidia.nemotron4_340b_reward');
  t.ok('candidate ids are flagged unverified (no blind hard-coding)', REG.providerCandidates('nvidia.nemotron4_340b_instruct').verified === false);

  // ===== before governance/enablement → graceful fallback (no provider call) =====
  const fb = await R.call({ taskType: 'owner_briefing_explanation', input: 'brief', actor: 'owner', agent: 'copilot' });
  t.ok('un-governed model falls back gracefully (advisory)', fb.ok === true && fb.fallback === true && fb.reason === 'MODEL_NOT_GOVERNED' && fb.advisory === true);
  t.ok('fallback still writes a usage record', (await MCP.usage()).some((u) => u.fallback === true));

  // ===== AI cannot change settings; crew cannot enable; owner can =====
  t.eq('AI-origin cannot toggle model settings', (await R.setEnabled('nvidia.nemotron4_340b_instruct', true, { origin: 'ai' })).error, 'AI_NOT_PERMITTED');
  RB.setRole('crew');
  t.eq('crew cannot enable a model (owner-only)', (await R.setEnabled('nvidia.nemotron4_340b_instruct', true, { actor: 'crew' })).error, 'FORBIDDEN');
  RB.setRole('owner');

  // ===== AI cannot provision (governance is human-only) =====
  t.eq('AI cannot provision a governed model', (await R.provision('nvidia.nemotron4_340b_instruct', { origin: 'ai' })).error, 'AI_NOT_PERMITTED');

  // ===== provision → activate → enable, then a real (stubbed) call =====
  await provisionAndActivate(G, 'nvidia.nemotron4_340b_instruct');
  const res = await R.call({ taskType: 'owner_briefing_explanation', input: 'what needs me today', actor: 'owner', agent: 'owner_copilot', context: { promptVersion: 'p1', quoteIds: ['q1'] }, ownerApprovalRequired: true });
  t.ok('a governed, enabled model returns an advisory envelope', res.ok === true && res.fallback === false && res.advisory === true);
  t.ok('envelope carries the full required metadata', res.modelFamily === 'nemotron-4' && !!res.modelId && !!res.modelVersion && res.provider === 'nvidia' && res.governanceVersion === res.modelVersion && typeof res.confidence === 'number' && typeof res.riskScore === 'number' && !!res.outputChecksum);
  t.ok('output is advisory + flagged for owner approval', res.kind === 'text' && !!res.output.text && res.needsOwnerApproval === true);
  t.ok('source context is carried through', res.sourceContext && res.sourceContext.promptVersion === 'p1');

  // ===== provenance + audit were written =====
  t.ok('a provenance trace was created for the call', !!res.provenanceTraceId && (await G.AAA_PROVENANCE.get(res.provenanceTraceId)) !== null);
  t.ok('the call was audited (RUN_MODEL allowed)', (await GW.recentAudit(100)).some((a) => a.action === 'RUN_MODEL' && a.decision === 'allowed'));

  // ===== task-not-allowed is refused (an instruct task on the reward model) =====
  const bad = await R.call({ modelKey: 'nvidia.nemotron4_340b_reward', taskType: 'draft_customer_message', input: 'x', actor: 'owner' });
  t.eq('a task not allowed for the model is refused', bad.error, 'TASK_NOT_ALLOWED');

  // ===== reward scoring shape =====
  await provisionAndActivate(G, 'nvidia.nemotron4_340b_reward');
  const score = await R.call({ taskType: 'agent_output_score', input: { text: 'an agent recommendation' }, actor: 'owner', agent: 'outcome_intel' });
  t.ok('reward call returns a structured score', score.ok === true && score.kind === 'score' && score.output.score >= 0 && score.output.score <= 1 && typeof score.confidence === 'number');

  // ===== crew denied at RUN_MODEL (and audited) =====
  RB.setRole('crew');
  const denied = await R.call({ taskType: 'owner_briefing_explanation', input: 'x', actor: 'crew' });
  t.eq('crew is denied model inference', denied.error, 'FORBIDDEN');
  RB.setRole('owner');

  // ===== disabled model → fallback even when governed =====
  await R.setEnabled('nvidia.nemotron4_340b_instruct', false, { actor: 'owner' });
  const dis = await R.call({ taskType: 'owner_briefing_explanation', input: 'x', actor: 'owner' });
  t.ok('a disabled model falls back', dis.fallback === true && dis.reason === 'MODEL_DISABLED');

  // ===== status + metrics for the UI =====
  await R.setEnabled('nvidia.nemotron4_340b_instruct', true, { actor: 'owner' });
  const st = await R.status('nvidia.nemotron4_340b_instruct');
  t.ok('status reports governed + enabled + metrics', st.governed === true && st.enabled === true && !!st.modelId && st.metrics && typeof st.metrics.calls === 'number');

  // ===== advisory integrations route to the right governed model =====
  load('js/intelligence/executive-council.js');
  load('js/intelligence/outcome-intelligence.js');
  load('js/intelligence/learning-fabric.js');
  const rs = await G.AAA_OUTCOME_INTELLIGENCE.rewardScore({ text: 'a recommendation' }, { actor: 'owner' });
  t.ok('outcome-intelligence.rewardScore → Reward model', rs.ok === true && typeof rs.score === 'number' && rs.envelope.modelFamily === 'nemotron-4');
  await provisionAndActivate(G, 'nvidia.nemotron4_340b_base');
  const sc = await G.AAA_LEARNING_FABRIC.generateScenario({ segment: 'apartment_turn' }, { actor: 'owner' });
  t.ok('learning-fabric.generateScenario → Base model (internal only)', sc.ok === true && sc.internalOnly === true && !!sc.scenario);
  const sub = await G.AAA_EXECUTIVE_COUNCIL.submit({ type: 'ads_budget', title: 'Test ads', amount: 500, detail: {} }, { actor: 'owner' });
  const nar = await G.AAA_EXECUTIVE_COUNCIL.narrate(sub.review.id, { actor: 'owner' });
  t.ok('executive-council.narrate → Instruct model (advisory)', nar.ok === true && nar.advisory === true && !!nar.narrative);
  t.eq('advisory narrative did NOT change the decision', (await G.AAA_EXECUTIVE_COUNCIL.get(sub.review.id)).decision, sub.review.decision);

  return t.report();
};
