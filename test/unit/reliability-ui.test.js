/* Reliability Command Center UI — health, metrics, alerts, incidents, gates, states. */
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
  load('js/core/aaa-rbac.js'); load('js/intelligence/reliability-center.js');
  load('js/ui/reliability-command-center-ui.js');
  G.AAA_UI = fakeUI();
}

module.exports = async function run() {
  const t = makeRunner('reliability-ui');
  const { G } = setupEnv();
  loadAll(G);
  const R = G.AAA_RELIABILITY;
  const UI = G.AAA_RELIABILITY_UI;
  const RB = G.AAA_RBAC;
  RB.setRole('owner');

  // stub signals with a critical condition
  G.AAA_TRANSPORT = { stats: async () => ({ sent: 1, delivered: 2, failed: 5, bounced: 1, pendingApproval: 14, queued: 2 }) };
  G.AAA_OUTCOME_LEARNING = { aggregate: async () => ({ overall: { winRate: 0.5, resolved: 10 } }) };

  // --- owner dashboard ---
  const c1 = fakeNode('div', {});
  await UI.render(c1);
  const dash = txt(c1, []).join(' || ');
  t.ok('renders the health summary', /Health/.test(dash) && /Metrics OK/.test(dash) && /Alerts/.test(dash) && /Open incidents/.test(dash));
  t.ok('renders metric tiles', /Metrics \|\|/.test(dash) || /Transport failure rate/.test(dash));
  t.ok('renders active alerts (crit failure rate)', /Active alerts/.test(dash) && /Transport failure rate/.test(dash));
  t.ok('offers snapshot + evaluate', /Snapshot \+ evaluate/.test(dash));
  t.ok('shows the observability disclaimer', /never auto-remediates/.test(dash));

  // --- incidents appear after evaluate ---
  await R.evaluate();
  const c2 = fakeNode('div', {});
  await UI.render(c2);
  const withInc = txt(c2, []).join(' || ');
  t.ok('incident timeline shows an open incident + resolve', /Incident timeline/.test(withInc) && /critical/.test(withInc) && /Resolve/.test(withInc));

  // --- crew lock ---
  RB.setRole('crew');
  const cCrew = fakeNode('div', {});
  await UI.render(cCrew);
  t.ok('crew sees owner-only lock', /owner-only/i.test(txt(cCrew, []).join(' ')));
  RB.setRole('owner');

  // --- error state ---
  const { G: G2 } = setupEnv(); loadAll(G2); G2.AAA_RBAC.setRole('owner');
  G2.AAA_RELIABILITY.health = async () => { throw new Error('boom'); };
  const cErr = fakeNode('div', {});
  await G2.AAA_RELIABILITY_UI.render(cErr);
  t.ok('error state handled', /Could not load reliability/.test(txt(cErr, []).join(' ')));

  return t.report();
};
