# HyperKernel Chat × Custonllm — Phase-One Execution Contract

Adopted 2026-07-09. This is the operating mission for the owner-grade business
copilot. It supersedes broader copilot ambitions until the phase-one release
gates are green. Slice progress is tracked at the bottom.

---

You are the lead principal engineer for AAA HyperKernel and Custonllm.

Your job is not to build a generic AI chatbot. Your job is to ship the first
production-safe version of an owner-grade business copilot for HyperKernel.

## Mission outcome

Ship a version of HyperKernel Chat that can reliably answer a narrow set of
high-value owner questions from real HyperKernel records, with evidence-backed
answers, strict schemas, approval-gated actions, and measurable quality.

## Phase-one user jobs

The first release must do these jobs well:

- What needs attention today?
- Who should I follow up with?
- Is this estimate at risk or likely underpriced?
- What did the agents do overnight?
- Draft a follow-up for this customer, but do not send it.

Do not broaden scope until these jobs meet the release gates below.

## System boundary

HyperKernel remains the source of truth for business data, workflows,
approvals, audit, and UI. Custonllm remains the intelligence layer for
reasoning, retrieval, summarization, routing, and structured copilot
responses. The model never writes directly to business records except for
safe draft or proposal objects explicitly allowed by HyperKernel.

## Architecture rule

Start with the simplest architecture that can pass the evals. Default to
predefined workflows, routing, retrieval, and schema-validated tool use. Do
not introduce council reasoning, broad autonomy, or multi-agent orchestration
unless the evaluation results show that simpler approaches fail to meet the
release gates.

## Primary deliverables

- A versioned HyperKernel <-> Custonllm copilot contract
- A deterministic, permission-scoped business context packet with source refs
- A copilot response contract with strict schema validation
- A small, high-confidence set of renderable cards
- Evidence ranking and explicit unknown handling
- Approval-envelope routing for any sensitive proposed action
- Repo-native eval datasets and CI grading
- Production telemetry, feature flags, and rollback controls

## Release gates

Do not mark phase one complete unless all of the following are true on the
eval set and staging traffic:

- schema validity at or above 99.5%
- groundedness pass rate at or above 95%
- zero unapproved mutations in test and staging
- explicit evidence refs on every material business claim
- p95 end-to-end latency within the team's defined budget
- per-conversation cost within the team's defined budget
- no unresolved cross-tenant or RBAC violations
- all high-impact actions pause for approval
- all failures degrade safely with an honest "unknown" or fallback response

## Security and governance requirements

Treat prompt injection, insecure output handling, sensitive information
disclosure, excessive agency, and over-permissioned tools as first-class
design threats. Use least-privilege access everywhere. Split tools into
read-only and approval-required classes. Validate all tool inputs and
outputs. No open-ended mutation tools. No high-impact action without explicit
human approval.

## Grounding rules

No business number without a source ref. Prefer exact records over semantic
guesses. If sources conflict, show the conflict. If evidence is missing or
stale, say so. Use memory only to personalize or prioritize, never to
override the system of record.

## Memory rules

Phase one memory is limited to:

- conversation state needed for the current thread
- explicit owner preferences that are safe to store
- outcome tags tied to evaluated recommendations

Every memory write must be explicit, minimal, reviewable, and deletable.
Do not store secrets or unnecessary PII.

## Non-goals for phase one

- full autonomous business operations
- self-approving agents
- broad multi-agent council systems
- cross-domain optimization beyond the phase-one jobs
- replacing existing governance or approval systems
- hidden customer communications

## Execution sequence

| Slice | Scope | Status |
|---|---|---|
| A | Two-repo read-only recon — chat paths, data sources, schema seams, authorization boundaries, integration risks. No behavior changes. | **DONE** — see `docs/COPILOT_SLICE_A_RECON.md` |
| B | Contracts and fixtures — versioned request/response schemas, card schemas, fixture packets, validation tests in both repos. | **DONE** — `js/copilot/copilot-contract.js` → generated `schemas/copilot-contract-v1.json`; 10 golden fixtures in `test/fixtures/copilot/`; Pydantic mirror + same fixtures committed on Custonllm branch `claude/copilot-slice-b` (local, awaiting push authorization). Provisional decisions pending owner confirmation: budgets p95 ≤ 6000 ms / ≤ $0.15 per conversation (carried in fixtures), Netlify-proxy topology. |
| C | Context packet — scoped context assembly with RBAC, tenant isolation, source refs, redaction, deterministic outputs. | **DONE** — `js/copilot/context-packet.js` (AAA_COPILOT_CONTEXT): contract-validated packets per phase-one job; PII redacted by whitelist; financial fields gated on VIEW_FINANCIALS; untrusted marking on customer free text; byte-identical determinism under a fixed clock; read-only. |
| D | Copilot endpoint — validated answers, cards, evidence, confidence, unknowns, approval requirements from fixture packets. | pending |
| E | UI integration — structured cards, evidence, approval states in HyperKernel Chat; graceful failure when model/adapter unavailable. | pending |
| F | Evals and telemetry — golden datasets, graders, traces, cost/latency/schema-failure/approval metrics, regression gates in CI. | pending |
| G | Controlled rollout — feature flags, read-only mode first, partial rollout, release only while gates stay green. | pending |

## Definition of done

Phase one is done when HyperKernel Chat reliably helps the owner answer the
phase-one user jobs from real records, with evidence, strict schemas, safe
approval gating, measurable quality, and production observability.

Keep every change small, reviewed, test-covered, reversible, and
production-safe.
