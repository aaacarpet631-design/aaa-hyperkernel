# Audio transcription function (`/api/transcribe`)

Server side of voice **Layer 2** (audio recording → transcript). The field app
records an audio note with `MediaRecorder` and POSTs it here; this function
forwards the audio to OpenAI Whisper and returns the transcript. Secrets stay
server-side — the browser never sees the API key.

## Contract

**Request** — `POST /api/transcribe`, `multipart/form-data`:

| field   | type   | required | notes                                  |
|---------|--------|----------|----------------------------------------|
| `audio` | file   | yes      | the recorded blob (e.g. `audio/webm`)  |
| `jobId` | string | no       | for correlation only; not persisted    |

**Response** — `application/json`:

```jsonc
// success
{ "ok": true, "transcript": "fix the stairs in the master bedroom", "confidence": 82 }
// no speech detected (HTTP 200 — the client treats this as EMPTY_TRANSCRIPT)
{ "ok": false, "error": "EMPTY_TRANSCRIPT", "message": "No speech was detected in the audio." }
// errors: NO_AUDIO/EMPTY_AUDIO/UNSUPPORTED_AUDIO_TYPE (400), AUDIO_TOO_LARGE (413),
//         MISSING_API_KEY (500), PROVIDER_AUTH_FAILED/RATE_LIMITED/UNAVAILABLE (4xx/5xx)
```

`confidence` (0–100) is derived from Whisper `verbose_json` per-segment
`avg_logprob` (duration-weighted). Plain responses with no segments report `0`
("unknown") rather than a fabricated number.

The client (`js/ai/sidekick-voice-engine.js → transcribeAudio`) always saves the
audio note **before** calling this, so a provider/network failure never loses the
recording — the note is kept with `status: 'failed'` and can be retried.

## Configuration

Set in the Netlify site environment:

```
OPENAI_API_KEY = sk-...
```

Without it the function returns `MISSING_API_KEY` and the client keeps the audio
note for a later retry (transcription is additive, never required).

Limits: 25 MB max upload (Whisper's limit), 60s function duration. To use a
different provider, swap `WHISPER_URL`/`MODEL` and adjust
`normalizeWhisperResponse` in `transcribe-lib.mjs` (kept pure + unit-tested in
`test/unit/transcribe.test.js`).
