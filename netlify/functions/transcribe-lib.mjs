/*
 * Transcription function — pure helpers (no network, no SDK).
 *
 * Split out from the handler so the validation, provider-response normalization,
 * and confidence derivation can be unit-tested without hitting OpenAI or needing
 * a real multipart request. The handler (index.mjs) wires these to a live request.
 */

// Whisper hard limit is 25 MB; reject anything larger before we spend an upload.
export const MAX_AUDIO_BYTES = 25 * 1024 * 1024;

// Accept the formats browsers actually produce from MediaRecorder + common uploads.
const ALLOWED_PREFIXES = ['audio/', 'video/webm', 'application/octet-stream'];

/**
 * Validate an incoming audio part before forwarding it to the provider.
 * @param {{ name?:string, type?:string, size?:number }} file
 * @returns {{ ok:true } | { ok:false, code:string, message:string }}
 */
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
 * responses have no logprobs → confidence 0 (honest "unknown"), never a fake number.
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

/**
 * Normalize a Whisper API response (verbose_json or json) to the client shape.
 * @returns {{ transcript:string, confidence:number }}
 */
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
