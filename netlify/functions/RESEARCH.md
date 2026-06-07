# Research Brain (`/api/research`) — AI-Q integration

The **Research Brain** connects AAA HyperKernel to a **separate** research/strategy
service (NVIDIA AI-Q Blueprint, or any backend that takes a question and returns a
citation-backed report). It is a **read-only strategy advisor** — it never touches
jobs, quotes, invoices, payments, bookkeeping, or customer records.

## Architecture (why it's separate)

```
AAA HyperKernel (this PWA, Netlify)        AI-Q Research Service (separate host)
  Quote / Accounting / CRM / Ads / Reviews   Python 3.13 · Docker/K8s · NVIDIA NIM
        │                                      deep + shallow research agents
        │  POST /api/research  ──────────────▶ web search · reports · citations
        │  (Netlify function, token server-side)
        └─ AAA_RESEARCH client → research_reports (read-only, advisory)
```

AI-Q needs Python, GPUs/NIM, and an `NVIDIA_API_KEY` — it **cannot** run inside
this static PWA. Run it on its own host; this app only calls it over HTTPS.

## Stand up the AI-Q service (one-time, on its own host)

```bash
unzip aiq-release-2.1.zip && cd aiq-release-2.1
uv venv --python 3.13 .venv && source .venv/bin/activate
uv pip install -e ".[dev]"
uv pip install -e ./frontends/aiq_api ./frontends/cli
cp deploy/.env.example deploy/.env       # add NVIDIA_API_KEY (+ TAVILY/SERPER if used)
python deploy/start_web.py               # serves POST /chat on :8000
```

Put it behind HTTPS and a bearer token (don't expose :8000 raw to the internet).

## Connect AAA to it

Set in the **Netlify site environment** (server-side only — never in the browser):

| var | required | meaning |
|-----|----------|---------|
| `AIQ_RESEARCH_URL` | yes | the AI-Q chat endpoint, e.g. `https://research.internal/chat` |
| `AIQ_RESEARCH_TOKEN` | recommended | bearer token the proxy sends to AI-Q |

Until `AIQ_RESEARCH_URL` is set, `/api/research` returns `RESEARCH_NOT_CONFIGURED`
and the UI shows a clear "not connected yet" message — no fabricated reports.

## Contract

`POST /api/research` (JSON) `{ "message": "<question>" }` →
`{ "ok": true, "report": "…", "citations": [{ "title", "url", "snippet" }] }`.
The proxy normalizes AI-Q variants (`report`/`answer`/`content`, `sources`/
`citations`/`references`). Errors map to stable codes
(`RESEARCH_AUTH_FAILED`/`_NOT_FOUND`/`_RATE_LIMITED`/`_UNAVAILABLE`) with no
secrets in the message.

## Using it in the app

Command Center → Executive Intelligence → **Research Brain (read-only)**. Pick a
template (Competitors, Google Ads, SEO, Market report, Pricing trends, Materials,
Tax/accounting) and a subject, or ask free-form. Reports are saved to
`research_reports` for later reading.

## Safety boundary (enforced in code + tests)

`js/agents/research-brain.js` writes **only** to `research_reports` and references
no mutation API. `test/unit/research-brain.test.js` asserts a successful research
run touches no jobs/quotes/invoices/payments/customers collections. Keep AI-Q
read-only until it has been independently security-reviewed before granting it any
write path into the business.
