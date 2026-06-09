/* Learning Fabric UI — insights, segment boards, recall recommendation, gates, states. */
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
  load('js/core/aaa-rbac.js'); load('js/intelligence/learning-fabric.js');
  load('js/ui/learning-fabric-ui.js');
  G.AAA_UI = fakeUI();
}

module.exports = async function run() {
  const t = makeRunner('learning-fabric-ui');
  const { G, data } = setupEnv();
  loadAll(G);
  const F = G.AAA_LEARNING_FABRIC;
  const UI = G.AAA_LEARNING_FABRIC_UI;
  const RB = G.AAA_RBAC;
  RB.setRole('owner');

  const mk = (id, st, zip, total, margin, status, sent, resolved) => ({ id: id, quoteId: id, workspaceId: 'ws_test', serviceType: [st], zip: zip, leadSource: 'referral', customerTotal: total, marginPct: margin, status: status, sentAt: sent, resolvedAt: resolved });
  await data.put('quotes', 'q1', mk('q1', 'carpet_install', '90210', 1500, 30, 'won', '2026-01-01', '2026-01-03'));
  await data.put('quotes', 'q2', mk('q2', 'carpet_install', '90210', 1600, 28, 'won', '2026-01-01', '2026-01-02'));
  await data.put('quotes', 'q3', mk('q3', 'carpet_install', '90210', 1400, 32, 'won', '2026-01-01', '2026-01-04'));

  // --- owner view ---
  const c1 = fakeNode('div', {});
  await UI.render(c1);
  const dash = txt(c1, []).join(' || ');
  t.ok('renders learning summary', /Jobs remembered/.test(dash) && /Ideal follow-up/.test(dash) && /Best segment/.test(dash));
  t.ok('surfaces what the business learned', /What the business has learned/.test(dash) && /carpet_install/.test(dash));
  t.ok('shows segment leaderboards', /Segments by close rate/.test(dash) && /Neighborhoods by margin/.test(dash));
  t.ok('shows the no-hardcoding disclaimer', /no rules are hardcoded/.test(dash));

  // --- recall recommendation render ---
  const rBody = fakeNode('div', {});
  await UI.renderRecall(rBody, { serviceType: 'carpet_install', zip: '90210', leadSource: 'referral' });
  const recall = txt(rBody, []).join(' || ');
  t.ok('recall shows an explainable recommendation', /Recommendation/.test(recall) && /Strong segment/.test(recall) && /Confidence/.test(recall));

  // --- crew lock ---
  RB.setRole('crew');
  const cCrew = fakeNode('div', {});
  await UI.render(cCrew);
  t.ok('crew sees owner-only lock', /owner-only/i.test(txt(cCrew, []).join(' ')));
  RB.setRole('owner');

  // --- error state ---
  const { G: G2 } = setupEnv(); loadAll(G2); G2.AAA_RBAC.setRole('owner');
  G2.AAA_LEARNING_FABRIC.refresh = async () => { throw new Error('boom'); };
  const cErr = fakeNode('div', {});
  await G2.AAA_LEARNING_FABRIC_UI.render(cErr);
  t.ok('error state handled', /Could not load the learning fabric/.test(txt(cErr, []).join(' ')));

  return t.report();
};
