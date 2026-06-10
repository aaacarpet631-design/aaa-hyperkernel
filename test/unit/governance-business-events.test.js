/*
 * Phase 4A — business-event → governance outcome wiring (no network).
 * Verifies routing (agent credit tied to the decision it influenced), idempotent
 * attachment (no double-count), missing agent types don't crash, audited, and
 * the event subscriptions fire.
 */
'use strict';
const { makeRunner, setupEnv, load } = require('../helpers/harness');
const flush = () => new Promise((r) => setImmediate(r));

module.exports = async function run() {
  const t = makeRunner('gov-business-events');
  const { G } = setupEnv({});
  load('js/governance/audit-ledger.js');
  load('js/governance/agent-outcomes.js');
  load('js/governance/governance-bridge.js');
  const O = G.AAA_AGENT_OUTCOMES, B = G.AAA_GOVERNANCE_BRIDGE, L = G.AAA_AUDIT_LEDGER;

  let seq = 0;
  async function seed(agentType, jobId) { seq++; return (await O.recordDecision({ agentId: agentType + seq, agentType: agentType, confidence: 0.7, recommendation: 'r', subjectType: 'job', subjectId: 'sub' + seq, jobId: jobId })).decision; }
  const statusOf = async (d) => (await O.getDecision(d.decisionId)).outcomeStatus;

  // ---- quote.accepted → quote + estimator (NOT review_request) -----------
  const qa = { q: await seed('quote', 'j1'), e: await seed('estimator', 'j1'), r: await seed('review_request', 'j1') };
  let res = await B.attach('quote_accepted', { jobId: 'j1' });
  t.eq('quote.accepted attaches to 2 agents', res.attached, 2);
  t.eq('quote validated', await statusOf(qa.q), 'successful');
  t.eq('estimator validated', await statusOf(qa.e), 'successful');
  t.eq('review_request NOT credited by a quote event', await statusOf(qa.r), 'pending');

  // idempotency: same event again → no re-attach (no double count)
  res = await B.attach('quote_accepted', { jobId: 'j1' });
  t.eq('duplicate quote.accepted attaches nothing', res.attached, 0);

  // ---- quote.rejected → quote + estimator (failure) ----------------------
  const qr = { q: await seed('quote', 'j2'), e: await seed('estimator', 'j2') };
  await B.attach('quote_rejected', { jobId: 'j2' });
  t.eq('quote.rejected → unsuccessful (quote)', await statusOf(qr.q), 'unsuccessful');
  t.eq('quote.rejected → unsuccessful (estimator)', await statusOf(qr.e), 'unsuccessful');

  // ---- payment.completed → quote/accounting/pos (NOT estimator) ----------
  const pay = { q: await seed('quote', 'j3'), a: await seed('accounting', 'j3'), e: await seed('estimator', 'j3') };
  res = await B.attach('payment_completed', { jobId: 'j3', value: 500 });
  t.eq('payment validates quote + accounting only', res.attached, 2);
  t.eq('quote credited by payment', await statusOf(pay.q), 'successful');
  t.eq('accounting credited by payment', await statusOf(pay.a), 'successful');
  t.eq('estimator NOT credited by payment', await statusOf(pay.e), 'pending');

  // ---- ad.lead.converted → ads/seo ; missing agent type doesn't crash ----
  const ad = await seed('ads', 'j4');
  res = await B.attach('ad_conversion', { jobId: 'j4', value: 50 });
  t.eq('ad conversion credits ads', await statusOf(ad), 'successful');
  const nothing = await B.attach('ad_conversion', { jobId: 'no-such-job' });
  t.ok('missing agent/job → no crash, attaches nothing', nothing.ok === true && nothing.attached === 0);

  // ---- review.received → review_request ; no duplicate with outcome.recorded
  const rev = await seed('review_request', 'j5');
  G.AAA_EVENTS.emit('outcome.recorded', { jobId: 'j5', result: 'review' });
  await flush();
  t.eq('review credited via outcome.recorded', await statusOf(rev), 'successful');
  G.AAA_EVENTS.emit('review.received', { jobId: 'j5' });
  await flush();
  t.eq('review.received does not double-attach', (await O.getDecision(rev.decisionId)).outcomeStatus, 'successful');

  // ---- event subscriptions fire end-to-end -------------------------------
  const ev = await seed('quote', 'j6');
  G.AAA_EVENTS.emit('quote.accepted', { jobId: 'j6', quoteId: 'qX', value: 900 });
  await flush();
  t.eq('quote.accepted event auto-attaches', await statusOf(ev), 'successful');
  const evP = await seed('accounting', 'j7');
  G.AAA_EVENTS.emit('payment.completed', { jobId: 'j7', amount: 900 });
  await flush();
  t.eq('payment.completed event auto-attaches', await statusOf(evP), 'successful');

  // ---- every attachment audited ------------------------------------------
  const attachAudits = (await L.chain()).filter((e) => e.type === 'outcome_attached');
  t.ok('attachments audited', attachAudits.length >= 8);
  t.ok('audit ledger verifies', (await L.verify()).ok === true);

  return t.report();
};
