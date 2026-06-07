# Text-to-Speech (NVIDIA Chatterbox / Riva TTS NIM)

Spoken output for the field app — read quotes, notes, and sidekick replies aloud,
hands-free on a job site. The model runs as an NVIDIA **Riva TTS NIM** on your
own GPU host; the app talks to it through a server-side proxy so no key or
internal URL is ever shipped to the browser.

```
browser  ──POST /api/tts {text}──►  Netlify proxy  ──form-data──►  Riva TTS NIM (:9000)
   ▲                                                                     │
   └──────────────────  WAV audio  ◄──────────────────────────  /v1/audio/synthesize
```

## 1. Run the NIM on a GPU host

> Treat your NGC key as a secret — never paste it into a chat, commit it, or bake
> it into an image. Export it in the shell and rotate it if it's ever exposed.

```bash
export NGC_API_KEY=<your-ngc-key>
echo "$NGC_API_KEY" | docker login nvcr.io -u '$oauthtoken' --password-stdin

docker run -it --rm --name=chatterbox-tts-multilingual \
    --runtime=nvidia --gpus '"device=0"' --shm-size=8GB \
    -e NGC_API_KEY=$NGC_API_KEY \
    -e NIM_HTTP_API_PORT=9000 -e NIM_GRPC_API_PORT=50051 \
    -p 9000:9000 -p 50051:50051 \
    nvcr.io/nim/nvidia/chatterbox-tts-multilingual:latest

# wait for readiness, then list the available voice ids:
curl -sS http://localhost:9000/v1/health/ready
curl -sS http://localhost:9000/v1/audio/list_voices
```

## 2. Point the app at it (server env, never the client)

Set these in the Netlify site environment (or your function host):

| Var | Required | Purpose |
|---|---|---|
| `RIVA_TTS_URL` | yes | NIM base URL, e.g. `http://gpu-host:9000` |
| `RIVA_TTS_VOICE` | no | default voice id from `/v1/audio/list_voices` |
| `RIVA_TTS_LANGUAGE` | no | default language code (default `en-US`) |
| `RIVA_TTS_API_KEY` | no | bearer token if the NIM sits behind an authed gateway |

The proxy lives at `netlify/functions/chatterbox-tts.mjs` and serves **`/api/tts`**.
When `RIVA_TTS_URL` is unset it returns `503 TTS_NOT_CONFIGURED` and the client
degrades gracefully (browser voice, or silent) — it never crashes.

## 3. Use it from the app

```js
await AAA_TTS.speak('Your quote total is twelve hundred dollars.');
await AAA_TTS.speak(text, { voice: 'SomeVoice', language: 'es-ES' });
AAA_TTS.stop();
```

Provider order (honest, degrading):
1. **server** — `/api/tts` → the Riva NIM, plays the returned WAV.
2. **browser** — the platform `speechSynthesis` voice (no infra) as fallback,
   including when the NIM is configured but unreachable.
3. **none** — returns `{ ok:false, error:'TTS_UNAVAILABLE' }`, never throws.

Config flags (via `AAA_CONFIG`): `ttsEndpoint` (default `/api/tts`), `ttsEnabled`
(default true), `ttsVoice`, `ttsLanguage`.

## API contract (offline synthesize)

`POST {RIVA_TTS_URL}/v1/audio/synthesize` — multipart form-data:

| Field | Notes |
|---|---|
| `text` | text to synthesize (required) |
| `language` | e.g. `en-US` (default) |
| `voice` | optional; see `/v1/audio/list_voices` |
| `sample_rate_hz` | optional, e.g. `22050` |
| `encoding` | optional |

Returns a complete `audio/wav`. (A streaming endpoint
`/v1/audio/synthesize_online` returns raw LPCM — not used here.)

> **Honest caveat:** the exact form-field names and voice ids can vary by NIM
> version. They follow NVIDIA's documented curl (`-F language=en-US -F text=...`);
> confirm against your running NIM with `/v1/audio/list_voices` and adjust
> `functions/chatterbox-tts.js` (`buildSynthFields`) if your build differs. That
> translation is pure and unit-tested (`functions/chatterbox-tts.test.js`).

## Files

- `functions/chatterbox-tts.js` — pure request/validation/error helpers (shared, tested).
- `netlify/functions/chatterbox-tts.mjs` — the `/api/tts` proxy.
- `js/ai/tts-engine.js` — `AAA_TTS` browser client with browser-voice fallback.
- `test/unit/tts.test.js`, `functions/chatterbox-tts.test.js` — coverage.
