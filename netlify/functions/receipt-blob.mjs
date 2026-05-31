/*
 * Receipt blob storage (Netlify Blobs).
 *
 * Durable storage for the original receipt image/PDF so the source document is
 * retained for audit even after the local cache is cleared. The client uploads
 * a base64 copy (best-effort) right after capture; the GL expense keeps the
 * returned key so the paper trail is always one click away.
 *
 * POST { key, data(base64), mediaType }  -> { ok, key }
 * GET  ?key=...                          -> the raw bytes (image/pdf)
 *
 * Uses the @netlify/blobs store (already a project dependency). Auth/isolation
 * is layered by the caller + site access controls; keys are namespaced per
 * receipt media id.
 */
import { getStore } from '@netlify/blobs';

const STORE = 'aaa-receipts';

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

export default async (req) => {
  const store = getStore(STORE);

  if (req.method === 'POST') {
    let body;
    try { body = await req.json(); } catch { return json({ ok: false, error: 'INVALID_JSON' }, 400); }
    const key = body && body.key;
    const data = body && body.data;
    const mediaType = (body && body.mediaType) || 'image/jpeg';
    if (!key || typeof key !== 'string') return json({ ok: false, error: 'NO_KEY' }, 400);
    if (!data || typeof data !== 'string') return json({ ok: false, error: 'NO_DATA' }, 400);
    try {
      const bytes = Buffer.from(data, 'base64');
      await store.set(key, bytes, { metadata: { mediaType, storedAt: new Date().toISOString() } });
      return json({ ok: true, key });
    } catch (err) {
      console.error('Receipt blob store error', err);
      return json({ ok: false, error: 'STORE_FAILED', message: String((err && err.message) || err) }, 500);
    }
  }

  if (req.method === 'GET') {
    const url = new URL(req.url);
    const key = url.searchParams.get('key');
    if (!key) return json({ ok: false, error: 'NO_KEY' }, 400);
    try {
      const res = await store.getWithMetadata(key, { type: 'arrayBuffer' });
      if (!res) return json({ ok: false, error: 'NOT_FOUND' }, 404);
      const mediaType = (res.metadata && res.metadata.mediaType) || 'application/octet-stream';
      return new Response(res.data, { status: 200, headers: { 'content-type': mediaType } });
    } catch (err) {
      console.error('Receipt blob fetch error', err);
      return json({ ok: false, error: 'FETCH_FAILED', message: String((err && err.message) || err) }, 500);
    }
  }

  return json({ ok: false, error: 'METHOD_NOT_ALLOWED' }, 405);
};

export const config = { path: '/api/receipt-blob' };
