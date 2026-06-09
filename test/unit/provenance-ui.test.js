/* Provenance Graph UI — owner-only trace viewer; trace-to-origin; node chain; gates. */
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
  load('js/core/aaa-rbac.js'); load('js/core/aaa-runtime-gateway.js');
  load('js/quotes/quote-store.js'); load('js/intelligence/outcome-learning-store.js');
  load('js/intelligence/prediction-closure.js'); load('js/intelligence/calibration-registry.js');
  load('js/intelligence/provenance-store.js'); load('js/intelligence/provenance-builder.js');
  load('js/ui/provenance-ui.js');
  G.AAA_UI = fakeUI();
}

module.exports = async function run() {
  const t = makeRunner('provenance-ui');
  const { G, data } = setupEnv();
  loadAll(G);
  const B = G.AAA_PROVENANCE_BUILDER;
  const UI = G.AAA_PROVENANCE_UI;
  const RB = G.AAA_RBAC;

  // Seed a recommendation source + a recorded trace.
  await data.put('quotes', 'q1', { id: 'q1', quoteId: 'q1', workspaceId: 'ws_test', customerName: 'Jane', customerTotal: 500, status: 'won', marginPct: 22, resolvedAt: '2026-01-02T00:00:00Z' });
  await data.put('calibration_versions', 'calv1', { id: 'calv1', agent: 'pricing_optimizer', version: 2, confidenceBias: 4, riskBias: 0, active: true, workspaceId: 'ws_test' });
  const rec = { id: 'rec_pb', type: 'price_band_losses', title: 'Low win rate band', reasoning: 'Only 30% closed.', confidence: 60, adjustedConfidence: 65, risk: 35, supportingQuoteIds: ['q1'], predictionId: null, recommendedAction: 'Review', supervisorReview: { verdict: 'approve', note: 'ok', riskFlags: [] } };
  // The optimizer's analysis is exercised in its own suite; here we pin one
  // recommendation so the trace dashboard has something to list.
  G.AAA_PRICING_OPTIMIZER = { analyze: async () => ({ ok: true, recommendations: [rec] }) };

  // --- owner sees the trace dashboard ---
  RB.setRole('owner');
  const c1 = fakeNode('div', {});
  await UI.render(c1);
  const dash = txt(c1, []).join(' || ');
  t.ok('renders the trace-to-origin header', /Trace to origin/.test(dash));
  t.ok('lists a recommendation with a Trace button', /Trace to origin/.test(dash) && /source quotes/.test(dash));
  t.ok('shows recorded traces section', /Recorded traces/.test(dash));

  // --- the trace view: governed versions + node chain ---
  const g = await B.build('pricing_recommendation', rec);
  const cT = fakeNode('div', {});
  UI.renderTrace(cT, g);
  const view = txt(cT, []).join(' || ');
  t.ok('shows governed versions', /Governed versions/.test(view) && /Model: deterministic/.test(view) && /Calibration: v2/.test(view));
  t.ok('shows the where-it-came-from chain', /Where this came from/.test(view) && /source quotes/.test(view));
  t.ok('renders the source quote node', /Jane/.test(view));
  t.ok('renders the evidence node', /optimizer flagged/.test(view) || /reasonable/.test(view) || /Supervisor/.test(view));

  // --- crew is locked out ---
  RB.setRole('crew');
  const cCrew = fakeNode('div', {});
  await UI.render(cCrew);
  const crew = txt(cCrew, []).join(' || ');
  t.ok('crew sees owner-only lock', /owner-only/i.test(crew));
  t.ok('crew sees no trace list', !/Trace to origin/.test(crew));
  RB.setRole('owner');

  // --- empty + error states ---
  const cTraceMissing = fakeNode('div', {});
  UI.renderTrace(cTraceMissing, null);
  t.ok('missing trace handled', /Trace not found/.test(txt(cTraceMissing, []).join(' ')));

  const { G: G3 } = setupEnv(); loadAll(G3);
  G3.AAA_PROVENANCE.list = async () => { throw new Error('boom'); };
  const cErr = fakeNode('div', {});
  await G3.AAA_PROVENANCE_UI.render(cErr);
  t.ok('error state handled', /Could not load provenance/.test(txt(cErr, []).join(' ')));

  return t.report();
};
