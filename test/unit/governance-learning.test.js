/*
 * Governance Learning command center — logic (no network).
 *
 * Covers: training queue + filters, recommendation-only supervisor output,
 * accept/reject auditing, improvement-task creation + auditing, PII-stripped
 * JSONL export, thin-data agents not ranked, and missing outcomes not counted
 * as failures.
 */
'use strict';
const { makeRunner, setupEnv, load } = require('../helpers/harness');

module.exports = async function run() {
  const t = makeRunner('gov-learning');
  const { G, data } = setupEnv({ config: { role: 'owner', firebaseUid: 'owner_1', govMinSample: 5 } });
  load('js/core/aaa-rbac.js');
  load('js/governance/audit-ledger.js');
  load('js/governance/governance-escalation.js');
  load('js/governance/agent-outcomes.js');
  load('js/governance/agent-scorecards.js');
  load('js/governance/governance-supervisor.js');
  load('js/governance/governance-learning.js');
  const O = G.AAA_AGENT_OUTCOMES, SC = G.AAA_AGENT_SCORECARDS, L = G.AAA_GOVERNANCE_LEARNING, LED = G.AAA_AUDIT_LEDGER;

  // ---- pure: PII scrub + sample allowlist + JSONL ------------------------
  const dirty = { decisionId: 'd1', agentId: 'review_request', agentType: 'review_request', customerId: 'cust_1', customerName: 'Jane Doe',
    decision: { recommendation: 'Hi Jane, email jane@home.com or call 555-123-4567', confidence: 0.7 },
    outcome: { result: 'refund' }, finalResult: 'unsuccessful', overrideReason: 'contact 555-987-6543', createdAt: 100 };
  const sample = L.toSample(dirty);
  const blob = JSON.stringify(sample);
  t.ok('export drops customerId/customerName', blob.indexOf('cust_1') === -1 && blob.indexOf('Jane Doe') === -1);
  t.ok('export redacts email', blob.indexOf('jane@home.com') === -1 && blob.indexOf('[email]') !== -1);
  t.ok('export redacts phones', blob.indexOf('555-123-4567') === -1 && blob.indexOf('555-987-6543') === -1 && blob.indexOf('[phone]') !== -1);
  t.ok('export keeps governance fields', sample.agentType === 'review_request' && sample.outcomeResult === 'refund' && sample.confidence === 0.7);
  t.ok('JSONL is newline-joined json', L.toJSONL([{ a: 1 }, { a: 2 }]) === '{"a":1}\n{"a":2}');

  // ---- training queue + filters ------------------------------------------
  // seed decisions with outcomes → training entries
  async function seed(agentType, conf, result) {
    const d = (await O.recordDecision({ agentId: agentType, agentType: agentType, confidence: conf, recommendation: 'x' })).decision;
    await O.attachOutcome(d.decisionId, { result: result });
    return d;
  }
  await seed('estimator', 0.8, 'lost_job');     // unsuccessful
  await seed('estimator', 0.6, 'refund');       // unsuccessful, result refund
  await seed('quote', 0.9, 'chargeback');       // unsuccessful, result chargeback
  const all = await L.trainingCases({});
  t.ok('training queue renders cases', all.length === 3);
  t.ok('filter by agentType', (await L.trainingCases({ agentType: 'quote' })).length === 1);
  t.ok('filter by outcome type (refund)', (await L.trainingCases({ outcomeType: 'refund' })).length === 1);
  t.ok('filter by severity high (refund/chargeback)', (await L.trainingCases({ severity: 'high' })).length === 2);
  t.ok('filter by date since', (await L.trainingCases({ since: Date.now() + 1000 })).length === 0);

  // ---- export strips PII + audited ---------------------------------------
  const exp = await L.exportTrainingSamples({ agentType: 'quote' }, {});
  t.ok('export returns jsonl + count', exp.ok === true && exp.count === 1 && typeof exp.jsonl === 'string');
  t.ok('export audited (ids + count, no PII)', (await LED.chain()).some((e) => e.type === 'training_exported' && e.payload.count === 1));

  // ---- supervisor recommendations are recommendation-only ----------------
  // make estimator clearly bad so recs fire
  for (let i = 0; i < 6; i++) { const d = (await O.recordDecision({ agentId: 'estimator', agentType: 'estimator', confidence: 0.8, recommendation: 'r' + i, subjectId: 'sub' + i, subjectType: 'job' })).decision; await O.attachOutcome(d.decisionId, { result: 'lost_job', value: 100 }); }
  await SC.recompute('estimator');
  const recs = await L.recommendations('estimator');
  t.ok('recommendations produced', recs.length >= 1);
  t.ok('recommendations are non-autonomous + proposed', recs.every((r) => r.autonomous === false && r.status === 'proposed'));
  t.ok('recommendation carries evidence/kpi/risk/confidence', recs.some((r) => r.evidence && r.expectedKpiImpact && r.riskLevel && r.confidence != null));

  // ---- accept → task created, both audited -------------------------------
  const rec0 = recs[0];
  const acc = await L.acceptRecommendation(rec0.id, { owner: 'owner_1', sourceTrainingCases: ['t1'] });
  t.ok('accept creates a task', acc.ok === true && acc.task && acc.task.status === 'open' && acc.task.agentId === 'estimator');
  t.ok('task carries source training cases', acc.task.sourceTrainingCases[0] === 't1');
  t.ok('accept audited', (await LED.chain()).some((e) => e.type === 'recommendation_accepted' && e.payload.recId === rec0.id));
  t.ok('task creation audited', (await LED.chain()).some((e) => e.type === 'improvement_task_created' && e.payload.taskId === acc.task.taskId));
  t.eq('recommendation marked accepted', (await data.get('gov_retraining_recommendations', rec0.id)).status, 'accepted');

  // ---- reject audited -----------------------------------------------------
  if (recs[1]) {
    const rej = await L.rejectRecommendation(recs[1].id, { reason: 'not now' });
    t.ok('reject ok + audited', rej.ok === true && (await LED.chain()).some((e) => e.type === 'recommendation_rejected' && e.payload.recId === recs[1].id));
  } else { t.ok('reject audited (skipped: single rec)', true); }

  // ---- task status change audited ----------------------------------------
  await L.updateTaskStatus(acc.task.taskId, 'in_progress', {});
  t.ok('task status change audited', (await LED.chain()).some((e) => e.type === 'task_status_changed' && e.payload.status === 'in_progress'));
  t.eq('bad status rejected', (await L.updateTaskStatus(acc.task.taskId, 'nonsense', {})).error, 'BAD_STATUS');

  // ---- NO autonomy: applying a change is still disabled -------------------
  t.eq('supervisor cannot auto-apply', (await G.AAA_GOVERNANCE_SUPERVISOR.applyChange()).error, 'AUTONOMOUS_CHANGES_DISABLED');

  // ---- thin-data agent not ranked + missing outcomes not failures --------
  // 'newbie' has 2 resolved + 4 pending → insufficient, and pending must not hurt accuracy
  for (let i = 0; i < 2; i++) { const d = (await O.recordDecision({ agentId: 'newbie', agentType: 'newbie', confidence: 0.9, recommendation: 'n', subjectId: 'nb' + i, subjectType: 'job' })).decision; await O.attachOutcome(d.decisionId, { result: 'won_job' }); }
  for (let i = 0; i < 4; i++) await O.recordDecision({ agentId: 'newbie', agentType: 'newbie', confidence: 0.9, recommendation: 'n', subjectId: 'nbp' + i, subjectType: 'job' });
  await SC.recompute('newbie');
  const card = await SC.get('newbie');
  t.ok('thin agent labeled insufficient_data', card.dataQuality.label === 'insufficient_data');
  t.ok('missing outcomes counted separately (4 pending)', card.samples.pending === 4 && card.samples.missingOutcomes === 4);
  t.eq('missing outcomes do not lower accuracy (2/2 won)', card.accuracy, 1);
  const ins = await SC.insights();
  t.ok('thin agent not in worst ranking', !ins.worst.some((c) => c.agentType === 'newbie'));
  t.ok('thin agent surfaced as insufficientData', ins.insufficientData.some((c) => c.agentType === 'newbie'));
  t.ok('missing outcomes flagged in insights', ins.missingOutcomes.some((m) => m.agentType === 'newbie' && m.pending === 4));

  t.ok('audit ledger verifies', (await LED.verify()).ok === true);
  return t.report();
};
