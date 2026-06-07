/* NVIDIA Nemotron adapter — provider-neutral interface, transport seam, deterministic stub. */
'use strict';
const { makeRunner, setupEnv, load } = require('../helpers/harness');

module.exports = async function run() {
  const t = makeRunner('nvidia-nemotron-adapter');
  const { G } = setupEnv();
  load('js/ai/providers/nvidia-nemotron-adapter.js');
  const A = G.AAA_NVIDIA_ADAPTER;

  // ===== interface =====
  t.ok('exposes a provider-neutral adapter interface', A.provider === 'nvidia' && typeof A.supports === 'function' && typeof A.invoke === 'function');
  t.ok('supports only nvidia.* model keys', A.supports('nvidia.nemotron4_340b_instruct') === true && A.supports('openai.gpt') === false);
  t.ok('self-registered into the shared adapter list', (G.AAA_MODEL_ADAPTERS || []).indexOf(A) !== -1);

  // ===== deterministic offline stub (no transport, no network, no key) =====
  const s1 = await A.invoke({ modelKey: 'nvidia.nemotron4_340b_instruct', modelId: 'nvidia/nemotron-4-340b-instruct', variant: 'instruct', taskType: 'owner_briefing_explanation', input: 'explain today' });
  const s2 = await A.invoke({ modelKey: 'nvidia.nemotron4_340b_instruct', modelId: 'nvidia/nemotron-4-340b-instruct', variant: 'instruct', taskType: 'owner_briefing_explanation', input: 'explain today' });
  t.ok('instruct stub returns deterministic text', s1.ok === true && s1.kind === 'text' && /nemotron-instruct stub/.test(s1.text) && s1.text === s2.text);
  t.ok('stub never required a key or network', s1.raw && s1.raw.stub === true);

  const rw = await A.invoke({ modelKey: 'nvidia.nemotron4_340b_reward', modelId: 'nvidia/nemotron-4-340b-reward', variant: 'reward', taskType: 'agent_output_score', input: { text: 'a recommendation' } });
  t.ok('reward stub returns a structured score in [0,1]', rw.ok === true && rw.kind === 'score' && rw.score >= 0 && rw.score <= 1);

  t.eq('a missing model id is refused', (await A.invoke({ variant: 'instruct', taskType: 'x' })).error, 'NO_MODEL_ID');

  // ===== injected transport (the prod path is a same-origin proxy) =====
  let seen = null;
  const transport = async (payload) => { seen = payload; return { ok: true, text: 'real-ish reply', usage: { tokens: 10 } }; };
  const viaT = await A.invoke({ modelKey: 'nvidia.nemotron4_340b_instruct', modelId: 'mid', variant: 'instruct', taskType: 'draft_customer_message', input: 'hi', transport: transport });
  t.ok('uses an injected transport when present', viaT.ok === true && viaT.text === 'real-ish reply' && seen.modelId === 'mid' && seen.provider === 'nvidia');
  t.ok('the adapter passed NO api key to the transport', !('apiKey' in seen) && !('key' in seen) && !('authorization' in seen));

  // ===== a transport failure surfaces as unavailable (→ router fallback) =====
  const bad = await A.invoke({ modelKey: 'nvidia.nemotron4_340b_instruct', modelId: 'mid', variant: 'instruct', taskType: 'x', input: 'hi', transport: async () => { throw new Error('boom'); } });
  t.eq('a throwing transport is reported as unavailable', bad.error, 'PROVIDER_UNAVAILABLE');
  const malformed = await A.invoke({ modelKey: 'nvidia.nemotron4_340b_reward', modelId: 'mid', variant: 'reward', taskType: 'x', input: 'hi', transport: async () => ({ ok: true }) });
  t.eq('a reward response with no score is rejected', malformed.error, 'BAD_REWARD_RESPONSE');

  return t.report();
};
