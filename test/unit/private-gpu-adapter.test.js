/* Private GPU Adapter — governed end-to-end: provision→activate→enable→call, fail-safe. */
'use strict';
const { makeRunner, setupEnv, load } = require('../helpers/harness');

async function provisionAndActivate(G, key, modelId) {
  const R = G.AAA_GOVERNED_MODEL_ROUTER, GOV = G.AAA_GOVERNANCE;
  const prov = await R.provision(key, { actor: 'owner', modelId: modelId, verifiedId: true });
  await GOV.approve(prov.governanceVersionId, { actor: 'owner' });
  await GOV.activate(prov.governanceVersionId, { actor: 'owner' });
  await R.setEnabled(key, true, { actor: 'owner' });
  return prov;
}

module.exports = async function run() {
  const t = makeRunner('private-gpu-adapter');
  const { G } = setupEnv();
  load('js/core/aaa-rbac.js');
  load('js/core/aaa-runtime-gateway.js');
  load('js/intelligence/provenance-store.js');
  load('js/intelligence/governance-registry.js');
  load('js/ai/model-registry.js');
  load('js/ai/model-call-provenance.js');
  load('js/ai/providers/private-gpu-adapter.js');
  load('js/ai/providers/private-gpu-transport.js');
  load('js/ai/model-router.js');
  const R = G.AAA_GOVERNED_MODEL_ROUTER;
  const REG = G.AAA_MODEL_REGISTRY;
  const A = G.AAA_PRIVATE_GPU_ADAPTER;
  const T = G.AAA_PRIVATE_GPU_TRANSPORT;
  const GW = G.AAA_RUNTIME_GATEWAY;
  const RB = G.AAA_RBAC;
  RB.setRole('owner');

  // ===== registry + adapter wiring =====
  t.ok('private GPU model is registered', !!REG.get('privategpu.local') && REG.get('privategpu.local').provider === 'private_gpu');
  t.ok('adapter handles only privategpu.* keys', A.supports('privategpu.local') === true && A.supports('nvidia.x') === false);
  t.ok('adapter self-registered for the router', (G.AAA_MODEL_ADAPTERS || []).indexOf(A) !== -1);
  t.ok('candidate id resolves for the non-NIM provider', REG.providerCandidates('privategpu.local').modelId === 'local-model');

  // ===== before governance/enablement → fallback (no provider call) =====
  const fb = await R.call({ modelKey: 'privategpu.local', taskType: 'owner_briefing_explanation', input: 'brief', actor: 'owner', agent: 'copilot' });
  t.ok('un-governed GPU model falls back gracefully', fb.ok === true && fb.fallback === true && fb.reason === 'MODEL_NOT_GOVERNED');

  // ===== owner provisions + activates + enables, then a governed (stubbed) call =====
  await provisionAndActivate(G, 'privategpu.local', 'local-model');
  const res = await R.call({ modelKey: 'privategpu.local', taskType: 'owner_briefing_explanation', input: 'what needs me today', actor: 'owner', agent: 'owner_copilot', context: { promptVersion: 'p1' } });
  t.ok('governed GPU call returns an advisory envelope', res.ok === true && res.fallback === false && res.provider === 'private_gpu');
  t.ok('envelope carries governance + checksum + provenance', !!res.governanceVersion && !!res.outputChecksum && !!res.provenanceTraceId);
  t.ok('the call was audited (RUN_MODEL)', (await GW.recentAudit(100)).some((a) => a.action === 'RUN_MODEL' && a.decision === 'allowed'));
  t.ok('a usage row was written for the GPU provider', (await G.AAA_MODEL_CALL_PROVENANCE.usage()).some((u) => u.provider !== undefined));

  // ===== GPU DOWN → fail safe (router fallback), recorded as a failed call =====
  T.install({ endpoint: '/api/private-gpu', fetch: async () => { throw new Error('connection refused'); }, retryCap: 0, failThreshold: 5, timeoutMs: 50 });
  const down = await R.call({ modelKey: 'privategpu.local', taskType: 'owner_briefing_explanation', input: 'x', actor: 'owner', agent: 'copilot' });
  t.ok('a down GPU fails safe → governed fallback, no fake output', down.ok === true && down.fallback === true && /unavailable/.test(down.output.text));
  t.ok('the failed GPU call is recorded (visible to Reliability)', (await G.AAA_MODEL_CALL_PROVENANCE.usage({ modelKey: 'privategpu.local' })).some((u) => u.fallback === true));
  T.uninstall();

  // ===== crew denied; AI cannot enable =====
  RB.setRole('crew');
  t.eq('crew is denied GPU inference', (await R.call({ modelKey: 'privategpu.local', taskType: 'owner_briefing_explanation', input: 'x', actor: 'crew' })).error, 'FORBIDDEN');
  RB.setRole('owner');
  t.eq('AI cannot toggle the GPU model setting', (await R.setEnabled('privategpu.local', false, { origin: 'ai' })).error, 'AI_NOT_PERMITTED');

  return t.report();
};
