/* Vector Memory UI — semantic console, ranked results, gates, states. */
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
  load('js/core/aaa-rbac.js'); load('js/intelligence/vector-memory.js'); load('js/ui/vector-memory-ui.js');
  G.AAA_UI = fakeUI();
}

module.exports = async function run() {
  const t = makeRunner('vector-memory-ui');
  const { G, data } = setupEnv();
  loadAll(G);
  const VM = G.AAA_VECTOR_MEMORY, UI = G.AAA_VECTOR_MEMORY_UI;
  const RB = G.AAA_RBAC;
  RB.setRole('owner');
  const node = (id, text) => data.put('knowledge_nodes', id, { id: id, workspaceId: 'ws_test', sourceCollection: 'quotes', sourceId: id, kind: 'quote', text: text, sensitivity: 'general' });
  await node('kn_carpet', 'carpet cleaning steam service');
  await node('kn_uphol', 'upholstery sofa cleaning');

  // --- office view ---
  const c1 = fakeNode('div', {});
  await UI.render(c1);
  const dash = txt(c1, []).join(' || ');
  t.ok('renders the memory summary', /Memories/.test(dash) && /Dimensions/.test(dash) && /Embedder/.test(dash));
  t.ok('offers sample semantic searches', /Search by meaning/.test(dash) && /carpet steam cleaning/.test(dash));
  t.ok('shows the on-device disclaimer', /by meaning, not exact words/.test(dash));

  // --- ranked results render ---
  const rBody = fakeNode('div', {});
  await UI.runQuery(rBody, 'carpet washing steam');
  const res = txt(rBody, []).join(' || ');
  t.ok('renders ranked results with similarity', /match\(es\) by meaning/.test(res) && /similarity/.test(res) && /quote/.test(res));

  // --- crew lock ---
  RB.setRole('crew');
  const cCrew = fakeNode('div', {});
  await UI.render(cCrew);
  t.ok('crew sees office-only lock', /office-only/i.test(txt(cCrew, []).join(' ')));
  RB.setRole('owner');

  // --- error state ---
  const { G: G2 } = setupEnv(); loadAll(G2); G2.AAA_RBAC.setRole('owner');
  G2.AAA_VECTOR_MEMORY.index = async () => { throw new Error('boom'); };
  const cErr = fakeNode('div', {});
  await G2.AAA_VECTOR_MEMORY_UI.render(cErr);
  t.ok('error state handled', /Could not load semantic memory/.test(txt(cErr, []).join(' ')));

  return t.report();
};
