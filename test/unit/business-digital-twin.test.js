/* Business Digital Twin — baseline model, lever simulations, compare, save, no writes. */
'use strict';
const { makeRunner, setupEnv, load } = require('../helpers/harness');

module.exports = async function run() {
  const t = makeRunner('business-digital-twin');
  const { G, data } = setupEnv();
  load('js/intelligence/business-digital-twin.js');
  const T = G.AAA_DIGITAL_TWIN;

  // seed history: 6 wins @ ~$1500/30% margin + 4 losses across ~2 months
  let i = 0;
  const add = (status, total, margin, day) => { i++; return data.put('quotes', 'q' + i, { id: 'q' + i, quoteId: 'q' + i, workspaceId: 'ws_test', status: status, customerTotal: total, marginPct: margin, sentAt: '2026-01-0' + day, resolvedAt: '2026-01-0' + (day + 1) }); };
  for (let k = 0; k < 6; k++) await add('won', 1500, 30, 1);
  for (let k = 0; k < 4; k++) await add('lost', 1500, 0, 2);
  await data.put('quotes', 'late', { id: 'late', quoteId: 'late', workspaceId: 'ws_test', status: 'won', customerTotal: 1500, marginPct: 30, sentAt: '2026-03-01', resolvedAt: '2026-03-02' });

  // ===== baseline reflects the data =====
  const base = await T.baseline();
  t.ok('baseline derives win rate from data (7/11 ~ 0.64)', base.winRate >= 0.6 && base.winRate <= 0.66);
  t.eq('baseline avg job value from wins', base.avgJobValue, 1500);
  t.eq('baseline avg margin from wins', base.avgMargin, 30);
  t.ok('baseline computes monthly revenue + profit', base.monthlyRevenue > 0 && base.monthlyProfit === Math.round(base.monthlyRevenue * 0.3));

  // ===== ads_spend: more spend → more wins + revenue, ROI-bounded profit =====
  const ads = await T.simulate({ lever: 'ads_spend', magnitude: 1000, horizonMonths: 12 }, { winRate: 0.5, avgJobValue: 1500, avgMargin: 30, monthlyWins: 5, monthlyLeads: 10 });
  t.ok('ads spend lifts monthly wins + revenue', ads.ok === true && ads.delta.monthlyWins > 0 && ads.delta.monthlyRevenue > 0);
  t.ok('ads projection states its assumptions', ads.assumptions.some((a) => /leads/.test(a)) && ads.path.length === 12);
  t.ok('net profit impact is a number over the horizon', typeof ads.netProfitImpact === 'number');

  // ===== hiring: adds capacity + cost; profit nets the crew cost =====
  const hire = await T.simulate({ lever: 'hiring', magnitude: 1 }, { winRate: 0.6, avgJobValue: 1500, avgMargin: 30, monthlyWins: 8, monthlyLeads: 14, capacityUtil: 90 });
  t.ok('hiring adds jobs', hire.delta.monthlyWins > 0 && hire.projected.addedCostPerMonth > 0);
  t.ok('hiring profit nets the crew cost', hire.projected.monthlyProfit === Math.round(hire.projected.monthlyRevenue * 0.3 - hire.projected.addedCostPerMonth));

  // ===== price_change: a raise trades win rate for price (elasticity) =====
  const raise = await T.simulate({ lever: 'price_change', magnitude: 0.1 }, { winRate: 0.6, avgJobValue: 1500, avgMargin: 30, monthlyWins: 8, monthlyLeads: 14 });
  t.ok('a price raise lowers modeled win rate', /win rate to/.test(raise.assumptions.join(' ')) && raise.projected.monthlyWins < 14 * 0.6);
  t.ok('price change is directionally explainable', raise.assumptions.some((a) => /elasticity/.test(a)));

  // ===== new_territory: ramps over time =====
  const terr = await T.simulate({ lever: 'new_territory', magnitude: 20, horizonMonths: 12 }, { winRate: 0.5, avgJobValue: 1500, avgMargin: 30, monthlyWins: 5, monthlyLeads: 10 });
  t.ok('a profitable territory ramps up over time (month 1 < month 12)', terr.path[0].profit < terr.path[11].profit);
  t.eq('unknown lever rejected', (await T.simulate({ lever: 'nope' })).error, 'UNKNOWN_LEVER');

  // ===== compare ranks scenarios by net impact =====
  const cmp = await T.compare([
    { lever: 'ads_spend', magnitude: 2000 },
    { lever: 'hiring', magnitude: 1 },
    { lever: 'price_change', magnitude: -0.2 }
  ], { winRate: 0.5, avgJobValue: 1500, avgMargin: 30, monthlyWins: 6, monthlyLeads: 12, capacityUtil: 85 });
  t.ok('compare ranks by net profit impact (desc)', cmp.ranked.length === 3 && cmp.ranked[0].netProfitImpact >= cmp.ranked[2].netProfitImpact);

  // ===== save a scenario =====
  const saved = await T.save({ lever: 'hiring', magnitude: 1 }, hire, { name: 'Hire a crew', actor: 'owner' });
  t.ok('a scenario can be saved + listed', saved.ok === true && (await T.list()).some((x) => x.id === saved.scenario.id));

  // ===== no business mutation =====
  const before = JSON.stringify(data._store.quotes);
  await T.simulate({ lever: 'ads_spend', magnitude: 500 });
  t.eq('the twin mutates no quote', JSON.stringify(data._store.quotes), before);

  // ===== determinism =====
  const a1 = await T.simulate({ lever: 'ads_spend', magnitude: 1500 }, { winRate: 0.5, avgJobValue: 1500, avgMargin: 30, monthlyWins: 5, monthlyLeads: 10 });
  const a2 = await T.simulate({ lever: 'ads_spend', magnitude: 1500 }, { winRate: 0.5, avgJobValue: 1500, avgMargin: 30, monthlyWins: 5, monthlyLeads: 10 });
  t.eq('simulation is deterministic', JSON.stringify(a1.path), JSON.stringify(a2.path));

  return t.report();
};
