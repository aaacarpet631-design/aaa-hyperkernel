/*
 * claudeProxy — Firebase Cloud Function (Gen 2).
 *
 * The single server-side funnel for every Claude call in the app. The
 * Anthropic API key is stored as a Firebase secret and never reaches the
 * browser. CORS is enabled so the PWA (on Netlify or Firebase Hosting) can
 * call it directly.
 *
 * Deploy:  firebase deploy --only functions
 * Secret:  firebase functions:secrets:set ANTHROPIC_API_KEY
 */
const { onRequest } = require('firebase-functions/v2/https');
const { defineSecret } = require('firebase-functions/params');

const ANTHROPIC_API_KEY = defineSecret('ANTHROPIC_API_KEY');
const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const DEFAULT_MODEL = 'claude-opus-4-8';

exports.claudeProxy = onRequest(
  { secrets: [ANTHROPIC_API_KEY], cors: true, region: 'us-central1' },
  async (req, res) => {
    if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'METHOD_NOT_ALLOWED' });

    const key = ANTHROPIC_API_KEY.value() || process.env.ANTHROPIC_API_KEY;
    if (!key) return res.status(500).json({ ok: false, error: 'MISSING_API_KEY' });

    const body = req.body || {};
    if (!Array.isArray(body.messages) || body.messages.length === 0) {
      return res.status(400).json({ ok: false, error: 'NO_MESSAGES' });
    }

    const payload = { model: body.model || DEFAULT_MODEL, max_tokens: body.max_tokens || 1024, messages: body.messages };
    if (body.system) payload.system = body.system;
    if (body.output_config) payload.output_config = body.output_config;

    try {
      const r = await fetch(ANTHROPIC_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify(payload),
      });
      const data = await r.json();
      if (!r.ok) return res.status(r.status).json({ ok: false, error: 'ANTHROPIC_ERROR', detail: data });
      const text = Array.isArray(data.content)
        ? data.content.filter((b) => b.type === 'text').map((b) => b.text).join('')
        : '';
      return res.json({ ok: true, text, content: data.content, usage: data.usage, stop_reason: data.stop_reason });
    } catch (e) {
      return res.status(502).json({ ok: false, error: 'PROXY_FAILED', message: String((e && e.message) || e) });
    }
  }
);
