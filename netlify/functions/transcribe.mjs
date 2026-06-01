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
 * The pure helpers below (validateAudio, deriveConfidence, normalizeWhisperResponse,
 * mapProviderError) are exported as named exports so they can be unit-tested
 * (test/unit/transcribe.test.js). Netlify only consumes `default` and `config`;
 * the extra exports are ignored at deploy time. They live in this single function
 * file on purpose — a sibling .mjs in netlify/functions/ would be misread as its
 * own (broken) function.
 */

const WHISPER_URL = 'https://api.openai.com/v1/audio/transcriptions';
const MODEL = 'whisper-1';

// Whisper hard limit is 25 MB; reject anything larger before we spend an upload.
export const MAX_AUDIO_BYTES = 25 * 1024 * 1024;

// Accept the formats browsers actually produce from MediaRecorder + common uploads.
const ALLOWED_PREFIXES = ['audio/', 'video/webm', 'application/octet-stream'];

/** Validate an incoming audio part before forwarding it to the provider. */
export function validateAudio(file) {
  if (!file || typeof file.size !== 'number') return { ok: false, code: 'NO_AUDIO', message: 'No audio file was provided in the "audio" field.' };
  if (file.size <= 0) return { ok: false, code: 'EMPTY_AUDIO', message: 'The audio file was empty.' };
  if (file.size > MAX_AUDIO_BYTES) return { ok: false, code: 'AUDIO_TOO_LARGE', message: 'Audio exceeds the ' + Math.round(MAX_AUDIO_BYTES / (1024 * 1024)) + ' MB limit.' };
  const type = String(file.type || '').toLowerCase();
  // An empty type is allowed (some browsers omit it for blobs); a present type must match.
  if (type && !ALLOWED_PREFIXES.some((p) => type.startsWith(p))) {
    return { ok: false, code: 'UNSUPPORTED_AUDIO_TYPE', message: 'Unsupported audio content-type: ' + type };
  }
  return { ok: true };
}

/**
 * Derive a 0-100 confidence from Whisper verbose_json segments. Whisper reports
 * per-segment avg_logprob (natural log prob, ≤ 0); exp() maps it to ~0..1, which
 * we average (duration-weighted when available) and scale to 0-100. Plain-text
 * responses have no logprobs → confidence 0 (honest "unknown"), never fabricated.
 */
export function deriveConfidence(json) {
  const segs = json && Array.isArray(json.segments) ? json.segments : null;
  if (!segs || !segs.length) return 0;
  let wsum = 0, w = 0;
  for (const s of segs) {
    if (typeof s.avg_logprob !== 'number') continue;
    const dur = (typeof s.end === 'number' && typeof s.start === 'number' && s.end > s.start) ? (s.end - s.start) : 1;
    wsum += Math.exp(s.avg_logprob) * dur;
    w += dur;
  }
  if (!w) return 0;
  return Math.max(0, Math.min(100, Math.round((wsum / w) * 100)));
}

/** Normalize a Whisper API response (verbose_json or json) to the client shape. */
export function normalizeWhisperResponse(json) {
  const transcript = String((json && json.text) || '').trim();
  return { transcript: transcript, confidence: deriveConfidence(json) };
}

/** Map a thrown/HTTP error to a stable client code + safe message (no secrets). */
export function mapProviderError(err) {
  const status = err && typeof err.status === 'number' ? err.status : (err && typeof err.statusCode === 'number' ? err.statusCode : 0);
  if (status === 401 || status === 403) return { code: 'PROVIDER_AUTH_FAILED', message: 'Transcription provider rejected the API key.' };
  if (status === 429) return { code: 'PROVIDER_RATE_LIMITED', message: 'Transcription provider is rate-limiting; retry shortly.' };
  if (status >= 500 || status === 0) return { code: 'PROVIDER_UNAVAILABLE', message: 'Transcription provider is unavailable; the audio is saved — retry later.' };
  return { code: 'TRANSCRIPTION_FAILED', message: 'Transcription failed (' + status + ').' };
}

/** Small JSON Response helper (Web Fetch API), matching the other functions. */
export function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

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
// Matches the proven vision/sync/claude functions — only `path` (no unverified keys).
export const config = { path: '/api/transcribe' };
