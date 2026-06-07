/* Nemotron Transport — pure build/parse, no-key proxy POST, install seam, offline-by-default. */
'use strict';
const { makeRunner, setupEnv, load } = require('../helpers/harness');

module.exports = async function run() {
  const t = makeRunner('nemotron-transport');
  const { G } = setupEnv();
  load('js/ai/providers/nvidia-nemotron-adapter.js');
  load('js/ai/providers/nemotron-transport.js');
  const T = G.AAA_NEMOTRON_TRANSPORT;
  const A = G.AAA_NVIDIA_ADAPTER;

  // ===== pure build maps to the proxy request shape =====
  const body = T.build({ taskType: 'draft_customer_message', modelId: 'nvidia/nemotron-4-340b-instruct', input: 'follow up with Jane' });
  t.ok('build produces the proxy request shape', Array.isArray(body.messages) && body.messages[0].role === 'user' && body.model === 'nvidia/nemotron-4-340b-instruct' && typeof body.system === 'string' && typeof body.max_tokens === 'number');
  t.ok('build carries a task-appropriate system prompt + never a key', /never promise pricing/.test(body.system) && !('apiKey' in body) && !('authorization' in body));
  t.ok('object input is serialized into the user message', /Jane|follow up/.test(body.messages[0].content));

  // ===== pure parse maps proxy responses back =====
  t.ok('parse extracts text from a proxy reply', T.parse({ ok: true, text: 'Hi Jane!' }, 'instruct').text === 'Hi Jane!');
  t.eq('parse surfaces a proxy error', T.parse({ ok: false, error: 'UPSTREAM' }, 'instruct').error, 'UPSTREAM');
  t.eq('parse needs a score for reward', T.parse({ ok: true }, 'reward').error, 'NO_SCORE');
  t.ok('parse reads a reward score', T.parse({ ok: true, score: 0.8 }, 'reward').score === 0.8);

  // ===== off by default: no global transport until installed =====
  t.ok('the global transport is NOT installed by default (offline-safe)', !G.AAA_MODEL_TRANSPORT);
  t.eq('install refuses without an endpoint', T.install({}).error, 'NO_ENDPOINT');

  // ===== install with an injected fetch (no real network, no key) =====
  let posted = null;
  const fakeFetch = async (url, init) => { posted = { url: url, body: JSON.parse(init.body), headers: init.headers }; return { json: async () => ({ ok: true, text: 'Suggested: Hi Jane, following up!', usage: { tokens: 12 } }) }; };
  const inst = T.install({ endpoint: '/api/nemotron', fetch: fakeFetch });
  t.ok('install wires the global transport', inst.ok === true && typeof G.AAA_MODEL_TRANSPORT === 'function' && T.status().mode === 'live');

  // ===== the adapter now uses the live transport (still no key client-side) =====
  const res = await A.invoke({ modelKey: 'nvidia.nemotron4_340b_instruct', modelId: 'nvidia/nemotron-4-340b-instruct', variant: 'instruct', taskType: 'draft_customer_message', input: 'follow up with Jane' });
  t.ok('adapter routes through the installed transport', res.ok === true && /following up/.test(res.text) && !res.raw.stub);
  t.ok('the POST went to the proxy with no api key attached', posted.url === '/api/nemotron' && !('apiKey' in posted.body) && !('authorization' in (posted.headers || {})));

  // ===== reward unsupported without a scoring endpoint → router will fall back =====
  const rw = await T.send({ variant: 'reward', modelId: 'm', input: { text: 'x' } });
  t.eq('reward scoring is unsupported without a scoring endpoint', rw.error, 'REWARD_NOT_SUPPORTED');

  // ===== a transport failure is caught (→ adapter unavailable → router fallback) =====
  T.install({ endpoint: '/api/nemotron', fetch: async () => { throw new Error('network down'); } });
  t.eq('a failing fetch is caught, not thrown', (await T.send({ variant: 'instruct', modelId: 'm', input: 'x' })).error, 'TRANSPORT_FAILED');

  // ===== uninstall restores offline-stub behavior =====
  T.uninstall();
  t.ok('uninstall removes the global transport', !G.AAA_MODEL_TRANSPORT);

  return t.report();
};
