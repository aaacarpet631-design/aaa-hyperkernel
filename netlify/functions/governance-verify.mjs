/*
 * governance-verify — Netlify Function: independent, server-side SHA-256
 * re-verification of the governance audit ledger.
 *
 * The client posts the ledger entries; this recomputes the SHA-256 chain in a
 * trusted environment (Node crypto) using the exact same canonical serialization
 * as the client, and reports any entry whose content no longer matches its
 * stored sha, or whose per-writer chain linkage is broken. This is the
 * cryptographic counterpart to the in-app FNV checksum — stronger, and not
 * computed by the (potentially compromised) client.
 *
 * Pure helpers (canonical, verifyShaChain, json) are named exports for offline
 * tests; Netlify ignores the non-default exports.
 */
import { createHash } from 'node:crypto';

const GENESIS_SHA = '0000000000000000000000000000000000000000000000000000000000000000';

// MUST match js/governance/audit-ledger.js canonical() byte-for-byte.
export function canonical(o) {
  if (o === null || typeof o !== 'object') return JSON.stringify(o === undefined ? null : o);
  if (Array.isArray(o)) return '[' + o.map(canonical).join(',') + ']';
  return '{' + Object.keys(o).sort().map((k) => JSON.stringify(k) + ':' + canonical(o[k])).join(',') + '}';
}

function sha256hex(s) { return createHash('sha256').update(String(s), 'utf8').digest('hex'); }

function baseOf(rec) {
  return { id: rec.id, seq: rec.seq, writerId: rec.writerId, writerSeq: rec.writerSeq, type: rec.type, at: rec.at, payload: rec.payload, prevHash: rec.prevHash };
}

/** Re-verify the per-writer SHA-256 chain. Returns { ok, writers, length } or a break. */
export function verifyShaChain(entries) {
  const list = Array.isArray(entries) ? entries.slice() : [];
  const by = {};
  list.forEach((r) => { const w = (r && r.writerId) || 'default'; (by[w] = by[w] || []).push(r); });
  Object.keys(by).forEach((w) => by[w].sort((a, b) => (a.writerSeq || 0) - (b.writerSeq || 0)));

  for (const wid of Object.keys(by)) {
    let prev = GENESIS_SHA;
    for (const rec of by[wid]) {
      if (rec.sha == null) return { ok: false, writerId: wid, brokenAt: rec.writerSeq, reason: 'NO_SHA' };
      const expect = sha256hex(canonical(baseOf(rec)) + '|' + (rec.prevSha != null ? rec.prevSha : GENESIS_SHA));
      if (rec.prevSha !== prev) return { ok: false, writerId: wid, brokenAt: rec.writerSeq, reason: 'PREV_SHA_MISMATCH' };
      if (rec.sha !== expect) return { ok: false, writerId: wid, brokenAt: rec.writerSeq, reason: 'SHA_TAMPERED' };
      prev = rec.sha;
    }
  }
  return { ok: true, length: list.length, writers: Object.keys(by).length };
}

export function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*', 'access-control-allow-headers': 'authorization, content-type', 'access-control-allow-methods': 'POST, OPTIONS' }
  });
}

export default async (req) => {
  if (req.method === 'OPTIONS') return json({ ok: true });
  if (req.method !== 'POST') return json({ ok: false, error: 'METHOD_NOT_ALLOWED' }, 405);
  let body;
  try { body = await req.json(); } catch { return json({ ok: false, error: 'INVALID_JSON' }, 400); }
  if (!body || !Array.isArray(body.entries)) return json({ ok: false, error: 'NO_ENTRIES' }, 400);
  try { return json(verifyShaChain(body.entries)); }
  catch (e) { return json({ ok: false, error: 'VERIFY_FAILED', message: String((e && e.message) || e) }, 500); }
};

export const config = { path: '/api/governance-verify' };
