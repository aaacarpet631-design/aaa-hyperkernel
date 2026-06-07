/* Security Center UI — status, chain integrity, MFA/enforcement controls, gates, states. */
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
  load('js/core/aaa-rbac.js'); load('js/core/aaa-runtime-gateway.js'); load('js/core/aaa-security.js');
  load('js/ui/security-center-ui.js');
  G.AAA_UI = fakeUI();
}

module.exports = async function run() {
  const t = makeRunner('security-ui');
  const { G, data } = setupEnv();
  loadAll(G);
  const SEC = G.AAA_SECURITY;
  const GW = G.AAA_RUNTIME_GATEWAY;
  const UI = G.AAA_SECURITY_UI;
  const RB = G.AAA_RBAC;
  RB.setRole('owner');

  // generate some sealed audit history + a session
  await GW.run({ action: 'APPROVE_PAYMENT', actor: 'owner', mutate: async () => 'paid' });
  await SEC.startSession({ actor: 'owner', role: 'owner', deviceId: 'devA' });

  // --- owner status panel ---
  const c1 = fakeNode('div', {});
  await UI.render(c1);
  const dash = txt(c1, []).join(' || ');
  t.ok('renders the status summary', /Enforcement/.test(dash) && /Step-up MFA/.test(dash) && /Audit chain/.test(dash));
  t.ok('shows audit-chain integrity (intact)', /Audit chain integrity/.test(dash) && /Intact/.test(dash));
  t.ok('offers step-up + enforcement controls', /Step-up authentication/.test(dash) && /Set PIN/.test(dash) && /enforcement ON/i.test(dash));
  t.ok('shows the server-authority note', /Firestore rules enforce role/.test(dash));
  t.ok('lists a signed approval', /Recent signed approvals/.test(dash) && /APPROVE_PAYMENT/.test(dash));

  // --- tamper shows up in the UI ---
  const entries = (await data.list('audit_log')).sort((a, b) => a.seq - b.seq);
  await data.put('audit_log', entries[0].id, Object.assign({}, entries[0], { action: 'HACKED' }));
  const c2 = fakeNode('div', {});
  await UI.render(c2);
  t.ok('UI surfaces a detected tamper', /break\(s\) detected/.test(txt(c2, []).join(' ')));
  await data.put('audit_log', entries[0].id, entries[0]);

  // --- crew is locked out ---
  RB.setRole('crew');
  const cCrew = fakeNode('div', {});
  await UI.render(cCrew);
  const crew = txt(cCrew, []).join(' || ');
  t.ok('crew sees owner-only lock', /owner-only/i.test(crew));
  t.ok('crew sees no controls', !/Audit chain integrity/.test(crew));
  RB.setRole('owner');

  // --- error state ---
  const { G: G2 } = setupEnv(); loadAll(G2); G2.AAA_RBAC.setRole('owner');
  G2.AAA_SECURITY.status = async () => { throw new Error('boom'); };
  const cErr = fakeNode('div', {});
  await G2.AAA_SECURITY_UI.render(cErr);
  t.ok('error state handled', /Could not load security/.test(txt(cErr, []).join(' ')));

  return t.report();
};
