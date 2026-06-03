/* AI Estimator UI — renders the builder + result; gates internal cost to margin-viewers. */
'use strict';
const { makeRunner, setupEnv, load } = require('../helpers/harness');

function fakeNode(tag, opts) {
  const n = { tag: tag, opts: opts || {}, children: [], _html: '' };
  n.appendChild = function (c) { if (c) n.children.push(c); return c; };
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
  const t = makeRunner('estimator-ui');
  const { G } = setupEnv();
  load('js/measurements/models/measurement-models.js');
  load('js/quotes/integrations/measurement-to-quote.js');
  load('js/core/aaa-rbac.js');
  load('js/core/aaa-runtime-gateway.js');
  load('js/agents/estimator-agent.js');
  load('js/ui/estimator-ui.js');
  G.AAA_UI = fakeUI();
  const M = G.AAA_MEASUREMENT_MODELS;
  const E = G.AAA_ESTIMATOR;
  const UI = G.AAA_ESTIMATOR_UI;
  const RB = G.AAA_RBAC;

  // Builder renders (owner): tool chrome + a real service option + run button.
  RB.setRole('owner');
  const c1 = fakeNode('div', {});
  UI.render(c1);
  const text1 = collectText(c1, []).join(' || ');
  t.ok('renders the estimator title', /AI Estimator/.test(text1));
  t.ok('offers adding a room', /Add room/.test(text1));
  t.ok('lists a real service option', /Carpet Installation/.test(text1));
  t.ok('has a run button', /Run AI estimate/.test(text1));

  // Build a real estimate to render.
  const est = E.estimate({ sessions: [M.newSession({ roomName: 'Living', length: 12, width: 12 })], services: ['carpet_install'], jobId: 'j1' });
  t.ok('estimate built for render', est.ok === true);

  // Owner (margin-viewer) sees the internal cost breakdown.
  const cOwner = fakeNode('div', {});
  UI.renderResult(cOwner, est, { canSeeMargins: true });
  const ownerText = collectText(cOwner, []).join(' || ');
  t.ok('owner sees confidence + risk', /Confidence/.test(ownerText) && /Risk/.test(ownerText));
  t.ok('owner sees the customer receipt + total', /Customer Receipt/.test(ownerText) && /Total:/.test(ownerText));
  t.ok('owner sees the internal cost breakdown', /Internal \(cost/.test(ownerText) && /Labor/.test(ownerText));
  t.ok('shows the draft-only disclaimer', /never finalizes a price/i.test(ownerText));

  // Crew (no margins) sees the receipt but NOT the internal cost breakdown.
  const cCrew = fakeNode('div', {});
  UI.renderResult(cCrew, est, { canSeeMargins: false });
  const crewText = collectText(cCrew, []).join(' || ');
  t.ok('crew still sees the customer receipt', /Customer Receipt/.test(crewText) && /Total:/.test(crewText));
  t.ok('crew does NOT see internal labor/material', !/Internal \(cost/.test(crewText) && !/Labor/.test(crewText));

  // Honest empty-result state.
  const cEmpty = fakeNode('div', {});
  UI.renderResult(cEmpty, { ok: false, message: 'add a room' }, { canSeeMargins: true });
  t.ok('handles a non-ok estimate gracefully', /add a room/.test(collectText(cEmpty, []).join(' ')));

  return t.report();
};
