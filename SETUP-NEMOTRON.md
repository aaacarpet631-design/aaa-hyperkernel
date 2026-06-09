# AAA HyperKernel — NVIDIA Nemotron backend (optional AI provider)

The app's AI runs through one server-side funnel (`AAA_DATA.callAgent` → proxy).
By default that proxy talks to **Claude**. This guide points it at **NVIDIA's
hosted Nemotron** instead — a multimodal ("Omni") reasoning model — without
touching any agent code. It is a **config flip plus one deployed function**.

> **Why hosted, not local?** `Nemotron-3-Nano-Omni-30B-A3B-NVFP4` is a 30B
> model and needs a GPU host — it cannot run in the browser or in a serverless
> function. We use NVIDIA's hosted, OpenAI-compatible endpoint so the app stays
> a PWA + serverless deploy. The model weights are **not** vendored into this
> repo.

## How it fits

```
agents → AAA_DATA.callAgent({ system, messages, model:'claude-…' })
       → proxy (nemotronProxy / nemotron-proxy / /api/nemotron)
       → functions/nemotron-translate.js   (Anthropic shape ⇄ OpenAI shape)
       → https://integrate.api.nvidia.com/v1/chat/completions
```

`nemotron-translate.js` is the only place that knows the two APIs differ. It:
- hoists `system` into the OpenAI messages array,
- converts Anthropic image blocks → OpenAI `image_url` (Nemotron-Omni is multimodal),
- **maps agent-pinned Claude model ids** (`claude-opus-4-8`, …) to the Nemotron
  model, so no agent needs editing,
- normalizes the reply back to `{ ok, text, content, usage, stop_reason }`.

It is unit-tested offline: `node functions/nemotron-translate.test.js` (also run
by `npm test`).

## 1. Get an NVIDIA API key
Create a key at **build.nvidia.com** (NIM / NVIDIA API catalog). It looks like
`nvapi-…`. This is the only secret you need.

## 2. Deploy the proxy (pick the backend you already use)

**Netlify (easy path — same deploy as the app):**
```bash
# Set the env var in the Netlify site settings:
NVIDIA_API_KEY=nvapi-xxxxx
# optional, if NVIDIA publishes a different served name:
NEMOTRON_MODEL=nvidia/<served-name>
```
The function `netlify/functions/nemotron.mjs` is served at `/api/nemotron`.

**Firebase:**
```bash
firebase functions:secrets:set NVIDIA_API_KEY      # paste nvapi-xxxxx
firebase deploy --only functions:nemotronProxy
```

**Supabase:**
```bash
supabase functions deploy nemotron-proxy --no-verify-jwt
supabase secrets set NVIDIA_API_KEY=nvapi-xxxxx
# optional: supabase secrets set NEMOTRON_MODEL=nvidia/<served-name>
```

## 3. Point the app at Nemotron
One flag. From the browser console on the deployed site (or via `window.AAA_ENV`):
```js
AAA_CONFIG.set({ aiProvider: 'nemotron' });
location.reload();
```
With Firebase/Supabase configured, `proxyUrl` now auto-resolves to
`nemotronProxy` / `nemotron-proxy`. On **Netlify**, also set the endpoint:
```js
AAA_CONFIG.set({ aiProvider: 'nemotron', proxyUrl: '/api/nemotron' });
```
To switch back, `AAA_CONFIG.set({ aiProvider: 'claude' })` (or clear it).

## 4. Verify
```js
AAA_CONFIG.aiProvider;        // 'nemotron'
AAA_CONFIG.proxyUrl;          // …/nemotronProxy  or  /api/nemotron
await AAA_DATA.callAgent({ max_tokens: 16, messages: [{ role:'user', content:'Reply with exactly: OK' }] });
// → { ok:true, text:'OK', usage:{ input_tokens, output_tokens }, ... }
```
The same "honest by construction" rule still holds: with no proxy configured,
agents return `AI_NOT_CONFIGURED` and fall back to real data — they never
fabricate.

