# Copilot Slice A — Two-Repo Read-Only Recon

Mission: `docs/HYPERKERNEL_CHAT_MISSION.md`. Scope: map chat paths, data
sources, schema seams, authorization boundaries, and integration risks across
`aaacarpet631-design/aaa-hyperkernel` and `aaacarpet631-design/Custonllm`
(cloned read-only at `/workspace/custonllm`, HEAD `76eed5a`). **No behavior
was changed in either repo for this slice.**

## 1. HyperKernel chat path (browser, local-first)

The chat surface already exists and is substantial — phase one is an
*upgrade of a working pipeline*, not a greenfield build:

```
user text
  → js/copilot/chat-canvas.js         send(): stores message (chat-message-store),
                                      queues offline (offline-chat-queue)
  → js/copilot/chat-intent-router.js  delegates to the Executive Copilot router
                                      + chat-native intents (software_factory,
                                      governance_approval)
  → js/copilot/executive-copilot.js   ask(): classify → governance gate →
                                      route (simulation council / teleological
                                      goals / briefing engine / council query +
                                      executive-synthesizer)
  → js/copilot/copilot-governance-gate.js  PROPOSE-never-PERFORM: protected
                                      actions (pricing, customer messages, ad
                                      spend, dispatch, refunds, payroll, legal,
                                      bank, config) halt with
                                      HUMAN_APPROVAL_REQUIRED → approval package
                                      via Council Governance
  → js/copilot/rich-card-renderer.js  escape-safe HTML from card models:
                                      executive_briefing | simulation | goal |
                                      software_factory | governance_approval | text
```

Adjacent, already live: `copilot-memory-retriever.js` (read-only pulls from
Belief Registry / Learning Fabric / Vector Memory; empty set when nothing is
known), `morning-briefing-engine.js`, SMS adapters (`sms-command-router`,
`sms-copilot-adapter`, `sms-response-formatter`), voice input adapter.
Covered by suites: `copilot`, `chat-canvas`, `sms-copilot`, `owner-copilot`,
`owner-copilot-ui`.

**External model seam** (the only one): `js/ai/model-router.js` —
`AAA_GOVERNED_MODEL_ROUTER.call()` is the single canonical path to any
provider: registry resolution → gateway `RUN_MODEL` (audited, RBAC) → model
must be a governed ACTIVE artifact AND owner-enabled → provider adapter →
provenance trace + usage record. Adapters call **server proxies only**
(`netlify/functions/claude.mjs`, `nemotron.mjs`, `private-gpu.mjs`,
`vision.mjs`, `transcribe.mjs`, `research.mjs`) — no keys in the client.
`js/ai/content-safety.js` and `tenant-model-policy.js` sit beside it.

## 2. HyperKernel data sources for the phase-one jobs

| Phase-one job | Source of truth (today) |
|---|---|
| What needs attention today? | `AAA_DATA` jobs/leads/quotes read-models; morning-briefing-engine; decision-inbox; approval inbox |
| Who should I follow up with? | `AAA_QUOTES.followUpQueue()`, `AAA_LEADS` stages, followup-intelligence |
| Estimate at risk / underpriced? | quote records (margin/cost, owner-only), win-probability-engine, margin-guardian, pricing-optimizer |
| What did agents do overnight? | `gov_agent_decisions` (AAA_AGENT_OUTCOMES), audit_log, decision_envelopes, `ads_recommendations`, workforce queue |
| Draft a follow-up, don't send | lead-store follow-up templates (static drafts), assisted-draft-queue + `SEND_MESSAGE`/`APPROVE_ASSISTED_MSG` gateway actions (human-only send) |

Everything needed is already recorded locally; the missing piece is a
**deterministic, permission-scoped context packet** that assembles these with
source refs (Slice C).

## 3. Custonllm (Python 3.11, FastAPI)

A provider-agnostic *coding-agent platform* (LLM router, tool registry,
execution loop, personas) — today it is NOT business-aware. Relevant assets:

- **API**: `agent/api/` — routers for `POST /chat` (single-shot, guarded:
  rate-limit per IP, role coercion, capability/persona resolution), council,
  calibration (`POST /predictions`, `POST /predictions/{id}/outcome`,
  `GET /calibration`), capabilities, missions, tools, ws, webhook, health,
  diag, graph, models/personas, pages/pwa.
- **Auth**: `agent/api/auth.py` — HMAC-signed tokens carrying name/role/expiry;
  roles `owner|admin|estimator|crew|customer` with server-side deny-by-default
  `ROLE_PERMS`; restricted users are *coerced* to safe defaults, not rejected.
- **Governance**: `agent/governance/` — audit sink + redaction;
  `agent/ledger/` calibration ledger with pluggable storage
  (memory | file | **firestore** for production).
- **LLM routing**: `agent/core/llm.py` + `model_registry.py` —
  OpenAI/Anthropic/OpenRouter, provider-agnostic.
- **Deploy**: Dockerfile / Procfile / render.yaml (Render or Cloud Run);
  Firestore optional dependency.
- **Tests**: 631 test functions incl. `test_chat_router`, `test_auth`,
  `test_contracts`, `test_council`, `test_architecture`.
- **Contracts**: `agent/api/contracts.py` holds *internal* Protocol contracts
  (CodeGraph/Ledger/Council/Reviewer/Reconciler) — there is no HyperKernel
  copilot contract yet.

