'use strict';
const path = require('path');
const { makeRunner, setupEnv, load, ROOT } = require('../helpers/harness');

module.exports = async function run() {
  const t = makeRunner('openai');
  const lib = await import(path.join(ROOT, 'netlify/lib/openai.mjs'));
  const { authorizeOpenAI } = await import(path.join(ROOT, 'netlify/lib/openai-auth.mjs'));
  const endpoint = (await import(path.join(ROOT, 'netlify/functions/openai.mjs'))).createHandler({ budget: async () => {} });
  const vision = (await import(path.join(ROOT, 'netlify/functions/vision.mjs'))).createHandler({ budget: async () => {} });
  const schema = { type: 'object', properties: { answer: { type: 'string' }, notes: { type: 'array', items: { type: 'string' } } }, required: ['answer'], additionalProperties: false };
  const request = { model: lib.MODEL, system: [{ type: 'text', text: 'Use evidence.', cache_control: { type: 'ephemeral' } }], max_tokens: 700,
    output_config: { format: { type: 'json_schema', schema } }, messages: [{ role: 'user', content: [
      { type: 'text', text: 'Inspect the carpet.' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'aGVsbG8=' } }
    ] }] };
  const before = JSON.stringify(request);
  const payload = lib.toRequest(request, {});
  t.eq('exact model id', payload.model, 'gpt-6-astra');
  t.eq('system instructions preserved', payload.instructions, 'Use evidence.');
  t.eq('photo translated to image input', payload.input[0].content[1].image_url, 'data:image/png;base64,aGVsbG8=');
  t.eq('reasoning has its own total budget', payload.max_output_tokens, 8192);
  t.eq('responses storage disabled', payload.store, false);
  t.eq('strict schema enabled', payload.text.format.strict, true);
  t.eq('optional field made nullable', payload.text.format.schema.properties.notes.anyOf[1].type, 'null');
  t.eq('request not mutated', JSON.stringify(request), before);
  const failure = async (label, fn, code) => {
    try { await fn(); t.ok(label + ' must fail', false); }
    catch (e) { t.eq(label, e.code, code); }
  };
  await failure('unknown model rejected', () => lib.toRequest({ ...request, model: 'other' }), 'UNSUPPORTED_MODEL');
  await failure('unsupported blocks rejected', () => lib.toRequest({ messages: [{ role: 'user', content: [{ type: 'tool_result' }] }] }), 'UNSUPPORTED_CONTENT');
  await failure('tool requests not silently dropped', () => lib.toRequest({ ...request, tools: [] }), 'UNSUPPORTED_REQUEST');
  await failure('unsupported effort rejected', () => lib.toRequest(request, { OPENAI_REASONING_EFFORT: 'none' }), 'INVALID_OPENAI_CONFIG');
  await failure('oversized output budget rejected', () => lib.toRequest(request, { OPENAI_MAX_OUTPUT_TOKENS: '1000000' }), 'INVALID_OPENAI_CONFIG');
  await failure('malformed JSON rejected', () => lib.readBody(new Request('https://app/api/openai', { method: 'POST', body: '{' })), 'INVALID_JSON');
  await failure('oversized request rejected', () => lib.readBody(new Request('https://app/api/openai', { method: 'POST', body: '{}', headers: { 'content-length': String(lib.MAX_BODY_BYTES + 1) } })), 'REQUEST_TOO_LARGE');

  const completed = (text) => ({ status: 'completed', id: 'resp_fixture', model: lib.MODEL,
    output: [{ type: 'reasoning', summary: [] }, { type: 'message', content: [{ type: 'output_text', text }] }], usage: { input_tokens: 123, output_tokens: 456 } });
  t.eq('reasoning items skipped when extracting text', lib.fromResponse(completed('OK')).text, 'OK');
  t.eq('token usage preserved', lib.fromResponse(completed('OK')).usage.output_tokens, 456);
  await failure('truncated JSON is never a success', () => lib.fromResponse({ ...completed('{'), status: 'incomplete' }), 'PROVIDER_INCOMPLETE');
  await failure('refusal is never a success', () => lib.fromResponse({ status: 'completed', output: [{ type: 'message', content: [{ type: 'refusal', refusal: 'no' }] }] }), 'PROVIDER_REFUSAL');
  await failure('empty response rejected', () => lib.fromResponse(completed('')), 'EMPTY_OUTPUT');

  const env = { OPENAI_API_KEY: 'fixture-provider-key', OPENAI_AUTH_PROVIDER: 'firebase', OPENAI_ALLOWED_USER_IDS: 'owner_1', FIREBASE_PROJECT_ID: 'aaa-test', FIREBASE_WEB_API_KEY: 'fixture-public-key' };
  const claims = { aud: 'aaa-test', iss: 'https://securetoken.google.com/aaa-test', sub: 'owner_1', exp: Math.floor(Date.now() / 1000) + 3600 };
  const tokenFor = c => 'header.' + Buffer.from(JSON.stringify(c)).toString('base64url') + '.signature';
  const req = (body = request, token = tokenFor(claims)) => new Request('https://app/api/openai', { method: 'POST', headers: token ? { authorization: 'Bearer ' + token } : {}, body: JSON.stringify(body) });
  let calls = [];
  const authFetch = async (url, options) => { calls.push({ url, options }); return new Response(JSON.stringify({ users: [{ localId: 'owner_1' }] })); };
  t.eq('verified allowlisted Firebase user authorized', await authorizeOpenAI(req(), { env, fetchImpl: authFetch }), 'owner_1');
  t.eq('Firebase validates the actual bearer token', JSON.parse(calls[0].options.body).idToken, tokenFor(claims));
  await failure('missing allowlist disables endpoint', () => authorizeOpenAI(req(), { env: {}, fetchImpl: authFetch }), 'OPENAI_AUTH_NOT_CONFIGURED');
  calls = [];
  await failure('missing session denied', () => authorizeOpenAI(req(request, ''), { env, fetchImpl: authFetch }), 'SIGN_IN_REQUIRED');
  t.eq('no network for missing session', calls.length, 0);
  await failure('cross-project token denied', () => authorizeOpenAI(req(request, tokenFor({ ...claims, aud: 'other' })), { env, fetchImpl: authFetch }), 'INVALID_SESSION');
  await failure('expired token denied', () => authorizeOpenAI(req(request, tokenFor({ ...claims, exp: 1 })), { env, fetchImpl: authFetch }), 'INVALID_SESSION');
  await failure('forged claims alone cannot authenticate', () => authorizeOpenAI(req(), { env, fetchImpl: async () => new Response('{}', { status: 400 }) }), 'INVALID_SESSION');
  await failure('non-allowlisted user denied', () => authorizeOpenAI(req(), { env: { ...env, OPENAI_ALLOWED_USER_IDS: 'different_owner' }, fetchImpl: authFetch }), 'OPENAI_ACCESS_DENIED');
  await failure('disabled user denied', () => authorizeOpenAI(req(), { env, fetchImpl: async () => new Response(JSON.stringify({ users: [{ localId: 'owner_1', disabled: true }] })) }), 'INVALID_SESSION');
  await failure('auth outage fails closed', () => authorizeOpenAI(req(), { env, fetchImpl: async () => { throw new Error('fixture secret'); } }), 'AUTH_UNAVAILABLE');
  t.eq('Supabase session verified by configured server', await authorizeOpenAI(req(), {
    env: { ...env, OPENAI_AUTH_PROVIDER: 'supabase', SUPABASE_URL: 'https://project.supabase.co', SUPABASE_ANON_KEY: 'public' },
    fetchImpl: async (url) => { t.eq('fixed Supabase auth destination', url, 'https://project.supabase.co/auth/v1/user'); return new Response(JSON.stringify({ id: 'owner_1' })); }
  }), 'owner_1');

  const savedFetch = global.fetch;
  const saved = Object.fromEntries(Object.keys(env).map(k => [k, process.env[k]]));
  try {
    Object.assign(process.env, env);
    calls = [];
    global.fetch = async (url, options) => {
      calls.push({ url, options });
      return new Response(JSON.stringify(url.startsWith('https://identitytoolkit.') ? { users: [{ localId: 'owner_1' }] } : completed('{"answer":"OK","notes":null}')));
    };
    t.eq('GET not allowed', (await endpoint(new Request('https://app/api/openai'))).status, 405);
    t.eq('anonymous endpoint call rejected', (await endpoint(req(request, ''))).status, 401);
    t.eq('unauthorized request cannot reach paid provider', calls.length, 0);
    const response = await endpoint(req());
    t.eq('authenticated message request succeeds', response.status, 200);
    t.eq('response not cached', response.headers.get('cache-control'), 'no-store');
    t.eq('actual model returned', (await response.json()).model, lib.MODEL);
    t.eq('Responses endpoint used', calls[1].url, 'https://api.openai.com/v1/responses');
    t.eq('only provider key sent upstream', calls[1].options.headers.authorization, 'Bearer fixture-provider-key');
    t.ok('no app session sent upstream', !calls[1].options.body.includes(tokenFor(claims)));
    global.fetch = async (url) => url.startsWith('https://identitytoolkit.') ? new Response(JSON.stringify({ users: [{ localId: 'owner_1' }] })) : new Response('{"error":{"message":"fixture-provider-key"}}', { status: 429 });
    const limited = await endpoint(req());
    t.eq('rate limit surfaced', limited.status, 429);
    t.eq('raw provider error hidden', (await limited.json()).error, 'PROVIDER_RATE_LIMITED');

    const analysis = { type: 'Seam repair', severity: 'LOW', confidence: 70, estimatedTimeMins: 30, estimatedQuoteRange: '$150-$250', materials: ['Seam tape'], recommendedNextStep: 'Measure the seam.', summary: 'Visible seam separation.' };
    global.fetch = async (url, options) => {
      if (url.startsWith('https://identitytoolkit.')) return new Response(JSON.stringify({ users: [{ localId: 'owner_1' }] }));
      const body = JSON.parse(options.body);
      t.eq('vision uses requested model', body.model, lib.MODEL);
      t.eq('vision estimate schema preserved', body.text.format.schema.properties.severity.enum.join(','), 'LOW,MEDIUM,HIGH');
      return new Response(JSON.stringify(completed(JSON.stringify(analysis))));
    };
    const photo = await vision(req({ image: 'aGVsbG8=', mediaType: 'image/png', model: lib.MODEL }));
    t.eq('photo analysis succeeds', photo.status, 200);
    t.eq('photo response contract preserved', (await photo.json()).analysis.type, analysis.type);
    t.eq('photo also requires session', (await vision(req({ image: 'aGVsbG8=', model: lib.MODEL }, ''))).status, 401);
  } finally {
    global.fetch = savedFetch;
    for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }

  // Exercise the actual client routing seam, not just the adapter.
  const { G, data } = setupEnv();
  G.AAA_LOCAL_FIRST_STORAGE = { get: data.get, put: data.put, getAll: data.list };
  G.AAA_CONFIG.premiumModel = 'gpt-6-astra';
  G.AAA_CONFIG.isProxyConfigured = () => true;
  G.AAA_CLOUD = { callProxy: async (body, url) => { calls.push({ body, url }); return { ok: true, text: 'OK', model: body.model }; } };
  load('js/agents/model-router.js');
  load('js/core/aaa-data.js');
  load('js/ai/tenant-model-policy.js');
  const router = G.AAA_MODEL_ROUTER;
  t.eq('owner choice applies to planning', router.route('planning').model, lib.MODEL);
  t.eq('routine triage stays Haiku', router.route('triage').model, router.MODELS.HAIKU);
  t.eq('worker tier stays Sonnet', router.forAgent(router.MODELS.SONNET).model, router.MODELS.SONNET);
  t.eq('premium agent uses Astra', router.forAgent(router.MODELS.OPUS).model, lib.MODEL);
  calls = [];
  await G.AAA_DATA.callAgent({ model: router.MODELS.OPUS, messages: [{ role: 'user', content: 'Plan' }] });
  t.eq('legacy pinned premium callers use Astra', calls[0].body.model, lib.MODEL);
  t.eq('Astra gets explicit OpenAI endpoint', calls[0].url, '/api/openai');
  await G.AAA_TENANT_MODEL_POLICY.setPolicy({ allowedModels: ['nonexistent'] });
  calls = [];
  t.eq('tenant deny stops paid call', (await G.AAA_DATA.callAgent({ model: router.MODELS.OPUS })).error, 'NO_ALLOWED_MODEL_FOR_TENANT');
  t.eq('no network on tenant deny', calls.length, 0);
  await G.AAA_TENANT_MODEL_POLICY.setPolicy({ allowedModels: [router.MODELS.SONNET] });
  await G.AAA_DATA.callAgent({ model: router.MODELS.OPUS });
  t.eq('policy substitute honored', calls[0].body.model, router.MODELS.SONNET);
  t.eq('substitute uses original provider path', calls[0].url, undefined);
  await G.AAA_TENANT_MODEL_POLICY.setPolicy({ allowedModels: [lib.MODEL] });
  t.eq('unknown residency is not invented', G.AAA_TENANT_MODEL_POLICY.evaluate(lib.MODEL, { residency: 'eu' }).allowed, false);
  calls = [];
  G.AAA_CLOUD.callProxy = async () => { calls.push({}); return { ok: false, error: 'PROVIDER_INCOMPLETE' }; };
  await G.AAA_DATA.callAgent(request);
  t.eq('OpenAI errors not retried with schema stripped', calls.length, 1);
  G.AAA_CONFIG.premiumModel = router.MODELS.OPUS;
  t.eq('switching back restores premium model', router.route('planning').model, router.MODELS.OPUS);
  return t.report();
};
