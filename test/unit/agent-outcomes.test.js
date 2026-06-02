/*
 * Agent Outcome Registry + feedback loop + training queue (no network).
 */
'use strict';
const { makeRunner, setupEnv, load } = require('../helpers/harness');

module.exports = async function run() {
  const t = makeRunner('agent-outcomes');
  const { G, data } = setupEnv({});
  load('js/governance/audit-ledger.js');
  load('js/governance/agent-outcomes.js');
  const O = G.AAA_AGENT_OUTCOMES;
  const L = G.AAA_AUDIT_LEDGER;

  // ---- pure helpers -------------------------------------------------------
  t.ok('normConfidence 0..1 passthrough', O.normConfidence(0.8) === 0.8);
  t.ok('normConfidence percent → 0..1', O.normConfidence(80) === 0.8);
  t.ok('normConfidence null', O.normConfidence(null) === null);
  t.eq('won_job → successful', O.resultToStatus('won_job'), 'successful');
  t.eq('chargeback → unsuccessful', O.resultToStatus('chargeback'), 'unsuccessful');
  t.eq('unknown → null', O.resultToStatus('whatever'), null);

  // ---- recordDecision -----------------------------------------------------
  t.eq('agent required', (await O.recordDecision({})).error, 'AGENT_REQUIRED');
  const d = (await O.recordDecision({ agentId: 'quote-1', agentType: 'quote', confidence: 0.9, recommendation: '$1,200', subjectType: 'job', subjectId: 'j1' })).decision;
  t.eq('starts pending', d.outcomeStatus, 'pending');
  t.ok('confidence normalized + ids set', d.confidence === 0.9 && d.agentType === 'quote' && !!d.decisionId);

  // ---- attachOutcome: success -------------------------------------------
  let r = await O.attachOutcome(d.decisionId, { result: 'won_job', value: 1200 });
  t.eq('won → successful', r.decision.outcomeStatus, 'successful');
  t.ok('outcome value captured', r.decision.outcome.value === 1200);
  t.ok('outcome_attached audited', (await L.chain()).some((e) => e.type === 'outcome_attached' && e.payload.decisionId === d.decisionId));
  t.ok('successful does NOT queue training', (await O.trainingQueue()).length === 0);

  // ---- attachOutcome: failure → training queue ---------------------------
  const d2 = (await O.recordDecision({ agentId: 'quote-1', agentType: 'quote', confidence: 0.7, recommendation: '$800' })).decision;
  r = await O.attachOutcome(d2.decisionId, { result: 'refund', value: 800, humanCorrection: 'over-quoted; correct was $500' });
  t.eq('refund → unsuccessful', r.decision.outcomeStatus, 'unsuccessful');
  let tq = await O.trainingQueue();
  t.ok('unsuccessful queued for training', tq.length === 1 && tq[0].decisionId === d2.decisionId);
  t.ok('training entry has correction + final result', tq[0].humanCorrection === 'over-quoted; correct was $500' && tq[0].finalResult === 'unsuccessful');

  // ---- unknown result rejected -------------------------------------------
  const d3 = (await O.recordDecision({ agentId: 'ads-1', agentType: 'ads', confidence: 0.5 })).decision;
  t.eq('unknown result rejected', (await O.attachOutcome(d3.decisionId, { result: 'mystery' })).error, 'UNKNOWN_RESULT');

  // ---- markOverridden → training + audit ---------------------------------
  r = await O.markOverridden(d3.decisionId, { reason: 'human rewrote the ad copy', actorId: 'owner_1' });
  t.eq('overridden status', r.decision.outcomeStatus, 'overridden');
  t.ok('override queued for training', (await O.trainingQueue()).some((x) => x.decisionId === d3.decisionId && x.overrideReason === 'human rewrote the ad copy'));
  t.ok('override audited as outcome_attached', (await L.chain()).some((e) => e.type === 'outcome_attached' && e.payload.outcomeStatus === 'overridden'));

  // ---- markAbandoned (queued for review visibility, Phase 3) -------------
  const d4 = (await O.recordDecision({ agentId: 'seo-1', agentType: 'seo', confidence: 0.4 })).decision;
  const beforeTQ = (await O.trainingQueue()).length;
  await O.markAbandoned(d4.decisionId);
  t.eq('abandoned status', (await O.getDecision(d4.decisionId)).outcomeStatus, 'abandoned');
  t.ok('abandoned is queued for review', (await O.trainingQueue()).length === beforeTQ + 1);
  t.ok('abandoned training entry tagged', (await O.trainingQueue()).some((x) => x.decisionId === d4.decisionId && x.finalResult === 'abandoned'));

  // ---- attachOutcomeBySubject -------------------------------------------
  await O.recordDecision({ agentId: 'sched-1', agentType: 'scheduling', confidence: 0.6, subjectType: 'job', subjectId: 'jX' });
  await O.recordDecision({ agentId: 'sched-2', agentType: 'scheduling', confidence: 0.6, subjectType: 'job', subjectId: 'jX' });
  const bySub = await O.attachOutcomeBySubject('job', 'jX', { result: 'won_job', value: 300 });
  t.eq('attached to all pending subject decisions', bySub.attached, 2);

  return t.report();
};
