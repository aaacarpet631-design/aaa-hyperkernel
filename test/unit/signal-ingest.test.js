/* Signal Ingestion — wider senses: normalized stream, idempotency, honest metrics. */
'use strict';
const { makeRunner, setupEnv, load } = require('../helpers/harness');

module.exports = async function run() {
  const t = makeRunner('signal-ingest');
  const { G, data } = setupEnv();
  load('js/intelligence/signal-ingest.js');
  const SI = G.AAA_SIGNAL_INGEST;

  // ===== empty business: ingest is a clean no-op (no fabrication) =====
  const empty = await SI.ingest();
  t.ok('ingest on an empty business adds nothing', empty.ok === true && empty.added === 0);
  const m0 = await SI.metrics();
  t.ok('metrics are honest nulls when no data', m0.total === 0 && m0.invoicePaidRate === null && m0.missedCallRate === null && m0.cac === null);

  // ===== seed real-today sources: invoices, payments, expenses, customers =====
  await data.put('invoices', 'i1', { id: 'i1', jobId: 'j1', customerId: 'c1', amount: 1000, status: 'paid', issuedAt: '2026-01-01T00:00:00Z' });
  await data.put('invoices', 'i2', { id: 'i2', jobId: 'j2', customerId: 'c2', amount: 500, status: 'sent', issuedAt: '2026-01-02T00:00:00Z' });
  await data.put('payments', 'p1', { id: 'p1', invoiceId: 'i1', amount: 1000, receivedAt: '2026-01-03T00:00:00Z' });
  await data.put('expenses', 'e1', { id: 'e1', jobId: 'j1', amount: 200, category: 'materials', incurredAt: '2026-01-01T00:00:00Z' });
  await data.put('customers', 'c1', { id: 'c1', name: 'Acme', source: 'referral', createdAt: '2025-12-20T00:00:00Z' });
  await data.put('customers', 'c2', { id: 'c2', name: 'Beta', source: 'google', createdAt: '2025-12-21T00:00:00Z' });

  const ing = await SI.ingest();
  // i1: issued+paid(2), i2: issued(1), p1(1), e1(1), c1+c2 leads(2) = 7
  t.ok('ingest normalizes every real source', ing.ok === true && ing.added === 7);
  t.ok('per-source tallies are reported', ing.bySource.invoices === 3 && ing.bySource.payments === 1 && ing.bySource.expenses === 1 && ing.bySource.customers === 2);

  // ===== idempotent =====
  const again = await SI.ingest();
  t.eq('re-ingest adds no duplicates', again.added, 0);
  t.eq('stream size is stable', (await SI.signals()).length, 7);

  // ===== stream is typed + filterable =====
  t.eq('invoice_issued count', (await SI.signals({ type: 'invoice_issued' })).length, 2);
  t.eq('invoice_paid count', (await SI.signals({ type: 'invoice_paid' })).length, 1);
  t.eq('filter by source', (await SI.signals({ source: 'expenses' })).length, 1);
  t.eq('unknown type rejected', (await SI.record('not_a_type', {})).error, 'UNKNOWN_TYPE');

  // ===== metrics derive real KPIs =====
  const m = await SI.metrics();
  t.eq('revenue billed = sum of invoices issued', m.revenueBilled, 1500);
  t.eq('revenue collected = sum of payments', m.revenueCollected, 1000);
  t.eq('spend = expenses (+ ad spend)', m.spend, 200);
  t.eq('invoice paid-rate (1 of 2)', m.invoicePaidRate, 50);
  t.eq('leads counted', m.leads, 2);
  t.ok('CAC null without ad spend', m.cac === null);
  t.ok('missed-call rate null without calls', m.missedCallRate === null);

  // ===== schema-ready sources light up the moment records arrive =====
  await data.put('calls', 'call1', { id: 'call1', missed: true, at: '2026-01-04T00:00:00Z' });
  await data.put('calls', 'call2', { id: 'call2', missed: false, at: '2026-01-04T01:00:00Z' });
  await data.put('refunds', 'r1', { id: 'r1', amount: 100, at: '2026-01-05T00:00:00Z' });
  await data.put('ad_events', 'a1', { id: 'a1', type: 'spend', spend: 400, campaign: 'spring', at: '2026-01-01T00:00:00Z' });
  await data.put('leads', 'l1', { id: 'l1', campaign: 'spring', at: '2026-01-02T00:00:00Z' });

  const ing2 = await SI.ingest();
  t.ok('new sources ingest without touching old ones', ing2.added === 5 && ing2.bySource.calls === 2 && ing2.bySource.refunds === 1 && ing2.bySource.ad_events === 1 && ing2.bySource.leads === 1);
  const m2 = await SI.metrics();
  t.eq('missed-call rate now computed (1 of 2)', m2.missedCallRate, 50);
  t.eq('refund total computed', m2.refundTotal, 100);
  t.eq('spend now includes ad spend', m2.spend, 600);
  t.eq('CAC = ad spend / leads (400 / 3)', m2.cac, 133.33);

  return t.report();
};
