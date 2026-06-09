/*
 * Governance Bridge — automatic measurement integration (no network).
 *
 * Covers: agent decision recording (estimator/quote/review-request), idempotent
 * suppression, materially-changed update, outcome auto-attach via business
 * events, backfill (jobs with no decision don't crash), audit entries, and that
 * customer PII never reaches a governance alert payload.
 */
'use strict';
const { makeRunner, setupEnv, load } = require('../helpers/harness');
const flush = () => new Promise((r) => setImmediate(r));

module.exports = async function run() {
  const t = makeRunner('governance-bridge');
  const { G, data } = setupEnv({ config: { role: 'owner', businessName: 'AAA Carpet' } });
  load('js/governance/audit-ledger.js');
  load('js/governance/governance-escalation.js');
  load('js/governance/governance-notifier.js');
  load('js/governance/agent-outcomes.js');
  load('js/governance/governance-bridge.js');
  const B = G.AAA_GOVERNANCE_BRIDGE;
  const O = G.AAA_AGENT_OUTCOMES;
  const L = G.AAA_AUDIT_LEDGER;

  // ---- measure an estimator decision -------------------------------------
  const m = await B.measure('estimator', { agentId: 'measurement_assistant', subjectType: 'job', subjectId: 'j1', jobId: 'j1', customerId: 'cust_1', confidence: 0.7, recommendation: 'replace', sourceModule: 'measurement-ai-assistant', agentVersion: 'v1' });
  t.ok('estimator decision recorded', m.ok === true && !!m.decision.decisionId && m.decision.outcomeStatus === 'pending');
  t.ok('linking metadata stored', m.decision.jobId === 'j1' && m.decision.customerId === 'cust_1' && m.decision.sourceModule === 'measurement-ai-assistant');
  t.ok('decision_recorded audited', (await L.chain()).some((e) => e.type === 'decision_recorded' && e.payload.decisionId === m.decision.decisionId));

  // ---- idempotency: same agent+subject, unchanged → reused ---------------
  const m2 = await B.measure('estimator', { agentId: 'measurement_assistant', subjectType: 'job', subjectId: 'j1', jobId: 'j1', confidence: 0.7, recommendation: 'replace' });
  t.ok('duplicate decision suppressed (reused)', m2.reused === true && m2.decision.decisionId === m.decision.decisionId);
  t.ok('no duplicate row created', (await O.decisionsForAgent('estimator')).length === 1);

  // ---- materially-changed recommendation → updates in place --------------
  const m3 = await B.measure('estimator', { agentId: 'measurement_assistant', subjectType: 'job', subjectId: 'j1', jobId: 'j1', confidence: 0.9, recommendation: 'repair instead' });
  t.ok('changed recommendation updates same decision', m3.updated === true && m3.decision.decisionId === m.decision.decisionId && m3.decision.recommendation === 'repair instead');
  t.ok('decision_updated audited', (await L.chain()).some((e) => e.type === 'decision_updated' && e.payload.decisionId === m.decision.decisionId));

  // a quote agent decision on the same job (distinct agent)
  await B.measure('quote', { agentId: 'quote', subjectType: 'job', subjectId: 'j1', jobId: 'j1', confidence: 0.8, recommendation: '$1,200' });

  // ---- outcome auto-attaches via business event --------------------------
  G.AAA_EVENTS.emit('outcome.recorded', { jobId: 'j1', result: 'won', value: 1200 });
  await flush();
  const dEst = await O.getDecision(m.decision.decisionId);
  t.eq('won_job attaches to estimator decision', dEst.outcomeStatus, 'successful');
  t.ok('outcome value captured', dEst.outcome && dEst.outcome.value === 1200);
  t.ok('outcome_attached audited', (await L.chain()).some((e) => e.type === 'outcome_attached' && e.payload.decisionId === m.decision.decisionId));

  // ---- review-request agent decision (engine integration) ----------------
  G.AAA_DATA.callAgent = async () => ({ ok: true, text: 'Hi Jane, thank you!' });
  G.AAA_CONTENT_SAFETY = { isReady: () => true, async checkResponse() { return { ok: true, safe: true, verdict: 'safe', categories: [] }; } };
  load('js/governance/governance-engine.js');
  load('js/agents/review-request-engine.js');
  await data.put('jobs', 'jr', { id: 'jr', customerName: 'Jane Doe', customerId: 'cust_9', notes: 'cleaned' });
  const rr = await G.AAA_REVIEW_REQUEST_ENGINE.requestReview('jr');
  t.ok('review-request decision recorded + linked on record', !!rr.review.governanceDecisionId);
  const dRev = await O.getDecision(rr.review.governanceDecisionId);
  t.ok('review_request decision exists', !!dRev && dRev.agentType === 'review_request' && dRev.sourceModule === 'review-request-engine' && dRev.jobId === 'jr');

  // review_received attaches to the review_request decision (and not won/lost agents)
  G.AAA_EVENTS.emit('outcome.recorded', { jobId: 'jr', result: 'review' });
  await flush();
  t.eq('review_received attaches to review_request', (await O.getDecision(rr.review.governanceDecisionId)).outcomeStatus, 'successful');

  // ---- backfill: a job with no recorded decision does NOT crash ----------
  const none = await B.attach('won', { jobId: 'legacy-job-no-decisions', value: 999 });
  t.ok('old job without decisionId → no attach, no crash', none.ok === true && none.attached === 0);

  // ---- agentTypes routing: review_received does not touch estimator ------
  await B.measure('estimator', { agentId: 'est2', subjectType: 'job', subjectId: 'j2', jobId: 'j2', confidence: 0.6, recommendation: 'x' });
  const before = (await O.getDecision((await O.decisionsForAgent('estimator')).find((d) => d.jobId === 'j2').decisionId)).outcomeStatus;
  await B.attach('review_received', { jobId: 'j2' });
  const after = (await O.getDecision((await O.decisionsForAgent('estimator')).find((d) => d.jobId === 'j2').decisionId)).outcomeStatus;
  t.ok('review outcome does not attach to estimator decision', before === 'pending' && after === 'pending');

  // ---- PII: customerId never reaches a governance alert payload ----------
  const payload = G.AAA_GOVERNANCE_NOTIFIER.buildPayload({ id: 'e1', kind: 'agent_accuracy', domain: 'agent', category: 'estimator', overrideCount: 1, threshold: 1, affectedCaseIds: [m.decision.decisionId], recommendedAction: 'review', customerId: 'cust_1', customerName: 'Jane Doe', message: 'Hi Jane' });
  const keys = Object.keys(payload);
  t.ok('alert payload omits customerId', keys.indexOf('customerId') === -1);
  t.ok('alert payload omits customer name/message', keys.indexOf('customerName') === -1 && keys.indexOf('message') === -1);
  t.ok('alert payload keeps governance refs (decision ids)', payload.affectedCaseIds[0] === m.decision.decisionId);

  // audit chain stays intact through all of it
  t.ok('audit ledger verifies', (await L.verify()).ok === true);

  return t.report();
};
