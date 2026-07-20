/* Copilot Remote Adapter — Slice E: the only path to the Custonllm endpoint.
 *
 * Guards: unconfigured = honestly absent (NO_ENDPOINT, fallback local);
 * outgoing requests are contract-valid with the session's real role and
 * workspace; and FAIL CLOSED on the way back — schema violations,
 * groundedness violations, evidence-integrity violations, requestId
 * mismatches, HTTP errors, contract refusals, deadline overruns, and network
 * throws are all discarded with an honest error + contract-shaped degraded
 * reason, never rendered. Every result carries timing; identical concurrent
 * asks share one flight; telemetry records automatically when present. */
'use strict';
const { makeRunner, setupEnv, load } = require('../helpers/harness');

module.exports = async function run() {
  const t = makeRunner('copilot-remote-adapter');
  const { G, cfg } = setupEnv({ fixedISO: '2026-07-09T16:00:00.000Z' });
  ['js/core/aaa-rbac.js', 'js/core/aaa-runtime-gateway.js',
   'js/leads/lead-store.js', 'js/quotes/quote-store.js',
   'js/copilot/copilot-contract.js', 'js/copilot/context-packet.js',
   'js/copilot/copilot-telemetry.js',
   'js/copilot/copilot-remote-adapter.js'].forEach(load);
  const R = G.AAA_COPILOT_REMOTE, C = G.AAA_COPILOT_CONTRACT, TEL = G.AAA_COPILOT_TELEMETRY;

  // a follow-up-able quote so the packet has content
  const draft = await G.AAA_QUOTES.createDraft({ estimate: { quote: { _laborTotal: 100, _materialTotal: 50, total: 400 }, receipt: { total: 400 } } });
  await G.AAA_QUOTES.markReviewed(draft.id, { actor: 'owner' });
  await G.AAA_QUOTES.send(draft.id, { actor: 'owner' });
  const sent = await G.AAA_QUOTES.get(draft.id);
  await G.AAA_DATA.put('quotes', draft.id, Object.assign({}, sent, { sentAt: '2026-07-01T00:00:00.000Z', updatedAt: '2026-07-01T00:00:00.000Z' }));

  // a minimal valid, grounded reply (no digits, empty cards, honest unknowns)
  function validReply(requestId) {
    return { contractVersion: '1.0', requestId: requestId, answer: 'Nothing is going cold.',
      cards: [], evidence: [], confidence: 30, unknowns: ['thin data'], approval: { required: false } };
  }
  function stubFetch(handler) { G.fetch = handler; }
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  // ===== unconfigured = honestly absent =====
  t.ok('configured() is false with no endpoint flag', R.configured() === false);
  const off = await R.ask({ job: 'followups', message: 'x' });
  t.ok('no endpoint → NO_ENDPOINT with local fallback', off.error === 'NO_ENDPOINT' && off.fallback === 'local');
  t.ok('no endpoint → contract-shaped degraded reason', off.degraded && off.degraded.reason === 'adapter_unavailable' && off.degraded.fallback === 'local');
  t.ok('failure carries timing', off.timing && typeof off.timing.latencyMs === 'number' && typeof off.timing.withinBudget === 'boolean');

  cfg.set({ copilotEndpoint: 'https://proxy.example/copilot' });
  t.ok('configured() flips with the flag', R.configured() === true);

  // ===== the outgoing request is contract-valid =====
  let sentBody = null;
  stubFetch(async function (url, init) {
    sentBody = JSON.parse(init.body);
    return { ok: true, status: 200, json: async function () { return validReply(sentBody.requestId); } };
  });
  TEL.reset();
  const ok = await R.ask({ job: 'followups', message: 'Who should I follow up with?' });
  t.ok('valid grounded reply is accepted', ok.ok === true && ok.response.answer === 'Nothing is going cold.');
  t.ok('the outgoing request validates against the contract', C.validateRequest(sentBody).ok === true);
  t.ok('request carries the session role + workspace, not client claims', sentBody.identity.role === 'owner' && sentBody.workspaceId === 'ws_test');
  t.ok('request carries the provisional budgets', sentBody.budgets.p95LatencyMs === 6000 && sentBody.budgets.maxCostUSDPerConversation === 0.15);
  t.ok('the packet rode inside the request', sentBody.contextPacket.sections[0].kind === 'followups');
  t.ok('success carries timing split', ok.timing && typeof ok.timing.latencyMs === 'number' && typeof ok.timing.packetMs === 'number' && typeof ok.timing.fetchMs === 'number');
  t.ok('success is within budget under the fixed clock', ok.timing.withinBudget === true);
  t.ok('success has no degraded reason', ok.degraded === undefined);
  t.ok('adapter auto-recorded remote_ok telemetry', TEL.summary().byOutcome.remote_ok === 1 && TEL.summary().byJob.followups === 1);

  // ===== fail closed on the way back =====
  stubFetch(async function () { return { ok: true, status: 200, json: async function () { return { contractVersion: '1.0', requestId: 'whatever', answer: 'hi' }; } }; });
  t.eq('schema-violating reply is discarded', (await R.ask({ job: 'followups', message: 'x' })).error, 'REMOTE_INVALID');

  stubFetch(async function (url, init) {
    const req = JSON.parse(init.body);
    const r = validReply(req.requestId);
    r.answer = 'Revenue was $4,200.'; // digits with zero evidence
    r.confidence = 90;
    return { ok: true, status: 200, json: async function () { return r; } };
  });
  const ungrounded = await R.ask({ job: 'followups', message: 'x' });
  t.ok('groundedness-violating reply is discarded', ungrounded.error === 'REMOTE_INVALID' && ungrounded.issues.some((i) => /NUMBER_WITHOUT_EVIDENCE/.test(i)));
  t.ok('invalid reply degrades as model_unavailable', ungrounded.degraded && ungrounded.degraded.reason === 'model_unavailable');

  // schema-valid + grounded, but cites a record the packet never carried
  stubFetch(async function (url, init) {
    const req = JSON.parse(init.body);
    const r = validReply(req.requestId);
    r.evidence = [{ claim: 'a quote is going cold', sourceRefs: [{ collection: 'quotes', id: 'q_fabricated' }] }];
    return { ok: true, status: 200, json: async function () { return r; } };
  });
  const fabricated = await R.ask({ job: 'followups', message: 'x' });
  t.ok('evidence citing a record outside the packet is discarded', fabricated.error === 'REMOTE_INVALID' && fabricated.issues.some((i) => /EVIDENCE_NOT_IN_PACKET/.test(i)));

  stubFetch(async function () { return { ok: true, status: 200, json: async function () { return validReply('someone_elses_id'); } }; });
  const mismatch = await R.ask({ job: 'followups', message: 'x' });
  t.ok('requestId mismatch is discarded', mismatch.error === 'REMOTE_INVALID' && mismatch.issues[0] === 'requestId mismatch');

  stubFetch(async function () { return { ok: false, status: 503, json: async function () { return {}; } }; });
  const http = await R.ask({ job: 'followups', message: 'x' });
  t.eq('HTTP failure is honest', http.error, 'REMOTE_HTTP_503');
  t.ok('HTTP failure degrades as model_unavailable', http.degraded && http.degraded.reason === 'model_unavailable');

  // non-2xx carrying a contract errorEnvelope surfaces the machine-readable refusal
  stubFetch(async function () {
    return { ok: false, status: 403, json: async function () {
      return { contractVersion: '1.0', error: { code: 'permission_denied', message: 'crew cannot ask this' } };
    } };
  });
  const refused = await R.ask({ job: 'followups', message: 'x' });
  t.ok('contract refusal surfaces as REMOTE_REFUSED with the code', refused.error === 'REMOTE_REFUSED' && refused.code === 'permission_denied');

  stubFetch(async function () { throw new Error('dns down'); });
  const net = await R.ask({ job: 'followups', message: 'x' });
  t.eq('network throw is honest', net.error, 'NETWORK_ERROR');
  t.ok('network throw degrades as model_unavailable', net.degraded && net.degraded.reason === 'model_unavailable');
  stubFetch(async function () { return { ok: true, status: 200, json: async function () { throw new Error('bad json'); } }; });
  t.eq('non-JSON reply is honest', (await R.ask({ job: 'followups', message: 'x' })).error, 'REMOTE_NOT_JSON');

  // ===== budget flag sanitization =====
  cfg.set({ copilotP95LatencyMs: -5, copilotMaxCostUSD: Number.NaN });
  stubFetch(async function (url, init) {
    sentBody = JSON.parse(init.body);
    return { ok: true, status: 200, json: async function () { return validReply(sentBody.requestId); } };
  });
  await R.ask({ job: 'followups', message: 'sanitize me' });
  t.ok('garbage budget flags fall back to defaults', sentBody.budgets.p95LatencyMs === 6000 && sentBody.budgets.maxCostUSDPerConversation === 0.15);

  // ===== client-side deadline: the fetch runs inside the request's budget =====
  cfg.set({ copilotP95LatencyMs: 30, copilotMaxCostUSD: 0.15 });
  stubFetch(function (url, init) {
    const req = JSON.parse(init.body);
    return new Promise(function (resolve) {
      setTimeout(function () { resolve({ ok: true, status: 200, json: async function () { return validReply(req.requestId); } }); }, 100);
    });
  });
  TEL.reset();
  const slow = await R.ask({ job: 'followups', message: 'take your time' });
  t.eq('a fetch slower than the budget times out', slow.error, 'REMOTE_TIMEOUT');
  t.ok('timeout degrades as budget_exceeded', slow.degraded && slow.degraded.reason === 'budget_exceeded');
  t.ok('timeout is never within budget', slow.timing && slow.timing.withinBudget === false);
  t.ok('timeout was recorded as remote_failed', TEL.summary().byError.REMOTE_TIMEOUT === 1);
  await sleep(120); // let the straggling stub settle harmlessly
  cfg.set({ copilotP95LatencyMs: 6000 });

  // ===== single-flight dedupe: identical concurrent asks share one request =====
  let fetchCount = 0;
  stubFetch(function (url, init) {
    fetchCount++;
    const req = JSON.parse(init.body);
    return new Promise(function (resolve) {
      setTimeout(function () { resolve({ ok: true, status: 200, json: async function () { return validReply(req.requestId); } }); }, 20);
    });
  });
  const pair = await Promise.all([
    R.ask({ job: 'followups', message: 'same question' }),
    R.ask({ job: 'followups', message: 'same question' })
  ]);
  t.ok('identical concurrent asks share one fetch', fetchCount === 1 && pair[0] === pair[1] && pair[0].ok === true);
  const different = await Promise.all([
    R.ask({ job: 'followups', message: 'question A' }),
    R.ask({ job: 'followups', message: 'question B' })
  ]);
  t.ok('different messages do not share a flight', fetchCount === 3 && different[0].ok === true && different[1].ok === true);
  await R.ask({ job: 'followups', message: 'same question' });
  t.ok('the in-flight entry is cleared on settle (re-ask refetches)', fetchCount === 4);

  // ===== upstream failures stay honest =====
  const noPacket = await R.ask({ job: 'estimate_risk', message: 'x' });
  t.eq('packet failure is surfaced (estimate_risk needs a quoteId)', noPacket.error, 'PACKET_FAILED');
  t.ok('packet failure degrades as context_unavailable', noPacket.degraded && noPacket.degraded.reason === 'context_unavailable');
  delete G.fetch;
  t.eq('no fetch primitive → NO_FETCH', (await R.ask({ job: 'followups', message: 'x' })).error, 'NO_FETCH');

  // ===== the deadline covers the BODY, not just the headers =====
  // A server that answers headers instantly and then stalls the body must
  // still be cut off at the budget — no eternal spinner, no pinned flight.
  cfg.set({ copilotP95LatencyMs: 30 });
  stubFetch(async function () {
    return { ok: true, status: 200, json: function () { return sleep(150).then(function () { return validReply('late'); }); } };
  });
  const bodyStall = await R.ask({ job: 'followups', message: 'body stall' });
  t.ok('a stalled body times out at the budget (REMOTE_TIMEOUT, budget_exceeded)',
    bodyStall.error === 'REMOTE_TIMEOUT' && bodyStall.degraded.reason === 'budget_exceeded');
  const afterStall = await R.ask({ job: 'followups', message: 'body stall' });
  t.ok('the in-flight entry is released after a body-stall timeout', afterStall.error === 'REMOTE_TIMEOUT');
  cfg.set({ copilotP95LatencyMs: null });

  return t.report();
};
