/* Vector Memory — deterministic embedder, semantic ranking, permission-aware, pluggable seam. */
'use strict';
const { makeRunner, setupEnv, load } = require('../helpers/harness');

module.exports = async function run() {
  const t = makeRunner('vector-memory');
  const { G, data } = setupEnv();
  load('js/core/aaa-rbac.js');
  load('js/intelligence/vector-memory.js');
  const VM = G.AAA_VECTOR_MEMORY;
  const RB = G.AAA_RBAC;
  RB.setRole('owner');

  // Seed Knowledge OS nodes directly (the corpus VM indexes).
  const node = (id, text, sensitivity, kind) => data.put('knowledge_nodes', id, { id: id, workspaceId: 'ws_test', sourceCollection: kind === 'invoice' ? 'invoices' : 'quotes', sourceId: id, kind: kind, text: text.toLowerCase(), sensitivity: sensitivity });
  await node('kn_carpet', 'carpet cleaning steam service living room', 'general', 'quote');
  await node('kn_uphol', 'upholstery sofa fabric cleaning', 'general', 'quote');
  await node('kn_invoice', 'invoice payment overdue balance accounting', 'financial', 'invoice');
  await node('kn_legal', 'incident liability claim water damage', 'legal', 'legal');

  // ===== deterministic embedder =====
  const v1 = await VM.embed('carpet cleaning');
  const v2 = await VM.embed('carpet cleaning');
  t.ok('embedding is deterministic + fixed-dim', v1.length === VM.DIM && JSON.stringify(v1) === JSON.stringify(v2));
  t.ok('identical text → cosine ~1', Math.abs(VM.cosine(v1, v2) - 1) < 1e-9);
  t.ok('unrelated text → much lower cosine', VM.cosine(await VM.embed('carpet cleaning'), await VM.embed('invoice payment')) < 0.6);

  // ===== index builds vectors (idempotent) =====
  const idx = await VM.index();
  t.ok('index builds a vector per node', idx.ok === true && idx.indexed === 4 && idx.total === 4);
  t.eq('index is idempotent (unchanged text → 0 re-embeds)', (await VM.index()).indexed, 0);

  // ===== semantic search ranks by MEANING, not exact tokens =====
  const hits = await VM.search('carpet washing steam', { role: 'owner' });
  t.ok('the carpet node ranks first for a semantically-related query', hits[0].nodeId === 'kn_carpet' && hits[0].score > 0);
  t.ok('an unrelated finance node ranks below the carpet node', (hits.find((h) => h.nodeId === 'kn_invoice') || { score: 0 }).score < hits[0].score);
  // a query with NO exact token overlap still matches via subword n-grams
  const sub = await VM.search('upholstered couch cleaned', { role: 'owner' });
  t.ok('subword/semantic match works without identical tokens', sub.length > 0 && sub[0].score > 0);

  // ===== permission-aware (mirrors Knowledge OS sensitivity tiers) =====
  const ownerHits = await VM.search('payment balance', { role: 'owner' });
  t.ok('owner can match financial memory', ownerHits.some((h) => h.nodeId === 'kn_invoice'));
  const crewHits = await VM.search('payment balance', { role: 'crew' });
  t.ok('crew cannot see financial memory', !crewHits.some((h) => h.nodeId === 'kn_invoice'));
  const mgrHits = await VM.search('water damage claim', { role: 'manager' });
  t.ok('manager can see legal memory; crew cannot', mgrHits.some((h) => h.nodeId === 'kn_legal') && !(await VM.search('water damage claim', { role: 'crew' })).some((h) => h.nodeId === 'kn_legal'));

  // ===== recall summary =====
  const rec = await VM.recall('carpet steam cleaning', { role: 'owner' });
  t.ok('recall returns a summary + top match', rec.ok === true && rec.top.nodeId === 'kn_carpet' && /similarity/.test(rec.summary));

  // ===== pluggable embedder seam (e.g. a governed embedding model) =====
  t.ok('defaults to the local deterministic embedder', VM.usingDefaultEmbedder() === true);
  VM.setEmbedder((text) => { const v = new Array(VM.DIM).fill(0); v[0] = /carpet/.test(text) ? 1 : -1; return v; });
  t.ok('setEmbedder swaps the embedder', VM.usingDefaultEmbedder() === false && (await VM.embed('carpet'))[0] === 1);
  VM.setEmbedder(); // reset
  t.ok('passing no fn resets to the default embedder', VM.usingDefaultEmbedder() === true);

  // ===== no business mutation (writes only its own vectors) =====
  const before = JSON.stringify(data._store.quotes || {});
  await VM.index();
  t.eq('vector memory mutates no business record', JSON.stringify(data._store.quotes || {}), before);

  return t.report();
};
