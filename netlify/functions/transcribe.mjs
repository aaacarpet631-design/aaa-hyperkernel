/*
 * Audio transcription function (Netlify) — the server side of voice Layer 2.
 *
 * The field app records an audio note (MediaRecorder) and POSTs it here as
 * multipart/form-data: field "audio" (the blob) + optional "jobId". This function
 * forwards the audio to OpenAI Whisper and returns { ok, transcript, confidence },
 * exactly the shape js/ai/sidekick-voice-engine.js → transcribeAudio() expects.
 *
 * Secrets stay server-side: set OPENAI_API_KEY in the Netlify site environment.
 * The key is never sent to the browser. Audio is forwarded straight to the
 * provider and not persisted here (the client keeps the durable copy as a note).
 *
 * Pure validation/normalization lives in transcribe-lib.mjs (unit-tested); this
 * handler only does request parsing + the network call.
 */
import { validateAudio, normalizeWhisperResponse, mapProviderError, json, MAX_AUDIO_BYTES } from './transcribe-lib.mjs';

const WHISPER_URL = 'https://api.openai.com/v1/audio/transcriptions';
const MODEL = 'whisper-1';

export default async (req) => {
  if (req.method !== 'POST') return json({ ok: false, error: 'METHOD_NOT_ALLOWED' }, 405);

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    // Honest config error — the client treats this as "transcription unavailable"
    // and keeps the saved audio note for a later retry.
    return json({ ok: false, error: 'MISSING_API_KEY', message: 'Set OPENAI_API_KEY in the Netlify site environment.' }, 500);
  }

  // Parse the multipart body the browser sent (Web FormData; no extra deps).
  let form;
  try { form = await req.formData(); }
  catch { return json({ ok: false, error: 'INVALID_FORM', message: 'Expected multipart/form-data with an "audio" field.' }, 400); }

  const audio = form.get('audio');
  if (!audio || typeof audio === 'string') return json({ ok: false, error: 'NO_AUDIO', message: 'Missing "audio" file field.' }, 400);

  const check = validateAudio({ name: audio.name, type: audio.type, size: audio.size });
  if (!check.ok) return json({ ok: false, error: check.code, message: check.message }, check.code === 'AUDIO_TOO_LARGE' ? 413 : 400);

  // Forward to Whisper. verbose_json gives us per-segment logprobs → real confidence.
  const upstream = new FormData();
  upstream.append('file', audio, audio.name || 'note.webm');
  upstream.append('model', MODEL);
  upstream.append('response_format', 'verbose_json');

  try {
    const res = await fetch(WHISPER_URL, {
      method: 'POST',
      headers: { authorization: 'Bearer ' + apiKey },
      body: upstream
    });
    if (!res.ok) {
      let detail = '';
      try { detail = (await res.json())?.error?.message || ''; } catch { /* ignore */ }
      const mapped = mapProviderError({ status: res.status });
      console.error('Transcribe provider error', res.status, detail);
      return json({ ok: false, error: mapped.code, message: mapped.message }, res.status >= 400 && res.status <= 599 ? res.status : 502);
    }
    const data = await res.json();
    const out = normalizeWhisperResponse(data);
    if (!out.transcript) return json({ ok: false, error: 'EMPTY_TRANSCRIPT', message: 'No speech was detected in the audio.' }, 200);
    return json({ ok: true, transcript: out.transcript, confidence: out.confidence });
  } catch (err) {
    const mapped = mapProviderError(err);
    console.error('Transcribe function error', err);
    return json({ ok: false, error: mapped.code, message: mapped.message }, 502);
  }
};

// Friendly route; the client defaults cfg.transcriptionEndpoint to /api/transcribe.
export const config = { path: '/api/transcribe', bodyParser: false, maxDuration: 60 };

export { MAX_AUDIO_BYTES };