## Enabling "thinking" (reasoning mode)
Nemotron is a reasoning model. Thinking is **off by default** so normal agent
calls stay cheap; opt in per call by passing the same params NVIDIA's own
example uses — the proxy forwards them through:
```js
await AAA_DATA.callAgent({
  max_tokens: 4096,
  messages: [{ role: 'user', content: 'Walk through the math, then answer.' }],
  reasoning_budget: 16384,
  chat_template_kwargs: { enable_thinking: true }
});
// → { ok:true, text:'<final answer>', reasoning:'<chain-of-thought>', usage, ... }
```
`top_p` defaults to NVIDIA's recommended `0.95` (override per call). The
chain-of-thought is returned as `result.reasoning`; `result.text` always holds
just the final answer so existing JSON parsers are unaffected.

## Content-safety guardrail (`AAA_CONTENT_SAFETY`)
A second Nemotron model — `nvidia/nemotron-3-content-safety` — is wired in as an
optional moderation layer. It runs through the **same Nemotron proxy** (no extra
deploy) and is reached **independently of `aiProvider`**, so it works even when
your agents run on Claude: the guardrail resolves `nemotronProxyUrl` itself
(Firebase `nemotronProxy` / Supabase `nemotron-proxy`, or set
`nemotronProxyUrl: '/api/nemotron'` on Netlify).

```js
// Screen a customer/field input:
await AAA_CONTENT_SAFETY.check('How can I steal money from here?');
// → { ok, safe:false, flagged:true, verdict:'unsafe', categories:[...], raw }

// Screen an AI-generated message before sending it to a customer:
await AAA_CONTENT_SAFETY.checkResponse(userPrompt, agentReply);
// → { ok, safe, verdict, responseSafety, categories, ... }
```

By construction it only **classifies** — it never blocks, edits, sends, or
stores anything; you decide what to do with a verdict. `safe` is `null` (unknown)
rather than a false "safe" when a reply can't be read, so a caller can fail
closed. With no proxy configured it returns `AI_NOT_CONFIGURED`. Pass
`{ categories: '/categories' }` to forward NVIDIA's `request_categories`
chat-template arg.

### Where it is enforced: AI-drafted review requests (fail-closed)
The one place the guardrail is wired in today is the **review-request engine**
(`AAA_REVIEW_REQUEST_ENGINE.requestReview`). Only **AI-drafted** outbound
customer text is screened; the deterministic template fallback is not (it is
human-authored). The mapping is fail-closed — a clean `safe` verdict is the only
path to a normal send:

| Verdict | Review status | Send flow |
|--------|---------------|-----------|
| `safe` | `pending` | normal one-tap send |
| `unsafe` | `blocked` | send disabled; admin banner; human reviews |
| `unknown` / unreadable / proxy error / guardrail unavailable | `queued` | send disabled; admin banner; human reviews |

The full verdict (decision, verdict, categories, raw response, model, timestamp,
and message-context id) is stored on the review record's `safety` field **and**
written to the agent log. Messages are never silently edited. Blocked/queued
drafts show a visible admin banner in the send sheet and do **not** expose the
one-tap SMS/email buttons. This is intentionally scoped to AI-drafted review
texts — it is not applied globally.

## Notes & honest limits
- **Vision estimating** (`/api/vision`) and **voice transcription**
  (`/api/transcribe`) still run on their existing functions. Nemotron-Omni
  *could* serve vision too (the translator already converts image blocks); that
  swap is a follow-up and is intentionally left out of this change.
- **Cost logging:** the Supabase proxy logs token counts to `ai_costs` with
  `usd: 0` — hosted-Nemotron pricing depends on your NVIDIA plan, so fill in the
  rate when you know it rather than guessing.
- **Reasoning output:** if the model returns `reasoning_content`, it is surfaced
  as `result.reasoning`; `text` always holds the final answer so existing JSON
  parsers keep working.
- Keep `NVIDIA_API_KEY` server-side only — never in the browser, exactly like
  `ANTHROPIC_API_KEY`.
