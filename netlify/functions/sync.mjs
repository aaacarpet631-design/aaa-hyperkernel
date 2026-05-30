/*
 * Sync function (Netlify Blobs).
 *
 * The mutation queue and entity snapshots that the local-first client
 * accumulates are pushed here and persisted in a Netlify Blobs store, so a
 * device's work is backed up off-device and can be pulled onto another device.
 *
 *   GET  /api/sync            -> { ok, state }            (pull server state)
 *   POST /api/sync  {jobs?, customers?, mutations?} -> { ok, accepted, state }
 *
 * Merge policy (single source of truth is the client): incoming jobs/customers
 * overwrite stored entries by id; mutations are appended and de-duplicated by
 * mutationId, keeping the most recent 2000.
 */
import { getStore } from '@netlify/blobs';

const STORE_NAME = 'hyperkernel-sync';
const STATE_KEY = 'state';
const MAX_MUTATIONS = 2000;

function emptyState() {
  return { jobs: {}, customers: {}, mutations: [], updatedAt: null };
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  });
}

function mergeMaps(target, incoming) {
  if (!incoming || typeof incoming !== 'object') return target;
  for (const [id, record] of Object.entries(incoming)) {
    target[id] = record;
  }
  return target;
}

function mergeMutations(existing, incoming) {
  if (!Array.isArray(incoming) || incoming.length === 0) return existing;
  const seen = new Set(existing.map((m) => m && m.mutationId).filter(Boolean));
  for (const m of incoming) {
    if (m && m.mutationId && !seen.has(m.mutationId)) {
      existing.push(m);
      seen.add(m.mutationId);
    }
  }
  return existing.slice(-MAX_MUTATIONS);
}

export default async (req) => {
  let store;
  try {
    store = getStore(STORE_NAME);
  } catch (err) {
    return json({ ok: false, error: 'BLOBS_UNAVAILABLE', message: String((err && err.message) || err) }, 500);
  }

  if (req.method === 'GET') {
    const state = (await store.get(STATE_KEY, { type: 'json' })) || emptyState();
    return json({ ok: true, state });
  }

  if (req.method === 'POST') {
    let body;
    try {
      body = await req.json();
    } catch {
      return json({ ok: false, error: 'INVALID_JSON' }, 400);
    }
    const incoming = body || {};
    const state = (await store.get(STATE_KEY, { type: 'json' })) || emptyState();

    state.jobs = mergeMaps(state.jobs || {}, incoming.jobs);
    state.customers = mergeMaps(state.customers || {}, incoming.customers);
    state.mutations = mergeMutations(Array.isArray(state.mutations) ? state.mutations : [], incoming.mutations);
    state.updatedAt = new Date().toISOString();

    await store.setJSON(STATE_KEY, state);
    return json({
      ok: true,
      accepted: Array.isArray(incoming.mutations) ? incoming.mutations.length : 0,
      state
    });
  }

  return json({ ok: false, error: 'METHOD_NOT_ALLOWED' }, 405);
};

export const config = { path: '/api/sync' };
