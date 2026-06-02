/* Controller Agent — read-only financial analysis, permission boundary, audit. */
'use strict';
const { makeRunner, setupEnv, load } = require('../helpers/harness');

module.exports = async function run() {
  const t = makeRunner('controller-agent');
  // Fixed clock so A/R aging + trailing cash-flow math is deterministic.
  const { G, data } = setupEnv({ fixedISO: '2026-06-01T00:00:00Z', config: { ctrlReceiptBacklog: 2 } });
  load('js/core/aaa-rbac.js');
  load('js/accounting/expense-classifier.js');
  load('js/accounting/accounting-store.js');
  load('js/core/aaa-runtime-gateway.js');
  load('js/accounting/receipt-intake-store.js');
  load('js/accounting/controller-agent.js');
  const A = G.AAA_ACCOUNTING;
  const C = G.AAA_CONTROLLER;
  const GW = G.AAA_RUNTIME_GATEWAY;
  const RB = G.AAA_RBAC;

  // Jobs.
  await data.put('jobs', 'j1', { id: 'j1', customerName: 'Jane', currentState: 'SCHEDULED', workspaceId: 'ws_test' });
  await data.put('jobs', 'j2', { id: 'j2', customerName: 'Bob', currentState: 'IN_PROGRESS', workspaceId: 'ws_test' });

  // j1: billed $1000 (47 days old → overdue), only $200 collected → aged A/R + a LOSS (cost 1200 > rev 200).
  const inv = await A.createInvoice({ jobId: 'j1', customerName: 'Jane', amount: 1000, status: 'sent', issuedAt: '2026-04-15' });
  await A.recordPayment({ invoiceId: inv.id, jobId: 'j1', amount: 200, receivedAt: '2026-05-25' });
  await A.addExpense({ jobId: 'j1', category: 'Materials', amount: 1200, receiptId: 'rcpt_doc', incurredAt: '2026-05-20' }); // documented (large but has a receipt)
  // j2: $500 cost, never invoiced → UNBILLED.
  await A.addExpense({ jobId: 'j2', category: 'Materials', amount: 500, incurredAt: '2026-05-21' });
  // Company-wide: a large UNCATEGORIZED expense with no receipt → tax + undocumented findings.
  await A.addExpense({ category: 'Uncategorized', amount: 1500, incurredAt: '2026-05-22' });

  // Receipt pipeline: 2 ready + 1 duplicate (queue 3 ≥ backlog 2) + 1 posted.
  await data.put('receipts', 'r1', { id: 'r1', status: 'ready', workspaceId: 'ws_test', createdAt: '2026-05-30', ocr: { vendor: 'X', total: 10 } });
  await data.put('receipts', 'r2', { id: 'r2', status: 'ready', workspaceId: 'ws_test', createdAt: '2026-05-30', ocr: { vendor: 'Y', total: 20 } });
  await data.put('receipts', 'r3', { id: 'r3', status: 'duplicate', workspaceId: 'ws_test', createdAt: '2026-05-30', ocr: { vendor: 'Z', total: 30 } });
  await data.put('receipts', 'r4', { id: 'r4', status: 'posted', expenseId: 'exp_x', workspaceId: 'ws_test', createdAt: '2026-05-29', ocr: { vendor: 'W', total: 40 } });

  // Snapshot the books + audit BEFORE analysis (to prove analyze() is read-only).
  const expBefore = (await A.listExpenses()).length;
  const invBefore = (await A.listInvoices()).length;
  const auditBefore = (await GW.recentAudit(500)).length;

  const a = await C.analyze();
  t.ok('analysis ok', a.ok === true);

  const has = (area, sub) => a.findings.some((f) => f.area === area && f.title.toLowerCase().indexOf(sub) !== -1);
  t.ok('flags operating at a loss', has('risk', 'loss'));
  t.ok('flags overdue receivables', has('risk', 'overdue'));
  t.ok('flags cash-flow burn', a.findings.some((f) => f.area === 'cashflow'));
  t.ok('flags a money-losing job', has('jobcost', 'losing money'));
  t.ok('flags unbilled job costs', has('jobcost', 'unbilled'));
  t.ok('flags uncategorized expense', has('tax', 'uncategorized'));
  t.ok('flags large expense without a receipt', has('tax', 'without a receipt'));
  t.ok('documented large expense is NOT flagged undocumented', !a.findings.some((f) => f.area === 'tax' && /without a receipt/i.test(f.title) && f.metrics.count > 1));
  t.ok('flags receipt backlog', has('receipts', 'backlog'));
  t.ok('notes duplicate receipts', has('receipts', 'duplicate'));

  // Structured outputs.
  t.eq('health profit is negative', a.health.profit < 0, true);
  t.ok('score is reduced + capped for a loss', a.score <= 40);
  t.ok('counts has criticals', a.counts.critical >= 1);
  t.ok('cashflow runway computed', a.cashflow && a.cashflow.runwayMonths != null);
  t.ok('job costing sorted worst-first', a.jobCosting.length >= 2 && a.jobCosting[0].profit <= a.jobCosting[a.jobCosting.length - 1].profit);
  t.ok('receipt accuracy surfaced (or null honestly)', a.receipts && 'classifierAccuracyPct' in a.receipts);

  // ---- The Controller is READ-ONLY: it mutated nothing. ----
  t.eq('no expenses created by analysis', (await A.listExpenses()).length, expBefore);
  t.eq('no invoices created by analysis', (await A.listInvoices()).length, invBefore);
  t.eq('analysis wrote NO audit entries (no gateway mutations)', (await GW.recentAudit(500)).length, auditBefore);

  // ---- Permission boundary on the actions the Controller recommends ----
  // Every recommended gatewayAction is human-only in the gateway. Prove AI is blocked.
  RB.setRole('owner');
  const aiTry = await GW.run({ action: 'MODIFY_ACCOUNTING', origin: 'ai', actor: 'controller', mutate: async () => { throw new Error('AI MUST NEVER REACH HERE'); } });
  t.eq('AI cannot perform a recommended accounting action', aiTry.error, 'AI_NOT_PERMITTED');

  // A human owner CAN (and it is audited).
  let humanRan = false;
  const ownerTry = await GW.run({ action: 'MODIFY_ACCOUNTING', origin: 'human', actor: 'owner', mutate: async () => { humanRan = true; return { ok: true }; } });
  t.ok('owner human CAN perform the action', ownerTry.ok === true && humanRan);

  // A crew member CANNOT (RBAC denies; no financial mutation by non-owners).
  RB.setRole('crew');
  const crewTry = await GW.run({ action: 'MODIFY_ACCOUNTING', origin: 'human', actor: 'crew', mutate: async () => { throw new Error('CREW MUST NOT REACH HERE'); } });
  t.eq('crew is forbidden from accounting mutations', crewTry.error, 'FORBIDDEN');
  RB.setRole('owner');

  // ---- Audit behavior: every attempt (allowed/denied) left a trail ----
  const audits = await GW.recentAudit(500);
  t.ok('AI attempt was audited as denied', audits.some((e) => e.action === 'MODIFY_ACCOUNTING' && e.origin === 'ai' && e.decision === 'denied' && e.reason === 'AI_NOT_PERMITTED'));
  t.ok('owner action was audited as allowed', audits.some((e) => e.action === 'MODIFY_ACCOUNTING' && e.origin === 'human' && e.decision === 'allowed'));
  t.ok('crew attempt was audited as denied/forbidden', audits.some((e) => e.action === 'MODIFY_ACCOUNTING' && e.decision === 'denied' && e.reason === 'FORBIDDEN'));

  // Healthy books → high score, no criticals (sanity for the happy path).
  const { G: G2, data: d2 } = setupEnv({ fixedISO: '2026-06-01T00:00:00Z' });
  load('js/accounting/expense-classifier.js');
  load('js/accounting/accounting-store.js');
  load('js/core/aaa-runtime-gateway.js');
  load('js/accounting/receipt-intake-store.js');
  load('js/accounting/controller-agent.js');
  const inv2 = await G2.AAA_ACCOUNTING.createInvoice({ jobId: 'jh', customerName: 'Pat', amount: 1000, status: 'sent', issuedAt: '2026-05-28' });
  await G2.AAA_ACCOUNTING.recordPayment({ invoiceId: inv2.id, jobId: 'jh', amount: 1000, receivedAt: '2026-05-28' });
  await G2.AAA_ACCOUNTING.addExpense({ jobId: 'jh', category: 'Materials', amount: 400, receiptId: 'r', incurredAt: '2026-05-28' });
  const healthy = await G2.AAA_CONTROLLER.analyze();
  t.ok('healthy books score high', healthy.score >= 80);
  t.eq('healthy books have no criticals', healthy.counts.critical, 0);

  return t.report();
};
