/* Model Governance UI — model list, status/metrics, provision/enable controls, gates, states. */
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
  load('js/intelligence/provenance-store.js'); load('js/intelligence/governance-registry.js');
  load('js/ai/model-registry.js'); load('js/ai/model-call-provenance.js');
  load('js/ai/providers/nvidia-nemotron-adapter.js'); load('js/ai/model-router.js');
  load('js/ui/model-governance-ui.js');
  G.AAA_UI = fakeUI();
}

module.exports = async function run() {
  const t = makeRunner('model-governance-ui');
  const { G } = setupEnv();
  loadAll(G);
  const R = G.AAA_GOVERNED_MODEL_ROUTER, GOV = G.AAA_GOVERNANCE, UI = G.AAA_MODEL_GOVERNANCE_UI;
  const RB = G.AAA_RBAC;
  RB.setRole('owner');

  // --- owner panel: all three models registered, none governed yet ---
  const c1 = fakeNode('div', {});
  await UI.render(c1);
  const dash = txt(c1, []).join(' || ');
  t.ok('renders the model governance summary', /Live models/.test(dash) && /Registered/.test(dash) && /NVIDIA/.test(dash));
  t.ok('lists all three Nemotron models', /Nemotron-4 340B Instruct/.test(dash) && /Nemotron-4 340B Base/.test(dash) && /Nemotron-4 340B Reward/.test(dash));
  t.ok('flags un-governed / unverified ids + offers provision', /not governed/.test(dash) && /unverified id/.test(dash) && /Provision → Governance/.test(dash));
  t.ok('shows the authority disclaimer', /intelligence engines, not authority engines/.test(dash));

  // --- govern + enable Instruct, then it shows LIVE + enable/disable control ---
  const prov = await R.provision('nvidia.nemotron4_340b_instruct', { actor: 'owner', modelId: 'nvidia/nemotron-4-340b-instruct', verifiedId: true });
  await GOV.approve(prov.governanceVersionId, { actor: 'owner' });
  await GOV.activate(prov.governanceVersionId, { actor: 'owner' });
  await R.setEnabled('nvidia.nemotron4_340b_instruct', true, { actor: 'owner' });
  const c2 = fakeNode('div', {});
  await UI.render(c2);
  const live = txt(c2, []).join(' || ');
  t.ok('a governed + enabled model shows LIVE with a Disable control', /LIVE/.test(live) && /Disable/.test(live));
  t.ok('shows operational metrics (calls/errors/latency)', /calls /.test(live) && /errors/.test(live) && /avg /.test(live));

  // --- crew lock ---
  RB.setRole('crew');
  const cCrew = fakeNode('div', {});
  await UI.render(cCrew);
  t.ok('crew sees owner-only lock', /owner-only/i.test(txt(cCrew, []).join(' ')));
  RB.setRole('owner');

  // --- error state ---
  const { G: G2 } = setupEnv(); loadAll(G2); G2.AAA_RBAC.setRole('owner');
  G2.AAA_GOVERNED_MODEL_ROUTER.status = async () => { throw new Error('boom'); };
  const cErr = fakeNode('div', {});
  await G2.AAA_MODEL_GOVERNANCE_UI.render(cErr);
  t.ok('error state handled', /Could not load model governance/.test(txt(cErr, []).join(' ')));

  return t.report();
};
