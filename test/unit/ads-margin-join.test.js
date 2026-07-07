/* Ads margin join — the click → margin loop: WON quotes join to campaigns via
 * quote.leadId → attribution, giving each campaign row grossMarginUSD +
 * marginKnownWon (coverage of the join, since most quotes may lack a leadId).
 *
 * Guards: quotes without a leadId contribute NOTHING (the gap stays visible);
 * margin is recomputed from finalPrice minus internal cost (jobCost, else the
 * drafted internalCost.total) — never invented; spend-dependent north stars
 * (marginPerAdDollar / costPerMarginDollar) stay null until spend is supplied;
 * rows stay PII-free; and reporting stays read-only by construction. */
'use strict';
const { makeRunner, setupEnv, load } = require('../helpers/harness');

module.exports = async function run() {
  const t = makeRunner('ads-margin-join');
  const { G } = setupEnv();
  load('js/intelligence/ad-attribution.js');
  load('js/revenue/ads-conversion-ledger.js');
  load('js/leads/lead-store.js');
  load('js/core/aaa-rbac.js');
  load('js/core/aaa-runtime-gateway.js');
  load('js/quotes/quote-store.js');
  load('js/revenue/ads-reporting.js');
  const CL = G.AAA_ADS_CONVERSIONS, LEADS = G.AAA_LEADS, Q = G.AAA_QUOTES, REP = G.AAA_ADS_REPORTING;

  function estimateOf(labor, material, total) {
    return { quote: { _laborTotal: labor, _materialTotal: material, total: total },
      receipt: { items: [{ description: 'service', amount: total }], total: total } };
  }
  // Walk a quote draft → reviewed → sent → WON through the gateway.
  async function winQuote(draftInput, wonOpts) {
    const q = await Q.createDraft(draftInput);
    await Q.markReviewed(q.id, { actor: 'owner' });
    await Q.send(q.id, { actor: 'owner' });
    const res = await Q.markWon(q.id, Object.assign({ actor: 'owner', reason: 'test win' }, wonOpts || {}));
    return { quote: res.ok ? res.quote : null, ok: res.ok === true };
  }

  // ---- seed: 2 attributed leads on Repair-Houston, 1 on Stretch-Austin ----
  const l1 = (await LEADS.createLead({ name: 'A One', phone: '7130000001', source: 'google_ads', serviceType: 'repair',
    attribution: { gclid: 'GC-1', campaign: 'Repair-Houston', consent: 'granted' } })).lead;
  const l2 = (await LEADS.createLead({ name: 'B Two', phone: '7130000002', source: 'google_ads', serviceType: 'repair',
    attribution: { gclid: 'GC-2', campaign: 'Repair-Houston', consent: 'granted' } })).lead;
  const l3 = (await LEADS.createLead({ name: 'C Three', phone: '7130000003', source: 'google_ads', serviceType: 'stretching',
    attribution: { gclid: 'GC-3', campaign: 'Stretch-Austin', consent: 'granted' } })).lead;
  for (const l of [l1, l2, l3]) await CL.record(l.leadId, 'LEAD_CREATED', {});
  await CL.record(l1.leadId, 'JOB_WON', { sourceRef: 'q1' });
  await CL.record(l2.leadId, 'JOB_WON', { sourceRef: 'q2' });
  await CL.record(l3.leadId, 'JOB_WON', { sourceRef: 'q3' });

  // Quote A: joined via leadId, actual jobCost recorded → margin 2000 - 1200 = 800.
  const wA = await winQuote({ estimate: estimateOf(900, 300, 2000), leadId: l1.leadId, leadSource: 'google_ads' },
    { finalPrice: 2000, jobCost: 1200 });
  // Quote B: WON but NO leadId → must contribute nothing, anywhere.
  const wB = await winQuote({ estimate: estimateOf(400, 200, 1000), leadSource: 'referral' },
    { finalPrice: 1000, jobCost: 700 });
  // Quote C: joined, no jobCost → falls back to drafted internalCost.total: 500 - (200+100) = 200.
  const wC = await winQuote({ estimate: estimateOf(200, 100, 500), leadId: l3.leadId, leadSource: 'google_ads' },
    { finalPrice: 500 });
  t.ok('all three quotes reached WON', wA.ok && wB.ok && wC.ok);

  // ---- margin join without spend ----
  const before = JSON.stringify(G.AAA_DATA._store);
  const sc = await REP.campaignScorecard();
  const hou = sc.rows.find((r) => r.campaign === 'Repair-Houston');
  const aus = sc.rows.find((r) => r.campaign === 'Stretch-Austin');
  t.ok('scorecard produces both campaign rows', sc.ok && !!hou && !!aus);
  t.eq('grossMarginUSD recomputed from finalPrice - jobCost', hou.grossMarginUSD, 800);
  t.eq('marginKnownWon shows coverage (2 won, only 1 joinable)', hou.marginKnownWon, 1);
  t.eq('won ladder column still counts both wins', hou.won, 2);
  t.eq('no jobCost → falls back to drafted internal cost (500 - 300)', aus.grossMarginUSD, 200);
  t.eq('fallback win counts as margin-known', aus.marginKnownWon, 1);
  t.eq('quote without leadId contributes NO margin to any row',
    sc.rows.reduce((s, r) => s + r.grossMarginUSD, 0), 1000);
  t.ok('no spend → margin north stars stay null',
    sc.rows.every((r) => r.marginPerAdDollar === null && r.costPerMarginDollar === null && r.spendUSD === null));

  // ---- spend unlocks the margin-adjusted north stars ----
  const withSpend = await REP.campaignScorecard({ spendByCampaign: { 'Repair-Houston': 400 } });
  const rs = withSpend.rows.find((r) => r.campaign === 'Repair-Houston');
  const as2 = withSpend.rows.find((r) => r.campaign === 'Stretch-Austin');
  t.eq('marginPerAdDollar = margin / spend (800 / 400)', rs.marginPerAdDollar, 2);
  t.eq('costPerMarginDollar = spend / margin (400 / 800)', rs.costPerMarginDollar, 0.5);
  t.ok('campaign without supplied spend keeps null cells', as2.marginPerAdDollar === null && as2.costPerMarginDollar === null);

  // ---- rows stay PII-free (no leadIds, names, phones) ----
  const rowsStr = JSON.stringify(sc.rows) + JSON.stringify(withSpend.rows);
  t.ok('rows carry no leadId/name/phone keys',
    sc.rows.concat(withSpend.rows).every((r) => !('leadId' in r) && !('name' in r) && !('phone' in r)));
  t.ok('row payloads contain no lead ids or PII values',
    rowsStr.indexOf(l1.leadId) === -1 && rowsStr.indexOf(l3.leadId) === -1 &&
    rowsStr.indexOf('A One') === -1 && rowsStr.indexOf('7130000001') === -1);

  // ---- read-only by construction ----
  t.ok('store byte-identical after scorecard runs', JSON.stringify(G.AAA_DATA._store) === before);

  return t.report();
};
