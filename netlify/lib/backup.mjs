/* Authenticated device snapshots, never a global cross-device merge. Conditional
 * writes prevent an older upload from replacing a newer confirmed generation.
 */
import { createHash } from 'node:crypto';
import { json, OpenAIError } from './openai.mjs';
import '../../js/core/backup-format.js';
const format = globalThis.AAA_BACKUP_FORMAT;

export const COLLECTIONS = ['jobs', 'customers', 'quotes', 'quote_builder_working', 'audit_log', 'outcomes'];
const hash = (s) => createHash('sha256').update(s).digest('hex');
const record = (v) => v && typeof v === 'object' && !Array.isArray(v);
const safeKey = (s) => typeof s === 'string' && s.length > 0 && s.length <= 200 && !['__proto__', 'constructor', 'prototype'].includes(s);
function device(s) { if (!/^[a-zA-Z0-9_-]{8,100}$/.test(s || '')) throw new OpenAIError('INVALID_DEVICE'); return s; }
function workspace(s) { if (!safeKey(s)) throw new OpenAIError('WORKSPACE_REQUIRED'); return s; }

export function validateSnapshot(body) {
  if (!record(body) || body.version !== 2 || !Number.isSafeInteger(body.generation) || body.generation < 1) throw new OpenAIError('INVALID_BACKUP');
  if (Object.keys(body).some(k => !['version', 'workspaceId', 'deviceId', 'generation', 'collections', 'mutations'].includes(k))) throw new OpenAIError('INVALID_BACKUP');
  workspace(body.workspaceId); device(body.deviceId);
  if (!record(body.collections) || Object.keys(body.collections).some(k => !COLLECTIONS.includes(k))) throw new OpenAIError('INVALID_COLLECTION');
  for (const name of COLLECTIONS) {
    const records = body.collections[name];
    if (!record(records) || Object.keys(records).length > 20000) throw new OpenAIError('INVALID_COLLECTION');
    for (const [key, row] of Object.entries(records)) {
      if (!safeKey(key) || !record(row) || row.workspaceId !== body.workspaceId) throw new OpenAIError('INVALID_RECORD');
    }
  }
  if (!Array.isArray(body.mutations) || body.mutations.length > 2000 || body.mutations.some(m => !record(m) || !safeKey(m.mutationId) || m.workspaceId !== body.workspaceId)) throw new OpenAIError('INVALID_MUTATIONS');
  if (new Set(body.mutations.map(m => m.mutationId)).size !== body.mutations.length) throw new OpenAIError('INVALID_MUTATIONS');
  try { format.validate(body, body.workspaceId); } catch (_) { throw new OpenAIError('INVALID_BACKUP'); }
  return body;
}

export async function handleBackup(req, { userId, store }) {
  const url = new URL(req.url);
  let body;
  if (req.method === 'POST') {
    try { body = await req.json(); } catch (_) { throw new OpenAIError('INVALID_JSON'); }
    validateSnapshot(body);
  }
  const ws = workspace(body ? body.workspaceId : url.searchParams.get('workspace'));
  // Hashing avoids path ambiguity; the verified account is always server-owned.
  const prefix = 'v2/' + hash(userId) + '/' + hash(ws) + '/';
  if (req.method === 'GET' && !url.searchParams.has('device')) {
    const [current, history] = await Promise.all([store.list({ prefix }), store.list({ prefix: 'history/' + prefix })]);
    const blobs = current.blobs.concat(history.blobs);
    const backups = await Promise.all(blobs.slice(0, 100).map(async (b) => {
      const meta = await store.getMetadata(b.key);
      return { ...meta?.metadata };
    }));
    return json({ ok: true, backups: backups.sort((a, b) => String(b.savedAt).localeCompare(String(a.savedAt))), truncated: blobs.length > 100 });
  }
  const id = device(body ? body.deviceId : url.searchParams.get('device'));
  const key = prefix + id;
  if (req.method === 'GET') {
    const generation = url.searchParams.get('generation');
    if (generation != null && (!/^[1-9]\d*$/.test(generation) || !Number.isSafeInteger(Number(generation)))) throw new OpenAIError('INVALID_GENERATION');
    let state = await store.get(key, { type: 'json' });
    if (generation && state?.generation !== Number(generation)) state = await store.get('history/' + key + '/' + generation, { type: 'json' });
    return state ? json({ ok: true, state }) : json({ ok: false, error: 'BACKUP_NOT_FOUND' }, 404);
  }
  // The digest makes retrying an acknowledged upload idempotent, but disallows
  // different content claiming the same generation.
  const digest = hash(format.canonical(body));
  for (let attempt = 0; attempt < 3; attempt++) {
    const previous = await store.getWithMetadata(key, { type: 'json' });
    if (previous && previous.data.generation >= body.generation) {
      if (previous.metadata.digest === digest) return json({ ok: true, generation: body.generation, acceptedIds: body.mutations.map(m => m.mutationId), savedAt: previous.metadata.savedAt });
      return json({ ok: false, error: 'BACKUP_CONFLICT' }, 409);
    }
    const savedAt = new Date().toISOString();
    const counts = Object.fromEntries(COLLECTIONS.map(c => [c, Object.keys(body.collections[c]).length]));
    // Archive the confirmed predecessor before replacing the latest pointer.
    // Failed archival leaves the last confirmed backup untouched. Concurrent
    // attempts may archive the same predecessor; onlyIfNew keeps it immutable.
    if (previous) await store.setJSON('history/' + key + '/' + previous.data.generation, previous.data, { onlyIfNew: true, metadata: previous.metadata });
    const result = await store.setJSON(key, await format.seal({ ...body, savedAt }), {
      ...(previous ? { onlyIfMatch: previous.etag } : { onlyIfNew: true }), metadata: { deviceId: id, generation: body.generation, digest, savedAt, counts }
    });
    if (result.modified) return json({ ok: true, generation: body.generation, acceptedIds: body.mutations.map(m => m.mutationId), savedAt });
  }
  return json({ ok: false, error: 'BACKUP_CONFLICT' }, 409);
}
