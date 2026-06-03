/*
 * nemotron — Netlify-hosted NVIDIA Nemotron proxy for the agent system.
 *
 * The easy path to run the agents on NVIDIA-hosted Nemotron instead of Claude:
 * same Netlify deploy as the app, key held server-side (Netlify env var
 * NVIDIA_API_KEY). Point the app at it by setting aiProvider:'nemotron' and the
 * Cloud Function URL to /api/nemotron in Command Center → Cloud Settings.
 *
 * Accepts { system?, messages, model?, max_tokens? } and returns
 * { ok, text, content, usage, stop_reason } — the shape AAA_*.callProxy expects.
 * All request/response translation lives in functions/nemotron-translate.js
 * (shared with the Firebase proxy and unit-tested).
 */
import nemo from '../../functions/nemotron-translate.js';

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

  const apiKey = process.env.NVIDIA_API_KEY;
  if (!apiKey) return json({ ok: false, error: 'MISSING_API_KEY', message: 'Set NVIDIA_API_KEY in the Netlify site environment.' }, 500);

  let body;
  try { body = await req.json(); } catch { return json({ ok: false, error: 'INVALID_JSON' }, 400); }
  if (!body || !Array.isArray(body.messages) || body.messages.length === 0) {
    return json({ ok: false, error: 'NO_MESSAGES' }, 400);
  }

  const payload = nemo.toRequest(body, { defaultModel: process.env.NEMOTRON_MODEL });

  try {
    const res = await fetch(nemo.NVIDIA_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + apiKey },
      body: JSON.stringify(payload)
    });
    const data = await res.json();
    if (!res.ok) return json({ ok: false, error: 'NVIDIA_ERROR', detail: data }, res.status);
    return json(nemo.fromResponse(data));
  } catch (err) {
    return json({ ok: false, error: 'PROXY_FAILED', message: String((err && err.message) || err) }, 502);
  }
};

export const config = { path: '/api/nemotron' };
