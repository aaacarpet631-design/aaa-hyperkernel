/* Native Model UI — train, metrics + weights, predict sandbox, promote, gates, states. */
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
  load('js/core/aaa-rbac.js'); load('js/core/aaa-runtime-gateway.js'); load('js/intelligence/governance-registry.js');
  load('js/intelligence/native-model.js'); load('js/ui/native-model-ui.js');
  G.AAA_UI = fakeUI();
}

module.exports = async function run() {
  const t = makeRunner('native-model-ui');
  const { G, data } = setupEnv();
  loadAll(G);
  const M = G.AAA_MODEL;
  const UI = G.AAA_MODEL_UI;
  const RB = G.AAA_RBAC;
  RB.setRole('owner');

  for (let i = 0; i < 24; i++) {
    const won = Math.floor(i / 4) % 2 === 0;
    await data.put('quotes', 'q' + i, { id: 'q' + i, quoteId: 'q' + i, workspaceId: 'ws_test', serviceType: ['carpet'], zip: '90210', leadSource: 'referral', customerTotal: (won ? 600 : 1900) + (i % 4) * 25, marginPct: 30, status: won ? 'won' : 'lost', resolvedAt: '2026-01-01' });
  }
  await M.train({ actor: 'owner' });

  // --- owner lab view ---
  const c1 = fakeNode('div', {});
  await UI.render(c1);
  const dash = txt(c1, []).join(' || ');
  t.ok('renders the model summary', /Active model/.test(dash) && /Holdout acc/.test(dash) && /Candidates/.test(dash));
  t.ok('offers training', /Train a new model/.test(dash));
  t.ok('shows the latest candidate metrics + learned weights', /Latest candidate/.test(dash) && /Learned weights/.test(dash) && /priceZ/.test(dash));
  t.ok('offers promote to governance', /Promote → Governance Registry/.test(dash));
  t.ok('shows the prediction sandbox + governance disclaimer', /Prediction sandbox/.test(dash) && /only goes live when you activate it/.test(dash));

  // --- prediction render ---
  const pBody = fakeNode('div', {});
  UI.renderPrediction(pBody, await M.predict({ customerTotal: 600, marginPct: 30, serviceType: ['carpet'], zip: '90210', leadSource: 'referral' }, { preview: true }), { customerTotal: 600, marginPct: 30 });
  const pred = txt(pBody, []).join(' || ');
  t.ok('prediction shows win probability + explainable reasons', /Win probability:/.test(pred) && /win odds/.test(pred));

  // --- crew lock ---
  RB.setRole('crew');
  const cCrew = fakeNode('div', {});
  await UI.render(cCrew);
  t.ok('crew sees owner-only lock', /owner-only/i.test(txt(cCrew, []).join(' ')));
  RB.setRole('owner');

  // --- error state ---
  const { G: G2 } = setupEnv(); loadAll(G2); G2.AAA_RBAC.setRole('owner');
  G2.AAA_MODEL.candidates = async () => { throw new Error('boom'); };
  const cErr = fakeNode('div', {});
  await G2.AAA_MODEL_UI.render(cErr);
  t.ok('error state handled', /Could not load the model lab/.test(txt(cErr, []).join(' ')));

  return t.report();
};
