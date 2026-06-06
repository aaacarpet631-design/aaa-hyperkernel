/* Calibration inbox UI — proposals, active versions, rollback; owner-only; empty/error. */
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
  load('js/core/aaa-rbac.js'); load('js/core/aaa-runtime-gateway.js'); load('js/agents/agent-registry.js');
  load('js/agents/supervisor.js'); load('js/quotes/quote-store.js'); load('js/intelligence/outcome-learning-store.js');
  load('js/agents/pricing-optimizer.js'); load('js/intelligence/prediction-closure.js');
  load('js/intelligence/calibration-registry.js'); load('js/ui/calibration-ui.js');
  G.AAA_UI = fakeUI();
}

module.exports = async function run() {
  const t = makeRunner('calibration-ui');
  const { G, data } = setupEnv();
  loadAll(G);
  const UI = G.AAA_CALIBRATION_UI;
  const RB = G.AAA_RBAC;

  await data.put('calibration_proposals', 'cp1', { id: 'cp1', agent: 'pricing_optimizer', workspaceId: 'ws_test', status: 'pending', confidenceBias: 10, riskBias: -5, segmentAdjustments: [{ segmentDim: 'leadSource', segmentKey: 'google', confidenceBias: 10 }], rationale: 'From 3 conclusive closures.', createdAt: '2026-06-10' });
  await data.put('calibration_versions', 'cv1', { id: 'cv1', agent: 'pricing_optimizer', version: 1, active: true, confidenceBias: 8, riskBias: -3, segmentAdjustments: [], appliedBy: 'owner', appliedAt: '2026-06-09', workspaceId: 'ws_test' });

  // --- owner sees inbox + active + rollback ---
  RB.setRole('owner');
  const c1 = fakeNode('div', {});
  await UI.render(c1);
  const dash = txt(c1, []).join(' || ');
  t.ok('renders pending/active/versions summary', /Pending/.test(dash) && /Active/.test(dash) && /Versions/.test(dash));
  t.ok('renders the calibration inbox proposal', /Calibration Inbox/.test(dash) && /pricing_optimizer/.test(dash) && /Approve & apply/.test(dash) && /Reject/.test(dash));
  t.ok('renders active calibration + rollback', /Active Calibration/.test(dash) && /v1/.test(dash) && /Roll back/.test(dash) && /History/.test(dash));
  t.ok('offers generate-from-learning', /Generate proposals from learning/.test(dash));
  t.ok('shows the governance disclaimer', /never changes a price/i.test(dash));

  // --- crew is locked out ---
  RB.setRole('crew');
  const cCrew = fakeNode('div', {});
  await UI.render(cCrew);
  const crew = txt(cCrew, []).join(' || ');
  t.ok('crew sees owner-only lock', /owner-only/i.test(crew));
  t.ok('crew sees no inbox', !/Calibration Inbox/.test(crew));
  RB.setRole('owner');

  // --- empty state ---
  const { G: G2 } = setupEnv();
  loadAll(G2);
  const cEmpty = fakeNode('div', {});
  await G2.AAA_CALIBRATION_UI.render(cEmpty);
  const emptyT = txt(cEmpty, []).join(' ');
  t.ok('empty state is honest', /No pending proposals/.test(emptyT) && /No calibration applied/.test(emptyT));

  // --- error state ---
  const { G: G3 } = setupEnv();
  loadAll(G3);
  G3.AAA_CALIBRATION_REGISTRY.listProposals = async () => { throw new Error('boom'); };
  const cErr = fakeNode('div', {});
  await G3.AAA_CALIBRATION_UI.render(cErr);
  t.ok('error state handled gracefully', /Could not load calibration/.test(txt(cErr, []).join(' ')));

  return t.report();
};
