/* Business Digital Twin UI — baseline model, scenario result, assumptions, gates, states. */
'use strict';
const { makeRunner, setupEnv, load } = require('../helpers/harness');

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
function txt(n, acc) { if (!n || typeof n !== 'object') return acc; const o = n.opts || {}; if (o.text) acc.push(String(o.text)); if (o.html) acc.push(String(o.html)); if (o.label) acc.push(String(o.label)); (n.children || []).forEach((c) => txt(c, acc)); return acc; }

function loadAll(G) {
  load('js/core/aaa-rbac.js'); load('js/intelligence/business-digital-twin.js');
  load('js/ui/business-digital-twin-ui.js');
  G.AAA_UI = fakeUI();
}

module.exports = async function run() {
  const t = makeRunner('business-digital-twin-ui');
  const { G, data } = setupEnv();
  loadAll(G);
  const T = G.AAA_DIGITAL_TWIN;
  const UI = G.AAA_DIGITAL_TWIN_UI;
  const RB = G.AAA_RBAC;
  RB.setRole('owner');

  let i = 0; const add = (status, day) => { i++; return data.put('quotes', 'q' + i, { id: 'q' + i, quoteId: 'q' + i, workspaceId: 'ws_test', status: status, customerTotal: 1500, marginPct: 30, sentAt: '2026-01-0' + day, resolvedAt: '2026-02-0' + day }); };
  for (let k = 0; k < 6; k++) await add('won', 1);
  for (let k = 0; k < 4; k++) await add('lost', 2);

  // --- baseline view ---
  const c1 = fakeNode('div', {});
  await UI.render(c1);
  const dash = txt(c1, []).join(' || ');
  t.ok('renders the current model', /Current model/.test(dash) && /Revenue\/mo/.test(dash) && /Win rate/.test(dash));
  t.ok('offers strategic presets', /Simulate a strategic move/.test(dash) && /Hire a crew/.test(dash) && /ads/.test(dash) && /price/.test(dash));
  t.ok('shows the planning disclaimer', /estimates, not guarantees/.test(dash));

  // --- result view ---
  const res = await T.simulate({ lever: 'ads_spend', magnitude: 1000, horizonMonths: 12 }, { winRate: 0.5, avgJobValue: 1500, avgMargin: 30, monthlyWins: 5, monthlyLeads: 10 });
  const rBody = fakeNode('div', {});
  UI.renderResult(rBody, res);
  const out = txt(rBody, []).join(' || ');
  t.ok('result shows net + before/after', /Net \(12mo\)/.test(out) && /Before → after/.test(out) && /Revenue/.test(out));
  t.ok('result lists assumptions', /Assumptions/.test(out) && /leads/.test(out));
  t.ok('result offers to save the plan', /Save this plan/.test(out));

  // --- crew lock ---
  RB.setRole('crew');
  const cCrew = fakeNode('div', {});
  await UI.render(cCrew);
  t.ok('crew sees owner-only lock', /owner-only/i.test(txt(cCrew, []).join(' ')));
  RB.setRole('owner');

  // --- error state ---
  const { G: G2 } = setupEnv(); loadAll(G2); G2.AAA_RBAC.setRole('owner');
  G2.AAA_DIGITAL_TWIN.baseline = async () => { throw new Error('boom'); };
  const cErr = fakeNode('div', {});
  await G2.AAA_DIGITAL_TWIN_UI.render(cErr);
  t.ok('error state handled', /Could not load the twin/.test(txt(cErr, []).join(' ')));

  return t.report();
};
