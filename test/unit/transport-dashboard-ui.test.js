/* Delivery dashboard — renders status + approval queue; office-only; empty/error. */
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
  load('js/transport/template-registry.js'); load('js/transport/transport-store.js'); load('js/ui/transport-dashboard-ui.js');
  G.AAA_UI = fakeUI();
}

module.exports = async function run() {
  const t = makeRunner('transport-dashboard-ui');
  const { G } = setupEnv();
  loadAll(G);
  const TX = G.AAA_TRANSPORT;
  const UI = G.AAA_TRANSPORT_DASHBOARD_UI;
  const RB = G.AAA_RBAC;

  await TX.draft({ templateId: 'quote_ready', to: '+15551234567', vars: { customerName: 'Jane', quoteRange: '$1,200' }, relatedId: 'q1' });

  // --- office (owner) sees dashboard + pending-approval queue ---
  RB.setRole('owner');
  const c1 = fakeNode('div', {});
  await UI.render(c1);
  const dash = txt(c1, []).join(' || ');
  t.ok('renders delivery status', /Delivered/.test(dash) && /Failed/.test(dash) && /Bounced/.test(dash) && /Pending Retry/.test(dash));
  t.ok('renders the pending-approval review gate', /Pending Approval/.test(dash) && /Approve & send/.test(dash) && /quote_ready|quote/.test(dash));
  t.ok('shows the governance disclaimer', /AI can draft, never send/i.test(dash));

  // --- crew is locked out (office-only) ---
  RB.setRole('crew');
  const cCrew = fakeNode('div', {});
  await UI.render(cCrew);
  const crew = txt(cCrew, []).join(' || ');
  t.ok('crew sees office-only lock', /office-only/i.test(crew));
  t.ok('crew sees no approval queue', !/Approve & send/.test(crew));
  RB.setRole('owner');

  // --- empty state ---
  const { G: G2 } = setupEnv();
  loadAll(G2);
  const cEmpty = fakeNode('div', {});
  await G2.AAA_TRANSPORT_DASHBOARD_UI.render(cEmpty);
  t.ok('empty state is honest', /Nothing waiting to send/.test(txt(cEmpty, []).join(' ')));

  // --- error state ---
  const { G: G3 } = setupEnv();
  loadAll(G3);
  G3.AAA_TRANSPORT.stats = async () => { throw new Error('boom'); };
  const cErr = fakeNode('div', {});
  await G3.AAA_TRANSPORT_DASHBOARD_UI.render(cErr);
  t.ok('error state handled', /Could not load delivery/.test(txt(cErr, []).join(' ')));

  return t.report();
};
