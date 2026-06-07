/* Financial Intelligence — P&L, AR aging, cash flow, KPIs (DSO), anomalies, forecast. */
'use strict';
const { makeRunner, setupEnv, load } = require('../helpers/harness');

module.exports = async function run() {
  const t = makeRunner('financial-intelligence');
  const { G, data } = setupEnv();
  load('js/core/aaa-rbac.js');
  load('js/accounting/accounting-store.js');
  load('js/intelligence/financial-intelligence.js');
  const FI = G.AAA_FINANCIAL_INTELLIGENCE;

  // seed invoices (some paid, some aged-unpaid), payments, expenses
  await data.put('invoices', 'inv1', { id: 'inv1', workspaceId: 'ws_test', amount: 1000, status: 'paid', issuedAt: '2026-01-01T00:00:00Z', customerName: 'A' });
  await data.put('invoices', 'inv2', { id: 'inv2', workspaceId: 'ws_test', amount: 2000, status: 'paid', issuedAt: '2026-02-01T00:00:00Z', customerName: 'B' });
  await data.put('invoices', 'inv3', { id: 'inv3', workspaceId: 'ws_test', amount: 500, status: 'sent', issuedAt: '2026-05-20T00:00:00Z', customerName: 'C' }); // ~current
  await data.put('invoices', 'inv4', { id: 'inv4', workspaceId: 'ws_test', amount: 800, status: 'sent', issuedAt: '2026-01-15T00:00:00Z', customerName: 'D' }); // very overdue
  await data.put('payments', 'p1', { id: 'p1', workspaceId: 'ws_test', invoiceId: 'inv1', amount: 1000, receivedAt: '2026-01-11T00:00:00Z' }); // 10 days DSO
  await data.put('payments', 'p2', { id: 'p2', workspaceId: 'ws_test', invoiceId: 'inv2', amount: 2000, receivedAt: '2026-02-21T00:00:00Z' }); // 20 days DSO
  await data.put('expenses', 'e1', { id: 'e1', workspaceId: 'ws_test', category: 'Materials', amount: 400, incurredAt: '2026-01-05T00:00:00Z' });
  await data.put('expenses', 'e2', { id: 'e2', workspaceId: 'ws_test', category: 'Materials', amount: 300, incurredAt: '2026-02-05T00:00:00Z' });
  await data.put('expenses', 'e3', { id: 'e3', workspaceId: 'ws_test', category: 'Fuel', amount: 100, incurredAt: '2026-02-06T00:00:00Z' });
  const NOW = Date.parse('2026-06-01T00:00:00Z');

  // ===== P&L =====
  const pnl = await FI.pnl();
  t.eq('revenue = paid invoices', pnl.revenue, 3000);
  t.eq('expenses summed', pnl.expenses, 800);
  t.eq('net profit', pnl.netProfit, 2200);
  t.ok('net margin computed', pnl.netMargin === Math.round((2200 / 3000) * 100));

  // ===== AR aging =====
  const ar = await FI.arAging(NOW);
  t.ok('aging buckets unpaid invoices', ar.outstanding === 1300 && ar.buckets.d90plus === 800 && ar.buckets.current === 500);
  t.eq('overdue excludes current', ar.overdue, 800);

  // ===== cash flow =====
  const cf = await FI.cashFlow();
  t.ok('cash flow series by month', cf.months.length >= 2 && cf.months.find((m) => m.month === '2026-01').inflow === 1000);
  t.eq('net cash sums inflow - outflow', cf.netCash, (1000 + 2000) - (400 + 300 + 100));

  // ===== expense breakdown =====
  const brk = await FI.expenseBreakdown();
  t.ok('breakdown by category, largest first', brk.categories[0].category === 'Materials' && brk.categories[0].amount === 700);
  t.eq('breakdown total', brk.total, 800);

  // ===== KPIs incl DSO =====
  const k = await FI.kpis();
  t.eq('DSO averages issue→payment days', k.dso, 15); // (10 + 20)/2
  t.ok('expense ratio + avg invoice', k.expenseRatio === Math.round((800 / 3000) * 100) && k.avgInvoice === 1500);

  // ===== anomalies: an expense spike in the latest month =====
  await data.put('expenses', 'e4', { id: 'e4', workspaceId: 'ws_test', category: 'Equipment', amount: 5000, incurredAt: '2026-04-10T00:00:00Z' });
  await data.put('payments', 'p3', { id: 'p3', workspaceId: 'ws_test', amount: 1500, receivedAt: '2026-03-10T00:00:00Z' });
  const anom = await FI.anomalies();
  t.ok('flags an expense spike vs trailing average', anom.anomalies.some((a) => a.kind === 'expense_spike' && a.month === '2026-04'));

  // ===== forecast =====
  const fc = await FI.forecast(3);
  t.ok('forecast projects monthly net over the horizon', fc.ok === true && fc.horizon === 3 && fc.path.length === 3 && typeof fc.monthlyNet === 'number');

  // ===== overview bundles it + no mutation =====
  const before = JSON.stringify({ invoices: data._store.invoices, expenses: data._store.expenses, payments: data._store.payments });
  const ov = await FI.overview();
  t.ok('overview bundles pnl/ar/kpis/breakdown/anomalies', ov.ok === true && ov.pnl && ov.ar && ov.kpis && ov.expenseBreakdown && Array.isArray(ov.anomalies));
  t.eq('financial intelligence mutates no books', JSON.stringify({ invoices: data._store.invoices, expenses: data._store.expenses, payments: data._store.payments }), before);

  // ===== snapshot for trends =====
  const snap = await FI.snapshot();
  t.ok('a snapshot can be persisted + listed', snap.ok === true && (await FI.snapshots()).some((s) => s.id === snap.snapshot.id));

  return t.report();
};
