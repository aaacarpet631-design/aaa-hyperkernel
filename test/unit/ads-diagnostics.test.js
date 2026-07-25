/* Google Ads Diagnostics — read-only measurement health monitor.
 *
 * Guards the contracts: healthReport() computes every check from the real
 * ledgers; it is PROVABLY read-only (the store is byte-identical after a full
 * run); details are ids-only (a seeded name/phone/dollar value never appears
 * in the report); and a missing module degrades the affected check to
 * status 'warn' with detail 'module unavailable' — never a throw. */
'use strict';
const { makeRunner, setupEnv, load } = require('../helpers/harness');

module.exports = async function run() {
  const t = makeRunner('ads-diagnostics');
  const { G, cfg } = setupEnv();
  load('js/intelligence/ad-attribution.js');
  load('js/revenue/ads-conversion-ledger.js');
  load('js/leads/lead-store.js');
  load('js/ads/google-ads-diagnostics.js');
  const CL = G.AAA_ADS_CONVERSIONS;
  const LEADS = G.AAA_LEADS;
  const DIAG = G.AAA_ADS_DIAGNOSTICS;
  const find = (report, id) => report.checks.find((c) => c.id === id) || {};

  // ===== seed a small world ==================================================
  // Lead A: fully measurable — click id + consent granted.
  const a = await LEADS.createLead({ name: 'Jane Zebra', phone: '7135550001', source: 'google_ads', serviceType: 'repair',
    attribution: { gclid: 'GC-A', campaign: 'Repair-Houston', consent: 'granted' } });
  // Lead B: attributed but broken — no click id, consent unresolved.
  const b = await LEADS.createLead({ name: 'Bob Yonder', phone: '7135550002', source: 'google_ads', serviceType: 'stretch',
    attribution: { campaign: 'Stretch-Houston', consent: 'unknown' } });
  // Lead C: paid source with NO attribution record at all (the measurement gap).
  const c = await LEADS.createLead({ name: 'Cara Xylo', phone: '7135550003', source: 'google_ads', serviceType: 'clean' });
  t.ok('seed leads created', a.ok && b.ok && c.ok);

  await CL.record(a.lead.leadId, 'LEAD_CREATED', {});                    // volume signal, never uploadable
  await CL.record(a.lead.leadId, 'JOB_WON', { valueUSD: 4321 });         // the one clean uploadable payload
  await CL.record(b.lead.leadId, 'QUALIFIED_LEAD', {});                  // skipped: NO_CLICK_ID
  await CL.record(c.lead.leadId, 'ESTIMATE_SENT', {});                   // skipped: NO_ATTRIBUTION
  await CL.record('ghost_1', 'JOB_WON', { valueUSD: 500 });              // orphan: no such lead

  // ===== read-only proof around a full run ===================================
  // The harness fake materializes an empty collection key on first list(); do
  // that read up front so the snapshot compares actual RECORDS, not the fake's
  // lazy bookkeeping.
  await G.AAA_DATA.list('ads_conversion_exports');
  const before = JSON.stringify(G.AAA_DATA._store);
  const r1 = await DIAG.healthReport();
  const after = JSON.stringify(G.AAA_DATA._store);
  t.ok('healthReport is read-only — store byte-identical after a full run', before === after);
  t.ok('report shape: ok + 8 checks + summary', r1.ok === true && r1.checks.length === 8 && !!r1.summary);
  t.ok('every check has id/status/detail', r1.checks.every((ch) => ch.id && ['pass', 'warn', 'fail'].indexOf(ch.status) !== -1 && typeof ch.detail === 'string'));
  const tally = { pass: 0, warn: 0, fail: 0 };
  r1.checks.forEach((ch) => { tally[ch.status]++; });
  t.ok('summary counts match the checks', r1.summary.pass === tally.pass && r1.summary.warn === tally.warn && r1.summary.fail === tally.fail);

  // ===== per-check assertions ================================================
  // click_id_coverage: 1 of 2 attribution records has a click id = 50% → warn (<80), not fail (not <50).
  const cid = find(r1, 'click_id_coverage');
  t.ok('click_id_coverage at exactly the fail floor is warn, not fail', cid.status === 'warn' && cid.count === 1);
  // consent_coverage: B is 'unknown' → warn with the unresolved count.
  const cons = find(r1, 'consent_coverage');
  t.ok('consent_coverage warns when any record is consent-unknown', cons.status === 'warn' && cons.count === 1);
  // upload_blockers: NO_CLICK_ID x1 (B) + NO_ATTRIBUTION x2 (C, ghost) → warn.
  const blk = find(r1, 'upload_blockers');
  t.ok('upload_blockers warns with skipped count', blk.status === 'warn' && blk.count === 3);
  t.ok('upload_blockers histogram of skip reasons', blk.histogram && blk.histogram.NO_CLICK_ID === 1 && blk.histogram.NO_ATTRIBUTION === 2 && blk.histogram.NO_CONSENT == null);
  // dedupe_integrity: the ledger makes violations impossible — check proves it.
  const ded = find(r1, 'dedupe_integrity');
  t.ok('dedupe_integrity passes on a healthy ledger', ded.status === 'pass' && ded.count === 0);
  // orphan_events: ghost_1 has conversion events but no lead.
  const orp = find(r1, 'orphan_events');
  t.ok('orphan_events warns and counts the ghost event', orp.status === 'warn' && orp.count === 1 && orp.detail.indexOf('ghost_1:JOB_WON') !== -1);
  // missing_attribution: lead C is paid-source with no attribution record.
  const mis = find(r1, 'missing_attribution');
  t.ok('missing_attribution warns with the gap count', mis.status === 'warn' && mis.count === 1 && mis.detail.indexOf(c.lead.leadId) !== -1);
  // value_sanity: 4321 and 500 are sane → pass.
  t.ok('value_sanity passes on sane values', find(r1, 'value_sanity').status === 'pass' && find(r1, 'value_sanity').count === 0);
  // unreleased_backlog: A:JOB_WON is uploadable but no released batch exists yet.
  const bkl = find(r1, 'unreleased_backlog');
  t.ok('unreleased_backlog warns for uploadable-but-unreleased payloads', bkl.status === 'warn' && bkl.count === 1 && bkl.detail.indexOf(a.lead.leadId + ':JOB_WON') !== -1);

  // ===== no PII (and no customer dollar values) in the report ================
  const dump = JSON.stringify(r1);
  t.ok('report carries no seeded names', dump.indexOf('Jane') === -1 && dump.indexOf('Zebra') === -1 && dump.indexOf('Bob') === -1 && dump.indexOf('Cara') === -1);
  t.ok('report carries no seeded phones', dump.indexOf('7135550001') === -1 && dump.indexOf('7135550002') === -1 && dump.indexOf('7135550003') === -1);
  t.ok('report carries no per-customer dollar values', dump.indexOf('4321') === -1);

  // ===== backlog clears when a released batch covers the payload =============
  await G.AAA_DATA.put('ads_conversion_exports', 'adsexp_t1', {
    id: 'adsexp_t1', workspaceId: cfg.workspaceId, status: 'released', transmitted: false,
    payloads: [{ eventId: a.lead.leadId + ':JOB_WON' }], skipped: []
  });
  const r2 = await DIAG.healthReport();
  t.ok('unreleased_backlog passes once every payload is in a released batch',
    find(r2, 'unreleased_backlog').status === 'pass' && find(r2, 'unreleased_backlog').count === 0);

  // ===== value_sanity fails on negative / absurd primary-signal values =======
  await CL.record(a.lead.leadId, 'JOB_COMPLETED', { valueUSD: 250000 }); // > adsMaxSaneValueUSD default 100000
  await CL.record('ghost_1', 'JOB_COMPLETED', { valueUSD: -5 });         // negative
  const before3 = JSON.stringify(G.AAA_DATA._store);
  const r3 = await DIAG.healthReport();
  t.ok('still read-only on the second full run', JSON.stringify(G.AAA_DATA._store) === before3);
  const vs = find(r3, 'value_sanity');
  t.ok('value_sanity fails with the count of negative/absurd values', vs.status === 'fail' && vs.count === 2);
  t.ok('value_sanity detail is ids-only — offending amounts never echoed', vs.detail.indexOf('250000') === -1 && vs.detail.indexOf('-5') === -1);

  // ===== thresholds come from config flags ====================================
  cfg.set({ adsClickIdCoverageFailPct: 60 });
  t.eq('raising the fail floor via flag turns 50% coverage into fail', find(await DIAG.healthReport(), 'click_id_coverage').status, 'fail');
  cfg.set({ adsClickIdCoverageFailPct: null });

  // ===== missing-module tolerance: warn, never throw ==========================
  const savedLeads = G.AAA_LEADS; delete G.AAA_LEADS;
  let threw = null, r4 = null;
  try { r4 = await DIAG.healthReport(); } catch (e) { threw = e; }
  G.AAA_LEADS = savedLeads;
  t.ok('a deleted AAA_LEADS never throws', threw === null && r4 && r4.ok === true);
  t.ok('lead-dependent checks degrade to warn: module unavailable',
    find(r4, 'orphan_events').status === 'warn' && find(r4, 'orphan_events').detail === 'module unavailable' &&
    find(r4, 'missing_attribution').status === 'warn' && find(r4, 'missing_attribution').detail === 'module unavailable');

  const savedData = G.AAA_DATA; delete G.AAA_DATA;
  let threw2 = null, r5 = null;
  try { r5 = await DIAG.healthReport(); } catch (e) { threw2 = e; }
  G.AAA_DATA = savedData;
  t.ok('a missing data layer degrades EVERY check to warn, no throw',
    threw2 === null && r5 && r5.checks.length === 8 && r5.checks.every((ch) => ch.status === 'warn' && ch.detail === 'module unavailable'));

  return t.report();
};
