/* Ads Conversion Ledger — the deduplicated conversion ladder.
 *
 * Guards the Slice-1 contracts: one event per (leadId, type) ever (uploads can
 * never double-count); LEAD_CREATED is a volume signal, never a primary/bidding
 * signal; records are built by whitelist so PII cannot land in the collection;
 * upload payloads are generated ONLY for click-id'd, consent-granted leads and
 * nothing is ever transmitted. */
'use strict';
const { makeRunner, setupEnv, load } = require('../helpers/harness');

module.exports = async function run() {
  const t = makeRunner('ads-conversion-ledger');
  const { G } = setupEnv();
  load('js/intelligence/ad-attribution.js');
  load('js/revenue/ads-conversion-ledger.js');
  const AD = G.AAA_AD_ATTRIBUTION;
  const CL = G.AAA_ADS_CONVERSIONS;

  // ===== taxonomy =====
  t.eq('the ladder has exactly the 10 planned event types', CL.TYPES.length, 10);
  t.ok('LEAD_CREATED is a volume signal, not business truth', CL.isPrimarySignal('LEAD_CREATED') === false);
  t.ok('JOB_WON / JOB_COMPLETED / HIGH_MARGIN_JOB are the primary signals',
    CL.isPrimarySignal('JOB_WON') && CL.isPrimarySignal('JOB_COMPLETED') && CL.isPrimarySignal('HIGH_MARGIN_JOB'));
  t.ok('BAD_LEAD is a negative signal', CL.typeInfo('BAD_LEAD').direction === 'negative');
  t.eq('unknown types are rejected', (await CL.record('l1', 'CLICKED_AD', {})).error, 'UNKNOWN_TYPE');

  // ===== record + dedupe =====
  const first = await CL.record('l1', 'JOB_WON', { valueUSD: 1200, sourceRef: 'quote_9' });
  t.ok('recording returns the stored event', first.ok && first.event.type === 'JOB_WON' && first.event.valueUSD === 1200);
  const dup = await CL.record('l1', 'JOB_WON', { valueUSD: 9999 });
  t.ok('a repeat (leadId,type) is a dedupe no-op returning the ORIGINAL', dup.ok && dup.deduped === true && dup.event.valueUSD === 1200);
  t.eq('only one JOB_WON event exists for the lead', (await CL.listForLead('l1')).length, 1);
  const other = await CL.record('l1', 'JOB_COMPLETED', { valueUSD: 1200 });
  t.ok('a different type for the same lead is a new event', other.ok && other.deduped === false);

  // ===== PII whitelist =====
  const pii = await CL.record('l2', 'QUALIFIED_LEAD', { valueUSD: null, name: 'Jane Doe', phone: '7135551234', email: 'jane@x.com', note: 'photo quote sent' });
  const stored = (await CL.listForLead('l2'))[0];
  t.ok('record is built by whitelist — name/phone/email never stored',
    pii.ok && !('name' in stored) && !('phone' in stored) && !('email' in stored));
  const dump = JSON.stringify(G.AAA_DATA._store[CL.COLLECTION] || {});
  t.ok('no PII anywhere in the conversion collection', dump.indexOf('Jane') === -1 && dump.indexOf('7135551234') === -1 && dump.indexOf('jane@x.com') === -1);

  // ===== uploadQueue: consent + click-id gated, generated not transmitted =====
  await AD.attach('l1', { gclid: 'GC-1', campaign: 'Repair-Houston', consent: 'granted' });
  await AD.attach('l2', { gclid: 'GC-2', campaign: 'Repair-Houston' });            // consent unknown
  await AD.attach('l3', { campaign: 'Repair-Houston', consent: 'granted' });       // no click id
  await CL.record('l3', 'ESTIMATE_SENT', {});
  await CL.record('l4', 'JOB_WON', { valueUSD: 500 });                             // no attribution at all
  await CL.record('l1', 'BAD_LEAD', {});                                           // negative → never uploadable

  const q = await CL.uploadQueue();
  const ids = q.payloads.map((p) => p.eventId);
  t.ok('consented lead with click id yields payloads', ids.indexOf('l1:JOB_WON') !== -1 && ids.indexOf('l1:JOB_COMPLETED') !== -1);
  t.ok('payload carries gclid + value + orderId dedupe key', q.payloads[0].gclid === 'GC-1' && q.payloads.find((p) => p.eventId === 'l1:JOB_WON').conversionValueUSD === 1200 && q.payloads[0].orderId === q.payloads[0].eventId);
  const reason = (id) => (q.skipped.find((s) => s.eventId === id) || {}).reason;
  t.eq('consent-unknown lead is skipped with NO_CONSENT', reason('l2:QUALIFIED_LEAD'), 'NO_CONSENT');
  t.eq('lead without click id is skipped with NO_CLICK_ID', reason('l3:ESTIMATE_SENT'), 'NO_CLICK_ID');
  t.eq('lead without attribution is skipped with NO_ATTRIBUTION', reason('l4:JOB_WON'), 'NO_ATTRIBUTION');
  t.ok('negative + volume signals are never in the upload queue',
    !ids.some((id) => id.indexOf('BAD_LEAD') !== -1 || id.indexOf('LEAD_CREATED') !== -1));

  // ===== null-safety =====
  const savedData = G.AAA_DATA; delete G.AAA_DATA;
  let threw = null, res = null;
  try { res = await CL.record('x', 'JOB_WON', {}); await CL.list(); await CL.uploadQueue(); } catch (e) { threw = e; }
  G.AAA_DATA = savedData;
  t.ok('survives a missing data layer (no throw, honest ok:false)', threw === null && res && res.ok === false);

  return t.report();
};
