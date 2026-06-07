/* Sensing UI — signal log, drafts-queued count, links, gates, states. */
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
  load('js/core/aaa-events.js'); load('js/core/aaa-event-bus.js');
  load('js/core/sensing-ingress.js'); load('js/ui/sensing-ui.js');
  G.AAA_UI = fakeUI();
}

module.exports = async function run() {
  const t = makeRunner('sensing-ui');
  const { G } = setupEnv();
  loadAll(G);
  const S = G.AAA_SENSING, UI = G.AAA_SENSING_UI;
  const RB = G.AAA_RBAC;
  RB.setRole('owner');
  // ingest a couple of signals (no model router loaded → no draft, but signal recorded)
  await S.ingest({ type: 'inbound_sms', externalId: 'SM1', source: 'twilio', payload: { from: '+15551112222', body: 'hi there' } }, { actor: 'owner' });
  await S.ingest({ type: 'missed_call', externalId: 'CA1', source: 'twilio', payload: { from: '+15553334444', status: 'no-answer' } }, { actor: 'owner' });

  // --- office view ---
  const c1 = fakeNode('div', {});
  await UI.render(c1);
  const dash = txt(c1, []).join(' || ');
  t.ok('renders the signal summary', /Signals/.test(dash) && /Channels/.test(dash));
  t.ok('lists recent signals with channel + sender', /inbound_sms/.test(dash) && /missed_call/.test(dash) && /\+15551112222/.test(dash));
  t.ok('shows the perceive-not-send disclaimer', /never sends one/.test(dash));

  // --- crew lock ---
  RB.setRole('crew');
  const cCrew = fakeNode('div', {});
  await UI.render(cCrew);
  t.ok('crew sees office-only lock', /office-only/i.test(txt(cCrew, []).join(' ')));
  RB.setRole('owner');

  // --- error state ---
  const { G: G2 } = setupEnv(); loadAll(G2); G2.AAA_RBAC.setRole('owner');
  G2.AAA_SENSING.list = async () => { throw new Error('boom'); };
  const cErr = fakeNode('div', {});
  await G2.AAA_SENSING_UI.render(cErr);
  t.ok('error state handled', /Could not load signals/.test(txt(cErr, []).join(' ')));

  return t.report();
};
