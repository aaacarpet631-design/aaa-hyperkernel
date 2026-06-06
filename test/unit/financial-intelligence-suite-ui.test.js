/* Financial Intelligence UI — P&L, A/R aging, KPIs, expenses, anomalies, gates, states. */
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
  load('js/core/aaa-rbac.js'); load('js/accounting/accounting-store.js'); load('js/intelligence/financial-intelligence.js');
  load('js/ui/financial-intelligence-suite-ui.js');
  G.AAA_UI = fakeUI();
}

module.exports = async function run() {
  const t = makeRunner('financial-intelligence-suite-ui');
  const { G, data } = setupEnv();
  loadAll(G);
  const UI = G.AAA_FINANCIAL_INTELLIGENCE_UI;
  const RB = G.AAA_RBAC;
  RB.setRole('owner');

  await data.put('invoices', 'inv1', { id: 'inv1', workspaceId: 'ws_test', amount: 2000, status: 'paid', issuedAt: '2026-01-01T00:00:00Z' });
  await data.put('invoices', 'inv2', { id: 'inv2', workspaceId: 'ws_test', amount: 800, status: 'sent', issuedAt: '2026-01-10T00:00:00Z' });
  await data.put('payments', 'p1', { id: 'p1', workspaceId: 'ws_test', invoiceId: 'inv1', amount: 2000, receivedAt: '2026-01-11T00:00:00Z' });
  await data.put('expenses', 'e1', { id: 'e1', workspaceId: 'ws_test', category: 'Materials', amount: 500, incurredAt: '2026-01-05T00:00:00Z' });

  // --- owner view ---
  const c1 = fakeNode('div', {});
  await UI.render(c1);
  const dash = txt(c1, []).join(' || ');
  t.ok('renders the financial summary', /Revenue/.test(dash) && /Net profit/.test(dash) && /Net margin/.test(dash) && /DSO/.test(dash));
  t.ok('shows P&L', /Profit & loss/.test(dash) && /Expenses/.test(dash));
  t.ok('shows A/R aging', /A\/R aging/.test(dash) && /Current/.test(dash));
  t.ok('shows expense breakdown', /Expenses by category/.test(dash) && /Materials/.test(dash));
  t.ok('shows forecast + disclaimer', /Forecast/.test(dash) && /posts nothing and changes no invoice/.test(dash));

  // --- crew lock ---
  RB.setRole('crew');
  const cCrew = fakeNode('div', {});
  await UI.render(cCrew);
  t.ok('crew sees owner-only lock', /owner-only/i.test(txt(cCrew, []).join(' ')));
  RB.setRole('owner');

  // --- error state ---
  const { G: G2 } = setupEnv(); loadAll(G2); G2.AAA_RBAC.setRole('owner');
  G2.AAA_FINANCIAL_INTELLIGENCE.overview = async () => { throw new Error('boom'); };
  const cErr = fakeNode('div', {});
  await G2.AAA_FINANCIAL_INTELLIGENCE_UI.render(cErr);
  t.ok('error state handled', /Could not load financials/.test(txt(cErr, []).join(' ')));

  return t.report();
};
