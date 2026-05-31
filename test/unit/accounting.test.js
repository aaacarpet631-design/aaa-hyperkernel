/* Accounting — invoices, payments (auto-paid), P&L, job costing. */
'use strict';
const { makeRunner, setupEnv, load } = require('../helpers/harness');

module.exports = async function run() {
  const t = makeRunner('accounting');
  const { G } = setupEnv();
  load('js/accounting/accounting-store.js');
  const A = G.AAA_ACCOUNTING;

  const inv = await A.createInvoice({ jobId: 'j1', customerName: 'Jane', items: [{ description: 'Install', amount: 1000 }, { description: 'Stairs', amount: 200 }] });
  t.eq('invoice total summed', inv.amount, 1200);
  t.eq('invoice starts draft', inv.status, 'draft');

  await A.addExpense({ jobId: 'j1', category: 'materials', amount: 400 });
  let sum = await A.summary();
  t.eq('billed 1200', sum.billed, 1200);
  t.eq('expensed 400', sum.expensed, 400);
  t.eq('outstanding = billed', sum.outstanding, 1200);

  await A.recordPayment({ invoiceId: inv.id, jobId: 'j1', amount: 600 });
  sum = await A.summary();
  t.eq('collected 600', sum.collected, 600);
  t.eq('profit 600-400', sum.profit, 200);
  t.eq('invoice still draft (partial)', (await A.listInvoices())[0].status, 'draft');

  await A.recordPayment({ invoiceId: inv.id, jobId: 'j1', amount: 600 });
  t.eq('invoice auto-paid when covered', (await A.listInvoices())[0].status, 'paid');

  const jc = await A.jobCosting('j1');
  t.ok('job costing rev/cost/profit', jc.revenue === 1200 && jc.cost === 400 && jc.profit === 800);

  const fromJob = await A.invoiceFromJob({ id: 'j2', customerName: 'Bob', estimates: [{ type: 'Repair', estimatedQuoteRange: '$150–$250' }] });
  t.eq('invoiceFromJob mid of range', fromJob.items[0].amount, 200);

  return t.report();
};
