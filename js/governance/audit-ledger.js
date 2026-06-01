/*
 * AAA Audit Ledger — an append-only, hash-chained, tamper-evident record.
 *
 * The immutable substrate of the Governance Engine. Every governed event
 * (a high-risk AI decision being flagged, an override being requested/approved/
 * denied, a human pressing Send) is appended here and never mutated. Each entry
 * carries the hash of the previous entry, so any later edit to a stored record
 * breaks the chain and `verify()` reports exactly where.
 *
 * Domain-agnostic by design: it stores opaque event payloads, so any future
 * guardrail (legal, accounting, contract, compliance, ad copy, SMS/email …)
 * writes to the same ledger. Entries are frozen on creation; the store exposes
 * append + read + verify only — no update, no delete.
 *
 * The chain hash is a fast non-cryptographic checksum (FNV-1a over a canonical
 * serialization). It makes tampering self-evident within the app; a backend can
 * re-hash with SHA-256 for cryptographic guarantees without changing callers.
 */
;(function (global) {
  'use strict';

  function data() { return global.AAA_DATA; }
  function cloud() { return global.AAA_CLOUD; }
  function ids() { return global.AAA_ID_FACTORY; }
  function clock() { return global.AAA_RUNTIME_CLOCK; }
  function nowISO() { return clock() && clock().nowISO ? clock().nowISO() : new Date().toISOString(); }

  const COLLECTION = 'governance_audit';
  const GENESIS = '0000000000000000';

  // Deterministic canonical serialization (sorted keys) so the hash is stable
  // regardless of property insertion order.
  function canonical(o) {
    if (o === null || typeof o !== 'object') return JSON.stringify(o === undefined ? null : o);
    if (Array.isArray(o)) return '[' + o.map(canonical).join(',') + ']';
    return '{' + Object.keys(o).sort().map(function (k) { return JSON.stringify(k) + ':' + canonical(o[k]); }).join(',') + '}';
  }

  function deepFreeze(o) {
    if (o && typeof o === 'object' && !Object.isFrozen(o)) {
      Object.keys(o).forEach(function (k) { deepFreeze(o[k]); });
      Object.freeze(o);
    }
    return o;
  }

  function fnv1a(str) {
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
    }
    return ('00000000' + h.toString(16)).slice(-8);
  }

  // 16 hex chars: FNV-1a of the canonical string, plus FNV-1a of a salted copy,
  // for a wider, harder-to-collide checksum than a single 32-bit pass.
  function hashEntry(entry) {
    const s = canonical(entry);
    return fnv1a(s) + fnv1a('aaa-governance:' + s + '|' + s.length);
  }

  async function ordered() {
    const list = (data() && data().list) ? await data().list(COLLECTION) : [];
    return (Array.isArray(list) ? list.slice() : []).sort(function (a, b) { return (a.seq || 0) - (b.seq || 0); });
  }

  async function mirror(rec) {
    try {
      if (data().cloudReady && data().cloudReady() && cloud() && cloud().insertEvent) {
        await cloud().insertEvent(COLLECTION, rec);
      }
    } catch (_) { /* mirror is best-effort; the local ledger is source of truth */ }
  }

  const Ledger = {
    COLLECTION: COLLECTION,
    GENESIS: GENESIS,
    hashEntry: hashEntry,

    /**
     * Append an immutable event. `type` names the event; `payload` is any
     * serializable governance context. Returns the frozen, hash-linked record.
     */
    async append(type, payload) {
      const chain = await ordered();
      const last = chain.length ? chain[chain.length - 1] : null;
      const seq = last ? (last.seq || 0) + 1 : 0;
      const prevHash = last ? last.hash : GENESIS;
      const base = {
        id: (ids() && ids().createId) ? ids().createId('aud') : ('aud_' + seq + '_' + Date.now()),
        seq: seq,
        type: String(type || 'event'),
        at: nowISO(),
        payload: payload || {},
        prevHash: prevHash
      };
      const rec = deepFreeze(Object.assign({}, base, { hash: hashEntry(base) }));
      if (data() && data().put) await data().put(COLLECTION, rec.id, rec);
      await mirror(rec);
      return rec;
    },

    /** The full chain, ordered by seq. Read-only snapshot. */
    async chain() { return ordered(); },

    /**
     * Recompute the chain and report integrity. Detects any record whose stored
     * hash no longer matches its content, or whose prevHash breaks linkage.
     * Returns { ok, length, brokenAt? , reason? }.
     */
    async verify() {
      const chain = await ordered();
      let prev = GENESIS;
      for (let i = 0; i < chain.length; i++) {
        const rec = chain[i];
        const recompute = hashEntry({ id: rec.id, seq: rec.seq, type: rec.type, at: rec.at, payload: rec.payload, prevHash: rec.prevHash });
        if (rec.prevHash !== prev) return { ok: false, length: chain.length, brokenAt: i, reason: 'PREV_HASH_MISMATCH' };
        if (rec.hash !== recompute) return { ok: false, length: chain.length, brokenAt: i, reason: 'CONTENT_TAMPERED' };
        prev = rec.hash;
      }
      return { ok: true, length: chain.length };
    }
  };

  global.AAA_AUDIT_LEDGER = Ledger;
})(typeof window !== 'undefined' ? window : this);
