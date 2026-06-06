/* Native inbox UI — conversations, status, failures, suggested replies, gates, states. */
'use strict';
const { makeRunner, setupEnv, load } = require('../helpers/harness');

function fakeNode(tag, opts) {
  const n = { tag: tag, opts: opts || {}, children: [], _html: '' };
  n.appendChild = function (c) { if (c) n.children.push(c); return c; };
  n.addEventListener = function () {};
  Object.defineProperty(n, 'innerHTML', { get() { return n._html; }, set(v) { n._html = v; if (v === '') n.children = []; } });
  return n;
}
function fakeUI() {
  return {
    el: (tag, opts, children) => { const n = fakeNode(tag, opts); (children || []).forEach((c) => c && n.children.push(c)); return n; },
    button: (o) => fakeNode('button', o), spinner: (text) => fakeNode('spinner', { text: text }),
    sheet: (o) => ({ overlay: fakeNode('div', o), body: fakeNode('div', {}), close() {} }), confirm: async () => true
  };
}
function txt(n, acc) { if (!n || typeof n !== 'object') return acc; const o = n.opts || {}; if (o.text) acc.push(String(o.text)); if (o.html) acc.push(String(o.html)); if (o.label) acc.push(String(o.label)); (n.children || []).forEach((c) => txt(c, acc)); return acc; }

function loadAll(G) {
  load('js/core/aaa-rbac.js'); load('js/core/aaa-runtime-gateway.js');
  load('js/transport/template-registry.js'); load('js/transport/transport-store.js');
  load('js/transport/transport-adapters.js'); load('js/transport/transport-core.js');
  load('js/ui/transport-inbox-ui.js');
  G.AAA_TRANSPORT_ADAPTERS.reset();
  G.AAA_UI = fakeUI();
}

module.exports = async function run() {
  const t = makeRunner('transport-inbox-ui');
  const { G, data } = setupEnv();
  loadAll(G);
  const CORE = G.AAA_TRANSPORT_CORE;
  const TX = G.AAA_TRANSPORT;
  const UI = G.AAA_TRANSPORT_INBOX_UI;
  const RB = G.AAA_RBAC;
  RB.setRole('owner');

  // Seed a conversation: an outbound draft + an inbound reply + a failure.
  const sent = await CORE.send({ templateId: 'quote_followup', to: '+15551112222', channel: 'sms', vars: { customerName: 'Jane' }, customerId: 'c1', relatedType: 'quote', relatedId: 'q1', origin: 'ai', actor: 'estimator' });
  await CORE.receiveInbound({ channel: 'sms', from: '+15551112222', body: 'How much for the stairs?' });
  await TX.markFailed(sent.message.id, 'carrier rejected');

  // --- owner dashboard ---
  const c1 = fakeNode('div', {});
  await UI.render(c1);
  const dash = txt(c1, []).join(' || ');
  t.ok('renders analytics summary', /Open/.test(dash) && /Delivered/.test(dash) && /Failed/.test(dash));
  t.ok('shows owner notifications for the reply', /Notifications/.test(dash) && /New reply/.test(dash));
  t.ok('shows failures as actionable', /Needs attention/.test(dash) && /carrier rejected/.test(dash) && /Retry/.test(dash));
  t.ok('lists the conversation', /Conversations/.test(dash) && /\+15551112222/.test(dash));
  t.ok('shows the ownership disclaimer', /AAA owns every conversation/.test(dash));

  // --- thread view: timeline + suggested replies ---
  const tBody = fakeNode('div', {});
  await UI.renderThread(tBody, sent.threadId);
  const thread = txt(tBody, []).join(' || ');
  t.ok('thread shows the merged timeline', /Conversation/.test(thread) && /inbound/.test(thread) && /stairs/.test(thread));
  t.ok('thread shows quote/customer linking', /customer linked/.test(thread) && /q1/.test(thread));
  t.ok('thread offers AI suggested replies', /Suggested replies/.test(thread) && /Draft this reply/.test(thread));

  // --- opt-out thread surfaces, never auto-answers ---
  await CORE.receiveInbound({ channel: 'sms', from: '+15559998888', body: 'STOP texting me' });
  const optThread = (await CORE.threads()).find((th) => th.peer === '+15559998888');
  const oBody = fakeNode('div', {});
  await UI.renderThread(oBody, optThread.id);
  t.ok('opt-out is surfaced in the UI', /Opt-out requested/.test(txt(oBody, []).join(' ')));

  // --- crew is locked out ---
  RB.setRole('crew');
  const cCrew = fakeNode('div', {});
  await UI.render(cCrew);
  const crew = txt(cCrew, []).join(' || ');
  t.ok('crew sees office-only lock', /office-only/i.test(crew));
  t.ok('crew sees no conversations', !/Conversations \(/.test(crew));
  RB.setRole('owner');

  // --- empty + error states ---
  const { G: G2 } = setupEnv(); loadAll(G2); G2.AAA_RBAC.setRole('owner');
  const cEmpty = fakeNode('div', {});
  await G2.AAA_TRANSPORT_INBOX_UI.render(cEmpty);
  t.ok('empty state is honest', /No conversations yet/.test(txt(cEmpty, []).join(' ')));

  const { G: G3 } = setupEnv(); loadAll(G3); G3.AAA_RBAC.setRole('owner');
  G3.AAA_TRANSPORT_CORE.analytics = async () => { throw new Error('boom'); };
  const cErr = fakeNode('div', {});
  await G3.AAA_TRANSPORT_INBOX_UI.render(cErr);
  t.ok('error state handled', /Could not load conversations/.test(txt(cErr, []).join(' ')));

  return t.report();
};
