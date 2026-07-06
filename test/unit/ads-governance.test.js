/* Ads Governance — every recommendation ships in a sealed Decision Envelope,
 * and every mutation waits for a human.
 *
 * Guards: budget/campaign/bid/goal changes can NEVER auto-approve; approval
 * and apply route through the runtime gateway (aiAllowed:false — an AI-origin
 * call is hard-blocked and audited); nothing applies before approval; every
 * recommendation leaves a governance record (envelope + audit + ads record);
 * and no governance module → no recommendation at all. */
'use strict';
const { makeRunner, setupEnv, load } = require('../helpers/harness');

module.exports = async function run() {
  const t = makeRunner('ads-governance');
  const { G } = setupEnv();
  load('js/core/aaa-runtime-gateway.js');
  load('js/governance/decision-envelope.js');
  load('js/intelligence/ad-attribution.js');
  load('js/revenue/ads-conversion-ledger.js');
  load('js/revenue/ads-governance.js');
  const GOV = G.AAA_ADS_GOVERNANCE, ENV = G.AAA_DECISION_ENVELOPE, CL = G.AAA_ADS_CONVERSIONS;

  // ===== a BUDGET_CHANGE (mutation) requires approval, always =====
  const budget = await GOV.recommend({
    agent: 'agent:budget-bidding', type: 'BUDGET_CHANGE', campaign: 'Repair-Houston',
    recommendation: 'Raise Repair-Houston daily budget from $40 to $55',
    rationale: 'Impression share lost to budget on winning terms; cost per won job $92 vs $170 account avg.',
    confidence: 95, impactUSD: 450, payload: { campaign: 'Repair-Houston', dailyBudgetUSD: 55 }
  });
  t.ok('mutation recommendation is recorded with an envelope', budget.ok && !!budget.envelope.id && budget.recommendation.envelopeId === budget.envelope.id);
  t.ok('mutation ALWAYS awaits approval (even at confidence 95)',
    budget.envelope.approval.required === true && budget.envelope.approval.status === 'awaiting_approval');
  t.ok('the envelope is sealed into the governance store', !!(await ENV.get(budget.envelope.id)));
  t.ok('an ads_recommendations governance record exists', (await GOV.list()).some((r) => r.id === budget.recommendation.id));

  // ===== cannot apply before approval =====
  const early = await GOV.clearForApply(budget.recommendation.id);
  t.eq('clearForApply before approval is refused', early.error, 'NOT_APPROVED');

  // ===== AI cannot approve or apply — gateway hard block =====
  const aiApprove = await GOV.approve(budget.recommendation.id, { origin: 'ai', approver: 'agent:budget-bidding' });
  t.eq('AI-origin approval is hard-blocked by the gateway', aiApprove.error, 'AI_NOT_PERMITTED');
  const humanBadId = await ENV.approve(budget.envelope.id, { approver: 'agent:budget-bidding' });
  t.eq('a non-human approver identity is refused at the envelope too', humanBadId.error, 'NON_HUMAN_APPROVER');

  // ===== human approves → cleared change order; still no API call =====
  const ok = await GOV.approve(budget.recommendation.id, { approver: 'owner' });
  t.ok('human approval succeeds via gateway + envelope', ok.ok && ok.recommendation.status === 'approved');
  const aiApply = await GOV.clearForApply(budget.recommendation.id, { origin: 'ai' });
  t.eq('AI-origin apply is hard-blocked even after approval', aiApply.error, 'AI_NOT_PERMITTED');
  const cleared = await GOV.clearForApply(budget.recommendation.id, { actor: 'owner' });
  t.ok('approved mutation clears with the change order payload',
    cleared.ok && cleared.changeOrder.payload.dailyBudgetUSD === 55 && cleared.changeOrder.envelopeId === budget.envelope.id);
  const audit = Object.values(G.AAA_DATA._store.audit_log || {});
  t.ok('gateway audited the review + apply (and the denied AI attempts)',
    audit.some((a) => a.action === 'REVIEW_ADS_RECOMMENDATION' && a.decision === 'allowed') &&
    audit.some((a) => a.action === 'APPLY_ADS_CHANGE' && a.decision === 'allowed') &&
    audit.some((a) => a.decision === 'denied' && a.reason === 'AI_NOT_PERMITTED'));

  // ===== rejection path =====
  const launch = await GOV.recommend({ agent: 'agent:growth-commander', type: 'CAMPAIGN_LAUNCH', campaign: 'PMax-Test',
    recommendation: 'Launch a PMax campaign', rationale: 'expansion test', confidence: 80, impactUSD: 900 });
  const rejected = await GOV.reject(launch.recommendation.id, { approver: 'owner', reason: 'conversion tracking not clean yet' });
  t.ok('owner can reject; record + envelope both show it', rejected.ok && rejected.recommendation.status === 'rejected');
  t.eq('a rejected mutation can never clear', (await GOV.clearForApply(launch.recommendation.id)).error, 'NOT_APPROVED');

  // ===== analysis tier may auto-approve, and clears without extra approval =====
  const analysis = await GOV.recommend({ agent: 'agent:search-intent', type: 'NEGATIVE_KEYWORD_PATCH',
    recommendation: 'Add negatives: "diy", "rental", "jobs hiring"', rationale: '31 clicks, 0 leads on these terms in 30 days', confidence: 92 });
  t.ok('advisory (non-mutation) may auto-approve when gate+stakes allow', analysis.ok && analysis.recommendation.status === 'auto_approved');
  t.ok('auto-approved ADVISORY clears (guarded-apply tier)', (await GOV.clearForApply(analysis.recommendation.id)).ok === true);

  // ===== conversion export release is human-only via gateway =====
  const AD = G.AAA_AD_ATTRIBUTION;
  await AD.attach('lx', { gclid: 'GC-X', campaign: 'Repair-Houston', consent: 'granted' });
  await CL.record('lx', 'JOB_WON', { valueUSD: 700 });
  const aiExport = await CL.releaseExport({ origin: 'ai' });
  t.eq('AI cannot release a conversion export', aiExport.error, 'AI_NOT_PERMITTED');
  const rel = await CL.releaseExport({ actor: 'owner' });
  t.ok('owner releases the batch; payloads recorded, nothing transmitted',
    rel.ok && rel.batch.status === 'released' && rel.batch.transmitted === false && rel.batch.payloads.length === 1);

  // ===== honest failure modes =====
  t.eq('unknown recommendation types are refused', (await GOV.recommend({ type: 'HACK_THE_PLANET', recommendation: 'x', rationale: 'y', confidence: 50 })).error, 'UNKNOWN_TYPE');
  const savedEnv = G.AAA_DECISION_ENVELOPE; delete G.AAA_DECISION_ENVELOPE;
  const ungoverned = await GOV.recommend({ type: 'BUDGET_CHANGE', recommendation: 'x', rationale: 'y', confidence: 90 });
  G.AAA_DECISION_ENVELOPE = savedEnv;
  t.eq('no governance module → NO recommendation is recorded', ungoverned.error, 'NO_GOVERNANCE');
  const savedGw = G.AAA_RUNTIME_GATEWAY; delete G.AAA_RUNTIME_GATEWAY;
  const noGw = await GOV.approve(budget.recommendation.id, { approver: 'owner' });
  G.AAA_RUNTIME_GATEWAY = savedGw;
  t.eq('no gateway → approval refused (absence of a guard is not permission)', noGw.error, 'NO_GATEWAY');

  return t.report();
};
