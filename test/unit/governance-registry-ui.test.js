/* Governance Registry UI — owner panel, history, diff, lifecycle actions, provenance link, gates. */
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
  load('js/intelligence/provenance-store.js');
  load('js/intelligence/governance-registry.js');
  load('js/ui/governance-registry-ui.js');
  G.AAA_UI = fakeUI();
}

module.exports = async function run() {
  const t = makeRunner('governance-registry-ui');
  const { G } = setupEnv();
  loadAll(G);
  const R = G.AAA_GOVERNANCE;
  const STORE = G.AAA_PROVENANCE;
  const UI = G.AAA_GOVERNANCE_UI;
  const RB = G.AAA_RBAC;
  RB.setRole('owner');

  // Seed an artifact with an active version + a second proposed version.
  const a = await R.createDraft('prompt', 'pricing_optimizer', 'v1 prompt body', { actor: 'owner' });
  await R.propose(a.version.id, { actor: 'owner' }); await R.approve(a.version.id, { actor: 'owner' }); await R.activate(a.version.id, { actor: 'owner' });
  const b = await R.createDraft('prompt', 'pricing_optimizer', 'v2 prompt body changed', { actor: 'owner' });
  await R.propose(b.version.id, { actor: 'owner' });
  // a provenance trace that used the active version (for the "used by" link)
  await STORE.record({ subjectType: 'pricing_recommendation', subjectId: 'rec1', promptVersionId: a.version.id, modelVersion: 'deterministic' });

  // --- owner sees the registry panel ---
  const c1 = fakeNode('div', {});
  await UI.render(c1);
  const dash = txt(c1, []).join(' || ');
  t.ok('renders the governed-artifacts panel', /Governed artifacts/.test(dash) && /pricing_optimizer/.test(dash));
  t.ok('shows the active version + checksum', /active: v1/.test(dash) && new RegExp(a.version.checksum).test(dash));
  t.ok('shows the provenance link count', /used by 1 trace/.test(dash));
  t.ok('shows the governance disclaimer', /No version goes active without your approval/.test(dash));

  // --- history drawer: version list + checksum-chain status + lifecycle actions ---
  const body = fakeNode('div', {});
  await UI.renderHistory(body, 'prompt', 'pricing_optimizer');
  const hist = txt(body, []).join(' || ');
  t.ok('history shows both versions', /v1 · /.test(hist) && /v2 · /.test(hist));
  t.ok('history shows checksum-chain status', /Checksum chain/.test(hist) && /intact/.test(hist));
  t.ok('proposed version offers Approve', /Approve/.test(hist));
  t.ok('offers a diff action', /Diff →/.test(hist));

  // --- diff viewer logic ---
  const diff = UI.diffLines('line A\nshared', 'line B\nshared');
  t.ok('diff marks a removed + an added line, keeps shared out', diff.some((d) => d.type === 'del' && /line A/.test(d.text)) && diff.some((d) => d.type === 'add' && /line B/.test(d.text)));
  t.ok('identical content reports no differences', UI.diffLines('same', 'same').every((d) => d.type === 'same'));

  // --- crew is locked out ---
  RB.setRole('crew');
  const cCrew = fakeNode('div', {});
  await UI.render(cCrew);
  const crew = txt(cCrew, []).join(' || ');
  t.ok('crew sees owner-only lock', /owner-only/i.test(crew));
  t.ok('crew sees no artifacts panel', !/Governed artifacts/.test(crew));
  RB.setRole('owner');

  // --- empty + error states ---
  const { G: G2 } = setupEnv(); loadAll(G2); G2.AAA_RBAC.setRole('owner');
  const cEmpty = fakeNode('div', {});
  await G2.AAA_GOVERNANCE_UI.render(cEmpty);
  t.ok('empty state is honest', /No governed artifacts yet/.test(txt(cEmpty, []).join(' ')));

  const { G: G3 } = setupEnv(); loadAll(G3); G3.AAA_RBAC.setRole('owner');
  G3.AAA_GOVERNANCE.artifacts = async () => { throw new Error('boom'); };
  const cErr = fakeNode('div', {});
  await G3.AAA_GOVERNANCE_UI.render(cErr);
  t.ok('error state handled', /Could not load governance/.test(txt(cErr, []).join(' ')));

  return t.report();
};
