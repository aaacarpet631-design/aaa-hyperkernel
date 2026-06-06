/* Executive Council UI — submit, review (seats/objections/risk), owner controls, gates, states. */
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
  load('js/core/aaa-rbac.js'); load('js/core/aaa-runtime-gateway.js'); load('js/intelligence/executive-council.js');
  load('js/ui/executive-council-ui.js');
  G.AAA_UI = fakeUI();
}

module.exports = async function run() {
  const t = makeRunner('executive-council-ui');
  const { G } = setupEnv();
  loadAll(G);
  const C = G.AAA_EXECUTIVE_COUNCIL;
  const UI = G.AAA_EXECUTIVE_COUNCIL_UI;
  const RB = G.AAA_RBAC;
  RB.setRole('owner');

  const sub = await C.submit({ type: 'large_quote', title: 'Office tower', amount: 80000, detail: { marginPct: 18 } }, { actor: 'owner', context: { winRate: 0.5, marginFloor: 25, sample: 20 } });

  // --- owner dashboard ---
  const c1 = fakeNode('div', {});
  await UI.render(c1);
  const dash = txt(c1, []).join(' || ');
  t.ok('renders the submit options', /Submit a high-impact decision/.test(dash) && /large quote/.test(dash) && /price change/.test(dash));
  t.ok('lists reviews with decision + risk', /Reviews \(/.test(dash) && /Office tower/.test(dash) && /risk/.test(dash));
  t.ok('shows the advisory disclaimer', /The council advises; you decide/.test(dash));

  // --- review detail: seats + objections + owner controls ---
  const rBody = fakeNode('div', {});
  UI.renderReview(rBody, await C.get(sub.review.id));
  const detail = txt(rBody, []).join(' || ');
  t.ok('shows all five seats', /CEO/.test(detail) && /Finance/.test(detail) && /Risk/.test(detail) && /Sales/.test(detail) && /Operations/.test(detail));
  t.ok('shows confidence + risk + objections', /Confidence/.test(detail) && /Risk/.test(detail) && /Objections/.test(detail));
  t.ok('surfaces the Finance objection', /floor/.test(detail));
  t.ok('offers owner accept + override', /Your decision/.test(detail) && /Accept \(/.test(detail) && /Override →/.test(detail));

  // --- crew lock ---
  RB.setRole('crew');
  const cCrew = fakeNode('div', {});
  await UI.render(cCrew);
  t.ok('crew sees owner-only lock', /owner-only/i.test(txt(cCrew, []).join(' ')));
  RB.setRole('owner');

  // --- empty + error ---
  const { G: G2 } = setupEnv(); loadAll(G2); G2.AAA_RBAC.setRole('owner');
  const cEmpty = fakeNode('div', {});
  await G2.AAA_EXECUTIVE_COUNCIL_UI.render(cEmpty);
  t.ok('empty state is honest', /No executive reviews yet/.test(txt(cEmpty, []).join(' ')));

  const { G: G3 } = setupEnv(); loadAll(G3); G3.AAA_RBAC.setRole('owner');
  G3.AAA_EXECUTIVE_COUNCIL.list = async () => { throw new Error('boom'); };
  const cErr = fakeNode('div', {});
  await G3.AAA_EXECUTIVE_COUNCIL_UI.render(cErr);
  t.ok('error state handled', /Could not load the council/.test(txt(cErr, []).join(' ')));

  return t.report();
};
