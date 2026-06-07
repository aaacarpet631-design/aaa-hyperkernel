/* Native Transport — adapters (neutral pipes), core brain: threads, inbox, suggestions, analytics, audit. */
'use strict';
const { makeRunner, setupEnv, load } = require('../helpers/harness');

module.exports = async function run() {
  const t = makeRunner('transport-native');
  const { G, data } = setupEnv();
  load('js/core/aaa-rbac.js');
  load('js/core/aaa-runtime-gateway.js');
  load('js/transport/template-registry.js');
  load('js/transport/transport-store.js');
  load('js/transport/transport-adapters.js');
  load('js/transport/transport-core.js');
  const A = G.AAA_TRANSPORT_ADAPTERS;
  const TX = G.AAA_TRANSPORT;
  const CORE = G.AAA_TRANSPORT_CORE;
  const GW = G.AAA_RUNTIME_GATEWAY;
  const RB = G.AAA_RBAC;
  A.reset();
  RB.setRole('owner');

  // ===== ADAPTERS: provider-neutral, local-first, no hard-coded Twilio =====
  t.ok('local adapter is the default pipe', A.names().indexOf('local') !== -1);
  t.ok('NO vendor (e.g. twilio) is hard-coded as default', A.names().indexOf('twilio') === -1);
  t.ok('local pipe covers sms/email/push/voice', ['sms', 'email', 'push', 'voice'].every((c) => A.for(c).some((a) => a.name === 'local')));
  const localSend = await A.for('sms')[0].send({ channel: 'sms', to: '+15551112222', body: 'hi' });
  t.ok('local send hands off + returns a providerId (no fake carrier delivery)', localSend.ok === true && /^local/.test(localSend.providerId) && localSend.via === 'local');
  // future adapters register the same way (replaceable pipes)
  A.register(A.httpAdapter('sendgrid', ['email'], 'sendgrid'));
  A.register({ name: 'wa', channels: ['sms'], async send() { return { ok: true, providerId: 'wa1' }; } });
  t.ok('future adapters register as plugs (sendgrid/whatsapp-style)', A.get('sendgrid') && A.get('wa'));
  A.setChain('sms', ['local', 'wa']);
  t.ok('chains are owner-controlled + ordered', A.for('sms').map((a) => a.name).join(',') === 'local,wa');
  const inb = A.localAdapter().parseInbound({ from: '+15551112222', body: 'How much for stairs?' });
  t.ok('adapter parses an inbound payload', inb && inb.from === '+15551112222' && /stairs/.test(inb.body));

  // ===== CORE OUTBOUND: governed draft + auto-threading =====
  await data.put('customers', 'c1', { id: 'c1', name: 'Jane', phone: '+15551112222' });
  const sent = await CORE.send({ templateId: 'quote_followup', to: '+15551112222', channel: 'sms', vars: { customerName: 'Jane' }, customerId: 'c1', relatedType: 'quote', relatedId: 'q1', origin: 'ai', actor: 'estimator' });
  t.ok('core.send drafts through the governed store (AI may draft)', sent.ok === true && sent.message.status === 'pending_approval' && !!sent.threadId);
  t.ok('the draft is linked to a conversation thread', (await CORE.thread(sent.threadId)).outboundRefs.indexOf(sent.message.id) !== -1);
  t.ok('thread carries quote/customer linking', (await CORE.thread(sent.threadId)).customerId === 'c1' && (await CORE.thread(sent.threadId)).relatedId === 'q1');

  // AI still cannot SEND — approval is human + gateway-audited (governance intact).
  t.eq('AI cannot approve-send through the store', (await TX.approve(sent.message.id, { origin: 'ai' })).error, 'AI_NOT_PERMITTED');
  const appr = await TX.approve(sent.message.id, { actor: 'owner' });
  t.ok('owner approves → queued', appr.ok === true);

  // ===== CORE DISPATCH via adapters (no fake delivered) =====
  A.setChain('sms', ['local']);
  const disp = await CORE.dispatch();
  t.ok('dispatch sends queued via the adapter chain', disp.ok === true && disp.sent === 1);
  const afterSend = await TX.get(sent.message.id);
  t.ok('sent via local pipe — marked sent, NOT faked-delivered', afterSend.status === 'sent' && afterSend.provider === 'local');

  // ===== CORE INBOUND: reply inbox + routing + owner notification + audit =====
  const rx = await CORE.receiveInbound({ channel: 'sms', from: '+15551112222', body: 'What is the price for stairs?' });
  t.ok('inbound recorded in app-owned storage', rx.ok === true && (await data.list('comm_inbound')).some((m) => m.id === rx.inbound.id && m.body));
  t.eq('inbound routed to the SAME conversation thread', rx.threadId, sent.threadId);
  t.ok('inbound inherits customer/quote links from the thread', rx.inbound.customerId === 'c1' && rx.inbound.relatedId === 'q1');
  t.ok('inbound raises an owner notification', !!rx.notificationId && (await CORE.notifications({ unread: true })).some((n) => n.id === rx.notificationId && n.kind === 'inbound'));
  t.ok('inbound receipt is audited (INBOUND_MESSAGE)', (await GW.recentAudit(200)).some((a) => a.action === 'INBOUND_MESSAGE' && a.decision === 'allowed') && !!rx.inbound.auditRef);
  t.ok('thread shows unread + inbound last direction', (await CORE.thread(sent.threadId)).unread >= 1 && (await CORE.thread(sent.threadId)).lastDirection === 'inbound');
  t.eq('inbound with no sender is an honest error', (await CORE.receiveInbound({ channel: 'sms', body: 'x' })).error, 'NO_SENDER');

  // ===== THREAD VIEW: merged outbound + inbound in time order =====
  const msgs = await CORE.threadMessages(sent.threadId);
  t.ok('thread view merges outbound + inbound', msgs.length >= 2 && msgs.some((m) => m.direction === 'outbound') && msgs.some((m) => m.direction === 'inbound'));

  // ===== AI RESPONSE SUGGESTIONS (recommendation-only) =====
  const sug = await CORE.suggestReply(sent.threadId);
  t.ok('suggests a pricing follow-up for a price question', sug.ok === true && sug.suggestions.some((s) => s.intent === 'quote'));
  t.ok('every suggestion requires approval (never auto-sends)', sug.suggestions.every((s) => s.requiresApproval === true));
  await CORE.receiveInbound({ channel: 'sms', from: '+15553334444', body: 'STOP' });
  const optoutThread = (await CORE.threads()).find((th) => th.peer === '+15553334444');
  const sOpt = await CORE.suggestReply(optoutThread.id);
  t.ok('opt-out is surfaced, never auto-answered', sOpt.intent === 'opt_out' && sOpt.suggestions[0].text === null && sOpt.suggestions[0].action === 'opt_out');

  // ===== mark read clears unread =====
  await CORE.markThreadRead(sent.threadId, { actor: 'owner' });
  t.ok('marking a thread read clears unread', (await CORE.thread(sent.threadId)).unread === 0);

  // ===== FAILURES visible + actionable =====
  await TX.markFailed(sent.message.id, 'carrier rejected');
  const fails = await CORE.failures();
  t.ok('failed messages are visible', fails.some((m) => m.id === sent.message.id && m.status === 'failed'));
  const retried = await CORE.retryFailed(sent.message.id, { actor: 'owner' });
  t.ok('a failed message is actionable (re-queue, audited)', retried.ok === true);

  // ===== review requests / follow-ups flow into the native core (reconcile) =====
  const drafted = await TX.draft({ templateId: 'review_request_24h', to: 'jane@example.com', channel: 'email', vars: { customerName: 'Jane' }, relatedType: 'job', relatedId: 'job9', origin: 'ai', actor: 'scheduler' });
  const threadsAfter = await CORE.threads();
  t.ok('a scheduler-drafted review request appears as a conversation', threadsAfter.some((th) => th.channel === 'email' && th.peer === 'jane@example.com' && th.outboundRefs.indexOf(drafted.message.id) !== -1));

  // ===== ANALYTICS =====
  const an = await CORE.analytics();
  t.ok('analytics reports outbound/inbound/threads + rates', an.ok === true && an.outbound >= 1 && an.inbound >= 2 && an.threads >= 2 && an.responseRate != null && typeof an.byChannel === 'object');

  // ===== notifications can be marked read =====
  await CORE.markNotificationRead(rx.notificationId);
  t.ok('notifications are dismissable', !(await CORE.notifications({ unread: true })).some((n) => n.id === rx.notificationId));

  return t.report();
};
