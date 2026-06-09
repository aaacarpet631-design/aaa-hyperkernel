/*
 * private-gpu — Netlify-hosted proxy to a PRIVATE GPU model server.
 *
 * Option B: the frontend NEVER calls the GPU server. The browser POSTs the app
 * shape ({ system?, messages, model?, max_tokens? }) to this same-origin function
 * (/api/private-gpu); this function — and only this function — knows
 * PRIVATE_GPU_MODEL_URL and PRIVATE_GPU_MODEL_KEY (Netlify env vars, server-side),
 * forwards an OpenAI-style /v1/chat/completions request to the GPU server, and
 * returns the app's { ok, text, content, usage } shape. The GPU URL + key are
 * never exposed to the client. If the GPU is unset or down, it fails safely with
 * { ok:false, error } — the app shows "AI model unavailable", never fake output.
 *
 * Network posture (enforced at the infra layer, not here): GPU port 8000 is NOT
 * public; only this backend's egress IP may reach the GPU server.
 */
import gpu from '../../functions/private-gpu-translate.js';

const TIMEOUT_MS = Number(process.env.PRIVATE_GPU_TIMEOUT_MS || 30000);

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json',
      'access-control-allow-origin': '*',
      'access-control-allow-headers': 'authorization, content-type',
      'access-control-allow-methods': 'POST, OPTIONS'
    }
  });
}

export default async (req) => {
  if (req.method === 'OPTIONS') return json({ ok: true });
  if (req.method !== 'POST') return json({ ok: false, error: 'METHOD_NOT_ALLOWED' }, 405);

  const base = process.env.PRIVATE_GPU_MODEL_URL;
  const key = process.env.PRIVATE_GPU_MODEL_KEY;
  if (!base) return json({ ok: false, error: 'GPU_NOT_CONFIGURED' }, 503);

  const url = gpu.endpointFor(base);
  if (!url) return json({ ok: false, error: 'GPU_BAD_URL' }, 503);

  let appBody;
  try { appBody = await req.json(); } catch { return json({ ok: false, error: 'BAD_REQUEST' }, 400); }

  const upstream = gpu.toRequest(appBody, { defaultModel: process.env.PRIVATE_GPU_MODEL || undefined });

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const headers = { 'content-type': 'application/json' };
    if (key) headers['authorization'] = 'Bearer ' + key;   // key stays server-side
    const r = await fetch(url, { method: 'POST', headers, body: JSON.stringify(upstream), signal: ctrl.signal });
    if (!r.ok) return json({ ok: false, error: 'GPU_HTTP_' + r.status }, 502);
    const data = await r.json();
    return json(gpu.fromResponse(data));
  } catch (e) {
    const aborted = e && (e.name === 'AbortError');
    return json({ ok: false, error: aborted ? 'GPU_TIMEOUT' : 'GPU_UNAVAILABLE' }, 504);
  } finally {
    clearTimeout(timer);
  }
};
