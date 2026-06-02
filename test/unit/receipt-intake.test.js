/* Receipt intake — ingest → classify → de-dupe → job-match → human approve → post. */
'use strict';
const { makeRunner, setupEnv, load } = require('../helpers/harness');

module.exports = async function run() {
  const t = makeRunner('receipt-intake');
  const { G, data } = setupEnv();
  // Load the whole spine: classifier + accounting + gateway + intake.
  load('js/accounting/expense-classifier.js');
  load('js/accounting/accounting-store.js');
  load('js/core/aaa-runtime-gateway.js');
  load('js/accounting/receipt-intake-store.js');
  const R = G.AAA_RECEIPT_INTAKE;
  const A = G.AAA_ACCOUNTING;

  // Seed an active job for matching (same-day, overlapping address).
  await data.put('jobs', 'j1', { id: 'j1', customerName: 'Jane', currentState: 'SCHEDULED', scheduledDate: '2026-05-20', serviceAddress: '1234 Oak Park Lane, Houston, TX', workspaceId: 'ws_test' });

  // 1) A clean, confident Home Depot receipt -> READY, classified Materials.
  const r1 = await R.ingest({ mediaId: 'm1', ocr: { vendor: 'The Home Depot', date: '2026-05-20', address: '1500 Oak Park Blvd Houston TX', subtotal: 92.10, tax: 7.59, total: 99.69, receiptNumber: 'A1' } });
  t.eq('r1 classified Materials', r1.category, 'Materials');
  t.eq('r1 ready for approval', r1.status, 'ready');
  t.ok('r1 suggests the job by date+address', r1.jobMatch && r1.jobMatch.jobId === 'j1');
  t.ok('r1 not auto-assigned (human confirms)', r1.jobId === null);

  // 2) A blurry receipt missing a total -> NEEDS_REVIEW (never auto-ready).
  const r2 = await R.ingest({ mediaId: 'm2', ocr: { vendor: 'Some Shop', total: null, confidence: 40, quality: 'blurry' } });
  t.eq('r2 needs review', r2.status, 'needs_review');

  // 3) Duplicate detection: same vendor+date+total fingerprint.
  const r3 = await R.ingest({ mediaId: 'm3', ocr: { vendor: 'The Home Depot', date: '2026-05-20', total: 99.69 } });
  t.eq('r3 flagged duplicate', r3.status, 'duplicate');
  t.eq('r3 points at original', r3.duplicateOf, r1.id);

  // 4) Posting requires a human + a category + an amount, and is gated.
  //    Assign the job first (human confirmation), then approve.
  await R.assignJob(r1.id, 'j1');
  const post = await R.approveAndPost(r1.id, { actor: 'owner' });
  t.ok('post ok', post.ok === true && !!post.expenseId);
  t.ok('post wrote an audit entry', !!post.auditId);
  const posted = await R.get(r1.id);
  t.eq('r1 now posted', posted.status, 'posted');

  // The expense is now real money in the books, tagged to the job.
  const sum = await A.summary();
  t.eq('expense hit the P&L', sum.expensed, 99.69);
  const jc = await A.jobCosting('j1');
  t.eq('expense tagged to job cost', jc.cost, 99.69);

  // 5) Idempotent: re-approving does not double-post.
  const again = await R.approveAndPost(r1.id, { actor: 'owner' });
  t.ok('no double post', again.ok === true && again.alreadyPosted === true);
  t.eq('still one expense', (await A.listExpenses()).length, 1);

  // 6) Uncategorized cannot post until categorized.
  const r4 = await R.ingest({ mediaId: 'm4', ocr: { vendor: 'Mystery Vendor', total: 50 } });
  t.eq('r4 uncategorized', r4.category, 'Uncategorized');
  t.eq('blocked without category', (await R.approveAndPost(r4.id, { actor: 'owner' })).error, 'NEEDS_CATEGORY');
  // Human re-categorizes -> teaches the classifier -> can post.
  await R.reclassify(r4.id, 'Materials', { actor: 'owner' });
  const r4b = await R.get(r4.id);
  t.eq('r4 recategorized', r4b.category, 'Materials');
  t.eq('r4 promoted to ready', r4b.status, 'ready');
  t.ok('r4 posts after categorize', (await R.approveAndPost(r4b.id, { actor: 'owner' })).ok === true);

  // 7) Duplicate cannot post without an explicit override.
  t.eq('dup blocked', (await R.approveAndPost(r3.id, { actor: 'owner' })).error, 'DUPLICATE');
  t.ok('dup posts with override', (await R.approveAndPost(r3.id, { actor: 'owner', overrideDuplicate: true })).ok === true);

  // 8) Reject path: kept for audit, cannot post.
  const r5 = await R.ingest({ mediaId: 'm5', ocr: { vendor: 'Bad Receipt', total: 10 } });
  await R.reject(r5.id, 'personal, not business', { actor: 'owner' });
  t.eq('r5 rejected', (await R.get(r5.id)).status, 'rejected');
  t.eq('rejected cannot post', (await R.approveAndPost(r5.id, { actor: 'owner' })).error, 'REJECTED');

  // 9) Stats reflect the workflow.
  const stats = await R.stats();
  t.ok('stats count posted', stats.posted >= 3);
  t.ok('stats track queue depth', typeof stats.queueDepth === 'number');

  return t.report();
};
