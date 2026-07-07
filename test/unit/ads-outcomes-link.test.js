/* Ads ↔ Agent Outcome Registry link + the HIGH_MARGIN_JOB financial rule.
 *
 * Guards: every governed ads recommendation lands in the Agent Outcome
 * Registry (agent + confidence intact, outcomeDecisionId linked back); a
 * missing registry degrades honestly (recommend still works, id is null);
 * a human rejection marks the registered decision 'overridden' and queues it
 * as training data; recordJobFinancials always records JOB_COMPLETED and
 * records HIGH_MARGIN_JOB only at/above the adsHighMarginPctFloor flag
 * (default 55%); dedupe holds; invalid inputs are refused; and the raw cost
 * breakdown NEVER reaches the stored events — margin value only. */
'use strict';
const { makeRunner, setupEnv, load } = require('../helpers/harness');

module.exports = async function run() {
  const t = makeRunner('ads-outcomes-link');
  const { G, cfg } = setupEnv();
  load('js/core/aaa-runtime-gateway.js');
  load('js/governance/decision-envelope.js');
  load('js/governance/agent-outcomes.js');
  load('js/intelligence/ad-attribution.js');
  load('js/revenue/ads-conversion-ledger.js');
  load('js/revenue/ads-governance.js');
  const GOV = G.AAA_ADS_GOVERNANCE, OUT = G.AAA_AGENT_OUTCOMES, CL = G.AAA_ADS_CONVERSIONS;

  // ===== recommend() registers the decision in the outcome registry =====
  const rec = await GOV.recommend({
    agent: 'agent:budget-bidding', type: 'BUDGET_CHANGE', campaign: 'Repair-Houston',
    recommendation: 'Raise Repair-Houston daily budget from $40 to $55',
    rationale: 'Impression share lost to budget on winning terms.',
    confidence: 95, impactUSD: 450, payload: { campaign: 'Repair-Houston', dailyBudgetUSD: 55 }
  });
  t.ok('recommend succeeds and links an outcomeDecisionId', rec.ok && !!rec.recommendation.outcomeDecisionId);
  const dec = await OUT.getDecision(rec.recommendation.outcomeDecisionId);
  t.ok('registry decision exists for the same agent', !!dec && dec.agentId === 'agent:budget-bidding' && dec.agentType === 'ads');
  t.eq('confidence carried through (95 normalized to 0.95)', dec && dec.confidence, 0.95);
  t.eq('decision links back to the ads record as its subject', dec && dec.subjectId, rec.recommendation.id);
  t.eq('decision starts pending — no result invented', dec && dec.outcomeStatus, 'pending');
  const stored = (await GOV.list()).find((r) => r.id === rec.recommendation.id);
  t.eq('outcomeDecisionId is persisted on the ads_recommendations record', stored && stored.outcomeDecisionId, dec && dec.decisionId);

  // ===== registry absent → measurement is advisory, governance unblocked =====
  const savedOut = G.AAA_AGENT_OUTCOMES;
  delete G.AAA_AGENT_OUTCOMES;
  const bare = await GOV.recommend({
    agent: 'agent:search-intent', type: 'ANALYSIS',
    recommendation: 'Weekly search-term readout', rationale: 'routine analysis', confidence: 70
  });
  G.AAA_AGENT_OUTCOMES = savedOut;
  t.ok('no registry → recommend still succeeds', bare.ok === true);
  t.eq('…and honestly records outcomeDecisionId null', bare.recommendation.outcomeDecisionId, null);

  // ===== reject() marks the registered decision overridden =====
  const rejected = await GOV.reject(rec.recommendation.id, { approver: 'owner', reason: 'conversion tracking not clean yet' });
  t.ok('owner rejection succeeds', rejected.ok === true && rejected.recommendation.status === 'rejected');
  const overridden = await OUT.getDecision(rec.recommendation.outcomeDecisionId);
  t.eq('registry decision becomes overridden', overridden && overridden.outcomeStatus, 'overridden');
  t.eq('override carries the human reason', overridden && overridden.override && overridden.override.reason, 'conversion tracking not clean yet');
  t.ok('overridden decision entered the training queue', (await OUT.trainingQueue()).some((e) => e.decisionId === rec.recommendation.outcomeDecisionId));

  // ===== recordJobFinancials: JOB_COMPLETED always, HIGH_MARGIN_JOB gated =====
  // cost 4321.99 → margin 5678.01 (56.7801%) — above the default 55% floor.
  const hi = await CL.recordJobFinancials('lead_hi', { revenueUSD: 10000, costUSD: 4321.99, sourceRef: 'job_77' });
  t.ok('JOB_COMPLETED recorded with valueUSD = revenue', hi.ok && hi.events[0].type === 'JOB_COMPLETED' && hi.events[0].valueUSD === 10000);
  t.ok('margin above the default 55% floor → HIGH_MARGIN_JOB with rounded margin value',
    hi.highMargin === true && hi.events.length === 2 && hi.events[1].type === 'HIGH_MARGIN_JOB' && hi.events[1].valueUSD === 5678);
  t.ok('marginPct reported honestly', Math.abs(hi.marginPct - 56.7801) < 1e-9);

  const lo = await CL.recordJobFinancials('lead_lo', { revenueUSD: 1000, costUSD: 500 });
  t.ok('margin below the floor (50%) → JOB_COMPLETED only', lo.ok && lo.highMargin === false && lo.events.length === 1);
  t.eq('no HIGH_MARGIN_JOB stored below the floor', (await CL.listForLead('lead_lo')).filter((e) => e.type === 'HIGH_MARGIN_JOB').length, 0);

  const edge = await CL.recordJobFinancials('lead_edge', { revenueUSD: 1000, costUSD: 450 });
  t.ok('exactly at the floor (55%) counts as high margin', edge.ok && edge.highMargin === true && edge.events[1].valueUSD === 550);

  // ===== custom floor via the adsHighMarginPctFloor flag =====
  cfg.set({ adsHighMarginPctFloor: 70 });
  const c1 = await CL.recordJobFinancials('lead_c1', { revenueUSD: 1000, costUSD: 350 });
  t.ok('65% margin is NOT high margin under a 70% floor', c1.ok && c1.highMargin === false && c1.events.length === 1);
  const c2 = await CL.recordJobFinancials('lead_c2', { revenueUSD: 1000, costUSD: 250 });
  t.ok('75% margin IS high margin under a 70% floor', c2.ok && c2.highMargin === true && c2.events[1].valueUSD === 750);
  cfg.set({ adsHighMarginPctFloor: null }); // back to the default

  // ===== dedupe still holds =====
  const again = await CL.recordJobFinancials('lead_hi', { revenueUSD: 10000, costUSD: 4321.99 });
  t.ok('repeat call is a no-op returning the original events',
    again.ok && again.events.length === 2 && again.events[0].valueUSD === 10000 && again.events[1].valueUSD === 5678);
  t.eq('no duplicate events stored for the lead', (await CL.listForLead('lead_hi')).length, 2);

  // ===== invalid inputs are refused, nothing stored =====
  t.eq('missing fin refused', (await CL.recordJobFinancials('lead_bad')).ok, false);
  t.eq('non-finite revenue refused', (await CL.recordJobFinancials('lead_bad', { revenueUSD: 'lots', costUSD: 10 })).ok, false);
  t.eq('zero revenue refused', (await CL.recordJobFinancials('lead_bad', { revenueUSD: 0, costUSD: 0 })).ok, false);
  t.eq('missing cost refused', (await CL.recordJobFinancials('lead_bad', { revenueUSD: 100 })).ok, false);
  t.eq('missing lead refused', (await CL.recordJobFinancials(null, { revenueUSD: 100, costUSD: 10 })).ok, false);
  t.eq('refused calls stored nothing', (await CL.listForLead('lead_bad')).length, 0);

  // ===== the raw cost never reaches the stored events =====
  const blob = JSON.stringify(G.AAA_DATA._store[CL.COLLECTION] || {});
  t.ok('raw cost (4321.99) is absent from the entire stored collection',
    blob.indexOf('4321.99') === -1 && blob.indexOf('costUSD') === -1);

  return t.report();
};
