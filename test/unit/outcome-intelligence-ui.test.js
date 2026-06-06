/* Outcome Intelligence UI — metrics, scoreboard, patterns, gates, states. */
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
  load('js/core/aaa-rbac.js'); load('js/intelligence/outcome-intelligence.js');
  load('js/ui/outcome-intelligence-ui.js');
  G.AAA_UI = fakeUI();
}

module.exports = async function run() {
  const t = makeRunner('outcome-intelligence-ui');
  const { G, data } = setupEnv();
  loadAll(G);
  const OI = G.AAA_OUTCOME_INTELLIGENCE;
  const UI = G.AAA_OUTCOME_INTELLIGENCE_UI;
  const RB = G.AAA_RBAC;
  RB.setRole('owner');

  await data.put('quotes', 'q1', { id: 'q1', quoteId: 'q1', workspaceId: 'ws_test', status: 'won', marginPct: 30, sentAt: '2026-01-01T00:00:00Z', resolvedAt: '2026-01-03T00:00:00Z' });
  G.AAA_PREDICTION_CLOSURE = { calibrationSummary: async () => ({ agents: [{ agent: 'pricing_optimizer', validated: 8, contradicted: 2, validationRate: 0.8, closures: 10 }] }) };
  G.AAA_OUTCOME_LEARNING = { aggregate: async () => ({ overall: { winRate: 0.6 }, byServiceType: [{ key: 'carpet_install', count: 6, winRate: 0.75, avgMarginPct: 28 }], byZip: [], byLeadSource: [] }) };
  await OI.refresh();

  // --- owner view ---
  const c1 = fakeNode('div', {});
  await UI.render(c1);
  const dash = txt(c1, []).join(' || ');
  t.ok('renders outcome metrics', /Conversion/.test(dash) && /Avg margin/.test(dash) && /Outcomes/.test(dash));
  t.ok('renders the agent scoreboard', /Agent scoreboard/.test(dash) && /pricing_optimizer/.test(dash) && /accuracy/.test(dash));
  t.ok('renders learning patterns', /Learning patterns/.test(dash) && /carpet_install/.test(dash));
  t.ok('offers refresh', /Refresh intelligence/.test(dash));
  t.ok('shows the advisory disclaimer', /nothing is applied automatically/.test(dash));

  // --- crew lock ---
  RB.setRole('crew');
  const cCrew = fakeNode('div', {});
  await UI.render(cCrew);
  t.ok('crew sees owner-only lock', /owner-only/i.test(txt(cCrew, []).join(' ')));
  RB.setRole('owner');

  // --- error state ---
  const { G: G2 } = setupEnv(); loadAll(G2); G2.AAA_RBAC.setRole('owner');
  G2.AAA_OUTCOME_INTELLIGENCE.metrics = async () => { throw new Error('boom'); };
  const cErr = fakeNode('div', {});
  await G2.AAA_OUTCOME_INTELLIGENCE_UI.render(cErr);
  t.ok('error state handled', /Could not load outcome intelligence/.test(txt(cErr, []).join(' ')));

  return t.report();
};
