/*
 * claude — Netlify-hosted Claude proxy for the agent system.
 *
 * The easy path to bring the AI agents online without Blaze or the Firebase
 * CLI: this runs on the same Netlify deploy as the app and holds the Anthropic
 * key server-side (Netlify env var ANTHROPIC_API_KEY — the same key the vision
 * function uses). Point the app at it by setting the "Cloud Function URL" in
 * Command Center → Cloud Settings to /api/claude.
 *
 * Accepts { system?, messages, model?, max_tokens?, output_config? } and
 * returns { ok, text, content, usage } — the shape AAA_*.callProxy expects.
 */
const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const DEFAULT_MODEL = 'claude-opus-4-8';

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

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return json({ ok: false, error: 'MISSING_API_KEY', message: 'Set ANTHROPIC_API_KEY in the Netlify site environment.' }, 500);

  let body;
  try { body = await req.json(); } catch { return json({ ok: false, error: 'INVALID_JSON' }, 400); }
  if (!body || !Array.isArray(body.messages) || body.messages.length === 0) {
    return json({ ok: false, error: 'NO_MESSAGES' }, 400);
  }

  const payload = { model: body.model || DEFAULT_MODEL, max_tokens: body.max_tokens || 1024, messages: body.messages };
  if (body.system) payload.system = body.system;
  if (body.output_config) payload.output_config = body.output_config;

  try {
    const res = await fetch(ANTHROPIC_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify(payload)
    });
    const data = await res.json();
    if (!res.ok) return json({ ok: false, error: 'ANTHROPIC_ERROR', detail: data }, res.status);
    const text = Array.isArray(data.content)
      ? data.content.filter((b) => b.type === 'text').map((b) => b.text).join('')
      : '';
    return json({ ok: true, text, content: data.content, usage: data.usage, stop_reason: data.stop_reason });
  } catch (err) {
    return json({ ok: false, error: 'PROXY_FAILED', message: String((err && err.message) || err) }, 502);
  }
};

export const config = { path: '/api/claude' };
