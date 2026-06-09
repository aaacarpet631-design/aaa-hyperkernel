/* Financial Intelligence dashboard — rendering + owner-only permission boundary. */
'use strict';
const { makeRunner, setupEnv, load } = require('../helpers/harness');

// A tiny fake of the AAA_UI kit + a fake container, so we can render without a DOM.
function fakeNode(tag, opts) {
  const n = { tag: tag, opts: opts || {}, children: [], _html: '' };
  n.appendChild = function (c) { if (c) n.children.push(c); return c; };
  Object.defineProperty(n, 'innerHTML', { get() { return n._html; }, set(v) { n._html = v; if (v === '') n.children = []; } });
  return n;
}
function fakeUI() {
  return {
    el: (tag, opts, children) => { const n = fakeNode(tag, opts); (children || []).forEach((c) => c && n.children.push(c)); return n; },
    button: (o) => fakeNode('button', o),
    spinner: (text) => fakeNode('spinner', { text: text }),
    sheet: (o) => ({ overlay: fakeNode('div', o), body: fakeNode('div', {}), close() {} }),
    confirm: async () => true
  };
}
function collectText(n, acc) {
  if (!n || typeof n !== 'object') return acc;
  const o = n.opts || {};
  if (o.text) acc.push(String(o.text));
  if (o.html) acc.push(String(o.html));
  if (o.label) acc.push(String(o.label));
  (n.children || []).forEach((c) => collectText(c, acc));
  return acc;
}

module.exports = async function run() {
  const t = makeRunner('financial-intelligence-ui');
  const { G, data } = setupEnv({ fixedISO: '2026-06-01T00:00:00Z' });
  load('js/core/aaa-rbac.js');
  load('js/accounting/expense-classifier.js');
  load('js/accounting/accounting-store.js');
  load('js/core/aaa-runtime-gateway.js');
  load('js/accounting/receipt-intake-store.js');
  load('js/accounting/controller-agent.js');
  load('js/ui/financial-intelligence-ui.js');
  G.AAA_UI = fakeUI();
  const A = G.AAA_ACCOUNTING;
  const RB = G.AAA_RBAC;
  const UI = G.AAA_FINANCIAL_INTEL_UI;
  const GW = G.AAA_RUNTIME_GATEWAY;

  // Seed enough to produce findings across areas.
  await data.put('jobs', 'j1', { id: 'j1', customerName: 'Jane', currentState: 'SCHEDULED', workspaceId: 'ws_test' });
  const inv = await A.createInvoice({ jobId: 'j1', customerName: 'Jane', amount: 1000, status: 'sent', issuedAt: '2026-04-15' });
  await A.recordPayment({ invoiceId: inv.id, jobId: 'j1', amount: 200, receivedAt: '2026-05-25' });
  await A.addExpense({ jobId: 'j1', category: 'Materials', amount: 900, incurredAt: '2026-05-20' });
  await A.addExpense({ category: 'Uncategorized', amount: 1500, incurredAt: '2026-05-22' });

  // ---- Owner renders the full dashboard ----
  RB.setRole('owner');
  const auditBefore = (await GW.recentAudit(500)).length;
  const container = fakeNode('div', {});
  await UI.render(container);
  const text = collectText(container, []).join(' || ');

  t.ok('renders the health score header', /Financial Health:/.test(text) && /\/100/.test(text));
  t.ok('renders the Risk & Profitability section', /Risk & Profitability/.test(text));
  t.ok('renders the Cash Flow section', /Cash Flow/.test(text));
  t.ok('renders Per-Job Costing', /Per-Job Costing/.test(text));
  t.ok('renders the Tax & Categorization section', /Tax & Categorization/.test(text));
  t.ok('renders the Receipt Pipeline section', /Receipt Pipeline/.test(text));
  t.ok('shows the read-only disclaimer', /never posts to the books/i.test(text));
  t.ok('surfaces a real finding (uncategorized)', /uncategorized/i.test(text));

  // The dashboard is read-only too — rendering wrote no audit/gateway mutations.
  t.eq('rendering performed no gateway mutations', (await GW.recentAudit(500)).length, auditBefore);

  // ---- Crew is locked out (owner-only) ----
  RB.setRole('crew');
  const crewContainer = fakeNode('div', {});
  await UI.render(crewContainer);
  const crewText = collectText(crewContainer, []).join(' || ');
  t.ok('crew sees the owner-only lock', /owner-only/i.test(crewText));
  t.ok('crew does NOT see the health score', !/Financial Health:/.test(crewText));
  t.ok('crew does NOT see job costing numbers', !/Per-Job Costing/.test(crewText));
  RB.setRole('owner');

  return t.report();
};
