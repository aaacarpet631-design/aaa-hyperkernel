/* Knowledge OS UI — ask console, answer render with evidence, permission gates, states. */
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
  load('js/core/aaa-rbac.js'); load('js/intelligence/knowledge-fabric.js'); load('js/ui/knowledge-os-ui.js');
  G.AAA_UI = fakeUI();
}

module.exports = async function run() {
  const t = makeRunner('knowledge-os-ui');
  const { G, data } = setupEnv();
  loadAll(G);
  const K = G.AAA_KNOWLEDGE;
  const UI = G.AAA_KNOWLEDGE_OS_UI;
  const RB = G.AAA_RBAC;
  RB.setRole('owner');

  await data.put('quotes', 'q1', { id: 'q1', quoteId: 'q1', workspaceId: 'ws_test', serviceType: ['apartment_turn'], zip: '90210', customerTotal: 1200, marginPct: 35, status: 'won', resolvedAt: '2026-01-01', createdAt: '2026-01-01' });
  await data.put('quotes', 'q2', { id: 'q2', quoteId: 'q2', workspaceId: 'ws_test', serviceType: ['apartment_turn'], zip: '90210', customerTotal: 1300, marginPct: 38, status: 'won', resolvedAt: '2026-01-02', createdAt: '2026-01-02' });

  // --- owner console ---
  const c1 = fakeNode('div', {});
  await UI.render(c1);
  const dash = txt(c1, []).join(' || ');
  t.ok('renders the ask console with suggested questions', /Ask about the business/.test(dash) && /apartment turns/.test(dash) && /highest margins/.test(dash));
  t.ok('shows the evidence/audit disclaimer', /cite their evidence/.test(dash) && /owner-only/.test(dash));

  // --- answer render with evidence ---
  const aBody = fakeNode('div', {});
  UI.renderAnswer(aBody, await K.ask('last 10 apartment turns'));
  const ans = txt(aBody, []).join(' || ');
  t.ok('answer shows the result + intent + evidence', /apartment/.test(ans) && /intent: last_n/.test(ans) && /Evidence/.test(ans));

  // --- financial answer gated for crew ---
  RB.setRole('crew');
  const cBody = fakeNode('div', {});
  UI.renderAnswer(cBody, await K.ask('which neighborhoods produce the highest margins'));
  t.ok('crew is shown the owner-only lock on a financial answer', /owner only|owner-only/i.test(txt(cBody, []).join(' ')));
  // crew also cannot open the console at all
  const cCrew = fakeNode('div', {});
  await UI.render(cCrew);
  t.ok('crew sees office-only lock on the console', /office-only/i.test(txt(cCrew, []).join(' ')));
  RB.setRole('owner');

  // --- error state ---
  const { G: G2 } = setupEnv(); loadAll(G2); G2.AAA_RBAC.setRole('owner');
  G2.AAA_KNOWLEDGE.index = async () => { throw new Error('boom'); };
  const cErr = fakeNode('div', {});
  await G2.AAA_KNOWLEDGE_OS_UI.render(cErr);
  t.ok('error state handled', /Could not load knowledge/.test(txt(cErr, []).join(' ')));

  return t.report();
};
