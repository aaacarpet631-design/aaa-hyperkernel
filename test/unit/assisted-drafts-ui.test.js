/* Assisted Drafts UI — pending list, model badge, edit/approve/reject, gates, states. */
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
  load('js/ai/assisted-draft-queue.js'); load('js/ui/assisted-drafts-ui.js');
  G.AAA_UI = fakeUI();
}
async function activate(G) {
  const R = G.AAA_GOVERNED_MODEL_ROUTER, GOV = G.AAA_GOVERNANCE;
  const prov = await R.provision('nvidia.nemotron4_340b_instruct', { actor: 'owner', modelId: 'nvidia/nemotron-4-340b-instruct', verifiedId: true });
  await GOV.approve(prov.governanceVersionId, { actor: 'owner' });
  await GOV.activate(prov.governanceVersionId, { actor: 'owner' });
  await R.setEnabled('nvidia.nemotron4_340b_instruct', true, { actor: 'owner' });
}

module.exports = async function run() {
  const t = makeRunner('assisted-drafts-ui');
  const { G } = setupEnv();
  loadAll(G);
  const Q = G.AAA_ASSISTED_DRAFTS, UI = G.AAA_ASSISTED_DRAFTS_UI;
  const RB = G.AAA_RBAC;
  RB.setRole('owner');
  await activate(G);
  await Q.draft({ customerId: 'c1', customerName: 'Jane', to: '+15551112222', channel: 'sms', intent: 'follow_up', actor: 'owner' });

  // --- office review view ---
  const c1 = fakeNode('div', {});
  await UI.render(c1);
  const dash = txt(c1, []).join(' || ');
  t.ok('renders the queue summary', /Pending you/.test(dash) && /Approved/.test(dash) && /Rejected/.test(dash));
  t.ok('lists a pending draft with the model badge', /follow_up → \+15551112222/.test(dash) && /nvidia\/nemotron-4-340b-instruct/.test(dash) && /conf /.test(dash));
  t.ok('offers edit / approve / reject', /Edit/.test(dash) && /Approve \(ready to send\)/.test(dash) && /Reject/.test(dash));
  t.ok('shows the no-autonomous-send disclaimer', /never sends a customer message on its own/.test(dash));

  // --- crew lock ---
  RB.setRole('crew');
  const cCrew = fakeNode('div', {});
  await UI.render(cCrew);
  t.ok('crew sees office-only lock', /office-only/i.test(txt(cCrew, []).join(' ')));
  RB.setRole('owner');

  // --- error state ---
  const { G: G2 } = setupEnv(); loadAll(G2); G2.AAA_RBAC.setRole('owner');
  G2.AAA_ASSISTED_DRAFTS.list = async () => { throw new Error('boom'); };
  const cErr = fakeNode('div', {});
  await G2.AAA_ASSISTED_DRAFTS_UI.render(cErr);
  t.ok('error state handled', /Could not load drafts/.test(txt(cErr, []).join(' ')));

  return t.report();
};
