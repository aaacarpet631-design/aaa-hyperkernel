# OPERATION LEVIATHAN — Phase 0: Model Infrastructure Inventory

Grounded recon of the model infrastructure that exists **today** across both
repos, mapped against the LEVIATHAN mission (Universal Open-Model Intelligence
Fabric). No behavior changed. Every claim cites a file. Mission spec is the
user's OMNIMODEL brief; this is its Phase 0 deliverable ("Map existing
providers, local models, current router, hardware, eval suites, model
policies, costs").

Branch tips audited: `claude/new-session-t5vc39` (aaa-hyperkernel),
`claude/copilot-slice-b` (custonllm).

## Headline

**LEVIATHAN is mostly a formalization-and-unification job, not a greenfield
build.** Six of the fabric's ten core objectives already exist in primitive,
working form — a governed gateway, a provider-neutral registry, pluggable
adapters, fail-closed tenant policy, per-call provenance, a deterministic
golden-eval harness, and (in Custonllm) an outcome-driven UCB model router.
What is genuinely absent is the *openness/license/supply-chain* spine, the
*lifecycle state machine*, *automated discovery*, *deployment tiers*, and —
critically — the fact that the two repos each run a **separate** model router
with **no shared registry or ID space**. The catalog is also small and
NVIDIA-centric, which directly violates the mission's "no laboratory
indispensable" rule.

## 1. HyperKernel model layer (governance owner)

| Component | File | What it does today | LEVIATHAN mapping |
|---|---|---|---|
| Governed Model Router | `js/ai/model-router.js` | The ONE canonical path (`AAA_GOVERNED_MODEL_ROUTER.call`): registry resolve → `RUN_MODEL` gateway gate (audited, crew/AI-over denied) → model must be a governed ACTIVE artifact AND owner-enabled → adapter runs (server proxy, never a client key) → provenance + usage record → advisory-only envelope. | **This IS the Universal Model Gateway** (§2 of the mission) — narrow but real. No app/agent calls a provider directly. |
| Model Registry | `js/ai/model-registry.js` | Provider-neutral METADATA catalog. Holds family/variant/allowedTasks/riskTier/exposure + documented candidate ids per runtime (`huggingface`/`nim`), all `verified:false` until owner confirms at activation. | Precursor to the **Universal Model Registry** (§4). Missing: openness class, licenseId/hash, weightHashes, signatureStatus, lifecycle state, most capability + economics fields. |
| Provider adapters | `js/ai/providers/` (nvidia-nemotron-adapter, private-gpu-adapter + transports) | `registerAdapter(a)` / `a.supports(modelKey)` / `a.invoke(...)`. Server-proxy transports only. | Precursor to **Provider/Runtime Adapters** (§6). Two runtimes today (NIM, OpenAI-compatible private GPU); mission wants ~12. |
| Tenant Model Policy | `js/ai/tenant-model-policy.js` | Per-workspace FAIL-CLOSED allowlist + data-residency + restricted-market check, consulted before dispatch; denials are audited. Owner-only (`MANAGE_GOVERNANCE`). | Directly serves **routing filter steps 1–4** (§10) and tenant governance (§2). |
| Model-call provenance | `js/ai/model-call-provenance.js` | Per-call provenance graph + `model_calls` usage record (checksum, latency, tokens). | Precursor to **Provenance Requirements** (§12). Missing weightRevision/weightHash/quantization/hardwareProfile/runtimeVersion. |
| Content safety | `js/ai/content-safety.js` | Output safety screen. | Part of **Gate 5/6** (governance + adversarial). |
| Golden eval harness | `js/intelligence/eval-golden-store.js` | Deterministic graders (numeric_mape, safety_label, json_schema, contains, exact) — NO LLM judge, no network; `score()`/`run()` batch → aggregate. | Precursor to the **Evaluation Foundry** (§8), specifically Gate 4 (AAA capability) with reproducible graders. |
| Calibration registry | `js/intelligence/calibration-registry.js` | Per-agent confidence calibration (0–100, ±bias). | Feeds **capability graph** confidence + outcome routing. |
| Model governance UI | `js/ui/model-governance-ui.js`, `native-model-ui.js` | Owner activates/enables/revokes governed model artifacts (human-only, audited). | The **production-promotion / revocation** control surface (§2, §17). |

**Catalog contents (OBSERVED):** only `nvidia.nemotron4_340b_{base,instruct,reward}` and `privategpu.local`. Provider-neutral in *design*, NVIDIA-only in *content*.

## 2. Custonllm model layer (model-intelligence owner)

