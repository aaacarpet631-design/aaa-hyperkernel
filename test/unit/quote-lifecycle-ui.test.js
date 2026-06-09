/* Quote Lifecycle dashboard — renders pipeline + detail; owner-only; customer view hides cost. */
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
    button: (o) => fakeNode('button', o),
    spinner: (text) => fakeNode('spinner', { text: text }),
    sheet: (o) => ({ overlay: fakeNode('div', o), body: fakeNode('div', {}), close() {} }),
    confirm: async () => true
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
  const t = makeRunner('quote-lifecycle-ui');
  const { G, data } = setupEnv();
  load('js/measurements/models/measurement-models.js');
  load('js/quotes/integrations/measurement-to-quote.js');
  load('js/core/aaa-rbac.js');
  load('js/core/aaa-runtime-gateway.js');
  load('js/agents/supervisor.js');
  load('js/agents/estimator-agent.js');
  load('js/quotes/quote-store.js');
  load('js/ui/quote-lifecycle-ui.js');
  G.AAA_UI = fakeUI();
  const M = G.AAA_MEASUREMENT_MODELS;
  const E = G.AAA_ESTIMATOR;
  const Q = G.AAA_QUOTES;
  const UI = G.AAA_QUOTE_LIFECYCLE_UI;
  const RB = G.AAA_RBAC;

  await data.put('jobs', 'j1', { id: 'j1', customerName: 'Jane', estimates: [], workspaceId: 'ws_test' });
  const est = await E.draftQuote({ sessions: [M.newSession({ roomName: 'Living', length: 14, width: 12 })], services: ['carpet_install'], jobId: 'j1', customerName: 'Jane', origin: 'human', actor: 'owner' });
  const q = await Q.get(est.quoteId);

  // --- owner sees the dashboard with pipeline snapshot + filters ---
  RB.setRole('owner');
  const c1 = fakeNode('div', {});
  await UI.render(c1);
  const dash = collectText(c1, []).join(' || ');
  t.ok('renders pipeline snapshot', /Pipeline/.test(dash) && /Close Rate/.test(dash));
  t.ok('renders status filters', /Follow-up/.test(dash) && /Won/.test(dash) && /Lost/.test(dash));
  t.ok('lists the drafted quote', /Jane/.test(dash) && /draft/.test(dash));

  // --- detail drawer: owner sees margin/cost/risk + customer view ---
  const cDetail = fakeNode('div', {});
  UI.renderDetail(cDetail, q);
  const detail = collectText(cDetail, []).join(' || ');
  t.ok('detail shows internal margin/cost section', /Margin & Risk \(internal\)/.test(detail) && /Cost/.test(detail) && /Margin/.test(detail));
  t.ok('detail shows the customer quote section', /Customer Quote \(no internal numbers\)/.test(detail) && /Total:/.test(detail));
  t.ok('detail shows status history + supervisor notes', /Status history/.test(detail) && /Supervisor notes/.test(detail));
  t.ok('detail offers the review action for a draft', /Mark reviewed/.test(detail));
  t.ok('detail carries the no-autopost disclaimer', /nothing here posts to the books/i.test(detail));

  // --- crew is locked out (owner-only / margins) ---
  RB.setRole('crew');
  const cCrew = fakeNode('div', {});
  await UI.render(cCrew);
  const crew = collectText(cCrew, []).join(' || ');
  t.ok('crew sees the owner-only lock', /owner-only/i.test(crew));
  t.ok('crew does NOT see pipeline/margin numbers', !/Close Rate/.test(crew) && !/Won Margin/.test(crew));
  RB.setRole('owner');

  return t.report();
};
