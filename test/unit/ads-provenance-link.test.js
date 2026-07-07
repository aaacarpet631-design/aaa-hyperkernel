/* Ads Governance ↔ Provenance ledger link.
 *
 * Guards: every governed ads recommendation appends an immutable "why does
 * this exist" trace to AAA_PROVENANCE (evidence ids + envelope id + agent +
 * confidence), linked back via provenanceId on the ads_recommendations
 * record; a missing provenance store degrades honestly (recommend still ok,
 * provenanceId null); a THROWING provenance store is equally advisory; and
 * customer PII (names / phones) NEVER reaches the stored provenance
 * collection — ids and aggregates only. */
'use strict';
const { makeRunner, setupEnv, load } = require('../helpers/harness');

module.exports = async function run() {
  const t = makeRunner('ads-provenance-link');
  const { G } = setupEnv();
  load('js/core/aaa-runtime-gateway.js');
  load('js/governance/decision-envelope.js');
  load('js/intelligence/provenance-store.js');
  load('js/revenue/ads-governance.js');
  const GOV = G.AAA_ADS_GOVERNANCE, PROV = G.AAA_PROVENANCE;

  // A lead world with PII exists nearby — none of it may leak into provenance.
  await G.AAA_DATA.put('leads', 'lead_991', {
    id: 'lead_991', workspaceId: 'ws_test',
    name: 'Zebulon Quiggly-Marchbanks', phone: '555-0104-7788'
  });

  // ===== recommend() with evidence → provenance trace + provenanceId link =====
  const rec = await GOV.recommend({
    agent: 'agent:budget-bidding', type: 'BUDGET_CHANGE', campaign: 'Repair-Houston',
    recommendation: 'Raise Repair-Houston daily budget from $40 to $55',
    rationale: 'Impression share lost to budget on winning terms.',
    confidence: 95, impactUSD: 450,
    payload: { campaign: 'Repair-Houston', dailyBudgetUSD: 55 },
    evidence: [
      { kind: 'lead', label: 'lead_991', detail: 'converted lead id (ids only, no PII)' },
      { kind: 'metric', label: 'cost_per_won_job', detail: '92 vs 170 account avg' },
      'conv_event:lead_991:JOB_WON'
    ]
  });
  t.ok('recommend succeeds', rec.ok === true);
  t.ok('recommendation carries a provenanceId', !!rec.recommendation.provenanceId);

  const trace = await PROV.get(rec.recommendation.provenanceId);
  t.ok('provenanceId points at a real stored trace', !!trace);
  t.eq('trace subject is the ads recommendation', trace && trace.subjectId, rec.recommendation.id);
  t.eq('trace subjectType is ads_recommendation', trace && trace.subjectType, 'ads_recommendation');
  t.eq('trace cites the sealed envelope id', trace && trace.envelopeId, rec.recommendation.envelopeId);
  t.eq('trace carries the agent', trace && trace.agent, 'agent:budget-bidding');
  t.ok('trace summary carries type + confidence + recommendation text',
    !!trace && trace.summary && trace.summary.decision === 'BUDGET_CHANGE' &&
    trace.summary.confidence === 95 &&
    trace.summary.recommendation === 'Raise Repair-Houston daily budget from $40 to $55');
  t.ok('every evidence item is cited in the trace',
    !!trace && Array.isArray(trace.evidence) &&
    trace.evidence.some((e) => e.kind === 'lead' && e.label === 'lead_991') &&
    trace.evidence.some((e) => e.kind === 'metric' && e.label === 'cost_per_won_job') &&
    trace.evidence.some((e) => e.label === 'conv_event:lead_991:JOB_WON'));
  t.ok('the envelope id is also cited as evidence linkage',
    !!trace && trace.evidence.some((e) => e.kind === 'envelope' && e.detail === rec.recommendation.envelopeId));
  t.ok('provenanceId is persisted on the stored ads record',
    ((await GOV.list()).find((r) => r.id === rec.recommendation.id) || {}).provenanceId === rec.recommendation.provenanceId);
  t.ok('the trace is queryable by subject through the store API',
    ((await PROV.latestFor('ads_recommendation', rec.recommendation.id)) || {}).id === rec.recommendation.provenanceId);

  // ===== provenance store absent → advisory, governance unblocked =====
  const savedProv = G.AAA_PROVENANCE;
  delete G.AAA_PROVENANCE;
  const bare = await GOV.recommend({
    agent: 'agent:search-intent', type: 'ANALYSIS',
    recommendation: 'Weekly search-term readout', rationale: 'routine analysis', confidence: 70
  });
  G.AAA_PROVENANCE = savedProv;
  t.ok('no provenance store → recommend still succeeds', bare.ok === true);
  t.eq('…and honestly records provenanceId null', bare.recommendation.provenanceId, null);

  // ===== provenance append THROWS → advisory, governance unblocked =====
  G.AAA_PROVENANCE = { record: async () => { throw new Error('ledger on fire'); } };
  const stormy = await GOV.recommend({
    agent: 'agent:growth-commander', type: 'CAMPAIGN_PAUSE', campaign: 'PMax-Test',
    recommendation: 'Pause PMax-Test', rationale: 'spend without conversions', confidence: 88,
    evidence: ['campaign:PMax-Test']
  });
  G.AAA_PROVENANCE = savedProv;
  t.ok('throwing provenance store → recommend still succeeds', stormy.ok === true);
  t.eq('…and honestly records provenanceId null', stormy.recommendation.provenanceId, null);
  t.ok('the failed attempt persisted provenanceId null on the stored record',
    ((await GOV.list()).find((r) => r.id === stormy.recommendation.id) || {}).provenanceId === null);

  // ===== no PII ever reaches the stored provenance collection =====
  const blob = JSON.stringify(G.AAA_DATA._store[PROV.COLLECTION] || {});
  t.ok('planted customer name never appears in the provenance collection',
    blob.indexOf('Zebulon') === -1 && blob.indexOf('Quiggly-Marchbanks') === -1);
  t.ok('planted customer phone never appears in the provenance collection',
    blob.indexOf('555-0104-7788') === -1);
  t.ok('…while the evidence ids themselves are present', blob.indexOf('lead_991') !== -1);

  return t.report();
};
