/*
 * Content Safety guardrail — unit tests (no network).
 *
 * Covers the tolerant verdict parser (JSON object form + Llama-Guard plain-text
 * form + unknown), the honest "not configured" gate, and that check/
 * checkResponse route to the Nemotron proxy URL with the right model/messages
 * via a stubbed AAA_CLOUD.callProxy.
 */
'use strict';
const { makeRunner, setupEnv, load } = require('../helpers/harness');

module.exports = async function run() {
  const t = makeRunner('content-safety');
  const { G, cfg } = setupEnv({ config: { firebaseProjectId: 'demo', firebaseRegion: 'us-central1', firebaseApiKey: 'k' } });

  // Give the config the real nemotronProxyUrl getter behavior via a stub.
  cfg.get_nemotronProxyUrl = undefined;
  Object.defineProperty(cfg, 'nemotronProxyUrl', { configurable: true, get() { return 'https://us-central1-demo.cloudfunctions.net/nemotronProxy'; } });
  Object.defineProperty(cfg, 'aiProvider', { configurable: true, get() { return 'claude'; } });

  // Stub the cloud: record the last callProxy(payload, url) and return a reply.
  let last = null;
  let reply = { ok: true, text: '{"User Safety":"safe"}', usage: { input_tokens: 5, output_tokens: 2 } };
  G.AAA_CLOUD = { isConfigured: () => true, async callProxy(payload, url) { last = { payload, url }; return reply; } };

  const S = (load('js/ai/content-safety.js'), G.AAA_CONTENT_SAFETY);

  // ---- parseVerdict: JSON object form ------------------------------------
  let v = S.parseVerdict('{"User Safety":"unsafe","Safety Categories":"S2, S7"}');
  t.eq('json unsafe → verdict', v.verdict, 'unsafe');
  t.ok('json unsafe → safe=false', v.safe === false);
  t.ok('categories parsed from string', v.categories.length === 2 && v.categories[0] === 'S2');
  v = S.parseVerdict('{"User Safety":"safe"}');
  t.ok('json safe → safe=true', v.safe === true && v.verdict === 'safe');
  v = S.parseVerdict('prefix {"Response Safety":"unsafe"} suffix');
  t.ok('embedded json object is recovered', v.safe === false && v.responseSafety === 'unsafe');

  // ---- parseVerdict: plain-text (Llama-Guard) form -----------------------
  v = S.parseVerdict('unsafe\nS5');
  t.ok('plain unsafe → safe=false', v.safe === false && v.categories[0] === 'S5');
  t.ok('plain safe → safe=true', S.parseVerdict('safe').safe === true);

  // ---- parseVerdict: unknown is null, never a false "safe" ---------------
  t.ok('empty → unknown/null', S.parseVerdict('').safe === null && S.parseVerdict('').verdict === 'unknown');
  t.ok('garbage → unknown/null', S.parseVerdict('???').safe === null);

  // ---- check(): routing, model, URL, parsed result -----------------------
  reply = { ok: true, text: '{"User Safety":"unsafe","Safety Categories":"S2"}', usage: {} };
  let r = await S.check('how can I steal money');
  t.ok('check ok', r.ok === true);
  t.ok('check flagged unsafe', r.flagged === true && r.safe === false);
  t.eq('routed to nemotron proxy URL', last.url, 'https://us-central1-demo.cloudfunctions.net/nemotronProxy');
  t.eq('uses content-safety model', last.payload.model, 'nvidia/nemotron-3-content-safety');
  t.ok('low temperature for stable verdict', last.payload.temperature === 0.2 && last.payload.top_p === 0.7);
  t.ok('single user message', last.payload.messages.length === 1 && last.payload.messages[0].role === 'user');

  // categories opt-in → chat_template_kwargs.request_categories
  await S.check('hi', { categories: '/categories' });
  t.ok('categories forwarded as request_categories', last.payload.chat_template_kwargs.request_categories === '/categories');
  await S.check('hi');
  t.ok('no categories → no chat_template_kwargs', last.payload.chat_template_kwargs === undefined);

  // ---- checkResponse(): user+assistant context ---------------------------
  reply = { ok: true, text: '{"User Safety":"safe","Response Safety":"safe"}', usage: {} };
  r = await S.checkResponse('Can you help?', 'Yes, here is your quote.');
  t.ok('checkResponse ok + safe', r.ok === true && r.safe === true);
  t.ok('sends user then assistant', last.payload.messages.length === 2 && last.payload.messages[1].role === 'assistant');

  // ---- guards ------------------------------------------------------------
  t.eq('empty text rejected', (await S.check('   ')).error, 'EMPTY_TEXT');
  t.eq('empty response rejected', (await S.checkResponse('q', '')).error, 'EMPTY_TEXT');

  // not configured → honest error, no fabricated verdict
  G.AAA_CLOUD = { isConfigured: () => false, async callProxy() { throw new Error('should not be called'); } };
  load('js/ai/content-safety.js');
  t.eq('not configured → AI_NOT_CONFIGURED', (await G.AAA_CONTENT_SAFETY.check('x')).error, 'AI_NOT_CONFIGURED');

  return t.report();
};
