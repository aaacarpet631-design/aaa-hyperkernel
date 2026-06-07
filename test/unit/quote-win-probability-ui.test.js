/* Quote Win-Probability — governed model prediction panel in the quote flow. */
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
  load('js/intelligence/native-model.js'); load('js/ui/quote-win-probability-ui.js');
  G.AAA_UI = fakeUI();
}
async function trainAndActivate(G, data) {
  const M = G.AAA_MODEL, GOV = G.AAA_GOVERNANCE;
  for (let i = 0; i < 24; i++) {
    const won = Math.floor(i / 4) % 2 === 0;
    await data.put('quotes', 't' + i, { id: 't' + i, quoteId: 't' + i, workspaceId: 'ws_test', serviceType: ['carpet'], zip: '90210', leadSource: 'referral', customerTotal: (won ? 600 : 1900) + (i % 4) * 25, marginPct: 30, status: won ? 'won' : 'lost', resolvedAt: '2026-01-01' });
  }
  const tr = await M.train({ actor: 'owner' });
  const prom = await M.promote(tr.version.id, { actor: 'owner' });
  await GOV.approve(prom.governanceVersionId, { actor: 'owner' });
  await GOV.activate(prom.governanceVersionId, { actor: 'owner' });
}

module.exports = async function run() {
  const t = makeRunner('quote-win-probability-ui');
  const { G, data } = setupEnv();
  loadAll(G);
  const WIN = G.AAA_QUOTE_WIN_UI;
  const RB = G.AAA_RBAC;
  RB.setRole('owner');

  // ===== no active model → owner is nudged to the Model Lab =====
  const c0 = fakeNode('div', {});
  await WIN.renderInto(c0, { customerTotal: 600, marginPct: 30 });
  t.ok('with no governed model, it nudges to train + activate', /No governed win model is live/.test(txt(c0, []).join(' ')));

  // ===== train + activate a governed model =====
  await trainAndActivate(G, data);

  // ===== panel shows a governed win probability + explainable reasons =====
  const cheap = fakeNode('div', {});
  await WIN.renderInto(cheap, { customerTotal: 600, marginPct: 30, serviceType: ['carpet'], zip: '90210', leadSource: 'referral' });
  const cheapTxt = txt(cheap, []).join(' || ');
  t.ok('renders the governed win-probability panel', /Predicted win probability \(governed model\)/.test(cheapTxt) && /Win likelihood/.test(cheapTxt));
  t.ok('shows that it used the live model', /live/.test(cheapTxt));
  t.ok('explains the prediction (reasons)', /win odds/.test(cheapTxt));
  t.ok('shows the advisory disclaimer', /never prices, sends, or changes the quote/.test(cheapTxt));

  // a pricier quote should read lower than a cheap one (model is live + sane)
  const M = G.AAA_MODEL;
  const cheapP = (await M.predict({ customerTotal: 600, marginPct: 30, serviceType: ['carpet'], zip: '90210', leadSource: 'referral' })).winProbability;
  const priceyP = (await M.predict({ customerTotal: 2000, marginPct: 30, serviceType: ['carpet'], zip: '90210', leadSource: 'referral' })).winProbability;
  t.ok('the live panel reflects price (cheaper > pricier)', cheapP > priceyP);

  // ===== crew sees nothing (owner-only, margin-derived) =====
  RB.setRole('crew');
  const cCrew = fakeNode('div', {});
  await WIN.renderInto(cCrew, { customerTotal: 600, marginPct: 30 });
  t.eq('crew gets no win panel at all', txt(cCrew, []).join(' '), '');
  RB.setRole('owner');

  // ===== integration: the quote detail view mounts the panel when present =====
  const { G: G2, data: d2 } = setupEnv();
  loadAll(G2); G2.AAA_RBAC.setRole('owner');
  load('js/quotes/quote-store.js'); load('js/ui/quote-lifecycle-ui.js');
  await trainAndActivate(G2, d2);
  const q = await G2.AAA_QUOTES.create ? null : null; // store may vary; render a plain quote object
  const detail = fakeNode('div', {});
  G2.AAA_QUOTE_LIFECYCLE_UI.renderDetail(detail, { id: 'qx', customerName: 'Jane', status: 'reviewed', customerTotal: 600, marginPct: 30, serviceType: ['carpet'], zip: '90210', leadSource: 'referral' });
  await new Promise((r) => setTimeout(r, 0)); // let the async renderInto settle
  t.ok('the quote detail view mounts the win panel via the guarded hook', /Predicted win probability/.test(txt(detail, []).join(' ')));

  return t.report();
};