## 4. Schema seams (what the versioned contract must bridge)

1. **No wire contract exists.** HyperKernel's copilot is fully local
   (in-browser JS reading `AAA_DATA`); Custonllm is a separately deployed API.
   Nothing connects them today — the Slice B contract is genuinely new, not a
   refactor.
2. **Cards are JS models, not schemas.** `rich-card-renderer` renders
   card-model objects but nothing validates them at a boundary. Slice B needs
   JSON Schemas (repo: `schemas/`, like `schemas/google-ads-attribution.json`)
   for: request envelope, context packet, response envelope, each card type,
   evidence ref, approval requirement.
3. **Evidence refs have precedents, not a standard.** Decision envelopes carry
   `evidence[]`, provenance traces carry citations, but there is no uniform
   `{collection, id, field, asOf}` source-ref shape. Define once in Slice B.
4. **Custonllm responses are Pydantic; HyperKernel validation is hand-rolled.**
   The same JSON Schema files should be consumed by both (Pydantic on one side,
   the zero-dep validator pattern from `aaa-event-bus` contracts on the other).

## 5. Authorization boundaries

| Boundary | HyperKernel | Custonllm | Seam risk |
|---|---|---|---|
| Identity | `AAA_RBAC` roles owner/manager/crew, per-device | HMAC token roles owner/admin/estimator/crew/customer | Role vocabularies differ — the contract must carry a mapped role + workspaceId, minted server-side, never client-claimed |
| Tenancy | `workspaceId` on every record; tenant-guard; Firestore rules (financial owner-only) | none built-in (single-tenant assumption) | Context packet must be assembled AND redacted on the HyperKernel side; Custonllm must never query business stores directly |
| Mutation | Runtime gateway `ACTIONS` (aiAllowed:false on money/customer/config); decision envelopes; PROPOSE-never-PERFORM gate | agent has a tool execution loop (file/code tools) | Custonllm's coding tools must be UNREACHABLE from the copilot path — read-only persona/capability class, no workspace tools |
| Model calls | Governed model router → RUN_MODEL gate → server proxies | direct provider SDKs w/ own keys | Two model governance regimes; copilot calls land on Custonllm's, so its audit sink + calibration ledger must feed back into HyperKernel telemetry (Slice F) |
| Secrets | none client-side; netlify env | `.env` provider keys, HMAC secret | standard |

## 6. Integration risks (ranked)

1. **Excessive agency via the platform's own tools.** Custonllm is a coding
   agent with an execution loop; wiring HyperKernel chat to `POST /chat`
   without a locked-down read-only capability class would expose tool
   execution to owner chat. Phase one must pin a dedicated copilot
   persona/capability with **zero mutating tools** (mission: "no open-ended
   mutation tools").
2. **Prompt injection through business data.** Customer names/notes/lead
   text flow into the context packet. Mitigations available on both sides
   (HyperKernel `content-safety.js`; Custonllm reply guard + redaction) but
   the contract must mark untrusted fields so the intelligence layer treats
   them as data, not instructions. Injection evals belong in Slice F.
3. **PII minimization across the wire.** Sending raw customer PII to a
   remotely-deployed Custonllm expands the exposure surface. The context
   packet should send ids + minimal fields per job, mirroring the ads-stack
   whitelist discipline; drafts come back referencing ids.
4. **Dual governance regimes drift.** HyperKernel's gateway/envelope audit
   vs Custonllm's audit sink/calibration ledger. Without Slice F telemetry
   unification, "zero unapproved mutations" cannot be *proven* end-to-end.
5. **Availability coupling.** Chat today is 100% local-first and works
   offline (offline-chat-queue). Adding a network intelligence layer must not
   break that: the existing local Executive Copilot is the natural fallback
   path (mission gate: "all failures degrade safely").
6. **Latency/cost budgets are undefined.** The mission requires p95 latency
   and per-conversation cost budgets "within the team's defined budget" —
   no numbers exist yet. Owner must set them before Slice F can gate on them.

## 7. What phase one does NOT need to build (already exists)

- Approval envelopes + human-only approval chain (decision envelope + runtime
  gateway + approval inbox UI).
- PROPOSE-never-PERFORM classification for protected actions.
- Honest-unknown rendering (`insufficient_data` cards).
- Draft-don't-send for customer messages (assisted-draft-queue +
  `APPROVE_ASSISTED_MSG`).
- Read-model sources for all five phase-one jobs (§2).
- On the Custonllm side: auth, rate limiting, audit, redaction, calibration
  ledger, health/diag endpoints, deploy pipeline.

## 8. Recommended Slice B cut

Contracts and fixtures, both repos, no runtime behavior:

- `schemas/copilot-contract-v1.json` in HyperKernel (request envelope, context
  packet, response envelope, card types, evidence ref, approval requirement) —
  mirrored into Custonllm as Pydantic models generated against the same file.
- Fixture packets: one golden context packet + expected response per
  phase-one job (10 fixtures), checked into both repos.
- Validation tests in both repos proving fixtures round-trip their schemas.
- Decision needed from owner: latency + cost budgets (§6.6), and whether
  Custonllm deploys adjacent to HyperKernel (Netlify function proxy) or is
  called directly from the client with minted tokens.
