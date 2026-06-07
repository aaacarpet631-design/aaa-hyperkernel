/*
 * chatterbox-tts — Netlify proxy for the NVIDIA Riva TTS NIM (text → speech).
 *
 * The field app POSTs JSON { text, voice?, language?, sampleRate? } to /api/tts;
 * this forwards it as form-data to the NIM's offline synthesize endpoint and
 * streams the WAV straight back, so the browser can play it. The NIM base URL
 * (and any auth) stay server-side — never shipped to the client.
 *
 * Config (Netlify site env):
 *   RIVA_TTS_URL       base URL of the running NIM, e.g. http://gpu-host:9000  (required)
 *   RIVA_TTS_VOICE     optional default voice id (see /v1/audio/list_voices)
 *   RIVA_TTS_LANGUAGE  optional default language code (default en-US)
 *   RIVA_TTS_API_KEY   optional bearer if the NIM sits behind an authed gateway
 *
 * Request/response translation + validation lives in functions/chatterbox-tts.js
 * (shared, unit-tested offline).
 */
import tts from '../../functions/chatterbox-tts.js';

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

  const base = process.env.RIVA_TTS_URL;
  if (!base) {
    // Honest config error — the client treats this as "TTS unavailable" and
    // falls back to the browser voice (or stays silent) without crashing.
    return json({ ok: false, error: 'TTS_NOT_CONFIGURED', message: 'Set RIVA_TTS_URL to the Chatterbox/Riva TTS NIM base URL (e.g. http://host:9000).' }, 503);
  }

  let body;
  try { body = await req.json(); } catch { return json({ ok: false, error: 'INVALID_JSON' }, 400); }

  const check = tts.validateText(body && body.text);
  if (!check.ok) return json({ ok: false, error: check.code, message: check.message }, check.code === 'TEXT_TOO_LONG' ? 413 : 400);

  const fields = tts.buildSynthFields(
    { text: check.text, voice: body.voice, language: body.language, sampleRate: body.sampleRate, encoding: body.encoding },
    { voice: process.env.RIVA_TTS_VOICE, language: process.env.RIVA_TTS_LANGUAGE }
  );
  const form = new FormData();
  Object.keys(fields).forEach((k) => form.append(k, fields[k]));

  const headers = {};
  if (process.env.RIVA_TTS_API_KEY) headers.authorization = 'Bearer ' + process.env.RIVA_TTS_API_KEY;

  try {
    const res = await fetch(tts.synthesizeUrl(base), { method: 'POST', headers, body: form });
    if (!res.ok) {
      let detail = '';
      try { detail = (await res.text()).slice(0, 300); } catch { /* ignore */ }
      const mapped = tts.mapProviderError(res.status);
      console.error('TTS provider error', res.status, detail);
      return json({ ok: false, error: mapped.code, message: mapped.message }, res.status >= 400 && res.status <= 599 ? res.status : 502);
    }
    // Stream the synthesized audio straight back to the browser.
    const buf = await res.arrayBuffer();
    const contentType = res.headers.get('content-type') || 'audio/wav';
    return new Response(buf, {
      status: 200,
      headers: { 'content-type': contentType, 'access-control-allow-origin': '*', 'cache-control': 'no-store' }
    });
  } catch (err) {
    const mapped = tts.mapProviderError(0);
    console.error('TTS function error', err);
    return json({ ok: false, error: mapped.code, message: mapped.message }, 502);
  }
};

export const config = { path: '/api/tts' };
