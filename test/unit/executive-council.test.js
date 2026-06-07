/* Executive Council — five-lens deliberation, objections, risk, submit/act governance. */
'use strict';
const { makeRunner, setupEnv, load } = require('../helpers/harness');

module.exports = async function run() {
  const t = makeRunner('executive-council');
  const { G, data } = setupEnv();
  load('js/core/aaa-rbac.js');
  load('js/core/aaa-runtime-gateway.js');
  load('js/intelligence/executive-council.js');
  const C = G.AAA_EXECUTIVE_COUNCIL;
  const GW = G.AAA_RUNTIME_GATEWAY;
  const RB = G.AAA_RBAC;
  RB.setRole('owner');

  // ===== five seats deliberate =====
  const d = C.deliberate({ type: 'ads_budget', amount: 500, detail: {} }, { winRate: 0.5, marketingRoi: 2, cashBuffer: 5000, capacityUtil: 60, sample: 20 });
  t.ok('all five executive seats weigh in (CEO + 4)', d.positions.length === 5 && d.positions[0].seat === 'CEO');
  t.ok('a reasonable ad spend is approved', d.decision === 'approve' && d.confidence > 0);
  t.ok('produces a risk score', typeof d.riskScore === 'number' && d.riskScore >= 0 && d.riskScore <= 100);

  // ===== a margin-eroding price cut draws a Finance objection → reject =====
  const cut = C.deliberate({ type: 'price_change', detail: { direction: 'down' } }, { marginPct: 22, marginFloor: 25, winRate: 0.6, sample: 20 });
  t.ok('Finance objects to cutting below the floor', cut.objections.some((o) => o.seat === 'Finance' && /floor/.test(o.objection)));
  t.eq('a core Finance objection makes the CEO reject', cut.decision, 'reject');

  // ===== hiring on thin data → Risk opposes =====
  const hire = C.deliberate({ type: 'hiring', amount: 4000 }, { cashBuffer: 20000, capacityUtil: 95, sample: 2 });
  t.ok('Risk opposes a hard-to-reverse commitment on thin data', hire.objections.some((o) => o.seat === 'Risk'));
  t.ok('hiring carries elevated risk score', hire.riskScore >= 40);

  // ===== overcapacity hire: Operations objects (capacity already exists) =====
  const hire2 = C.deliberate({ type: 'add_truck', amount: 1000 }, { cashBuffer: 50000, capacityUtil: 50, sample: 30 });
  t.ok('Operations opposes expansion when utilization is low', hire2.objections.some((o) => o.seat === 'Operations' && /utilization/.test(o.objection)));

  // ===== price raise with soft win rate: Sales objects =====
  const raise = C.deliberate({ type: 'price_change', detail: { direction: 'up' } }, { marginPct: 30, marginFloor: 25, winRate: 0.3, sample: 20 });
  t.ok('Sales objects to a raise when win rate is soft', raise.objections.some((o) => o.seat === 'Sales'));
  t.ok('mixed signals do not auto-approve', raise.decision !== 'approve');

  // ===== submit files a pending review (context auto-filled) + governance =====
  G.AAA_OUTCOME_LEARNING = { aggregate: async () => ({ overall: { winRate: 0.55, avgMarginPct: 28, resolved: 18 } }) };
  const sub = await C.submit({ type: 'large_quote', title: 'Office tower re-carpet', amount: 80000, detail: { marginPct: 18 } }, { actor: 'owner' });
  t.ok('submit files a pending review', sub.ok === true && sub.review.status === 'pending_approval' && Array.isArray(sub.review.positions));
  t.ok('context auto-filled from outcome learning', sub.review.context.winRate === 0.55 && sub.review.context.marginFloor === 25);
  t.ok('low-margin large quote → Finance objection + non-approve', sub.review.objections.some((o) => o.seat === 'Finance') && sub.review.decision !== 'approve');
  t.eq('unknown proposal type rejected', (await C.submit({ type: 'nonsense' })).error, 'UNKNOWN_TYPE');

  // ===== owner acts: gateway-audited; AI + crew blocked =====
  const rid = sub.review.id;
  t.eq('AI cannot act on an executive review', (await C.act(rid, { origin: 'ai' })).error, 'AI_NOT_PERMITTED');
  RB.setRole('crew');
  t.eq('crew cannot act (owner-only)', (await C.act(rid, { actor: 'crew' })).error, 'FORBIDDEN');
  RB.setRole('owner');
  const acted = await C.act(rid, { actor: 'owner', decision: 'approve' });
  t.ok('owner can accept/override', acted.ok === true && (await C.get(rid)).status === 'reviewed' && (await C.get(rid)).ownerDecision === 'approve');
  t.ok('override flag recorded', (await C.get(rid)).overridden === (sub.review.decision !== 'approve'));
  t.ok('owner action audited (REVIEW_EXECUTIVE)', (await GW.recentAudit(100)).some((a) => a.action === 'REVIEW_EXECUTIVE' && a.decision === 'allowed'));

  // mutates no business record
  const before = JSON.stringify(data._store.quotes || {});
  await C.submit({ type: 'marketing_spend', amount: 300 }, { actor: 'owner' });
  t.eq('council mutates no quote/price', JSON.stringify(data._store.quotes || {}), before);

  return t.report();
};
