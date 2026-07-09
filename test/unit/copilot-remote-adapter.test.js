/* Copilot Remote Adapter — Slice E: the only path to the Custonllm endpoint.
 *
 * Guards: unconfigured = honestly absent (NO_ENDPOINT, fallback local);
 * outgoing requests are contract-valid with the session's real role and
 * workspace; and FAIL CLOSED on the way back — schema violations,
 * groundedness violations, requestId mismatches, HTTP errors, and network
 * throws are all discarded with an honest error, never rendered. */
'use strict';
const { makeRunner, setupEnv, load } = require('../helpers/harness');

module.exports = async function run() {
  const t = makeRunner('copilot-remote-adapter');
  const { G, cfg } = setupEnv({ fixedISO: '2026-07-09T16:00:00.000Z' });
  ['js/core/aaa-rbac.js', 'js/core/aaa-runtime-gateway.js',
   'js/leads/lead-store.js', 'js/quotes/quote-store.js',
   'js/copilot/copilot-contract.js', 'js/copilot/context-packet.js',
   'js/copilot/copilot-remote-adapter.js'].forEach(load);
  const R = G.AAA_COPILOT_REMOTE, C = G.AAA_COPILOT_CONTRACT;

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

  // ===== unconfigured = honestly absent =====
  t.ok('configured() is false with no endpoint flag', R.configured() === false);
  const off = await R.ask({ job: 'followups', message: 'x' });
  t.ok('no endpoint → NO_ENDPOINT with local fallback', off.error === 'NO_ENDPOINT' && off.fallback === 'local');

  cfg.set({ copilotEndpoint: 'https://proxy.example/copilot' });
  t.ok('configured() flips with the flag', R.configured() === true);

  // ===== the outgoing request is contract-valid =====
  let sentBody = null;
  stubFetch(async function (url, init) {
    sentBody = JSON.parse(init.body);
    return { ok: true, status: 200, json: async function () { return validReply(sentBody.requestId); } };
  });
  const ok = await R.ask({ job: 'followups', message: 'Who should I follow up with?' });
  t.ok('valid grounded reply is accepted', ok.ok === true && ok.response.answer === 'Nothing is going cold.');
  t.ok('the outgoing request validates against the contract', C.validateRequest(sentBody).ok === true);
  t.ok('request carries the session role + workspace, not client claims', sentBody.identity.role === 'owner' && sentBody.workspaceId === 'ws_test');
  t.ok('request carries the provisional budgets', sentBody.budgets.p95LatencyMs === 6000 && sentBody.budgets.maxCostUSDPerConversation === 0.15);
  t.ok('the packet rode inside the request', sentBody.contextPacket.sections[0].kind === 'followups');

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

  stubFetch(async function () { return { ok: true, status: 200, json: async function () { return validReply('someone_elses_id'); } }; });
  const mismatch = await R.ask({ job: 'followups', message: 'x' });
  t.ok('requestId mismatch is discarded', mismatch.error === 'REMOTE_INVALID' && mismatch.issues[0] === 'requestId mismatch');

  stubFetch(async function () { return { ok: false, status: 503, json: async function () { return {}; } }; });
  t.eq('HTTP failure is honest', (await R.ask({ job: 'followups', message: 'x' })).error, 'REMOTE_HTTP_503');
  stubFetch(async function () { throw new Error('dns down'); });
  t.eq('network throw is honest', (await R.ask({ job: 'followups', message: 'x' })).error, 'NETWORK_ERROR');
  stubFetch(async function () { return { ok: true, status: 200, json: async function () { throw new Error('bad json'); } }; });
  t.eq('non-JSON reply is honest', (await R.ask({ job: 'followups', message: 'x' })).error, 'REMOTE_NOT_JSON');

  // ===== upstream failures stay honest =====
  t.eq('packet failure is surfaced (estimate_risk needs a quoteId)', (await R.ask({ job: 'estimate_risk', message: 'x' })).error, 'PACKET_FAILED');
  delete G.fetch;
  t.eq('no fetch primitive → NO_FETCH', (await R.ask({ job: 'followups', message: 'x' })).error, 'NO_FETCH');

  return t.report();
};
