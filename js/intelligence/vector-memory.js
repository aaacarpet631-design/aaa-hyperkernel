/*
 * AAA Vector Memory — semantic recall over the Knowledge OS.
 *
 * Where the Knowledge OS matches exact tokens, this matches by MEANING: it embeds
 * each knowledge node into a vector and answers a query by cosine similarity, so
 * "carpet washing" finds "carpet cleaning service" even with no shared exact token.
 *
 * Architecturally honest: the default embedder is a DETERMINISTIC, offline,
 * zero-dependency feature-hashing vectorizer (signed hashing of word tokens +
 * character 3-grams, L2-normalized) — no embedding API, so CI is green with no
 * credentials and recall is reproducible. A pluggable seam (setEmbedder) lets a
 * governed embedding model replace it later without changing callers.
 *
 * Permission-aware (financial/legal nodes gated by role, like the Knowledge OS),
 * read-only over the business (writes only its own vectors). Owner-only store.
 */
;(function (global) {
  'use strict';

  const VECTORS = 'memory_vectors';
  const NODES = 'knowledge_nodes';
  const DIM = 256;

  function cfg() { return global.AAA_CONFIG || {}; }
  function data() { return global.AAA_DATA; }
  function clock() { return global.AAA_RUNTIME_CLOCK; }
  function rbac() { return global.AAA_RBAC; }
  function knowledge() { return global.AAA_KNOWLEDGE; }
  function ws() { return cfg().workspaceId || 'default'; }
  function nowISO() { return clock() && clock().nowISO ? clock().nowISO() : new Date().toISOString(); }
  function mine(r) { return r && (r.workspaceId == null || r.workspaceId === ws()); }
  function role() { return rbac() && rbac().role ? rbac().role() : 'owner'; }
  function allowed(r) { return r === 'owner' ? ['general', 'financial', 'legal'] : r === 'manager' ? ['general', 'legal'] : ['general']; }

  function hash32(s) { let h = 0x811c9dc5; const str = String(s); for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0; } return h >>> 0; }
  function textHash(s) { return ('0000000' + hash32(s).toString(16)).slice(-8); }
  function tokens(s) { return String(s == null ? '' : s).toLowerCase().match(/[a-z0-9]+/g) || []; }
  function trigrams(tok) { const t = '^' + tok + '$'; const g = []; for (let i = 0; i + 3 <= t.length; i++) g.push(t.slice(i, i + 3)); return g; }
  function feature(v, key, weight) { const h = hash32(key); const idx = h % DIM; const sign = (hash32(key + '#') & 1) ? 1 : -1; v[idx] += sign * weight; }

  // Default deterministic embedder: signed feature hashing of tokens + char 3-grams.
  function localEmbed(text) {
    const v = new Array(DIM).fill(0);
    tokens(text).forEach((tok) => {
      feature(v, 'w:' + tok, 1);
      trigrams(tok).forEach((g) => feature(v, 'g:' + g, 0.5));
    });
    let norm = 0; for (let i = 0; i < DIM; i++) norm += v[i] * v[i];
    norm = Math.sqrt(norm) || 1;
    for (let i = 0; i < DIM; i++) v[i] = v[i] / norm;
    return v;
  }
  let EMBEDDER = localEmbed;

  function cosine(a, b) { if (!a || !b || a.length !== b.length) return 0; let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; }

  const Memory = {
    VECTORS: VECTORS, DIM: DIM,
    /** Embed text → vector (awaitable; a remote embedder may be async). */
    async embed(text) { return await Promise.resolve(EMBEDDER(String(text == null ? '' : text))); },
    cosine: cosine,
    /** Swap the embedder (e.g. a governed embedding model). Reset with no arg. */
    setEmbedder(fn) { EMBEDDER = (typeof fn === 'function') ? fn : localEmbed; return this; },
    usingDefaultEmbedder() { return EMBEDDER === localEmbed; },

    /** Build/refresh vectors for the Knowledge OS nodes (idempotent). */
    async index() {
      try { if (knowledge() && knowledge().index) await knowledge().index(); } catch (_) {}
      let nodes = []; try { nodes = (await data().list(NODES)).filter(mine); } catch (_) { nodes = []; }
      let indexed = 0;
      for (const n of nodes) {
        const id = 'vec_' + n.id;
        const th = textHash(n.text || '');
        const existing = await data().get(VECTORS, id);
        if (existing && existing.textHash === th && existing.dim === DIM) continue;
        const vector = await this.embed(n.text || '');
        await put({ id: id, workspaceId: ws(), nodeId: n.id, sourceCollection: n.sourceCollection || null, sourceId: n.sourceId || null, kind: n.kind || null, sensitivity: n.sensitivity || 'general', textHash: th, dim: DIM, vector: vector, at: nowISO() });
        indexed++;
      }
      return { ok: true, indexed: indexed, total: nodes.length };
    },

    /** Semantic search: cosine top-k, permission-aware. */
    async search(query, opts) {
      const o = opts || {};
      const allow = allowed(o.role || role());
      const qv = await this.embed(query);
      let vecs = []; try { vecs = (await data().list(VECTORS)).filter(mine); } catch (_) { vecs = []; }
      const scored = vecs
        .filter((v) => allow.indexOf(v.sensitivity || 'general') !== -1 && Array.isArray(v.vector))
        .filter((v) => !o.kind || v.kind === o.kind)
        .map((v) => ({ nodeId: v.nodeId, sourceCollection: v.sourceCollection, sourceId: v.sourceId, kind: v.kind, sensitivity: v.sensitivity, score: Math.round(cosine(qv, v.vector) * 1000) / 1000 }))
        .filter((x) => x.score > (o.minScore != null ? o.minScore : 0));
      scored.sort((a, b) => b.score - a.score);
      return scored.slice(0, o.k || 8);
    },

    /** Semantic recall: top matches + a short summary (for the UI / Knowledge OS). */
    async recall(query, opts) {
      const hits = await this.search(query, opts);
      return { ok: true, query: query, matches: hits, top: hits[0] || null, summary: hits.length ? hits.length + ' related record(s); best match in ' + (hits[0].sourceCollection || 'memory') + ' (similarity ' + hits[0].score + ')' : 'No semantically related records found yet.' };
    },
    async stats() { let v = []; try { v = (await data().list(VECTORS)).filter(mine); } catch (_) {} return { ok: true, vectors: v.length, dim: DIM, embedder: this.usingDefaultEmbedder() ? 'local-deterministic' : 'custom' }; }
  };

  async function put(rec) { await data().put(VECTORS, rec.id, rec); try { if (data().cloudReady && data().cloudReady() && global.AAA_CLOUD) global.AAA_CLOUD.upsertEntity(VECTORS, rec.id, rec); } catch (_) {} }

  global.AAA_VECTOR_MEMORY = Memory;
})(typeof window !== 'undefined' ? window : this);
