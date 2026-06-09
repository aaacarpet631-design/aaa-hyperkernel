/*
 * AAA Audit Ledger — append-only, hash-chained, tamper-evident record.
 *
 * The immutable substrate of the Governance Engine. Every governed event is
 * appended and never mutated. Two integrity layers:
 *   - a fast FNV-1a checksum chain (sync, self-evident tampering in-app), and
 *   - a SHA-256 cryptographic chain (verifiable independently / server-side).
 *
 * Conflict-safe multi-writer: each entry carries a writerId + per-writer
 * sequence, and chains off the previous entry FROM THE SAME WRITER. Two devices
 * appending concurrently extend their own lanes and never collide; a merge (via
 * cloud pull) simply unions the lanes, and verification validates each lane
 * independently. A single-writer install behaves exactly like a linear chain.
 */
;(function (global) {
  'use strict';

  function data() { return global.AAA_DATA; }
  function cfg() { return global.AAA_CONFIG || {}; }
  function ids() { return global.AAA_ID_FACTORY; }
  function clock() { return global.AAA_RUNTIME_CLOCK; }
  function nowISO() { return clock() && clock().nowISO ? clock().nowISO() : new Date().toISOString(); }

  const COLLECTION = 'governance_audit';
  const GENESIS = '0000000000000000';
  const GENESIS_SHA = '0000000000000000000000000000000000000000000000000000000000000000';

  // Deterministic canonical serialization (sorted keys) — identical on the
  // client and the server-side verifier so SHA-256 digests match exactly.
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
  function hashEntry(entry) {
    const s = canonical(entry);
    return fnv1a(s) + fnv1a('aaa-governance:' + s + '|' + s.length);
  }

  // Synchronous, dependency-free SHA-256 (standard) over a byte pipeline, so it
  // also backs HMAC. Sync keeps append off the async crypto path; the digests
  // are identical to Node's crypto, so the server-side verifier agrees exactly.
  const SHA_K = [0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2];
  function utf8Bytes(str) {
    const bytes = [];
    for (let i = 0; i < str.length; i++) {
      let c = str.charCodeAt(i);
      if (c < 0x80) bytes.push(c);
      else if (c < 0x800) bytes.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
      else if (c >= 0xd800 && c <= 0xdbff) { const c2 = str.charCodeAt(++i); const cp = 0x10000 + ((c & 0x3ff) << 10) + (c2 & 0x3ff); bytes.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3f), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f)); }
      else bytes.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
    }
    return bytes;
  }
  function sha256Words(msg) {
    const rotr = function (n, x) { return (x >>> n) | (x << (32 - n)); };
    const bytes = msg.slice();
    const bitLen = bytes.length * 8;
    bytes.push(0x80);
    while (bytes.length % 64 !== 56) bytes.push(0);
    bytes.push(0, 0, 0, 0, (bitLen >>> 24) & 0xff, (bitLen >>> 16) & 0xff, (bitLen >>> 8) & 0xff, bitLen & 0xff);
    const H = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
    const w = new Array(64);
    for (let i = 0; i < bytes.length; i += 64) {
      for (let j = 0; j < 16; j++) w[j] = (bytes[i + j * 4] << 24) | (bytes[i + j * 4 + 1] << 16) | (bytes[i + j * 4 + 2] << 8) | (bytes[i + j * 4 + 3]);
      for (let j = 16; j < 64; j++) { const s0 = rotr(7, w[j - 15]) ^ rotr(18, w[j - 15]) ^ (w[j - 15] >>> 3); const s1 = rotr(17, w[j - 2]) ^ rotr(19, w[j - 2]) ^ (w[j - 2] >>> 10); w[j] = (w[j - 16] + s0 + w[j - 7] + s1) | 0; }
      let a = H[0], b = H[1], c = H[2], d = H[3], e = H[4], f = H[5], g = H[6], h = H[7];
      for (let j = 0; j < 64; j++) {
        const S1 = rotr(6, e) ^ rotr(11, e) ^ rotr(25, e);
        const ch = (e & f) ^ ((~e) & g);
        const t1 = (h + S1 + ch + SHA_K[j] + w[j]) | 0;
        const S0 = rotr(2, a) ^ rotr(13, a) ^ rotr(22, a);
        const maj = (a & b) ^ (a & c) ^ (b & c);
        const t2 = (S0 + maj) | 0;
        h = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
      }
      H[0] = (H[0] + a) | 0; H[1] = (H[1] + b) | 0; H[2] = (H[2] + c) | 0; H[3] = (H[3] + d) | 0;
      H[4] = (H[4] + e) | 0; H[5] = (H[5] + f) | 0; H[6] = (H[6] + g) | 0; H[7] = (H[7] + h) | 0;
    }
    return H;
  }
  function wordsToHex(H) { return H.map(function (x) { return ('00000000' + (x >>> 0).toString(16)).slice(-8); }).join(''); }
  function wordsToBytes(H) { const b = []; H.forEach(function (x) { b.push((x >>> 24) & 0xff, (x >>> 16) & 0xff, (x >>> 8) & 0xff, x & 0xff); }); return b; }
  function sha256(str) { return wordsToHex(sha256Words(utf8Bytes(str))); }

  // HMAC-SHA256 (standard) — signs an entry with the workspace signing key so a
  // party holding the cloud copy but NOT the key cannot forge an entry.
  function hmacSha256(keyStr, msgStr) {
    let key = utf8Bytes(keyStr);
    if (key.length > 64) key = wordsToBytes(sha256Words(key));
    while (key.length < 64) key.push(0);
    const ipad = [], opad = [];
    for (let i = 0; i < 64; i++) { ipad.push(key[i] ^ 0x36); opad.push(key[i] ^ 0x5c); }
    const inner = wordsToBytes(sha256Words(ipad.concat(utf8Bytes(msgStr))));
    return wordsToHex(sha256Words(opad.concat(inner)));
  }

  // Optional workspace signing key (opt-in; never mirrored to the cloud).
  function signingKey() { return cfg().flag ? cfg().flag('governanceSigningKey', null) : (cfg().governanceSigningKey || null); }

  // Stable per-device writer id (so concurrent devices use separate lanes).
  let _writerId = null;
  function writerId() {
    if (_writerId) return _writerId;
    const c = cfg();
    let id = (c.flag ? c.flag('governanceWriterId', null) : null) || c.firebaseUid || c.governanceWriterId || null;
    if (!id) {
      id = 'w_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
      try { if (c.set) c.set({ governanceWriterId: id }); } catch (_) {}
    }
    _writerId = id;
    return id;
  }

  function baseOf(rec) {
    return { id: rec.id, seq: rec.seq, writerId: rec.writerId, writerSeq: rec.writerSeq, type: rec.type, at: rec.at, payload: rec.payload, prevHash: rec.prevHash };
  }
  function lanes(chain) {
    const by = {};
    chain.forEach(function (r) { const w = r.writerId || 'default'; (by[w] = by[w] || []).push(r); });
    Object.keys(by).forEach(function (w) { by[w].sort(function (a, b) { return (a.writerSeq || 0) - (b.writerSeq || 0); }); });
    return by;
  }

  async function ordered() {
    const list = (data() && data().list) ? await data().list(COLLECTION) : [];
    return (Array.isArray(list) ? list.slice() : []).sort(function (a, b) { return (a.seq || 0) - (b.seq || 0); });
  }

  const Ledger = {
    COLLECTION: COLLECTION,
    GENESIS: GENESIS,
    GENESIS_SHA: GENESIS_SHA,
    hashEntry: hashEntry,
    canonical: canonical,
    sha256: sha256,

    /** Append an immutable event. Returns the frozen, hash- + sha-linked record. */
    async append(type, payload) {
      const wid = writerId();
      const chain = await ordered();
      const mine = chain.filter(function (e) { return (e.writerId || 'default') === wid; });
      const prev = mine.length ? mine.reduce(function (a, b) { return (b.writerSeq || 0) > (a.writerSeq || 0) ? b : a; }) : null;
      const writerSeq = prev ? (prev.writerSeq || 0) + 1 : 0;
      const prevHash = prev ? prev.hash : GENESIS;
      const prevSha = prev ? (prev.sha || GENESIS_SHA) : GENESIS_SHA;
      const globalSeq = chain.length ? (chain.reduce(function (m, e) { return Math.max(m, e.seq || 0); }, 0) + 1) : 0;
      const base = {
        id: (ids() && ids().createId) ? ids().createId('aud') : ('aud_' + globalSeq + '_' + Date.now()),
        seq: globalSeq, writerId: wid, writerSeq: writerSeq,
        type: String(type || 'event'), at: nowISO(), payload: payload || {}, prevHash: prevHash
      };
      const hash = hashEntry(base);
      const sha = sha256(canonical(base) + '|' + prevSha);
      const key = signingKey();
      const sig = key ? hmacSha256(key, canonical(base) + '|' + prevHash + '|' + prevSha) : null;
      const rec = deepFreeze(Object.assign({}, base, { hash: hash, prevSha: prevSha, sha: sha, sig: sig }));
      if (data() && data().put) await data().put(COLLECTION, rec.id, rec);
      return rec;
    },

    async chain() { return ordered(); },

    /** Verify the fast FNV chain per writer. { ok, length, brokenAt?, reason?, writerId? }. */
    async verify() {
      const chain = await ordered();
      const by = lanes(chain);
      for (const wid in by) {
        let prev = GENESIS;
        const lane = by[wid];
        for (let i = 0; i < lane.length; i++) {
          const rec = lane[i];
          if (rec.prevHash !== prev) return { ok: false, length: chain.length, writerId: wid, brokenAt: rec.writerSeq != null ? rec.writerSeq : i, reason: 'PREV_HASH_MISMATCH' };
          if (rec.hash !== hashEntry(baseOf(rec))) return { ok: false, length: chain.length, writerId: wid, brokenAt: rec.writerSeq != null ? rec.writerSeq : i, reason: 'CONTENT_TAMPERED' };
          prev = rec.hash;
        }
      }
      return { ok: true, length: chain.length, writers: Object.keys(by).length };
    },

    /** Verify the SHA-256 cryptographic chain per writer. */
    async verifySha() {
      const chain = await ordered();
      const by = lanes(chain);
      for (const wid in by) {
        let prev = GENESIS_SHA;
        for (const rec of by[wid]) {
          if (rec.sha == null) return { ok: false, writerId: wid, brokenAt: rec.writerSeq, reason: 'NO_SHA' };
          const expect = sha256(canonical(baseOf(rec)) + '|' + (rec.prevSha != null ? rec.prevSha : GENESIS_SHA));
          if (rec.prevSha !== prev) return { ok: false, writerId: wid, brokenAt: rec.writerSeq, reason: 'PREV_SHA_MISMATCH' };
          if (rec.sha !== expect) return { ok: false, writerId: wid, brokenAt: rec.writerSeq, reason: 'SHA_TAMPERED' };
          prev = rec.sha;
        }
      }
      return { ok: true, length: chain.length, writers: Object.keys(by).length };
    },

    /**
     * Verify HMAC signatures when a workspace signing key is configured. This
     * makes entries non-forgeable by anyone WITHOUT the key (e.g. direct cloud/
     * DB tampering): a rewritten entry can't be re-signed. Skipped (ok) when no
     * key is set. A key-holder is trusted within the workspace by design.
     */
    async verifySig() {
      const key = signingKey();
      if (!key) return { ok: true, skipped: true, reason: 'NO_KEY' };
      const chain = await ordered();
      for (const rec of chain) {
        if (rec.sig == null) return { ok: false, writerId: rec.writerId, brokenAt: rec.writerSeq, reason: 'UNSIGNED' };
        const expect = hmacSha256(key, canonical(baseOf(rec)) + '|' + rec.prevHash + '|' + (rec.prevSha != null ? rec.prevSha : GENESIS_SHA));
        if (rec.sig !== expect) return { ok: false, writerId: rec.writerId, brokenAt: rec.writerSeq, reason: 'BAD_SIGNATURE' };
      }
      return { ok: true, length: chain.length };
    },

    /** Independent server-side SHA-256 re-verification (Netlify function). */
    async verifyOnServer(endpoint) {
      const url = endpoint || (cfg().flag ? cfg().flag('governanceVerifyEndpoint', '/api/governance-verify') : '/api/governance-verify');
      try {
        const chain = await ordered();
        const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ entries: chain }) });
        return await res.json();
      } catch (e) { return { ok: false, error: 'NETWORK', message: String((e && e.message) || e) }; }
    }
  };

  global.AAA_AUDIT_LEDGER = Ledger;
})(typeof window !== 'undefined' ? window : this);
