/*
 * sense — Netlify webhook endpoint for real-world signals (Option: event-driven
 * sensing). Providers (Twilio SMS/voice, a web-lead form) POST here; this function
 * optionally verifies a shared secret (SENSE_WEBHOOK_SECRET), normalizes the
 * payload via the pure sense-normalize module, and records it for the app to
 * ingest. It performs NO business action — the app's sensing layer turns the
 * signal into a PENDING owner-approval draft; nothing is sent without a human.
 *
 * The signing secret stays server-side; the GPU/LLM are never touched here.
 */
import sense from '../../functions/sense-normalize.js';

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*', 'access-control-allow-headers': 'authorization, content-type', 'access-control-allow-methods': 'POST, OPTIONS' }
  });
}

async function readBody(req) {
  const ct = (req.headers.get('content-type') || '').toLowerCase();
  if (ct.includes('application/json')) { try { return await req.json(); } catch { return null; } }
  // Twilio posts application/x-www-form-urlencoded
  try { const text = await req.text(); const params = new URLSearchParams(text); const o = {}; for (const [k, v] of params) o[k] = v; return o; } catch { return null; }
}

export default async (req) => {
  if (req.method === 'OPTIONS') return json({ ok: true });
  if (req.method !== 'POST') return json({ ok: false, error: 'METHOD_NOT_ALLOWED' }, 405);

  // Optional shared-secret check (set SENSE_WEBHOOK_SECRET to require it).
  const secret = process.env.SENSE_WEBHOOK_SECRET;
  if (secret) {
    const provided = req.headers.get('x-sense-secret') || new URL(req.url).searchParams.get('secret');
    if (provided !== secret) return json({ ok: false, error: 'UNAUTHORIZED' }, 401);
  }

  const body = await readBody(req);
  if (!body) return json({ ok: false, error: 'BAD_REQUEST' }, 400);

  const normalized = sense.normalize(body, { source: new URL(req.url).searchParams.get('source') || undefined });
  if (!normalized.ok) return json({ ok: false, error: normalized.error || 'UNRECOGNIZED' }, 202); // 202: accepted but ignored

  // Persist for the app to ingest (deployment wires this to the workspace store /
  // sync; kept storage-agnostic here). The app's AAA_SENSING.ingest() then records
  // it + files a PENDING owner-approval draft.
  return json({ ok: true, event: normalized.event });
};
