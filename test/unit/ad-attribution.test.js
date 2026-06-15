/* Ad Attribution — the closed-loop spine: click-id → lead → conversion value
 * → Google-ready offline-conversion payload + ROAS by campaign.
 *
 * Guards the honest contract: a conversion with no gclid is never emitted (you
 * can't attribute what you can't key); nothing fabricates ad spend it doesn't
 * have; ROAS aggregates are PII-minimized (keyed, never named); and no path
 * throws or transmits anything. */
'use strict';
const { makeRunner, setupEnv, load } = require('../helpers/harness');

module.exports = async function run() {
  const t = makeRunner('ad-attribution');
  const { G } = setupEnv();
  load('js/intelligence/ad-attribution.js');
  const AD = G.AAA_AD_ATTRIBUTION;

  // ===== attach: capture the click context at intake =====
  const a = await AD.attach('lead1', { gclid: 'GC-1', keyword: 'carpet restretch houston', adGroup: 'restretch', campaign: 'Restretch-Houston', searchTerm: 'power stretcher near me', landingPage: '/restretch' });
  t.ok('attach returns ok with the stored attribution', a.ok === true && a.attribution.gclid === 'GC-1');
  t.eq('keyword captured', a.attribution.keyword, 'carpet restretch houston');
  t.ok('source defaults to google_ads', a.attribution.source === 'google_ads');
  t.ok('get returns the attribution', (await AD.get('lead1')).campaign === 'Restretch-Houston');
  t.ok('attach with no leadId fails honestly', (await AD.attach(null, {})).ok === false);

  // upsert preserves capturedAt + conversion, updates fields
  const firstAt = (await AD.get('lead1')).capturedAt;
  await AD.attach('lead1', { gclid: 'GC-1', keyword: 'invisible seam repair' });
  const up = await AD.get('lead1');
  t.ok('attach upserts (keyword updated, capturedAt preserved)', up.keyword === 'invisible seam repair' && up.capturedAt === firstAt);

  // ===== recordConversion: realized value back onto the same gclid =====
  const noAttr = await AD.recordConversion('ghost', { valueUSD: 100 });
  t.eq('conversion without attribution is rejected', noAttr.error, 'NO_ATTRIBUTION');
  const noVal = await AD.recordConversion('lead1', {});
  t.eq('conversion without a value is rejected', noVal.error, 'NO_VALUE');
  const conv = await AD.recordConversion('lead1', { valueUSD: 1240, kind: 'profit', sourceRef: 'q1' });
  t.ok('recordConversion returns an upload-ready payload', conv.ok === true && conv.payload.gclid === 'GC-1' && conv.payload.conversionValueUSD === 1240);
  t.eq('payload currency is USD', conv.payload.currency, 'USD');
  t.ok('payload carries a conversion time', typeof conv.payload.conversionTime === 'string');
  t.eq('profit kind is recorded', conv.conversion.kind, 'profit');

  // ===== more leads for conversions() + roas() =====
  await AD.attach('lead2', { gclid: 'GC-2', campaign: 'Restretch-Houston', keyword: 'restretch' });
  await AD.recordConversion('lead2', { valueUSD: 800, kind: 'revenue' });
  await AD.attach('lead3', { gclid: 'GC-3', campaign: 'Seam-Repair' }); // attributed, NOT converted
  await AD.attach('lead4', { campaign: 'Seam-Repair' });               // converted but NO gclid → not uploadable
  await AD.recordConversion('lead4', { valueUSD: 500, kind: 'revenue' });

  // ===== conversions(): only converted AND keyable =====
  const ups = await AD.conversions();
  t.ok('conversions emits only converted leads WITH a click id', ups.length === 2 && ups.every((p) => p.gclid));
  t.ok('an unconverted attributed lead is excluded', !ups.some((p) => p.leadId === 'lead3'));
  t.ok('a converted lead with NO gclid is excluded (cannot be uploaded)', !ups.some((p) => p.leadId === 'lead4'));
  t.ok('conversions(kind) filters', (await AD.conversions({ kind: 'profit' })).length === 1);

  // ===== roas(): revenue/profit by campaign, PII-min =====
  const roas = await AD.roas({ dimension: 'campaign' });
  const houston = roas.rows.find((r) => r.key === 'Restretch-Houston');
  t.ok('roas groups by campaign with leads + conversions', houston.leads === 2 && houston.conversions === 2);
  t.eq('roas sums profit on the profit-kind conversion', houston.profitUSD, 1240);
  t.eq('roas sums revenue on the revenue-kind conversion', houston.revenueUSD, 800);
  t.ok('roas rows are PII-min (no name/phone fields)', roas.rows.every((r) => !('name' in r) && !('phone' in r) && !('leadId' in r)));
  t.ok('roas leaves spend/ratio null when no spend is supplied (no invented spend)', houston.spendUSD === null && houston.roas === null);
  const withSpend = await AD.roas({ dimension: 'campaign', spendByKey: { 'Restretch-Houston': 400 } });
  const h2 = withSpend.rows.find((r) => r.key === 'Restretch-Houston');
  t.eq('roas ratio computes when spend is supplied (800 rev / 400 spend = 2)', h2.roas, 2);

  // ===== null-safety =====
  const savedData = G.AAA_DATA; delete G.AAA_DATA;
  let threw = null, res = null;
  try { res = await AD.attach('x', { gclid: 'g' }); await AD.conversions(); await AD.roas({}); } catch (e) { threw = e; }
  G.AAA_DATA = savedData;
  t.ok('survives a missing data layer (no throw, honest ok:false)', threw === null && res && res.ok === false);

  return t.report();
};
