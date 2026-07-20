/* Copilot Chat Bridge + Contract Card Renderer — Slice E: phase-one questions
 * route to the remote copilot, everything else (and every failure) falls
 * through to the local path; responses render escape-safe with evidence,
 * approval, and unknown states. Also covers: draft_message replies filed into
 * the assisted-drafts queue (advisory, never sent), the rich card renderer's
 * copilot_contract branch, the actionable approval banner, and the sorted
 * attention card with its derived summary line. */
'use strict';
const { makeRunner, setupEnv, load } = require('../helpers/harness');

module.exports = async function run() {
  const t = makeRunner('copilot-chat-bridge');
  const { G, cfg } = setupEnv({ fixedISO: '2026-07-09T16:00:00.000Z' });
  ['js/core/aaa-rbac.js', 'js/core/aaa-runtime-gateway.js',
   'js/leads/lead-store.js', 'js/quotes/quote-store.js',
   'js/copilot/copilot-contract.js', 'js/copilot/context-packet.js',
   'js/copilot/copilot-remote-adapter.js', 'js/copilot/contract-card-renderer.js',
   'js/copilot/copilot-chat-bridge.js', 'js/copilot/rich-card-renderer.js', 'js/ai/assisted-draft-queue.js',
   'js/copilot/chat-message-store.js', 'js/copilot/offline-chat-queue.js', 'js/copilot/chat-canvas.js'].forEach(load);
  const B = G.AAA_COPILOT_CHAT_BRIDGE, RD = G.AAA_CONTRACT_CARD_RENDERER, CANVAS = G.AAA_CHAT_CANVAS, STORE = G.AAA_CHAT_MESSAGE_STORE;
  const RICH = G.AAA_RICH_CARD_RENDERER, DRAFTS = G.AAA_ASSISTED_DRAFTS;
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
  t.eq('"what happened overnight?" routes to agent activity', B.classify('what happened overnight?').job, 'agent_activity');
  t.eq('"anything need me today?" routes to attention', B.classify('anything need me today?').job, 'attention_today');
  t.ok('gratitude is not claimed', B.classify('thanks, that looks great') === null);
  t.ok('smalltalk is not claimed', B.classify('what a lovely morning') === null);

  // ===== canHandle: job AND configured endpoint =====
  t.ok('unconfigured remote → bridge steps aside', B.canHandle('What needs attention today?') === false);
  cfg.set({ copilotEndpoint: 'https://proxy.example/copilot' });
  t.ok('configured remote + phase-one job → bridge claims it', B.canHandle('What needs attention today?') === true);
  t.ok('configured remote + ordinary chat → still not claimed', B.canHandle('hello there') === false);

  // ===== end-to-end: hostile record data renders escaped =====
  // The adapter now enforces evidence referential integrity, so the record
  // the stubbed reply cites must genuinely ride in the packet: a stale NEW
  // lead (>12h old under the fixed clock) lands in the attention section.
  await G.AAA_DATA.put('leads', 'lead_x', {
    leadId: 'lead_x', stage: 'NEW_LEAD', serviceType: 'carpet',
    createdAt: Date.parse('2026-07-08T00:00:00.000Z'), updatedAt: Date.parse('2026-07-08T00:00:00.000Z')
  });
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

  // ===== the REAL UI render path: rich renderer's copilot_contract branch =====
  const richHtml = RICH.html(asked.card);
  t.ok('rich renderer delegates copilot_contract to the contract renderer',
    richHtml.indexOf('cc-response') !== -1 && richHtml.indexOf('&lt;script&gt;') !== -1 && richHtml.indexOf('<script>') === -1);
  t.eq('stored html is NEVER emitted raw (tamper-at-rest defense) — escaped summary instead',
    RICH.html({ type: 'copilot_contract', html: '<img onerror=x src=x>', summary: 'safe' }), '<div class="cp-card cp-text">safe</div>');
  t.eq('with neither, the summary renders escaped', RICH.html({ type: 'copilot_contract', summary: '<b>hi</b>' }), '<div class="cp-card cp-text">&lt;b&gt;hi&lt;/b&gt;</div>');

  // ===== a drafted follow-up is FILED into the assisted-drafts queue =====
  await G.AAA_DATA.put('quotes', 'quote_101', {
    quoteId: 'quote_101', id: 'quote_101', workspaceId: 'ws_test', status: 'sent', serviceType: 'carpet',
    customerId: 'cust_9', customerTotal: 400, sentAt: '2026-07-08T00:00:00.000Z', updatedAt: Date.parse('2026-07-08T12:00:00.000Z')
  });
  await G.AAA_DATA.put('customers', 'cust_9', { id: 'cust_9', workspaceId: 'ws_test', preferredChannel: 'sms', notes: 'prefers mornings' });
  G.fetch = async function (url, init) {
    const req = JSON.parse(init.body);
    const refs = req.contextPacket.sections[0].items.map(function (it) { return it.sourceRef; });
    const qref = refs.filter(function (r) { return r.collection === 'quotes'; })[0];
    const cref = refs.filter(function (r) { return r.collection === 'customers'; })[0];
    return { ok: true, status: 200, json: async function () {
      return { contractVersion: '1.0', requestId: req.requestId,
        answer: 'Draft ready for your review.',
        cards: [{ cardType: 'draft_message', channel: 'sms',
          customerRef: { collection: 'customers', id: cref.id, asOf: cref.asOf },
          body: 'Hi {{customer_name}} — just checking in on your carpet quote.',
          sendBlocked: true, approvalActionType: 'APPROVE_ASSISTED_MSG' }],
        evidence: [{ claim: 'the quote', sourceRefs: [{ collection: 'quotes', id: qref.id, asOf: qref.asOf }] }],
        confidence: 75, unknowns: [],
        approval: { required: true, reasons: ['A human sends every message.'], approvalPackage: { actionType: 'APPROVE_ASSISTED_MSG', payload: {} } } };
    } };
  };
  const drafted = await B.ask('Draft a follow-up for quote_101 but do not send it');
  t.ok('a draft reply returns a contract card', drafted.ok === true && drafted.job === 'draft_followup' && drafted.card.type === 'copilot_contract');
  t.ok('the draft is filed and the card carries draftQueuedId', typeof drafted.card.draftQueuedId === 'string' && drafted.card.draftQueuedId.length > 0);
  const queued = await DRAFTS.get(drafted.card.draftQueuedId);
  t.ok('queued draft is pending approval from the copilot, never sent',
    !!queued && queued.status === 'pending_owner' && queued.source === 'copilot' && queued.channel === 'sms' && queued.customerId === 'cust_9' && queued.finalText === null);
  t.ok('queued draft keeps {{placeholders}} verbatim', queued.suggestedText.indexOf('{{customer_name}}') !== -1);
  t.ok('the filed draft is on the normal pending list', (await DRAFTS.pending()).some(function (d) { return d.id === drafted.card.draftQueuedId; }));
  // approval banner is actionable: actionType + inbox button (renderer stays pure)
  t.ok('approval banner names the action type', drafted.card.html.indexOf('cc-approval-action') !== -1);
  t.ok('approval banner carries the Review in Approval Inbox button',
    drafted.card.html.indexOf('class="cc-open-approvals" data-action-type="APPROVE_ASSISTED_MSG"') !== -1 && drafted.card.html.indexOf('Review in Approval Inbox') !== -1);
  // advisory: a broken queue never breaks the chat reply
  G.AAA_ASSISTED_DRAFTS = { file: async function () { throw new Error('boom'); } };
  const drafted2 = await B.ask('Draft another follow-up for quote_101 please');
  t.ok('a filing failure never breaks the chat reply', drafted2.ok === true && drafted2.card.draftQueuedId == null);
  G.AAA_ASSISTED_DRAFTS = DRAFTS;

  // ===== attention card: worst-first ordering + derived summary line =====
  const attHtml = RD.renderCard({ cardType: 'attention_list', items: [
    { label: 'info item', why: 'w', severity: 'info', sourceRef: { collection: 'leads', id: 'l1' } },
    { label: 'urgent A', why: 'w', severity: 'urgent', sourceRef: { collection: 'leads', id: 'l2' } },
    { label: 'warn item', why: 'w', severity: 'warn', sourceRef: { collection: 'leads', id: 'l3' } },
    { label: 'mystery item', why: 'w', severity: 'later', sourceRef: { collection: 'leads', id: 'l5' } },
    { label: 'urgent B', why: 'w', severity: 'urgent', sourceRef: { collection: 'leads', id: 'l4' } }
  ] });
  t.ok('attention summary line is derived from the items', attHtml.indexOf('5 item(s) - 2 urgent') !== -1);
  const order = ['urgent A', 'urgent B', 'warn item', 'info item', 'mystery item'].map(function (s) { return attHtml.indexOf(s); });
  t.ok('items sort urgent > warn > info, unknown last, stable within rank',
    order.every(function (i) { return i !== -1; }) && order.slice(1).every(function (i, k) { return i > order[k]; }));

  // ===== canvas integration: remote pre-empt =====
  G.fetch = async function (url, init) {
    const req = JSON.parse(init.body);
    return { ok: true, status: 200, json: async function () {
      return { contractVersion: '1.0', requestId: req.requestId,
        answer: 'One item needs attention. Records cited below.',
        cards: [{ cardType: 'attention_list', items: [{ label: 'stale lead', why: 'no touch', severity: 'urgent', sourceRef: { collection: 'leads', id: 'lead_x' } }] }],
        evidence: [{ claim: 'stale', sourceRefs: [{ collection: 'leads', id: 'lead_x' }] }],
        confidence: 80, unknowns: [], approval: { required: false } };
    } };
  };
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

  // ===== filed-once: concurrent identical draft asks file ONE queue entry =====
  const pendingBefore = (await DRAFTS.pending()).length;
  G.fetch = async function (url, init) {
    const req = JSON.parse(init.body);
    const refs = req.contextPacket.sections[0].items.map(function (it) { return it.sourceRef; });
    const qref = refs.filter(function (r) { return r.collection === 'quotes'; })[0];
    const cref = refs.filter(function (r) { return r.collection === 'customers'; })[0];
    return { ok: true, status: 200, json: async function () {
      return { contractVersion: '1.0', requestId: req.requestId,
        answer: 'Draft ready for your review.',
        cards: [{ cardType: 'draft_message', channel: 'sms',
          customerRef: { collection: 'customers', id: cref.id, asOf: cref.asOf },
          body: 'Hi {{customer_name}} — second draft.', sendBlocked: true, approvalActionType: 'APPROVE_ASSISTED_MSG' }],
        evidence: [{ claim: 'the quote', sourceRefs: [{ collection: 'quotes', id: qref.id, asOf: qref.asOf }] }],
        confidence: 75, unknowns: [],
        approval: { required: true, reasons: ['A human sends every message.'], approvalPackage: { actionType: 'APPROVE_ASSISTED_MSG', payload: {} } } };
    } };
  };
  const pair = await Promise.all([
    B.ask('Draft a follow-up for quote_101 but do not send it'),
    B.ask('Draft a follow-up for quote_101 but do not send it')
  ]);
  t.ok('both concurrent callers get the shared ok reply', pair[0].ok && pair[1].ok);
  t.eq('one shared remote response files exactly ONE draft', (await DRAFTS.pending()).length, pendingBefore + 1);

  // ===== a quote ref masquerading as customerRef never becomes a customerId =====
  G.fetch = async function (url, init) {
    const req = JSON.parse(init.body);
    const qref = req.contextPacket.sections[0].items.map(function (it) { return it.sourceRef; })
      .filter(function (r) { return r.collection === 'quotes'; })[0];
    return { ok: true, status: 200, json: async function () {
      return { contractVersion: '1.0', requestId: req.requestId,
        answer: 'Draft ready for your review.',
        cards: [{ cardType: 'draft_message', channel: 'sms',
          customerRef: { collection: 'quotes', id: qref.id, asOf: qref.asOf }, // engine's no-customer fallback
          body: 'Hi {{customer_name}} — quote-ref fallback.', sendBlocked: true, approvalActionType: 'APPROVE_ASSISTED_MSG' }],
        evidence: [{ claim: 'the quote', sourceRefs: [{ collection: 'quotes', id: qref.id, asOf: qref.asOf }] }],
        confidence: 75, unknowns: [],
        approval: { required: true, reasons: ['A human sends every message.'], approvalPackage: { actionType: 'APPROVE_ASSISTED_MSG', payload: {} } } };
    } };
  };
  const qfall = await B.ask('Draft a message draft for quote_101 please');
  t.ok('quote-ref fallback still yields a reply with a filed draft', qfall.ok && typeof qfall.card.draftQueuedId === 'string');
  const qfallDraft = await DRAFTS.get(qfall.card.draftQueuedId);
  t.ok('a quote id NEVER persists as a customerId', qfallDraft.customerId === null);
  delete G.fetch;

  // ===== filing is role-gated like local drafting (no remote side door) =====
  cfg.set({ role: 'crew' });
  const crewFile = await DRAFTS.file({ channel: 'sms', body: 'Hi {{customer_name}}', source: 'copilot', origin: 'ai' });
  t.ok('crew cannot file drafts (parity with the gated local path)', crewFile.ok === false && crewFile.error === 'FORBIDDEN');
  cfg.set({ role: 'owner' });

  return t.report();
};
