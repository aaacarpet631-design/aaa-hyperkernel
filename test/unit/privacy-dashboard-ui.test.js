/* Data Governance UI — PII inventory, retention, erasure workflow, gates, states. */
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
  load('js/core/aaa-rbac.js'); load('js/core/aaa-runtime-gateway.js'); load('js/core/aaa-privacy.js');
  load('js/ui/privacy-dashboard-ui.js');
  G.AAA_UI = fakeUI();
}

module.exports = async function run() {
  const t = makeRunner('privacy-dashboard-ui');
  const { G, data } = setupEnv();
  loadAll(G);
  const P = G.AAA_PRIVACY;
  const UI = G.AAA_PRIVACY_DASHBOARD_UI;
  const RB = G.AAA_RBAC;
  RB.setRole('owner');

  await data.put('customers', 'c1', { id: 'c1', name: 'Jane Doe', phone: '+15551112222', email: 'jane@x.com' });
  await data.put('communications', 'm1', { id: 'm1', workspaceId: 'ws_test', customerId: 'c1', to: '+15551112222', body: 'hi', createdAt: '2024-01-01T00:00:00Z' });
  await P.requestErasure({ subjectType: 'customer', subjectId: 'c1', actor: 'owner' });

  // --- owner dashboard ---
  const c1 = fakeNode('div', {});
  await UI.render(c1);
  const dash = txt(c1, []).join(' || ');
  t.ok('renders the governance summary', /PII records/.test(dash) && /Past retention/.test(dash) && /Erasure pending/.test(dash));
  t.ok('shows the PII inventory', /PII inventory/.test(dash) && /customers/.test(dash));
  t.ok('shows retention status', /Retention/.test(dash) && /communications/.test(dash));
  t.ok('offers export + erasure', /Export customer data/.test(dash) && /Right to be forgotten/.test(dash) && /Approve & erase/.test(dash));
  t.ok('shows the governance disclaimer', /AAA owns and governs the data/.test(dash));

  // --- crew lock ---
  RB.setRole('crew');
  const cCrew = fakeNode('div', {});
  await UI.render(cCrew);
  t.ok('crew sees owner-only lock', /owner-only/i.test(txt(cCrew, []).join(' ')));
  RB.setRole('owner');

  // --- error state ---
  const { G: G2 } = setupEnv(); loadAll(G2); G2.AAA_RBAC.setRole('owner');
  G2.AAA_PRIVACY.scan = async () => { throw new Error('boom'); };
  const cErr = fakeNode('div', {});
  await G2.AAA_PRIVACY_DASHBOARD_UI.render(cErr);
  t.ok('error state handled', /Could not load data governance/.test(txt(cErr, []).join(' ')));

  return t.report();
};