| Component | File | What it does today | LEVIATHAN mapping |
|---|---|---|---|
| Multi-provider abstraction | `agent/core/llm.py` | `Provider` enum: OpenAI, Anthropic, Ollama, vLLM, OpenRouter, NVIDIA, Nous. Normalizes messages/tools/structured-output/streaming; strips `<think>`. | **Provider/Runtime Adapters** (§6) — the richer of the two repos' adapter layers (7 providers incl. local vLLM + Ollama). |
| Frontier catalog | `agent/core/llm.py:99` `FRONTIER_MODELS` | claude-opus/sonnet, hermes-4-405b/70b (+ Nous), hermes-3-405b, nemotron-super-49b, nemotron-3-ultra, diffusiongemma-26b, minimax-m3, + optional local vLLM fine-tune. | The de-facto model catalog — **12 families across 5 labs**, but a bare `key → (provider, model_id)` map with no license/openness/integrity data. |
| Capability registry | `agent/core/model_registry.py` | Capability table built FROM `FRONTIER_MODELS` (drift-guarded: a key can't exist in one and not the other) + live health. | Precursor to the **Capability Graph** (§9) — but static/hand-typed, not evaluation-derived. |
| Outcome/RL router | `agent/trust/policy.py:109` `select_model` | UCB bandit over `FRONTIER_MODELS`: picks the arm whose *measured* ledger outcomes maximize reward for the context, explores untried arms first. | **This IS a champion-challenger / outcome-based router** (§13) in embryonic form — arms are model ids, reward attributes to the model actually used. |
| Calibration ledger | `agent/ledger/` | Predictions → outcomes → Brier/ECE calibration. | **Continuous model competition** substrate (§13) + provenance outcomes (§12). |
| Copilot contract v1 | `agent/api/copilot_contracts.py` + HyperKernel mirror | Grounding-by-construction, evidence integrity, error envelope, eval gates in CI. | Template for **Gate 5 (governance) evals** and output validation (§8). |

## 3. Server-side transports (Netlify functions)

`netlify/functions/`: `claude.mjs`, `nemotron.mjs`, `private-gpu.mjs`,
`vision.mjs`, `transcribe.mjs`, `research.mjs` — the provider transports the
HyperKernel adapters proxy through (keys server-side). **Known issue from the
ATLAS audit (`docs/SYSTEM_AUDIT.md` C2):** these are unauthenticated with CORS
`*` — a LEVIATHAN prerequisite is to put them behind the authenticated
gateway, since the fabric multiplies the number of provider endpoints.

## 4. What exists vs the 10 core objectives

| # | Objective | Status | Evidence / gap |
|---|---|---|---|
| 1 | Discover new models automatically | **ABSENT** | No discovery watchers; catalog is hand-edited (`FRONTIER_MODELS`, `MODELS{}`). |
| 2 | Verify source/license/integrity | **ABSENT** | No license engine, no weight hashes, no signature check anywhere. Highest-value gap. |
| 3 | Canonical capability description | **PARTIAL** | `model_registry.py` capability table exists but is static/hand-typed, not evaluation-derived; HyperKernel registry has almost no capability fields. |
| 4 | Common inference interface | **PARTIAL** | Two adapter layers (JS `supports/invoke`; Python `Provider`) — real but **unfused across repos**. |
| 5 | AAA-specific evaluation | **PARTIAL** | `eval-golden-store.js` deterministic graders + copilot eval gates exist; no unified golden set spanning the mission's Gate-4 task list. |
| 6 | Quarantine unsafe models | **PARTIAL** | `verified:false` + owner activation + tenant fail-closed policy gate models, but there's no QUARANTINE lifecycle state or integrity gate. |
| 7 | Route to best qualified model | **PARTIAL** | HyperKernel routes by governance+policy; Custonllm routes by UCB outcomes — **two routers, not one**, and neither combines capability+cost+latency+policy as §10 specifies. |
| 8 | Replace failing/deprecated models | **PARTIAL** | UCB explores/exploits; owner can revoke. No automatic rollback-on-threshold-breach, no DEPRECATED lifecycle. |
| 9 | Record model per decision | **PRESENT** | `model-call-provenance.js` + calibration ledger. Missing weight-revision granularity (§12). |
| 10 | Improve routing from outcomes | **PARTIAL** | Custonllm UCB does this; HyperKernel does not feed outcomes back into routing. |

## 5. Distance to the fabric (honest)

- **Openness/license/integrity spine (§3, §4, §8 Gate 1): 0% — the biggest gap.** No `opennessClass` (O1–O5), no `licenseId`/`licenseTextHash`, no `weightHashes`/`signatureStatus`. Nothing today can answer "is this model legally usable and is it the artifact the lab published?" This is the mission's non-negotiable and must be Phase 1.
- **Lifecycle state machine (§4): absent.** Governance today is binary (governed-active + owner-enabled vs not); the mission's DISCOVERED→…→PRODUCTION_APPROVED + RESTRICTED/DEPRECATED/REVOKED/REJECTED states don't exist.
- **Cross-repo router split: the structural issue.** HyperKernel (`AAA_GOVERNED_MODEL_ROUTER`) and Custonllm (`select_model` UCB) are **separate routers with no shared registry, ID space, or outcome ledger.** The mission's ownership split (HyperKernel governance / Custonllm model intelligence) is the right target — but today they're two disconnected systems, not two halves of one gateway. Unifying the seam is the central architectural task.
- **Deployment tiers (§7): absent as a concept.** Device/local/private-cloud/hosted/managed lanes aren't modeled; there's `exposure` (internal/advisory/customerFacing) and a private-GPU adapter, but no tier taxonomy or hardware-fit routing.
- **Catalog breadth + neutrality: violates the final directive.** HyperKernel catalog is NVIDIA-only; Custonllm's 12 families lean NVIDIA/Anthropic/Nous. The mission's initial catalog (OpenAI, Meta, Google DeepMind, Mistral, DeepSeek, Qwen, NVIDIA, IBM, AI2, Cohere, Moonshot, MiniMax, xAI) with explicit per-release openness/license is not represented.

## 6. Strengths to build ON (do not rebuild)

1. The **governed gateway pattern** (`AAA_GOVERNED_MODEL_ROUTER`) — advisory-only, RUN_MODEL-gated, provenance-writing — is exactly the §2 "one controlled gateway" and already enforces "no direct application-to-model calls."
2. **Fail-closed tenant policy** (`tenant-model-policy.js`) already implements routing filter steps 1–4 with audited denials.
3. The **UCB outcome router** (`agent/trust/policy.py`) is a working champion-challenger core — extend it with governed promotion + shadow traffic rather than inventing §13 fresh.
4. **Deterministic golden graders** (`eval-golden-store.js`) — the right foundation for the Evaluation Foundry (no LLM-judge dependency).
5. The **copilot contract v1** discipline (grounding, evidence integrity, error envelope, CI mutant gates) is the template for Gate-5 governance evals and output validation.
6. **Human authority is already code-constant** (gateway `aiAllowed:false`, owner-only activation/revocation) — the mission's §17 revocation and §2 governance ownership have a real substrate.

## 7. Recommended Phase 1 cut (Universal Registry)

Smallest slice that turns the two catalogs into one governed, license-aware,
integrity-verified registry — the mission's own Phase 1:

1. **`opennessClass` + license engine** — add O1–O5, `licenseId`,
   `licenseTextHash`, `commercialUseAllowed`, `redistributionAllowed`,
   `fineTuningAllowed`, jurisdiction/revenue restrictions to a single canonical
   model record shape, backfilled for the existing `FRONTIER_MODELS` families.
2. **Integrity fields** — `weightHashes[]`, `signatureStatus`,
   `artifactRevision`, `modelCardLocation` (verification wiring is Phase 2's
   Foundry Gate 1; the *fields and the "unverified until proven" default* land
   now).
3. **Lifecycle state** — the DISCOVERED→…→PRODUCTION_APPROVED enum + terminal
   states as a governed, owner-transitioned field (reuse the decision-envelope +
   audit-ledger machinery — do not invent a new approval path).
4. **One registry record, two consumers** — define the canonical record once
   (JSON schema in `schemas/`, mirrored to Pydantic exactly like the copilot
   contract), so HyperKernel governance and Custonllm intelligence read/write
   the SAME model identity and ID space. This is the unification lever.
5. **Neutrality: seed the catalog** with the mission's initial families, each
   carrying explicit openness/license — and add a test that fails if any single
   provider exceeds a configured share of PRODUCTION_APPROVED task classes (the
   "no lab indispensable" rule as an executable guard).

None of this sends a request to a new model or downloads a weight — Phase 1 is
registry + license + identity only, exactly as the mission sequences it.

## Cross-reference

- ATLAS `docs/SYSTEM_AUDIT.md` C2 (unauthenticated proxies) and C4
  (browser-only AI block) are **prerequisites**: the fabric multiplies provider
  endpoints and model-origin surface, so the server-trust-boundary work from
  ATLAS Phase 2 and LEVIATHAN Phase 1 should be sequenced together.
- Human-authority rules (§18) are already ATLAS Team-8 code constants; LEVIATHAN
  extends, never weakens them.
