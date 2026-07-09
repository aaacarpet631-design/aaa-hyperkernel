/* Copilot Chat Bridge + Contract Card Renderer — Slice E: phase-one questions
 * route to the remote copilot, everything else (and every failure) falls
 * through to the local path; responses render escape-safe with evidence,
 * approval, and unknown states. */
'use strict';
const { makeRunner, setupEnv, load } = require('../helpers/harness');

module.exports = async function run() {
  const t = makeRunner('copilot-chat-bridge');
  const { G, cfg } = setupEnv({ fixedISO: '2026-07-09T16:00:00.000Z' });
  ['js/core/aaa-rbac.js', 'js/core/aaa-runtime-gateway.js',
   'js/leads/lead-store.js', 'js/quotes/quote-store.js',
   'js/copilot/copilot-contract.js', 'js/copilot/context-packet.js',
   'js/copilot/copilot-remote-adapter.js', 'js/copilot/contract-card-renderer.js',
   'js/copilot/copilot-chat-bridge.js',
   'js/copilot/chat-message-store.js', 'js/copilot/offline-chat-queue.js', 'js/copilot/chat-canvas.js'].forEach(load);
  const B = G.AAA_COPILOT_CHAT_BRIDGE, RD = G.AAA_CONTRACT_CARD_RENDERER, CANVAS = G.AAA_CHAT_CANVAS, STORE = G.AAA_CHAT_MESSAGE_STORE;
  G.AAA_OFFLINE_CHAT_QUEUE.setOnline(true);

  // ===== classification =====
  t.eq('attention question routes', B.classify('What needs attention today?').job, 'attention_today');
  t.eq('follow-up question routes', B.classify('Who should I follow up with?').job, 'followups');
  const risk = B.classify('Is quote_101 underpriced?');
  t.ok('risk question routes with its quoteId', risk.job === 'estimate_risk' && risk.quoteId === 'quote_101');
  t.eq('agent question routes', B.classify('What did the agents do overnight?').job, 'agent_activity');
  const dr = B.classify('Draft a follow-up for quote_101 but do not send it');
  t.ok('draft request routes with its quoteId', dr.job === 'draft_followup' && dr.quoteId === 'quote_101');
  t.ok('a draft request without a quote reference is NOT claimed', B.classify('draft something nice') === null);
  t.ok('ordinary chat is not claimed', B.classify('hello there') === null && B.classify('') === null);

  // ===== canHandle: job AND configured endpoint =====
  t.ok('unconfigured remote → bridge steps aside', B.canHandle('What needs attention today?') === false);
  cfg.set({ copilotEndpoint: 'https://proxy.example/copilot' });
  t.ok('configured remote + phase-one job → bridge claims it', B.canHandle('What needs attention today?') === true);
  t.ok('configured remote + ordinary chat → still not claimed', B.canHandle('hello there') === false);

  // ===== end-to-end: hostile record data renders escaped =====
  const hostile = '<script>alert(1)</script>';
  G.fetch = async function (url, init) {
    const req = JSON.parse(init.body);
    return { ok: true, status: 200, json: async function () {
      return { contractVersion: '1.0', requestId: req.requestId,
        answer: 'One item needs attention. Records cited below.',
        cards: [{ cardType: 'attention_list', items: [{ label: hostile, why: 'planted hostile string', severity: 'urgent', sourceRef: { collection: 'leads', id: 'lead_x' } }] }],
        evidence: [{ claim: 'planted', sourceRefs: [{ collection: 'leads', id: 'lead_x' }] }],
        confidence: 80, unknowns: [], approval: { required: false } };
    } };
  };
  const asked = await B.ask('What needs attention today?');
  t.ok('bridge returns a copilot_contract card', asked.ok && asked.card.type === 'copilot_contract' && asked.job === 'attention_today');
  t.ok('hostile record data is escaped, never markup', asked.card.html.indexOf('<script>') === -1 && asked.card.html.indexOf('&lt;script&gt;') !== -1);
  t.ok('evidence chips render collection:id', asked.card.html.indexOf('leads:lead_x') !== -1);

  // ===== canvas integration: remote pre-empt =====
  const sent = await CANVAS.send('What needs attention today?');
  t.ok('canvas routes phase-one questions to the remote copilot', sent.intent === 'copilot.attention_today' && sent.cardType === 'copilot_contract');
  t.ok('assistant message stored with the contract card', sent.assistantMessage && sent.assistantMessage.card.type === 'copilot_contract');
  t.eq('both messages landed in the thread', (await STORE.thread()).length, 2);

  // ===== canvas fallback: a failing remote never takes chat offline =====
  G.fetch = async function () { return { ok: true, status: 200, json: async function () { return { garbage: true }; } }; };
  const fell = await CANVAS.send('What needs attention today?');
  t.ok('invalid remote reply falls through to the local path (chat stays alive)',
    fell.queued === false && fell.cardType === 'text' && fell.intent !== 'copilot.attention_today');
  delete G.fetch;

  // ===== renderer: approval / unknowns / degraded / draft states =====
  const draftRes = { contractVersion: '1.0', requestId: 'r', answer: 'Draft ready.',
    cards: [{ cardType: 'draft_message', channel: 'sms', customerRef: { collection: 'customers', id: 'cust_1' }, body: 'Hi {{customer_name}}', sendBlocked: true, approvalActionType: 'APPROVE_ASSISTED_MSG' }],
    evidence: [{ claim: 'the quote', sourceRefs: [{ collection: 'quotes', id: 'q1' }] }],
    confidence: 85, unknowns: ['no call log'], approval: { required: true, reasons: ['human sends'] },
    degraded: { reason: 'model_unavailable', fallback: 'local' } };
  const html = RD.render(draftRes);
  t.ok('draft banner renders', html.indexOf('Draft only') !== -1 && html.indexOf('APPROVE_ASSISTED_MSG') !== -1);
  t.ok('approval banner renders', html.indexOf('human sends') !== -1);
  t.ok('unknowns render honestly', html.indexOf('no call log') !== -1);
  t.ok('degraded notice renders', html.indexOf('model_unavailable') !== -1);
  t.ok('placeholders render as text, not substituted', html.indexOf('{{customer_name}}') !== -1);
  t.eq('unknown card types render nothing (never throw)', RD.renderCard({ cardType: 'mind_control' }), '');
  t.ok('null response never throws', typeof RD.render(null) === 'string');

  return t.report();
};
