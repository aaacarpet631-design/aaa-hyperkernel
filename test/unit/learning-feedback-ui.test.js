/* Learning Feedback dashboard — render, filters, owner-only, empty + error states. */
'use strict';
const { makeRunner, setupEnv, load } = require('../helpers/harness');

const T0 = '2026-06-01T00:00:00Z';
const AFTER = '2026-06-10T00:00:00Z';
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
  load('js/core/aaa-rbac.js'); load('js/core/aaa-runtime-gateway.js'); load('js/agents/supervisor.js');
  load('js/quotes/quote-store.js'); load('js/intelligence/outcome-learning-store.js');
  load('js/agents/pricing-optimizer.js'); load('js/intelligence/prediction-closure.js'); load('js/ui/learning-feedback-ui.js');
  G.AAA_UI = fakeUI();
}

module.exports = async function run() {
  const t = makeRunner('learning-feedback-ui');
  const { G, data } = setupEnv();
  loadAll(G);
  const UI = G.AAA_LEARNING_FEEDBACK_UI;
  const RB = G.AAA_RBAC;

  let qn = 0;
  const q = (f) => { qn++; const id = 'q' + qn; return data.put('quotes', id, Object.assign({ quoteId: id, id: id, workspaceId: 'ws_test', leadSource: 'google', status: f.status, resolvedAt: AFTER, customerTotal: 1500, marginPct: 30 }, f)); };
  await q({ leadSource: 'google', status: 'won' }); await q({ leadSource: 'google', status: 'won' });
  await q({ leadSource: 'google', status: 'won' }); await q({ leadSource: 'google', status: 'lost' });
  await data.put('agent_decisions', 'P1', { id: 'P1', kind: 'pricing_prediction', agent: 'pricing_optimizer', workspaceId: 'ws_test', recommendationType: 'weak_lead_source', segment: 'google', segmentDim: 'leadSource', metric: 'winRate', expectedDirection: 'up', baseline: 0, baselineSample: 3, createdAt: T0, confidence: 50 });

  // --- owner sees the panel with a validated closure ---
  RB.setRole('owner');
  const c1 = fakeNode('div', {});
  await UI.render(c1);
  const dash = txt(c1, []).join(' || ');
  t.ok('renders validated/contradicted/inconclusive summary', /Validated/.test(dash) && /Contradicted/.test(dash) && /Inconclusive/.test(dash));
  t.ok('renders supervisor calibration (advisory)', /Supervisor calibration/.test(dash) && /not applied/.test(dash));
  t.ok('renders the prediction list', /Predictions \(/.test(dash) && /weak_lead_source/.test(dash));
  t.ok('shows the advisory disclaimer', /nothing reprices or retunes automatically/i.test(dash));

  // --- crew is locked out ---
  RB.setRole('crew');
  const cCrew = fakeNode('div', {});
  await UI.render(cCrew);
  const crew = txt(cCrew, []).join(' || ');
  t.ok('crew sees owner-only lock', /owner-only/i.test(crew));
  t.ok('crew sees no calibration/predictions', !/Supervisor calibration/.test(crew) && !/Predictions \(/.test(crew));
  RB.setRole('owner');

  // --- empty state ---
  const { G: G2 } = setupEnv();
  loadAll(G2);
  const cEmpty = fakeNode('div', {});
  await G2.AAA_LEARNING_FEEDBACK_UI.render(cEmpty);
  t.ok('empty state is honest', /No predictions to close yet/.test(txt(cEmpty, []).join(' ')));

  // --- error state (closure engine throws) ---
  const { G: G3 } = setupEnv();
  loadAll(G3);
  G3.AAA_PREDICTION_CLOSURE.close = async () => { throw new Error('boom'); };
  const cErr = fakeNode('div', {});
  await G3.AAA_LEARNING_FEEDBACK_UI.render(cErr);
  t.ok('error state is handled gracefully', /Could not load learning feedback/.test(txt(cErr, []).join(' ')));

  return t.report();
};
