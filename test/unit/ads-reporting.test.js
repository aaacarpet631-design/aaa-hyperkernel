/* Ads Reporting — the read-only join of attribution × conversion ladder ×
 * Lead OS outcomes.
 *
 * Guards: raw leads are NEVER presented as won jobs; revenue comes only from
 * primary signals (no double counting between event values and lead outcomes);
 * spend is never invented; rows are PII-minimal; and the service is read-only
 * by construction — the store is byte-identical after a full report run. */
'use strict';
const { makeRunner, setupEnv, load } = require('../helpers/harness');

module.exports = async function run() {
  const t = makeRunner('ads-reporting');
  const { G } = setupEnv();
  load('js/intelligence/ad-attribution.js');
  load('js/revenue/ads-conversion-ledger.js');
  load('js/leads/lead-store.js');
  load('js/revenue/ads-reporting.js');
  const CL = G.AAA_ADS_CONVERSIONS, LEADS = G.AAA_LEADS, REP = G.AAA_ADS_REPORTING;

  // ---- seed: 3 raw leads on Repair-Houston, 1 wins with revenue ----
  const l1 = (await LEADS.createLead({ name: 'A One', phone: '7130000001', source: 'google_ads', serviceType: 'repair',
    attribution: { gclid: 'GC-1', campaign: 'Repair-Houston', consent: 'granted' } })).lead;
  const l2 = (await LEADS.createLead({ name: 'B Two', phone: '7130000002', source: 'google_ads', serviceType: 'repair',
    attribution: { gclid: 'GC-2', campaign: 'Repair-Houston' } })).lead;
  const l3 = (await LEADS.createLead({ name: 'C Three', phone: '7130000003', source: 'google_ads', serviceType: 'repair',
    attribution: { gclid: 'GC-3', campaign: 'Repair-Houston' } })).lead;
  // paid lead with NO attribution → measurement gap
  const l4 = (await LEADS.createLead({ name: 'D Four', phone: '7130000004', source: 'google_ads', serviceType: 'stretching' })).lead;

  for (const l of [l1, l2, l3]) await CL.record(l.leadId, 'LEAD_CREATED', {});
  await CL.record(l1.leadId, 'QUALIFIED_LEAD', {});
  await CL.record(l1.leadId, 'ESTIMATE_SENT', { sourceRef: 'q1' });
  await CL.record(l1.leadId, 'JOB_WON', { valueUSD: 1500, sourceRef: 'q1' });
  await CL.record(l2.leadId, 'BAD_LEAD', {});

  const sc = await REP.campaignScorecard();
  const row = sc.rows.find((r) => r.campaign === 'Repair-Houston');
  t.ok('scorecard produces the campaign row', sc.ok && !!row);
  t.eq('3 raw leads counted as LEADS', row.leads, 3);
  t.eq('raw leads are NOT won jobs — exactly 1 won', row.won, 1);
  t.eq('revenue is the primary-signal value only', row.revenueUSD, 1500);
  t.eq('bad lead surfaces as a negative column', row.badLeads, 1);
  t.ok('spend is never invented', row.spendUSD === null && row.costPerWonJob === null && row.revenuePerAdDollar === null);
  t.ok('rows are PII-minimal (no names/phones/leadIds)',
    sc.rows.every((r) => !('name' in r) && !('phone' in r) && !('leadId' in r)) &&
    JSON.stringify(sc.rows).indexOf('7130000001') === -1 && JSON.stringify(sc.rows).indexOf('A One') === -1);

  // won outcome revenue on the LEAD is used when no primary event carried value — but never double-counted
  await LEADS.updateStage(l3.leadId, 'CONTACTED');
  await LEADS.updateStage(l3.leadId, 'ESTIMATE_SENT');
  await LEADS.recordOutcome(l3.leadId, { result: 'WON', revenue: 900 });
  const sc2 = await REP.campaignScorecard();
  const row2 = sc2.rows.find((r) => r.campaign === 'Repair-Houston');
  t.eq('lead-outcome revenue joins in (1500 event + 900 outcome)', row2.revenueUSD, 2400);
  await CL.record(l3.leadId, 'JOB_WON', { valueUSD: 900 });
  const sc3 = await REP.campaignScorecard();
  const row3 = sc3.rows.find((r) => r.campaign === 'Repair-Houston');
  t.eq('the same win never counts twice (event value replaces outcome join)', row3.revenueUSD, 2400);

  // spend unlocks unit economics
  const withSpend = await REP.campaignScorecard({ spendByCampaign: { 'Repair-Houston': 600 } });
  const rs = withSpend.rows.find((r) => r.campaign === 'Repair-Houston');
  t.eq('costPerWonJob = spend / won (600 / 2)', rs.costPerWonJob, 300);
  t.eq('revenuePerAdDollar = revenue / spend (2400 / 600)', rs.revenuePerAdDollar, 4);

  // ---- diagnostics: the measurement gap is VISIBLE ----
  const diag = await REP.diagnostics();
  t.ok('paid lead with no attribution is reported', diag.ok && diag.missingAttribution.some((m) => m.leadId === l4.leadId));
  t.ok('consent-unknown leads are reported', diag.consentUnknownLeadIds.indexOf(l2.leadId) !== -1);
  t.ok('blocked uploads carry reasons', diag.blockedUploads.length > 0 && diag.blockedUploads.every((s) => s.reason));

  // ---- ownerBrief: sentences, no PII ----
  const brief = await REP.ownerBrief();
  t.ok('owner brief renders lines incl. the measurement gap', brief.ok && brief.lines.some((l) => l.indexOf('MEASUREMENT GAP') !== -1));
  t.ok('owner brief carries no PII', brief.lines.join(' ').indexOf('A One') === -1 && brief.lines.join(' ').indexOf('7130000001') === -1);

  // ---- read-only by construction ----
  const before = JSON.stringify(G.AAA_DATA._store);
  await REP.campaignScorecard({ spendByCampaign: { 'Repair-Houston': 600 } });
  await REP.diagnostics();
  await REP.ownerBrief();
  t.ok('a full reporting run writes NOTHING to the store', JSON.stringify(G.AAA_DATA._store) === before);

  return t.report();
};
