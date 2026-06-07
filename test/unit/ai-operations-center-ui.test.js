/* AI Operations Center UI — briefing, health, unified action queue, gates, states. */
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
  load('js/core/aaa-rbac.js'); load('js/intelligence/ai-operations-center.js');
  load('js/ui/ai-operations-center-ui.js');
  G.AAA_UI = fakeUI();
}

module.exports = async function run() {
  const t = makeRunner('ai-operations-center-ui');
  const { G } = setupEnv();
  loadAll(G);
  const UI = G.AAA_AI_OPS_UI;
  const RB = G.AAA_RBAC;
  RB.setRole('owner');

  G.AAA_EXECUTIVE_COUNCIL = { list: async () => [{ id: 'exr1', title: 'Hire crew', decision: 'reject', riskScore: 70, objections: [{ seat: 'Finance' }] }] };
  G.AAA_RELIABILITY = { incidents: async () => [{ id: 'inc1', title: 'Transport failure critical', severity: 'crit', firstSeenAt: '2026-06-01' }], health: async () => ({ status: 'crit', score: 60 }) };
  G.AAA_TRANSPORT = { pendingApproval: async () => [{ id: 'm1', category: 'review', channel: 'sms', to: '+1555' }] };

  // --- owner mission control ---
  const c1 = fakeNode('div', {});
  await UI.render(c1);
  const dash = txt(c1, []).join(' || ');
  t.ok('renders the owner briefing headline', /decision\(s\) need you/.test(dash));
  t.ok('renders the health + counts summary', /To decide/.test(dash) && /Health/.test(dash) && /Agent actions/.test(dash));
  t.ok('renders the unified action queue', /Action queue \(/.test(dash) && /Hire crew/.test(dash) && /Transport failure critical/.test(dash));
  t.ok('shows the mission-control disclaimer', /acts on nothing/.test(dash));

  // --- empty / all-clear ---
  const { G: G2 } = setupEnv(); loadAll(G2); G2.AAA_RBAC.setRole('owner');
  ['AAA_EXECUTIVE_COUNCIL', 'AAA_RELIABILITY', 'AAA_TRANSPORT', 'AAA_PRICING_OPTIMIZER', 'AAA_AGENT_COUNCIL', 'AAA_CALIBRATION_REGISTRY', 'AAA_PRIVACY'].forEach((k) => { G2[k] = null; });
  const cEmpty = fakeNode('div', {});
  await G2.AAA_AI_OPS_UI.render(cEmpty);
  t.ok('all-clear when nothing pending', /All clear/.test(txt(cEmpty, []).join(' ')) && /Nothing is waiting/.test(txt(cEmpty, []).join(' ')));

  // --- crew lock ---
  RB.setRole('crew');
  const cCrew = fakeNode('div', {});
  await UI.render(cCrew);
  t.ok('crew sees owner-only lock', /owner-only/i.test(txt(cCrew, []).join(' ')));
  RB.setRole('owner');

  // --- error state ---
  const { G: G3 } = setupEnv(); loadAll(G3); G3.AAA_RBAC.setRole('owner');
  G3.AAA_AI_OPS.digest = async () => { throw new Error('boom'); };
  const cErr = fakeNode('div', {});
  await G3.AAA_AI_OPS_UI.render(cErr);
  t.ok('error state handled', /Could not load operations/.test(txt(cErr, []).join(' ')));

  return t.report();
};
