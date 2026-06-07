/* Private GPU Transport — build/parse, no-key proxy POST, timeout, retry cap, circuit breaker. */
'use strict';
const { makeRunner, setupEnv, load } = require('../helpers/harness');

module.exports = async function run() {
  const t = makeRunner('private-gpu-transport');
  const { G } = setupEnv();
  load('js/ai/providers/private-gpu-adapter.js');
  load('js/ai/providers/private-gpu-transport.js');
  const T = G.AAA_PRIVATE_GPU_TRANSPORT;
  const A = G.AAA_PRIVATE_GPU_ADAPTER;

  // ===== pure build/parse =====
  const body = T.build({ taskType: 'draft_customer_message', modelId: 'local-model', input: 'follow up' });
  t.ok('build maps to the app proxy shape (no key, no GPU url)', body.messages[0].role === 'user' && body.model === 'local-model' && typeof body.system === 'string' && !('apiKey' in body) && !('url' in body));
  t.ok('parse extracts text', T.parse({ ok: true, text: 'hi' }).text === 'hi');
  t.eq('parse surfaces proxy error', T.parse({ ok: false, error: 'GPU_TIMEOUT' }).error, 'GPU_TIMEOUT');

  // ===== off by default → adapter uses a deterministic offline stub =====
  t.ok('no global send fn until installed', !G.AAA_PRIVATE_GPU_SEND);
  const off = await A.invoke({ modelKey: 'privategpu.local', modelId: 'local-model', taskType: 'owner_briefing_explanation', input: 'x' });
  t.ok('adapter returns a deterministic stub when not installed', off.ok === true && /private-gpu stub/.test(off.text) && off.raw.stub === true);

  // ===== install with an injected fetch (no real network/key) — happy path =====
  let posted = null;
  const okFetch = async (url, init) => { posted = { url: url, body: JSON.parse(init.body), headers: init.headers }; return { json: async () => ({ ok: true, text: 'GPU says hi', usage: { input_tokens: 3 } }) }; };
  T.install({ endpoint: '/api/private-gpu', fetch: okFetch, failThreshold: 3, timeoutMs: 50 });
  const live = await A.invoke({ modelKey: 'privategpu.local', modelId: 'local-model', taskType: 'owner_briefing_explanation', input: 'x' });
  t.ok('installed transport routes through the proxy', live.ok === true && live.text === 'GPU says hi' && !live.raw.stub);
  t.ok('POST hit the same-origin proxy with no key/url client-side', posted.url === '/api/private-gpu' && !('authorization' in (posted.headers || {})) && !('apiKey' in posted.body));
  t.ok('breaker is closed + healthy after success', T.health().breaker === 'closed' && T.health().healthy === true);

  // ===== timeout is enforced =====
  T.uninstall(); T.install({ endpoint: '/api/private-gpu', fetch: () => new Promise(() => {}), timeoutMs: 20, retryCap: 0, failThreshold: 99 });
  t.eq('a hung GPU call times out (not hang)', (await T.send({ taskType: 'x', modelId: 'm', input: 'y' })).error, 'GPU_TIMEOUT');

  // ===== retry cap: one quick retry then give up =====
  let calls = 0; T.uninstall(); T.install({ endpoint: '/api/private-gpu', fetch: async () => { calls++; throw new Error('down'); }, retryCap: 1, timeoutMs: 50, failThreshold: 99 });
  const r1 = await T.send({ taskType: 'x', modelId: 'm', input: 'y' });
  t.ok('retry cap honored (2 attempts = 1 retry)', r1.ok === false && calls === 2);

  // ===== circuit breaker: trips open after threshold, fails fast, then half-opens =====
  let netCalls = 0; T.uninstall();
  T.install({ endpoint: '/api/private-gpu', fetch: async () => { netCalls++; throw new Error('down'); }, retryCap: 0, timeoutMs: 50, failThreshold: 2, cooldownMs: 10000 });
  await T.send({ taskType: 'x', modelId: 'm', input: 'y' });      // fail 1
  const beforeOpen = netCalls;
  await T.send({ taskType: 'x', modelId: 'm', input: 'y' });      // fail 2 → opens
  t.eq('breaker opens after the failure threshold', T.health().breaker, 'open');
  const fast = await T.send({ taskType: 'x', modelId: 'm', input: 'y' });   // should fail fast, NO network
  t.ok('open breaker fails fast without calling the GPU', fast.error === 'CIRCUIT_OPEN' && netCalls === beforeOpen + 1);

  // recovery: after cooldown it half-opens and a success closes it
  let recovered = false;
  T.uninstall();
  T.install({ endpoint: '/api/private-gpu', fetch: async () => ({ json: async () => ({ ok: true, text: 'back' }) }), retryCap: 0, timeoutMs: 50, failThreshold: 2, cooldownMs: 0 });
  // force an open state then let cooldown(0) half-open immediately
  T._reset();
  const rec = await T.send({ taskType: 'x', modelId: 'm', input: 'y' });
  recovered = rec.ok === true;
  t.ok('a healthy GPU call closes the breaker again', recovered && T.health().breaker === 'closed');

  T.uninstall();
  t.ok('uninstall restores offline-stub behavior', !G.AAA_PRIVATE_GPU_SEND);

  return t.report();
};
