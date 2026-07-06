/* Lead OS × Ad Attribution — Slice 1 intake contract.
 *
 * Guards: attribution offered at lead intake lands in the SEPARATE PII-free
 * ledger (never merged into the lead); UTM + consent + click ids are captured;
 * fromUrl() parses a landing URL without storing anything; missing attribution
 * on paid leads is VISIBLE; and no PII leaks into events, logs, or the
 * attribution collection. */
'use strict';
const { makeRunner, setupEnv, load } = require('../helpers/harness');

module.exports = async function run() {
  const t = makeRunner('lead-attribution');
  const { G } = setupEnv();
  load('js/intelligence/ad-attribution.js');
  load('js/leads/lead-store.js');
  const AD = G.AAA_AD_ATTRIBUTION, LEADS = G.AAA_LEADS;

  // capture everything emitted on the event bus during the test
  const emitted = [];
  G.AAA_EVENTS.on('*', (payload, type) => emitted.push({ type, payload }));

  // ===== fromUrl: pure parse of click ids + UTMs =====
  const parsed = AD.fromUrl('https://aaacarpet.com/repair?gclid=GC-77&utm_source=google&utm_medium=cpc&utm_campaign=Repair-Houston&utm_term=carpet+repair&foo=bar');
  t.ok('fromUrl extracts gclid + utm set', parsed.gclid === 'GC-77' && parsed.utmSource === 'google' && parsed.utmMedium === 'cpc' && parsed.utmCampaign === 'Repair-Houston');
  t.eq('fromUrl keeps the landing path (no query string)', parsed.landingPage, '/repair');
  t.ok('fromUrl ignores unknown params and never throws', !('foo' in parsed) && typeof AD.fromUrl(null) === 'object');

  // ===== intake: attribution rides in the separate ledger =====
  const created = await LEADS.createLead({
    name: 'Maria Gonzalez', phone: '7135559876', source: 'google_ads', serviceType: 'pet damage repair',
    attribution: Object.assign({}, parsed, { channel: 'form', city: 'Houston', zip: '77002', consent: 'granted', searchTerm: 'dog chewed carpet fix' })
  });
  t.ok('google_ads is a valid Lead OS source', created.ok === true);
  t.ok('the lead records that attribution was captured', created.lead.attributionCaptured === true);
  const att = await AD.get(created.lead.leadId);
  t.ok('attribution ledger holds the full click context', att.gclid === 'GC-77' && att.utmCampaign === 'Repair-Houston' && att.channel === 'form' && att.zip === '77002');
  t.eq('consent state is captured', att.consent, 'granted');
  t.ok('the LEAD record itself carries no click ids (separation of stores)', !('gclid' in created.lead) && !('utmCampaign' in created.lead));

  // ===== PII never leaks into attribution, events, or logs =====
  const attDump = JSON.stringify(G.AAA_DATA._store[AD.COLLECTION] || {});
  t.ok('attribution collection holds NO name/phone', attDump.indexOf('Maria') === -1 && attDump.indexOf('7135559876') === -1);
  const evDump = JSON.stringify(emitted);
  t.ok('event bus traffic carries ids only, never name/phone', evDump.indexOf('Maria') === -1 && evDump.indexOf('7135559876') === -1);
  const logDump = JSON.stringify(G.AAA_DATA._store.agent_logs || {});
  t.ok('agent logs hold no PII', logDump.indexOf('Maria') === -1 && logDump.indexOf('7135559876') === -1);

  // ===== consent defaults to unknown; junk consent is not stored =====
  await LEADS.createLead({ name: 'John Roe', phone: '7135550001', source: 'google_ads', serviceType: 'stretching',
    attribution: { gclid: 'GC-88', campaign: 'Stretch-Houston', consent: 'whatever' } });
  const atts = await AD.list();
  const john = atts.find((a) => a.gclid === 'GC-88');
  t.eq('unrecognized consent value degrades to unknown', john.consent, 'unknown');

  // ===== missing attribution is visible =====
  const bare = await LEADS.createLead({ name: 'No Attr', phone: '7135550002', source: 'google_ads', serviceType: 'repair' });
  t.ok('a paid lead with no attribution reports attributionCaptured:false', bare.lead.attributionCaptured === false);
  const gaps = await LEADS.missingAttribution();
  t.ok('missingAttribution lists the gap (ids only, no PII)',
    gaps.some((g) => g.leadId === bare.lead.leadId) && JSON.stringify(gaps).indexOf('No Attr') === -1);
  t.ok('attributed paid leads are NOT flagged as gaps', !gaps.some((g) => g.leadId === created.lead.leadId));

  // ===== organic sources keep working untouched =====
  const organic = await LEADS.createLead({ name: 'Ref Friend', phone: '7135550003', source: 'referral', serviceType: 'repair' });
  t.ok('non-paid lead creation is unchanged', organic.ok && organic.lead.attributionCaptured === false);
  t.ok('non-paid leads never appear in the attribution gap report', !(await LEADS.missingAttribution()).some((g) => g.leadId === organic.lead.leadId));

  return t.report();
};
