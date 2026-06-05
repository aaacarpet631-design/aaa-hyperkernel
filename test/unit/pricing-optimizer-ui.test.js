/* Pricing Optimizer dashboard — renders trend/recs/badges; owner-only; empty state. */
'use strict';
const { makeRunner, setupEnv, load } = require('../helpers/harness');

const BASE = Date.parse('2026-05-01T00:00:00Z');
function iso(days) { return new Date(BASE + days * 86400000).toISOString(); }
function fakeNode(tag, opts) {
  const n = { tag: tag, opts: opts || {}, children: [], _html: '' };
  n.appendChild = function (c) { if (c) n.children.push(c); return c; };
  n.addEventListener = function () {};
  Object.defineProperty(n, 'innerHTML', { get() { return n._html; }, set(v) { n._html = v; if (v === '') n.children = []; } });
  return n;
}
function fakeUI() {
  return {
    el: (tag, opts, children) => { const n = fakeNode(tag, opts); (children || []).forEach((c) => c && n.children.push(c)); return n; },
    button: (o) => fakeNode('button', o), spinner: (text) => fakeNode('spinner', { text: text }),
    sheet: (o) => ({ overlay: fakeNode('div', o), body: fakeNode('div', {}), close() {} }), confirm: async () => true
  };
}
function collectText(n, acc) {
  if (!n || typeof n !== 'object') return acc;
  const o = n.opts || {};
  if (o.text) acc.push(String(o.text));
  if (o.html) acc.push(String(o.html));
  if (o.label) acc.push(String(o.label));
  (n.children || []).forEach((c) => collectText(c, acc));
  return acc;
}

module.exports = async function run() {
  const t = makeRunner('pricing-optimizer-ui');
  const { G, data } = setupEnv();
  load('js/core/aaa-rbac.js');
  load('js/core/aaa-runtime-gateway.js');
  load('js/agents/supervisor.js');
  load('js/quotes/quote-store.js');
  load('js/intelligence/outcome-learning-store.js');
  load('js/agents/pricing-optimizer.js');
  load('js/ui/pricing-optimizer-ui.js');
  G.AAA_UI = fakeUI();
  const UI = G.AAA_PRICING_OPTIMIZER_UI;
  const RB = G.AAA_RBAC;

  let n = 0;
  function seed(q) { n++; const id = 'q' + n; const won = q.status === 'won'; return data.put('quotes', id, Object.assign({ quoteId: id, id: id, workspaceId: 'ws_test', serviceType: ['carpet_install'], zip: '77002', leadSource: 'google', customerTotal: 2600, finalPrice: won ? 2600 : null, marginPct: 25, risk: 40, wonLostReason: won ? 'value' : 'price too high', sentAt: iso(0), resolvedAt: iso(won ? 1 : 5), statusHistory: [{ status: 'sent', at: iso(0) }, { status: q.status, at: iso(won ? 1 : 5) }] }, q)); }
  // 3 google losses → weak lead source + loss-heavy band (a recommendation).
  await seed({ status: 'lost' }); await seed({ status: 'lost' }); await seed({ status: 'lost' });
  await seed({ status: 'won', leadSource: 'referral', zip: '77002', customerTotal: 1500, finalPrice: 1500 });

  // --- owner sees the panel ---
  RB.setRole('owner');
  const c1 = fakeNode('div', {});
  await UI.render(c1);
  const dash = collectText(c1, []).join(' || ');
  t.ok('renders win/loss trend', /Win Rate/.test(dash) && /Resolved/.test(dash));
  t.ok('renders top loss reasons', /Top loss reasons/.test(dash) && /price too high/.test(dash));
  t.ok('renders recommendations section', /Recommendations/.test(dash));
  t.ok('shows confidence/risk + supervisor badges', /conf /.test(dash) && /risk /.test(dash) && /supervisor:/.test(dash));
  t.ok('shows review-required + no-autopilot disclaimer', /Review required/.test(dash) && /never changes a price/i.test(dash));

  // --- crew is locked out ---
  RB.setRole('crew');
  const cCrew = fakeNode('div', {});
  await UI.render(cCrew);
  const crew = collectText(cCrew, []).join(' || ');
  t.ok('crew sees the owner-only lock', /owner-only/i.test(crew));
  t.ok('crew does NOT see win rate / recommendations', !/Win Rate/.test(crew) && !/Recommendations/.test(crew));
  RB.setRole('owner');

  // --- empty-data state ---
  const { G: G2, data: d2 } = setupEnv();
  load('js/core/aaa-rbac.js'); load('js/core/aaa-runtime-gateway.js'); load('js/agents/supervisor.js');
  load('js/quotes/quote-store.js'); load('js/intelligence/outcome-learning-store.js'); load('js/agents/pricing-optimizer.js'); load('js/ui/pricing-optimizer-ui.js');
  G2.AAA_UI = fakeUI();
  const cEmpty = fakeNode('div', {});
  await G2.AAA_PRICING_OPTIMIZER_UI.render(cEmpty);
  t.ok('empty state is honest', /Warming up/.test(collectText(cEmpty, []).join(' ')));

  return t.report();
};
