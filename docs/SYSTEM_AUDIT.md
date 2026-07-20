# PROJECT ATLAS — Phase 1 System Audit

Produced 2026-07-19 by a six-lens parallel audit (Executive Architecture, Governance & Compliance, Organizational Memory, Internationalization & Multi-Tenancy, Reliability & Security, Scalability & Bottlenecks) over both repos at branch tips `claude/new-session-t5vc39` (aaa-hyperkernel) and `claude/copilot-slice-b` (custonllm). Mission and success criteria: `docs/PROJECT_ATLAS_MISSION.md`.

**Judging bar:** the ATLAS target state — multi-tenant SaaS, multi-country, 99.95% availability, government-grade governance. Gaps are measured against THAT bar, not the current single-tenant, local-first, owner-operated mission, which most components serve honestly today. Every claim in the lens sections cites a file; findings are marked OBSERVED (read/measured) vs INFERRED (deduced).

## Executive summary

The platform is a genuinely advanced single-tenant, local-first AI business application with the deepest governance layer of any system of its size the auditors have seen (gateway ACTIONS with `aiAllowed:false`, decision envelopes, provenance, replay sandbox, an event taxonomy). **It is not yet a multi-tenant SaaS, and the distance is architectural, not cosmetic.** Six critical themes recur across independent lenses; the through-line is that **today's security and tenancy model assumes one trusted owner on trusted devices** — every hard guarantee (AI-block, tenant boundary, audit integrity, data durability) is enforced in the browser client or by convention, not by a server that a hostile tenant cannot bypass.

The good news: the *governance vocabulary* ATLAS needs already exists in code (envelopes, gateway, provenance, taxonomy). The Phase-2 blueprint's central job is to **move those guarantees from the client to a server boundary** and **make tenancy a data-layer invariant rather than a per-module convention** — not to invent governance from scratch.

Audit footprint measured: aaa-hyperkernel ~50.9k JS lines across 346 files / 347 `AAA_*` globals / 345 hand-ordered script tags; custonllm ~12.2k Python lines across 92 files. Graphify graph: 8,390 nodes / 14,853 edges / 691 communities.

## Consolidated critical risk themes (deduplicated across lenses)

| # | Theme | Corroborating lenses | Evidence |
|---|---|---|---|
| C1 | Unauthenticated sync endpoint — all tenants' data in one open global blob | L1,L5,L6 | `netlify/functions (/api/sync); firestore-independent path` |
| C2 | Unauthenticated LLM proxy functions (CORS *) — owner's paid API keys as an open relay | L1,L5 | `netlify/functions/claude.mjs, nemotron.mjs, etc.` |
| C3 | Tenant boundary is client-asserted — workspaceId comes from client config; only Firestore rules enforce server-side | L1,L4,L5 | `js/core/aaa-config.js, tenant-guard.js, firestore.rules` |
| C4 | AI hard-block (aiAllowed:false) is a BROWSER guarantee only — Firestore authorizes on member+role, not origin | L2,L5 | `js/core/aaa-runtime-gateway.js vs firestore.rules` |
| C5 | Institutional memory lives in browser localStorage (~5MB) with best-effort cloud mirror — silent data loss at quota | L3,L5,L6 | `js/core/local-first-storage.js, aaa-cloud.js` |
| C6 | Primary business audit_log is not hash-chained by default — tamper-evidence only when the security module is loaded | L2 | `js/governance/audit-ledger.js, aaa-security.js` |

Beyond these six themes the lenses logged **49 total risk entries** (12 critical instances collapsing into the six themes above, 23 high, 13 medium, 1 low). The high-severity register follows the lens sections.

## High-severity risk register (deduplicated)

| Severity | Lens | Risk | Evidence |
|---|---|---|---|
| critical | L1 | Netlify /api/sync endpoint is unauthenticated with a single global blob: any internet client can read the full jobs/customers dataset (PII) or overwrite it; no tenant concept at all | /home/user/aaa-hyperkernel/netlify/functions/sync.mjs (entire file; route in netlify.toml) |
| critical | L1 | Unauthenticated LLM proxy functions with CORS '*' expose paid Anthropic/NVIDIA keys as an open relay (cost abuse, no caller identity, no tenancy) | /home/user/aaa-hyperkernel/netlify/functions/claude.mjs:18-25 (also nemotron.mjs, vision.mjs, private-gpu.mjs) |
| critical | L1 | Tenant boundary is client-asserted everywhere except Firestore: workspaceId comes from client config (tenant-guard fan-in only 3 files), and custonllm binds no workspace to identity — any authenticated caller may assert any workspace_id | /home/user/aaa-hyperkernel/js/core/tenant-guard.js:25; /workspace/custonllm/agent/api/routers/copilot.py:106-110; /workspace/custonllm/agent/api/auth.py:15-41 |
| critical | L99 | AI hard-block (aiAllowed:false) is enforced only in the browser client; Firestore rules authorize on member+role and cannot distinguish an AI-origin write from a human one, so the entire human-authority firewall has no server backstop against a compromised/replaced client or direct API call. | js/core/aaa-runtime-gateway.js L154-158; firestore.rules L13-21,L171-177 |
| critical | L99 | The primary business-action audit trail (audit_log) is not hash-chained by default — chaining only happens if the optional Security module is loaded and enforcement enabled; otherwise entries are unchained and unsigned, detectable-as-tampered only via Firestore's update/delete block. | js/core/aaa-runtime-gateway.js L216-221; js/core/aaa-security.js L103,L233-242 |
| critical | L99 | Institutional memory persists in browser-local storage with silent best-effort cloud mirroring (try/catch-swallowed upserts); memory is per-device/per-workspace and can silently fail to replicate — incompatible with multi-tenant 99.95% ATLAS bar | js/intelligence/learning-fabric.js:144, js/intelligence/calibration-registry.js:237-240, js/intelligence/vector-memory.js:106, js/intelligence/outcome-intelligence.js:179 |
| critical | L99 | Tenant isolation is per-module convention, not a data-layer guarantee: unified list() is tenant-blind, mine() is copy-pasted in 69 modules, ~40 modules (incl. the governance audit ledger) list collections with no workspace filter, and core PII entities (customers/jobs/leads) are never workspace-stamped — with null-workspaceId records grandfathered into every tenant's view. | js/core/aaa-data.js:31; js/core/tenant-guard.js:49; js/leads/lead-store.js; js/governance/audit-ledger.js:150 |
| critical | L99 | Serverless AI proxy is unauthenticated and tenant-blind: CORS '*', shared ANTHROPIC_API_KEY, no token check, no per-tenant quota — cost isolation and abuse control impossible at SaaS scale. | netlify/functions/claude.mjs:21,48 |
| critical | L99 | /api/sync has no authentication and no tenant isolation — a single global Netlify Blob holds all devices' jobs/customers/mutations and an unauthenticated GET returns it; catastrophic multi-tenant data/PII exposure | netlify/functions/sync.mjs:17-18,60-63,75-77 |
| critical | L99 | All LLM/data proxy functions are unauthenticated (claude.mjs also CORS *) — anyone with the URL drains the owner's Anthropic/OpenAI/NVIDIA budget with no per-tenant metering (cost-exhaustion DoS) | netlify/functions/claude.mjs:20-33; vision.mjs, research.mjs, nemotron.mjs, private-gpu.mjs, receipt-ocr.mjs, transcribe.mjs |
| critical | L99 | Sync backend is one unauthenticated global Netlify blob (key 'state') with read-modify-write merge — tenant data merges and races begin at 2 tenants/2 devices; GET leaks full customer PII state to any caller | netlify/functions/sync.mjs:17-18,60-89; js/core/sync-engine.js:55-87 |
| critical | L99 | localStorage (~5 MB) is the entire database; on quota the store silently degrades to memory-only, losing new jobs, audit entries, and governance records — unbounded collections (audit_log per gateway action, never-pruned mutations queue) guarantee a busy tenant hits it | js/core/local-first-storage.js:36-73; js/core/aaa-runtime-gateway.js:221; js/core/sync-engine.js:92-97 |
| high | L1 | No single event spine: untyped AAA_EVENTS (58 emit sites) bypasses the typed hash-chained AAA_EVENT_BUS, whose delivery itself rides the untyped bus; the canonical 30-event taxonomy is mostly never published and publish failures are silently swallowed | /home/user/aaa-hyperkernel/js/core/aaa-events.js; js/core/aaa-event-bus.js:121; js/core/aaa-event-taxonomy.js; js/genesis/promotion-engine.js:115 |
| high | L1 | Module system is 347 hand-ordered browser globals across 345 script tags with god orchestrators (command-center-ui.js: 779 lines, fan-out 58) and 8 circular file pairs including kernel pair aaa-runtime-gateway <-> aaa-security — blocks code-splitting, team scaling, and multi-tenant client builds | /home/user/aaa-hyperkernel/index.html:30-399; js/ui/command-center-ui.js; measured reference graph |
| high | L1 | Availability/durability floor far below 99.95%: custonllm persists calibration/predictions to a whole-file ledger.json, rate-limits in process memory, and neither repo has replication, failover, or a single system of record across 3 clouds (Netlify, Firebase/GCP, Render) plus Supabase | /workspace/custonllm/agent/ledger/__init__.py:188-201; agent/api/__init__.py:53-56; /home/user/aaa-hyperkernel/js/core/aaa-cloud.js |
| high | L99 | Large ungoverned AI-writable surface: ~79 of 109 store-writing modules bypass the gateway, including Genesis ephemeral-agent facts and the organizational-memory stores (belief-registry, knowledge-fabric, outcome-intelligence, goal-engine, learning-fabric) which write with no gateway ACTION and no ledger append, gated only by a PROTECTED_WRITES denylist. | js/genesis/ephemeral-agent-runtime.js L137-146; js/genesis/agent-template-schema.js L46-50; js/epistemology/belief-registry.js; js/intelligence/outcome-intelligence.js |
| high | L99 | No delegation chains or segregation of duties: flat owner/manager/crew RBAC collapses every approval and the audit signing key to a single owner identity; HMAC key is workspace-local (code states key-holders are trusted by design) with no external anchoring or dual-control. | js/core/aaa-rbac.js L64-79; js/governance/audit-ledger.js L123,L226; js/governance/decision-envelope.js L228-229 |
| high | L99 | No legal-hold / evidence-preservation primitive: retention auto-expires and erasure redacts PII across business records with no mechanism to lock records under litigation hold, contradicting the ATLAS legal-evidence-preservation objective. | js/core/aaa-privacy.js L38,L142-153,L214-237 |
| high | L99 | Learning loops close only via human UI action — prediction-closure.close() has a single caller in a dashboard, and fabric ingest / agent scoring / scorecard recompute have no scheduler or event trigger, so 'every outcome improves future decisions' fails by default | js/ui/learning-feedback-ui.js:45, js/intelligence/prediction-closure.js:104-124, js/governance/agent-scorecards.js:189 |
| high | L99 | Two parallel unreconciled agent decision/outcome registries (agent_decisions vs gov_agent_decisions) with two independent scorecard systems — an agent's track record has two conflicting answers and most agents are instrumented into only one | js/governance/agent-outcomes.js:24, js/agents/pricing-optimizer.js:232, js/governance/agent-scorecards.js:21, js/intelligence/outcome-intelligence.js:24-26, js/governance/governance-bridge.js |
| high | L99 | Total cross-repo learning split: zero integration between HyperKernel's calibration registry (0-100 confidence, ±10 bias) and Custonllm's calibration ledger (Brier/ECE, graded outcome badness) — no shared ledger, schema, or ID space for organizational 'how often are we right' | grep across js/ and netlify/ vs /workspace/custonllm/agent (no references either way); js/intelligence/calibration-registry.js; /workspace/custonllm/agent/ledger/__init__.py:25,313 |
| high | L99 | Memory fragmentation: 45+ separate persisted collections and 6+ overlapping 'what worked' surfaces; 'what happened / what worked / what failed / what next' is not answerable from one place | collection constants across js/intelligence/*.js, js/epistemology/*.js, js/governance/*.js; js/intelligence/outcome-spine.js (read by only js/intelligence/price-book-store.js) |
| high | L99 | The international layer exists but is unwired: country-packs has only 3 consumers while the actual quote pipeline is a hardcoded USD-per-sqft rate card and 17+ UI modules hardcode '$'/en-US formatting; no i18n string catalog exists anywhere (grep AAA_I18N = 0), so EN/ES/FR/PT/DE has no substrate. | js/core/country-packs.js; js/quotes/integrations/measurement-to-quote.js:24-33,150; js/ui/financial-intelligence-ui.js:19; js/portal/portal-app.js:27 |
| high | L99 | Custonllm is structurally single-tenant: one HMAC master secret, tokens carry only name+role (no org/tenant claim anywhere in agent code), single filesystem audit ledger and personas, USD-typed cost contracts — multi-tenancy requires new data model, not configuration. | /workspace/custonllm/agent/api/auth.py:15-32,60; /workspace/custonllm/agent/governance/audit.py:89-92; /workspace/custonllm/agent/api/copilot_contracts.py:76,137 |
| high | L99 | Tenancy identity is client-asserted: workspaceId comes from device-local config with an unpartitioned shared local store, so a workspace switch on one device leaves the prior tenant's customers/jobs/leads readable (grandfathered untagged records pass every mine() filter). | js/core/aaa-config.js:36; js/core/local-first-storage.js; js/core/tenant-guard.js:14-17 |
| high | L99 | Audit-sealing HMAC key and step-up/TOTP secrets are stored client-side in owner-readable Firestore (security_config); the tamper-evident audit chain and approval signatures can be forged by anyone who can read the key — fails a government-grade/legal-evidence bar | js/core/aaa-security.js:24-25,103,233-264; firestore.rules:133-135 |
| high | L99 | Receipt blob store is an unauthenticated IDOR returning raw financial-document PII by guessable key; transport webhook accepts forged Twilio/SendGrid delivery events with no signature verification | netlify/functions/receipt-blob.mjs:24-58; netlify/functions/transport-webhook.mjs:47-68 |
| high | L99 | Custonllm auth tokens cannot be revoked except by rotating the master key (which nukes all users), and auth fails open when API_AUTH_KEY is unset (everyone becomes owner) | agent/api/auth.py:56-76; agent/api/__init__.py:103-104; agent/api/static/admin.html:154 |
| high | L99 | 99.95% availability is unattainable as deployed: Custonllm runs a single free-tier Render instance (cold starts, no HA/failover) and its rate limiter is process-local in-memory, ineffective across instances; no DR/backup/failover for either system | render.yaml:7; agent/api/__init__.py:53,207-215 |
| high | L99 | AES-256-GCM privacy-vault key (vaultKeyHex) is stored beside the ciphertext in client-readable privacy_config, defeating the encrypted-vault protection for the most sensitive PII | js/core/aaa-privacy.js:56-71 |
| high | L99 | No data-residency controls for the required EU/UK/Canada/Australia jurisdictions — Firestore and Netlify Blobs are single global (default-US) stores and sync merges all tenants into one blob; direct GDPR/PIPEDA/Aus Privacy Act residency gap | netlify/functions/sync.mjs:17-18; firestore.rules (no residency partitioning); render.yaml |
| high | L99 | Universal full-scan data plane: 233 data().list() call sites in 130 files, tenant filtering in JS after the scan (121 filter(mine) sites) — every hot path (campaignScorecard 5 scans/call, copilot context packet 4 scans/turn, createLead dedup scan per lead) assumes whole-collection-in-memory, blocking any server-side multi-tenant migration | js/core/aaa-data.js:31; js/revenue/ads-reporting.js:69-146; js/copilot/context-packet.js:126-167,263; js/leads/lead-store.js:129 |
| high | L99 | Audit/governance hash-chain ledgers re-read and sort their entire history on every append, then rewrite the whole collection to localStorage synchronously — O(N^2) lifetime cost on the exact primitive ATLAS calls government-grade | js/core/spatial-event-ledger.js:71,112; js/governance/audit-ledger.js:150-169; js/core/local-first-storage.js:62-73 |
| high | L99 | Custonllm horizontal scaling breaks at replica 2: module-level in-process rate limiter (limits multiply, unbounded per-IP memory), FirestoreEventLedger serves reads from a boot-time in-memory replay so cross-instance idempotency and work-packet state diverge; default backends are non-durable memory stores | /workspace/custonllm/agent/api/__init__.py:53,207-238; /workspace/custonllm/agent/workspace/event_ledger.py:81-115; /workspace/custonllm/agent/ledger/__init__.py:97-152,199 |
| high | L99 | Custonllm full-ledger scans (store.all(), a full Firestore stream in production) sit in per-request paths: every model-routing decision, trust-account computation, GitHub webhook dedup, and calibration report — latency at 10 tenants, cost/timeout at 1000 | /workspace/custonllm/agent/workspace/department.py:116; /workspace/custonllm/agent/api/routers/calibration.py:93,106; /workspace/custonllm/agent/ghfeed/__init__.py:29; /workspace/custonllm/agent/ledger/__init__.py:184-185,352 |

---

## LENS 1 — Executive Architecture Council: System Map, Bounded Contexts, Dependency Structure & Event Topology

Audit basis: direct file reads + mechanical dependency analysis (grep/wc + AST import walk + a global-reference graph script) over `/home/user/aaa-hyperkernel` (branch `claude/new-session-t5vc39`) and `/workspace/custonllm` (branch `claude/copilot-slice-b`), plus the graphify report (`graphify-out/GRAPH_REPORT.md`, built at commit `5e48a27a`, 8,390 nodes / 14,853 edges / 691 communities). Every claim below is marked **OBSERVED** (read/measured) or **INFERRED** (deduced). The bar is the ATLAS target state (multi-tenant SaaS, multi-country, 99.95% availability, government-grade governance) — not the current single-tenant mission, which many of these components serve honestly.

### 1. What actually exists (sizes, OBSERVED)

| Repo | Surface | Measured |
|---|---|---|
| aaa-hyperkernel | Browser PWA | 346 JS files / 50,942 lines under `js/`, all IIFE browser-globals; **347 distinct `AAA_*` globals**; **345 `<script>` tags manually ordered in `index.html`** (lines 30–399); no bundler, no module system |
| aaa-hyperkernel | Netlify functions | 17 `.mjs` functions, 1,397 lines (`netlify/functions/`) |
| aaa-hyperkernel | Firebase functions | second serverless stack (`functions/index.js`, `functions/qbo-proxy`, `functions/portal-proxy`, `functions/nemotron-translate.js`) duplicating the Claude/Nemotron proxy role |
| aaa-hyperkernel | Firestore rules | 187 lines, workspace-scoped membership model (`firestore.rules`) |
| custonllm | FastAPI platform | 92 Python files / 12,210 lines under `agent/` + `agent_platform/`; composition root `agent/api/__init__.py` (568 lines) |

### 2. Bounded contexts that actually exist (named from code)

**aaa-hyperkernel** (`js/` subdirectories, lines/files OBSERVED):

| Context | Dir(s) | Size | Notes |
|---|---|---|---|
| Kernel / platform core | `js/core` (22 files, 3,209 ln) | data, config, RBAC, runtime-gateway, tenant-guard, event buses, sync, country-packs, id-factory, clock | The real kernel; everything depends on it |
| Governance | `js/governance` (14 files, 2,915 ln) | audit-ledger, governance-engine, decision-envelope, prompt-registry, escalation, scorecards | Deepest governance in either repo |
| Intelligence | `js/intelligence` (51 files, 9,125 ln) | outcome-spine, world-model, proposal-engine, replay-sandbox, decision-inbox, calibration, vector memory, owner-copilot, ~24 graphify communities | Largest and most fragmented context |
| Agents | `js/agents` (25 files, 4,593 ln) | estimator, pricing-optimizer, hermes-gateway, planning-desk |
| Copilot seam | `js/copilot` (31 files, 2,742 ln) | contract v1, context-packet, remote adapter — the only cross-repo seam |
| Revenue / Ads | `js/revenue` (25 files, 1,913 ln) + `js/ads` | ads-governance, conversion ledger, council-governance |
| Field ops | `js/measurements`, `js/bluetooth`, `js/field` (~4,050 ln) | BLE capture, seam layout, field mode |
| Business records | `js/quotes`, `js/leads`, `js/accounting`, `js/customers`, `js/crew`, `js/scheduling`, `js/contracts`, `js/legal`, `js/transport` (comms) | thin per-domain stores over `AAA_DATA` |
| Agent lifecycle ("Genesis") | `js/genesis` (18 files, 2,222 ln) | spawn/promote/terminate ephemeral agents |
| Simulation / epistemology / innovation | `js/simulation`, `js/epistemology`, `js/innovation` (~1,780 ln) | counterfactuals, belief registry, experiments |
| UI shell | `js/ui` (64 files, 11,204 ln) | includes the two biggest files in the repo |

**custonllm** (OBSERVED): `agent/api` (3,229 ln — HTTP surface, auth, WAF, rate limit, copilot engine), `agent/core` (3,032 ln — LLM router `llm.py` 621 ln, execution loop 429 ln, "ForgeOS" kernel contracts `agent/core/kernel/contracts.py` 630 ln), `agent/workspace` (1,272 ln — departments), `agent/tools`, `agent/ledger` (calibration/predictions), `agent/council`, `agent/trust`, `agent/reviewer`, `agent/governance` (**162 lines total**), `agent/personas`. **INFERRED identity mismatch**: `docs/kernel_contracts.md` describes ForgeOS as "an Agent Operating System for autonomous software engineering" (RepositoryGraph, ImpactGraph, blast radius) — a coding-agent OS, while HyperKernel is a field-services business OS. The two repos share one contract (copilot v1) but not a domain model; ATLAS treats them as one ecosystem, the code does not yet.

### 3. System map (OBSERVED seams; auth posture per edge)

```mermaid
flowchart LR
  subgraph Browser["HyperKernel PWA (345 script tags, 347 AAA_* globals)"]
    UI[ui/*] --> CORE[core: AAA_DATA / AAA_CONFIG / RBAC / RUNTIME_GATEWAY]
    AG[agents + intelligence + governance] --> CORE
    CP[copilot-remote-adapter] --> CORE
    EV1[AAA_EVENTS untyped bus] --- EV2[AAA_EVENT_BUS typed+hash-chained] --- EV3[AAA_EVENT_TAXONOMY 30 events]
  end
  CORE -->|"AAA_CLOUD resolver: firebase-first"| FS[(Firestore\nworkspaces/{ws}/** rules)]
  CORE -->|"fallback"| SB[(Supabase\naaa-supabase.js)]
  Browser -->|"/api/sync — NO AUTH, one global blob"| NB[(Netlify Blobs\nhyperkernel-sync/state)]
  Browser -->|"/api/claude — NO AUTH, CORS *"| NF[Netlify functions x17]
  Browser -->|"claudeProxy (duplicate stack)"| FF[Firebase functions\nqbo-proxy, portal-proxy]
  NF --> EXT[Anthropic / NVIDIA / Twilio / AI-Q]
  CP -->|"POST /copilot, contract v1, fail-closed"| CL[custonllm FastAPI 'ForgeOS'\nshared-secret API_AUTH_KEY]
  CL --> LJ[(ledger.json\nfile store)]
```

### 4. God modules & dependency structure (measured)

**Fan-in (files referencing the global), aaa-hyperkernel — OBSERVED** via reference-graph script: `js/core/runtime-clock.js` 162, `js/core/aaa-data.js` 161, `js/core/aaa-config.js` 154, `js/core/id-factory.js` 111, `js/core/aaa-rbac.js` 68, `js/core/aaa-cloud.js` 60, `js/ui/ui-kit.js` 55, `js/governance/audit-ledger.js` 30. These are infra hubs and mostly small (aaa-data 194 ln, aaa-config 131 ln) — acceptable fan-in, **except** that `AAA_CONFIG` also carries the tenant boundary (`workspaceId`, see §6), making a 154-file fan-in on a client-mutable tenant selector.

**Fan-out (god orchestrators) — OBSERVED**: `js/ui/command-center-ui.js` (779 ln, references **58** other modules' globals), `js/ui/job-list-ui.js` (742 ln, 25), `js/intelligence/owner-copilot.js` (20), `js/intelligence/ai-operations-center.js` (19). These UI/orchestrator files are the true god modules — they wire half the platform by hand.

**Circular dependencies — OBSERVED**: 8 mutual-reference file pairs in JS, including one inside the kernel: `js/core/aaa-runtime-gateway.js` ↔ `js/core/aaa-security.js` (gateway calls `security().gateCheck/sealAudit`, security gates through the gateway), plus `core/aaa-data.js` ↔ `governance/governance-sync.js`, `genesis/capability-gap-detector.js` ↔ `genesis/genesis-council.js`, `intelligence/goal-engine.js` ↔ `intelligence/resource-allocator.js`, `intelligence/knowledge-fabric.js` ↔ `intelligence/vector-memory.js`, and 3 UI pairs around `job-list-ui.js`. In custonllm, one package-level cycle: `agent.core` ↔ `agent.tools` (AST-verified; the back-edges are deliberate lazy imports at `agent/core/execution.py:270`, `agent/core/tools.py:123-127` — contained, but still a cycle against the "no circular dependencies" mandate). `agent/api/__init__.py` has package fan-out 14 and inlines auth, rate limiting, an IP allow-list "WAF", CORS, and router mounting in one 568-line file (OBSERVED, lines 1–80).

### 5. Event topology: there is NOT one spine (OBSERVED)

Three mechanisms coexist, layered but not unified:

1. **`AAA_EVENTS`** (`js/core/aaa-events.js`, 36 ln) — untyped, synchronous pub/sub. ~58 `emit('…')` call sites across 26 files. No contracts, no log, no tenancy, errors swallowed to console.
2. **`AAA_EVENT_BUS`** (`js/core/aaa-event-bus.js`, 230 ln) — typed contracts, validation, hash-chained append-only `event_log`, optional external transport. ~23 `publish()` call sites across ~16 files. Crucially, **delivery is routed back through the untyped bus** (`events().emit('event.' + type, rec)`, line 121) — so `AAA_EVENTS` is the actual delivery spine, and any module can emit an untyped event that bypasses contracts and the immutable log entirely.
3. **`AAA_EVENT_TAXONOMY`** (`js/core/aaa-event-taxonomy.js`) — 30 canonical business events (`lead.captured` … ) with 5 classification axes. **OBSERVED gap**: what actually gets published are ~18 ad-hoc module events (`genesis.spawned`, `proposal.created`, `hermes.routed`, `simulation.completed`, …) whose contracts are **registered decentrally by each publisher** (e.g. `js/genesis/genesis-council.js:48-53`); the canonical business taxonomy is mostly defined-but-unpublished (only a handful bridged), and its classification axes are consumed by exactly one file (`js/intelligence/outcome-spine.js`). Publish failures are silently swallowed (`.catch(function () {})`, e.g. `js/genesis/promotion-engine.js:115`), so a contract-registration/load-order miss produces no signal.

**Verdict**: two overlapping buses plus a taxonomy that the traffic doesn't flow through. The hash-chained log covers a minority of real events; the majority ride the untyped bus. Custonllm has no event bus at all (audit is per-endpoint logging + `ledger.json`) — **INFERRED**: no cross-repo event spine exists.

### 6. Seams and the tenant boundary (the decisive ATLAS gaps)

- **`/api/sync` (`netlify/functions/sync.mjs`, whole file, route at `netlify.toml` + `config.path`)** — **OBSERVED: no authentication, no tenant scoping, one global blob key** (`STORE_NAME='hyperkernel-sync'`, `STATE_KEY='state'`). Any internet client can `GET` the entire jobs/customers dataset (PII) and `POST` merges that overwrite it. Header comment: "single source of truth is the client." Fatal at any multi-tenant bar; serious even today.
- **`/api/claude` (`netlify/functions/claude.mjs`)** — **OBSERVED: no auth check, `access-control-allow-origin: '*'`** (lines 18–25). An open relay on the Anthropic key (cost abuse); same pattern on `nemotron.mjs`, `vision.mjs`, `private-gpu.mjs`. Only `sense.mjs:35` verifies a shared secret; `research.mjs` holds tokens server-side but doesn't authenticate its caller.
- **Tenant boundary is client-asserted.** `AAA_TENANT_GUARD` (`js/core/tenant-guard.js`) is a well-built deep-scan policy, but the tenant it defends is `AAA_CONFIG.workspaceId || 'default'` (line 25) — chosen by the client — and the guard has **fan-in of only 3 files** (OBSERVED). Firestore rules (`firestore.rules:137-185`) are the one real server-side boundary (membership + role + owner-only financial collections + append-only audit_log — genuinely good), but everything outside Firestore (Netlify Blobs, Netlify/Firebase functions, Supabase path in `aaa-cloud.js`) has no tenant concept. In custonllm, `POST /copilot` checks only that the envelope's `workspace_id` matches the packet's (`agent/api/routers/copilot.py:106-110`) — identity (`agent/api/auth.py`: one shared `API_AUTH_KEY`, 5 roles) carries **no workspace binding**, so any authenticated caller may assert any workspace. **INFERRED**: no end-to-end tenant isolation exists across the ecosystem; it exists only inside Firestore.
- **Copilot seam (the good one)**: `js/copilot/copilot-remote-adapter.js` → custonllm `POST /copilot` is contract-v1, fail-closed, budget-bounded, telemetered on the client; deny-by-default perms, rate-limited, ErrorEnvelope-shaped, no model call, calibration-ledgered on the server (`agent/api/routers/copilot.py`). This is the architectural pattern the rest of the seams should be held to.
- **Duplicated proxy stacks**: Claude/Nemotron/private-GPU proxies exist in both `netlify/functions/*.mjs` and `functions/*` (Firebase) — **OBSERVED** — two deploy targets for the same responsibility, guaranteed drift.
- **Persistence sprawl (OBSERVED)**: local-first storage + Firestore + Supabase (runtime-selected in `js/core/aaa-cloud.js:31-37`, "Firebase first") + Netlify Blobs + custonllm `ledger.json` (`agent/ledger/__init__.py:188-201`, a JSON file rewritten whole). Five stores, three clouds (Netlify, Firebase/GCP, Render per `render.yaml`), no single system of record.

### 7. Scalability & availability limits vs 99.95% (OBSERVED mechanisms, INFERRED ceilings)

- Single-browser, single-workspace runtime: 345 sequential script tags, load-order-coupled globals — horizontal scaling of the client codebase (teams, tenants, code-splitting) is blocked by the module system itself.
- custonllm: file-backed `ledger.json` (no concurrency story beyond tmp-rename), in-process `_RATE` dict rate limiter, in-process session state — **INFERRED**: single-instance only; no replication, no regional failover, no health-based routing anywhere in either repo. 99.95% (≤ ~22 min/month) is not architecturally reachable today.
- "Immutable" chains (event_log, audit sealing) use `cyrb53` — a 14-hex non-cryptographic hash computed **in the client** (`js/core/aaa-event-bus.js:35-48`) — tamper-*evident* against accidents, not against an adversary who recomputes the chain. Government-grade evidence preservation needs server-side, cryptographic anchoring (Firestore's append-only rules are the strongest current piece).

### 8. What is genuinely strong (credit where due, OBSERVED)

`js/core/aaa-runtime-gateway.js` — one deterministic chokepoint, ~30-action policy table with `aiAllowed:false` on every money/customer/config mutation as code constants, every attempt audited (lines 40–128, 144–191). Firestore rules' financial/comms/legal role partitioning. The copilot contract seam. Country packs as data (`js/core/country-packs.js`) is the right i18n shape, though only starter-market packs exist. These are ATLAS foundations, not gaps.

### 9. Tech-debt register (Lens 1 entries)

| ID | Severity | Debt | Evidence |
|---|---|---|---|
| L1-01 | **Critical** | `/api/sync` unauthenticated, tenant-less, single global blob; world-readable/writable business data incl. customer PII | `netlify/functions/sync.mjs` (all), `netlify.toml` |
| L1-02 | **Critical** | Unauthenticated LLM proxies with CORS `*` (open relay on paid keys) | `netlify/functions/claude.mjs:18-25`, `nemotron.mjs`, `vision.mjs`, `private-gpu.mjs` |
| L1-03 | **Critical** | Tenant boundary client-asserted end-to-end; server enforcement only in Firestore; custonllm workspace_id unbound to identity | `js/core/tenant-guard.js:25`, `js/core/aaa-config.js`, `agent/api/routers/copilot.py:106-110`, `agent/api/auth.py:15-41` |
| L1-04 | **High** | No single event spine: untyped `AAA_EVENTS` (58 emits/26 files) bypasses the typed hash-chained bus; canonical 30-event taxonomy mostly unpublished; decentralized contract registration; silent publish failure | `js/core/aaa-events.js`, `aaa-event-bus.js:121,227`, `aaa-event-taxonomy.js`, `js/genesis/genesis-council.js:48-53`, `promotion-engine.js:115` |
| L1-05 | **High** | 347 browser globals / 345 hand-ordered script tags; no modules, no bundling; god orchestrators (`command-center-ui.js`: 779 ln, fan-out 58) | `index.html:30-399`, reference-graph measurement |
| L1-06 | **High** | Availability/durability floor: `ledger.json` file store, in-memory rate limiting, no failover/replication in either repo; 3-cloud sprawl with no system of record | `agent/ledger/__init__.py:188-201`, `agent/api/__init__.py:53-56`, `js/core/aaa-cloud.js`, `render.yaml` |
| L1-07 | **Medium** | Circular deps: 8 JS mutual pairs incl. kernel pair `aaa-runtime-gateway` ↔ `aaa-security`; `agent.core` ↔ `agent.tools` | measured; `agent/core/execution.py:270`, `agent/core/tools.py:123-127` |
| L1-08 | **Medium** | Duplicate serverless stacks (Netlify + Firebase) for the same proxies — config/behavior drift | `netlify/functions/` vs `functions/index.js`, `functions/nemotron-translate.js` |
| L1-09 | **Medium** | Non-cryptographic (`cyrb53`), client-computed audit/event chains presented as immutable evidence | `js/core/aaa-event-bus.js:35-48`, `aaa-runtime-gateway.js:216-223` |
| L1-10 | **Medium** | Governance asymmetry: 2,915 lines + gateway in HyperKernel vs 162 lines in custonllm; two disjoint audit models, no shared provenance schema | `js/governance/`, `agent/governance/`, `agent/ledger/` |
| L1-11 | **Medium** | `js/intelligence` sprawl: 51 files / 9,125 ln / ~24 graph communities of overlapping ledgers-registries-engines; unclear ownership boundaries | dir measurement, `graphify-out/GRAPH_REPORT.md` community list |
| L1-12 | **Low** | Repo/product identity mismatch: custonllm self-describes as ForgeOS (software-engineering agent OS); the business-copilot role is one router grafted onto it | `docs/kernel_contracts.md`, `agent/api/routers/copilot.py` |

### 10. Limits of what was verified

I did not execute either app or its test suites this pass (both stated green by mission brief); did not probe deployed endpoints (auth findings are from code, not live probing — a Netlify edge rule or plugin could in principle add auth in the dashboard, **not visible in-repo**: `netlify.toml` shows none); the JS dependency graph is a global-name reference graph (IIFE code has no imports), so runtime-only couplings via events or DOM are undercounted; graphify's broad query surface was of limited use for whole-system questions, so counts above are from direct measurement. Supabase RLS (`supabase/`) and Firebase functions' internal auth (`functions/qbo-proxy`, `portal-proxy`) were inventoried but not line-audited — flagged for Lens 6.

---

## Lens 2 — Governance & Compliance

Audit of the governance stack against the ATLAS bar (multi-tenant, multi-country, government-grade, 99.95%, human-authority-supreme). Rated against that target state, not the current single-tenant mission. OBSERVED = read in code; INFERRED = deduced.

### What exists and is genuinely strong (OBSERVED)

- **Runtime gateway chokepoint** (`js/core/aaa-runtime-gateway.js`). A table of ~30 `ACTIONS` (L40-128), each with `aiAllowed` and an RBAC `permission`. Hard AI block is a code constant, not a setting (L154-158); every attempt — allowed, denied, error — is audited (L179, L185, L201-225). Money/customer/config/legal/ads mutations are all `aiAllowed:false`. This is the Team-8 rule as code, and it holds for callers that actually route through it.
- **Decision envelopes** (`js/governance/decision-envelope.js`). One schema-locked wrapper composing safety-gate verdict + escalation stakes + country-localized impact + approval requirement + rollback (L112-165). Conservative-by-default: a missing safety gate forces `needs_approval` (L58-61). `approve()` blocks gate-denied envelopes, blocks non-human approvers by regex and self-approval, and requires `OVERRIDE_AI_DECISION` (L220-239); rejection is deliberately ungated (a brake anyone can pull).
- **Audit ledger tamper-evidence** (`js/governance/audit-ledger.js`). The `governance_audit` collection is append-only, deep-frozen (L36-42, L181), and triple-layered: FNV chain (L188-203), synchronous SHA-256 chain (L205-220), and optional HMAC signature (L228-238), all per-writer to survive multi-device merges. Canonical serialization matches the server verifier byte-for-byte (L30-34 vs `netlify/functions/governance-verify.mjs` L20-24). Independent re-verification runs both on-device (`js/governance/governance-integrity.js` `selfAudit`, which escalates a critical breach on failure) and as a scheduled server sweep (`netlify/functions/governance-ledger-audit.mjs`) reading past RLS with the service-role key.
- **Firestore server enforcement** (`firestore.rules`). `governance_audit` and `audit_log` are create-only, owner-read, update/delete `false` (L148-160). A `isSpecialCollection` guard (L105-109) stops the generic wildcard from silently re-granting these. Financial/legal/comms/security collection families are role-gated server-side (L169-184).
- **Replay sandbox** (`js/intelligence/replay-sandbox.js`) with a genuinely pure, IO-free recompute core (`pureReplay`, L49-114) routed through the gateway (`REPLAY_SANDBOX`, human-only) and writing zero business records.
- **Country packs** (`js/core/country-packs.js`) carry US/CA/UK/DE/AU/MX tax, invoice, and currency rules with validation.

### Critical gaps vs ATLAS

**1. The `aiAllowed:false` guarantee is client-side only; the server cannot distinguish AI from human. (critical, OBSERVED)**
The gateway's AI hard-block (`aaa-runtime-gateway.js` L154-158) runs in the browser. Server enforcement is `firestore.rules`, which authorizes on workspace membership + role (`firestore.rules` L13-21, L171-177) and has no concept of `origin:'ai'` — an AI agent and a human use the *same* member credential. Therefore any write an AI could form with member credentials (or any compromised/replaced client, or a direct Firestore/REST call) reaches every non-financial, non-special collection regardless of the ACTIONS table. The entire human-authority firewall depends on the honest client. For a multi-tenant, government-grade deployment this is the single largest governance risk: the strongest-stated invariant in the codebase has no server backstop.

**2. The primary business-action audit trail (`audit_log`) is NOT tamper-evident by default. (critical, OBSERVED)**
Two separate audit systems exist. `governance_audit` (audit-ledger.js) is always hash-chained. But the gateway's own trail — `audit_log`, where every money/customer/config attempt lands — is only chained if the optional Security module is loaded *and* enforcement configured: `_audit` calls `security().sealAudit(rec)` and falls back to the raw record when absent (`aaa-runtime-gateway.js` L216-221; `sealAudit` at `js/core/aaa-security.js` L233-242). With Security off (the default per `enforce:false`, aaa-security.js L103), `audit_log` entries carry no `seq`/`prevHash`/`hash` and no signature. Firestore blocks update/delete, but there is no cryptographic chain to detect a rewrite by anything holding write access at the storage layer (e.g. a compromised service-role key, the same key the sweep uses). The forensic trail the mission most relies on is weaker than the one for governance cases.

**3. Large ungoverned AI-writable surface — organizational memory is written directly. (high, OBSERVED)**
`data().put` appears in 221 sites across 109 files; the gateway (`AAA_RUNTIME_GATEWAY`) is referenced in only 30. The remainder write straight to stores. Sweeping by module family, the ungoverned writers that AI paths populate include: the Genesis ephemeral-agent runtime, which writes agent-produced facts to any collection in `allowedWrites` via a raw `data().put` with only a `genesis.run` ledger note, no gateway ACTION (`js/genesis/ephemeral-agent-runtime.js` L137-146, L167); and the organizational-memory stores — `belief-registry.js` (6 puts), `knowledge-fabric.js`, `outcome-intelligence.js`, `goal-engine.js`, `learning-fabric.js`, `opportunity-registry.js` — each writing with **no gateway and no ledger append**. The only Genesis guard is a `PROTECTED_WRITES` denylist (`js/genesis/agent-template-schema.js` L46-50: payroll, contracts, rate_card, prices, refunds, governance_audit, event_log, etc.). Everything *not* on that list is AI-writable. These stores are advisory today, but they are the substrate future decisions read from; poisoning them (a hallucinating or compromised agent) is an ungoverned integrity path with no envelope, no provenance requirement, and no tamper-evidence. INFERRED: at ATLAS scale (thousands of tenants, autonomous learning) this is the primary vector for silent decision corruption.

**4. Tamper-evidence and approval authority both collapse to a single owner; no delegation chains, no segregation of duties. (high, OBSERVED)**
RBAC is a flat three-role matrix — owner/manager/crew — with `owner: Object.keys(PERMISSIONS)` (`js/core/aaa-rbac.js` L64-79). `OVERRIDE_AI_DECISION` and `MANAGE_GOVERNANCE` are owner-only, so *every* envelope approval, prompt-registry apply, calibration approval, and BYOT-tool release resolves to the one owner identity. There is no delegation, no temporary/scoped grant, no quorum or dual-control for high-risk actions, and no "approver must differ from a prior approver" rule (only the envelope's author≠approver check, decision-envelope.js L225). The audit ledger's HMAC key is workspace-local and, when Security is on, stored in `security_config` inside the same owner-readable workspace (aaa-security.js L103, L164); the code states plainly "a key-holder is trusted within the workspace by design" (audit-ledger.js L226). So tamper-evidence protects against outsiders without the key, not against the owner/key-holder — there is no external notary or write-once anchor. Government-grade governance requires delegation matrices, separation of duties, and independent anchoring; none exist.

**5. No legal hold / evidence-preservation lock. (high, OBSERVED)**
Retention is time-windowed and auto-expiring (`js/core/aaa-privacy.js` L38 `DEFAULT_RETENTION`, L142-153 `retentionStatus`), and `_erase` redacts PII across customers/jobs/quotes/communications/vault (L214-237). There is no mechanism to place a litigation/regulatory hold that *prevents* retention expiry or erasure of records under preservation. ATLAS objective 1 names "legal evidence preservation" explicitly; the current model can be compelled to delete evidence by its own retention/erasure flow. INFERRED: erasure does not touch `audit_log`/`governance_audit` (targets list L219-222 excludes them), which is correct — but the absence of a hold primitive over business records is the gap.

**6. Decision replay is partial, and the provenance it depends on is neither universal nor chained. (medium, OBSERVED)**
`replay-sandbox.js` recomputes only governance-parameter effects — calibration bias on confidence/risk, policy floors/SLAs, council split-threshold (L49-114) — and models booking heuristically. It cannot reconstruct the actual model inference or prompt output (LLM calls are not captured as deterministic inputs), and price delta is 0 by construction (L75). It also requires a recorded provenance trace to anchor on (L37, provenance()), but provenance is only written for select artifacts, and `js/intelligence/provenance-store.js` is append-only *by convention* with **no hash chain** (L41-53, L72-75) — unlike the audit ledger. So "decision replay" and "evidence integrity" are real but incomplete: a full why/what-if reconstruction of an arbitrary past AI decision is not currently possible, and the provenance record itself is not tamper-evident.

**7. Multi-country compliance is descriptive metadata, not enforcement. (medium, OBSERVED)**
`country-packs.js` carries a `compliance` field per country (`privacyRegime` string + `gdpr` boolean — L40, L49, L58, L67, L76, L85). These are labels. There are no per-jurisdiction retention schedules (retention is one global `DEFAULT_RETENTION`), no data-residency routing, no consent capture/management, and no GDPR/CCPA/PIPEDA subject-rights workflow beyond the single generic erasure path. ATLAS objective 3 (US/CA/UK/AU/EU/LatAm privacy laws) needs a regulatory abstraction layer that enforces; today it decorates.

**8. custonllm audit ledger is weaker than the JS side — hashed but not chained or signed. (medium, OBSERVED)**
`/workspace/custonllm/agent/governance/audit.py` hashes each record's input/output (`_hash`, L30-31; `input_hash`/`output_hash` fields L42-46) and appends JSONL, but records are **not linked to each other** — no `prev_hash`, no chain, no signature (grep for prev_hash/chain/link returns nothing). The module docstring itself notes it is "durable-by-append" and swappable, i.e. append-only by file convention only. A governance-roadmap doc exists (`docs/governance-roadmap.md`) indicating this is known/aspirational. For the two-repo ATLAS whole, the Python agent platform's forensic trail does not meet the tamper-evidence bar the JS ledger sets.

### Limits of what I could verify
- OBSERVED findings are from reading source directly (paths/lines cited). I did not execute the test suites or a live tamper scenario; claims about default behavior (e.g. Security module off → unchained `audit_log`) are read from the `enforce:false` default and the `sealAudit` fallback, not from a runtime trace.
- The 221-put / 30-gateway ratio is a mechanical grep sweep; I spot-classified the highest-risk families (genesis, intelligence/epistemology memory) but did not hand-audit all 109 files, so "ungoverned" is confirmed for the cited modules and INFERRED as representative of the long tail.
- I did not audit whether any server-side (Netlify function) path re-checks `origin` — the functions read/verify but I found no function that re-enforces `aiAllowed`, consistent with finding 1.

---

## Lens 3 — Organizational Memory (Learning & Memory Systems Audit)

**Scope.** Inventory of every learning/memory subsystem across `aaa-hyperkernel` and `custonllm`; for each: what it stores, who writes, who reads, and whether outcomes actually flow back. Gaps are rated against the ATLAS bar (multi-tenant SaaS, 99.95% availability, institutional memory that answers "what happened / what worked / what failed / what next" from one place). Method: direct source reading plus caller tracing (grep of writers/readers); claims are marked OBSERVED (read in code) or INFERRED (deduced). Static analysis only — no runtime data volumes were inspected.

### 3.1 Inventory of memory systems (OBSERVED)

| # | System | File(s) | Stores (collection) | Writers | Readers | Outcome loop? |
|---|--------|---------|--------------------|---------|---------|---------------|
| 1 | Knowledge Graph | `js/core/knowledge-graph.js` | none — rebuilt in memory on every call from `customers/jobs/outcomes/review_requests/agent_decisions` (`build()`, L24–75) | n/a (derived) | `js/ui/business-ui.js`, `js/intelligence/intelligence-scorecard.js` | Derived view only; no persistence, no learning state |
| 2 | Learning Fabric | `js/intelligence/learning-fabric.js` | `job_memory` | its own `ingest()` from resolved quotes (L47–66) | `recall`/`recommendFor`/`insights` — read by `js/revenue/win-probability-engine.js`, `js/copilot/copilot-memory-retriever.js`, command-center UI | Yes, but `ingest()` runs only when `refresh()` is invoked (UI-triggered) |
| 3 | Vector Memory | `js/intelligence/vector-memory.js` | `memory_vectors` over `knowledge_nodes` | its own `index()` | `js/intelligence/knowledge-fabric.js`, vector-memory UI | n/a (retrieval). 256-dim deterministic hash embeddings, full-scan cosine (L84–96) |
| 4 | Outcome Spine | `js/intelligence/outcome-spine.js` | `outcome_labels` overlay; reads `outcomes`, quotes, leads, `AAA_AGENT_OUTCOMES` (L193–211) | humans via `label()` (actor required, L279) | `js/intelligence/price-book-store.js` only | Read-time unifier of 4 outcome sources; never writes back |
| 5 | Outcome Learning Store | `js/intelligence/outcome-learning-store.js` | none (pure aggregation over `quotes`) | n/a | Pricing Optimizer, Outcome Intelligence, Company Brain | Read-only analytics |
| 6 | Prediction Ledger + Closure | `js/agents/pricing-optimizer.js` (`createPrediction`, L232) + `js/intelligence/prediction-closure.js` | predictions in `agent_decisions` (kind `pricing_prediction`); closures in `learning_feedback` (append-only) | optimizer writes predictions; `close()` writes closures | `calibration-registry`, `outcome-intelligence`, `reliability-center`, `provenance-builder`, prediction-ledger UI | Yes — but `close()` is called **only** from `js/ui/learning-feedback-ui.js:45` (OBSERVED; no scheduler found) |
| 7 | Calibration Registry | `js/intelligence/calibration-registry.js` | `calibration_proposals`, `calibration_versions` | `propose()` from closure signals; human-gated `approve/reject/rollback` via gateway action `APPLY_CALIBRATION` (L93–144) | `AAA_AGENTS.setTuning` consumers; `rehydrate()` on boot (`index.html:449`) | Yes — the one fully wired human-gated loop (see 3.2) |
| 8 | Agent Outcome Registry (governance) | `js/governance/agent-outcomes.js` | `gov_agent_decisions`, `gov_training_queue` | agents via `AAA_GOVERNANCE_BRIDGE.measure()`; outcomes auto-attached from business events (`governance-bridge.js` `init()`, L77–100) | Agent Scorecards, Outcome Spine | Yes — event-driven attachment is genuinely automatic |
| 9 | Agent Scorecards | `js/governance/agent-scorecards.js` | `gov_agent_scorecards`, `gov_scorecard_history` | `recompute()` (Brier calibration, drift, breach escalation) | governance-supervisor, governance-learning, 2 UIs | Partial — no non-UI caller of `recompute()` found (OBSERVED grep) |
| 10 | Outcome Intelligence | `js/intelligence/outcome-intelligence.js` | `outcome_events`, `agent_scores`, `agent_accuracy`, `learning_patterns` | its own `ingest()/scoreAgents()/extractPatterns()` | outcome-intelligence UI, command center | `refresh()` is UI-triggered only |
| 11 | Belief Registry | `js/epistemology/belief-registry.js` | `epistemic_claims`, `epistemic_claim_events` (append-only; fact/belief/prediction/theory with evidence-gated promotion) | **only** `scientific-discovery-council.js` (L71, L105, L114) — no automated business-event path (OBSERVED: no other `assert()` callers) | `copilot-memory-retriever.js`, `knowledge-compounding-engine.js` | Design is sound; population depends on a manual council flow (INFERRED: sparsely populated in practice) |
| 12 | Knowledge OS / Company Brain / Compounding Engine | `js/intelligence/knowledge-fabric.js`, `company-brain.js`, `js/epistemology/knowledge-compounding-engine.js` | `knowledge_nodes`, snapshots | index/refresh flows | Q&A surfaces, copilot | Deterministic evidence-citing Q&A over other stores |
| 13 | Custonllm Calibration Ledger | `/workspace/custonllm/agent/ledger/__init__.py` | pluggable `MemoryStore`/`FileStore`/`FirestoreStore` (`make_store()`, L188) | `POST /predictions` (`agent/api/routers/calibration.py`), review/council producers, GitHub webhook | `GET /calibration`, `/trust` (`agent/trust/__init__.py:83` trust accounts), council | Yes — reconciliation from downstream reality (see 3.2) |
| 14 | Custonllm Event Ledger | `/workspace/custonllm/agent/workspace/event_ledger.py` | append-only in-memory or JSONL | workspace runtime | audit consumers | Audit trail, not learning |

Additionally OBSERVED: ~40 distinct persisted collection names declared as constants in `js/intelligence/` + `js/epistemology/` alone (e.g. `causal_hypotheses`, `causal_evidence`, `world_signals`, `provenance`, `visual_memory`, `prediction_deltas`, `replay_snapshots`, `reliability_snapshots`…), plus the governance (`gov_*`) and core collections — i.e. **45+ separate memory stores** in the browser data layer.

### 3.2 One real loop traced end-to-end (OBSERVED)

**HyperKernel pricing calibration loop — the strongest loop in the system, and it works:**
1. `pricing-optimizer.js` `analyze()`/`createPrediction()` (L75, L232) writes a prediction (segment, metric, expected direction, baseline, confidence) into `agent_decisions`.
2. Quotes resolve; `quote-store.js:274` emits `outcome.recorded`.
3. `prediction-closure.js` `evaluate()` (L67–97) compares post-prediction resolved quotes to the baseline; `close()` (L104–124) appends validated/contradicted closures to `learning_feedback` — **but only when a human opens the Learning Feedback UI (`js/ui/learning-feedback-ui.js:45`)**.
4. `calibration-registry.js` `propose()` (L51–80) turns closure signals into pending proposals; `approve()` (L88–108) is human-only via runtime-gateway action `APPLY_CALIBRATION`, versioned append-only, with `simulate()` replay and `rollback()`.
5. Approved tuning is installed via `AAA_AGENTS.setTuning` (`_applyTuning`, L206–209) and biases future optimizer output (`registryBias`, `pricing-optimizer.js:315`); tunings survive restart via `rehydrate()` called at boot (`index.html:449`).

**Custonllm loop:** `POST /predictions` → GitHub webhook/`close_stable` reconciliation against downstream reality (revert/hotfix/stable detectors, `agent/reconcile/__init__.py`) → graded outcome badness (`OUTCOME_BADNESS`, `agent/ledger/__init__.py:25`) → Brier/ECE/drift/per-model calibration (`compute_calibration`, L313) → earned-trust accounts (`agent/trust/__init__.py:83`). This loop is automated (webhook-driven), storage-pluggable, and deterministic-tested.

**Governance loop (partially wired):** `governance-bridge.js` auto-attaches business events (won/lost/payment/review/ad-conversion) to pending `gov_agent_decisions` (L77–100) — genuinely event-driven. But only ~3 producers call `measure()`/`recordDecision` (`review-request-engine.js:145`, `measurement-ai-assistant.js:85`, `revenue/ads-governance.js`); most agents write to the *other* registry (`agent_decisions`), and scorecard `recompute()` has no automated trigger.

### 3.3 Gaps vs the ATLAS institutional-memory bar (rated)

**F3.1 — CRITICAL — Institutional memory lives in a browser-local store with best-effort cloud mirroring.** Every learning store persists via `AAA_DATA` (local-first) with cloud upsert wrapped in swallowed `try/catch` fire-and-forget (`learning-fabric.js:144`, `calibration-registry.js:237–240`, `outcome-intelligence.js:179`, `vector-memory.js:106`). OBSERVED. For a single owner device this is fine; for multi-tenant SaaS at 99.95%, organizational memory that can silently fail to replicate — and is per-workspace-per-device — does not meet the bar. Losing a device can lose learning state (INFERRED).

**F3.2 — HIGH — Learning loops close only when a human opens a dashboard.** `prediction-closure.close()` has exactly one caller (`learning-feedback-ui.js:45`); `learning-fabric.ingest()`, `outcome-intelligence.refresh()`, and `agent-scorecards.recompute()` have no scheduler, boot hook, or event trigger (OBSERVED via caller grep; no `setInterval`/cron wiring found). "Every outcome must improve future decisions" currently holds only if the owner regularly visits the right screens. At thousands of tenants this is a dead loop by default.

**F3.3 — HIGH — Two parallel, unreconciled agent-decision/outcome registries.** `agent_decisions` (written by pricing-optimizer, estimator, supervisor, self-improvement, agent-council, +15 more modules) vs `gov_agent_decisions` (governance registry, Brier scorecards, training queue). Two scorecard systems exist over them (`gov_agent_scorecards` vs `agent_scores`) with different math and no cross-reference. OBSERVED. An agent's "track record" therefore has two answers. The Outcome Spine (`outcome-spine.js`) unifies four outcome sources at read time — the right idea — but is read by only one consumer (`price-book-store.js`).

**F3.4 — HIGH — Cross-repo learning split is total.** Zero references between repos' learning systems in either direction (OBSERVED: grep for `custonllm` in hyperkernel `js/`+`netlify/` and `hyperkernel` in custonllm `agent/` both empty). Two incompatible calibration ontologies: HyperKernel uses 0–100 confidence with ±10 bias tunings; Custonllm uses risk-of-badness in [0,1] with Brier/ECE and graded outcome labels. The organization's "how often are we right" has no single ledger, schema, or ID space.

**F3.5 — HIGH — Fragmentation: 45+ collections, no canonical memory, "what worked/failed/next" is not answerable from one place.** At least six overlapping surfaces each partially answer it: Learning Fabric `insights()`, Outcome Learning `aggregate()`, Outcome Intelligence `patterns()`, Knowledge OS `ask()`, Company Brain, and the in-memory Knowledge Graph `insights()`. Company Brain (`company-brain.js`) is the closest to a single evidence-citing answer surface but composes from a subset of stores. OBSERVED inventory; the "no single place" conclusion is OBSERVED structure + INFERRED user experience.

**F3.6 — MEDIUM — Tenant isolation of memory is soft.** Every learning store's `mine()` filter treats `workspaceId == null` as belonging to the current workspace (`learning-fabric.js:31`, `calibration-registry.js:37`, `belief-registry.js:37`, `outcome-intelligence.js:40`). Any legacy/unstamped record is visible to every workspace on the device. Acceptable single-tenant; a data-bleed vector under the ATLAS multi-tenant bar. OBSERVED.

**F3.7 — MEDIUM — Scalability ceilings in the retrieval layer.** Knowledge Graph rebuilds the entire graph from all collections on every `stats()/node()/insights()` call (`knowledge-graph.js:24–75`); Vector Memory does an O(n) full-list cosine scan per query with 256-dim hash embeddings (`vector-memory.js:84–96`, honestly documented as a seam). Both are OBSERVED; both fail at multi-tenant scale (INFERRED).

**F3.8 — MEDIUM — The epistemic ladder (Observation→Belief→Theory) is architecturally excellent but starved.** Belief assertion, evidence updates, and theory promotion occur only through the manual Scientific Discovery Council path (`scientific-discovery-council.js:71,105,114`); no automated path turns validated prediction closures or outcome patterns into beliefs. The copilot reads beliefs/theories (`copilot-memory-retriever.js`) — so the best-designed memory is the least fed. OBSERVED writers; "starved" is INFERRED.

**F3.9 — LOW — Custonllm ledger durability defaults.** `MemoryStore`/JSONL `FileStore` are the v1 defaults with Firestore optional (`agent/ledger/__init__.py:188`, `event_ledger.py`); container-local files are below the 99.95% bar until the pluggable backend is exercised. OBSERVED (design explicitly anticipates this).

### 3.4 What is genuinely strong (credit where due)
- Human-gated calibration with versioning, simulation, rollback, and boot rehydration is real, closed, and governance-compliant (Team 8 rules already enforced in code). OBSERVED.
- Append-only discipline is consistent (`learning_feedback`, `epistemic_claim_events`, calibration versions, custonllm ledger/event ledger).
- Custonllm's outcome ontology (graded badness scored against downstream reality, never merge success) is the most mature calibration thinking in either repo and is the natural schema to unify around in Phase 2.
- Evidence-citing, no-fabrication posture is pervasive (Learning Fabric, Company Brain, Prediction Ledger UI all refuse to overstate thin samples).

### 3.5 Limits of this audit
Static code audit only: I did not run the PWA or the FastAPI service, did not inspect any production/Firestore data, and cannot verify how populated any store actually is (all volume statements are INFERRED). Caller tracing used repo-wide grep; dynamically-registered or eval'd wiring would not be caught. Test suites (4062 assertions / 808 tests) were reported green by the mission brief but were not re-run for this lens.

---

## Lens 4 — Internationalization & Multi-Tenancy

**Scope:** hardcoded business rules (currency, language, tax, phone, date/locale), reach of the country-pack layer, workspace scoping discipline, Firestore tenancy model, and Custonllm's single-tenant assumptions — audited against the ATLAS target (multi-tenant SaaS, multi-country, government-grade governance), not the current single-tenant mission. All claims are OBSERVED (file read/grepped) unless marked INFERRED.

### 4.1 Verdict in one paragraph

Both repos are **single-tenant-per-deployment systems with a well-designed but almost entirely unwired international layer**. HyperKernel's `js/core/country-packs.js` is a genuinely good regulatory abstraction (6 markets, currency/tax/units/invoice-law/privacy-regime as data), but only **3 files in the entire codebase consume it**; the money pipeline that actually produces quotes and renders dollars is hardcoded US/USD/sqft/English throughout. Multi-tenancy is a **client-asserted config value** (`workspaceId` in device-local config) with per-module copy-pasted filters: 82 modules stamp `workspaceId`, 69 duplicate a `mine()` filter, ~40 modules list shared collections with **no workspace filter at all**, and the core PII entities (customers, jobs, leads) are never stamped. Custonllm has **no organization model whatsoever** — one HMAC master secret, five fixed roles, one filesystem ledger. Distance to multi-tenant SaaS: **far** — the tenancy seam must move from "convention in 69 modules" to "enforced in one data layer + server-authoritative identity," and the i18n seam must move from "exists" to "used."

### 4.2 Internationalization inventory

#### Country packs: excellent abstraction, ~zero reach — HIGH

- OBSERVED: `js/core/country-packs.js` defines US/CA/GB/DE/AU/MX packs with currency, tax type (sales_tax/VAT/GST, inclusive/exclusive), units (sqft/sqm), invoice legal fields (sequential numbering, tax-ID requirements, e-invoicing), phone prefix, and privacy regime (CCPA/PIPEDA/UK-GDPR/GDPR/Privacy Act/LFPDPPP). `register()` validates new packs at runtime; unknown codes return honest errors, never a silent US fallback. `formatMoney()` uses `Intl.NumberFormat` correctly (L142–154). This is the right shape for the ATLAS "regulatory abstraction layer."
- OBSERVED (the gap): a repo-wide grep for `AAA_COUNTRY_PACKS` finds exactly **three consumers**: the module itself, `js/agents/global-desk.js` (market-scoped agent dispatch), and `js/governance/decision-envelope.js:87` (`localizeImpact()`). No quote, invoice, accounting, revenue, portal, or UI module reads it. The international layer is loaded in `index.html:34` but is effectively a demonstration, not the money path.

#### Currency: hardcoded `$` + en-US in the entire display and quote layer — HIGH

- OBSERVED: **17+ independently duplicated money formatters**, all hardcoded to `$`/en-US, e.g. `js/ui/financial-intelligence-ui.js:19`, `js/ui/digital-twin-ui.js:34`, `js/ui/decision-card-ui.js:21`, `js/ui/quote-lifecycle-ui.js:17`, `js/ui/estimator-ui.js:21`, `js/ui/command-deck-ui.js:28`, `js/intelligence/company-brain.js:33` (`function usd(...)`), `js/portal/portal-app.js:27` (the **customer-facing** portal). Plus inline `'$' + n` concatenation in `js/ui/business-ui.js:70–76` and `js/accounting/controller-agent.js:118,143,274,283` (agent-generated findings speak dollars).
- OBSERVED: the quote engine `js/quotes/integrations/measurement-to-quote.js:24–33` is a hardcoded **USD-per-sqft rate card** (`install_per_sqft: 0.75` etc.), emitting `'$' + low + '–$' + high` strings (L150, L176). It never calls `convertArea()` or `formatMoney()`. A German or Mexican tenant cannot produce a legal quote today.
- OBSERVED: currency is baked into schemas — `schemas/google-ads-attribution.json` L64 field is literally `conversionValueUSD`.
- OBSERVED: no exchange-rate engine exists anywhere (ATLAS Team 4 calls for "currency engine (rates…)"). Country packs format currency but nothing converts between them.

#### Tax — MEDIUM

- OBSERVED: tax logic lives *only* in country-packs (`tax()`, `extractTax()`, VAT-inclusive handling) — good: no scattered `0.0825` constants were found in a repo sweep. But the quote/invoice pipeline (`js/quotes/quote-store.js`, `measurement-to-quote.js`) never calls it, so quotes today carry **no tax math at all** rather than wrong tax math. `validateInvoice()` (country-packs L204–223) encodes DE/GB/MX invoice law but has no caller in the invoice flow (INFERRED from grep: no consumers outside the 3 files above).

#### Phone: US 10-digit assumptions — MEDIUM

- OBSERVED: `js/leads/lead-store.js:85` `normPhone()` strips non-digits with no country-code awareness (so `+44 20 7946 0958` and a US number can collide or fail dedup).
- OBSERVED: `js/copilot/sms-command-router.js:18` `normalize()` does `d.length > 10 ? d.slice(-10) : d` — an explicit NANP assumption; two international numbers sharing the last 10 digits would be treated as the same sender for **SMS command authorization** (INFERRED consequence; router matching logic not fully traced).
- Country packs carry `phone.prefix` per market, but neither phone consumer reads it (OBSERVED: no `AAA_COUNTRY_PACKS` reference in either file).

#### Language: no i18n layer exists — HIGH

- OBSERVED: grep for `AAA_I18N` returns **zero** hits; there is no string catalog, no translation function, no locale-keyed resources anywhere in `js/`. All ~58 UI modules under `js/ui/` embed English literals directly (sampled: business-ui, decision-inbox-ui, quote-lifecycle-ui, portal-app). Country packs *declare* `language: 'de'|'es'` but nothing renders it. ATLAS Team 4's EN/ES/FR/PT/DE target has no substrate at all — every user-facing string would need extraction first.
- OBSERVED: agent prompts and copilot outputs are English-only; `global-desk.js` injects market language into agent *context* but there is no output-language enforcement or eval (INFERRED from reading global-desk header + copilot-contract grep showing no language field).

#### Date/time locale — LOW/MEDIUM

- OBSERVED: 11 modules call `toLocaleDateString()`/`toLocaleTimeString()` (browser-default locale — inconsistent rather than wrong), while several money formatters pin `'en-US'` explicitly (e.g. `visual-evidence-ui.js:22`, `digital-twin-ui.js:34`, `company-brain.js:33`). `js/copilot/copilot-contract.js:37` correctly mandates ISO-8601 UTC instants for machine timestamps — the contract layer is locale-clean; the render layer is not.

#### Custonllm i18n — MEDIUM

- OBSERVED: cost governance is USD-denominated in the contract itself — `agent/api/copilot_contracts.py:76` (`maxCostUSDPerConversation`), `:137` (`costUSD`). All personas/prompts/errors are English (INFERRED from sampling; no locale parameter appears in the API surface).

### 4.3 Multi-tenancy inventory

#### The tenancy model, as built

- OBSERVED: `workspaceId` is read from **device-local config** — `js/core/aaa-config.js:36` `get workspaceId() { return read('workspaceId', null) }` — i.e., the client asserts its own tenant. `js/core/tenant-guard.js:25` defaults to `'default'`.
- OBSERVED: cloud persistence is workspace-pathed: `js/core/aaa-firebase.js:9,79` puts documents at `workspaces/{workspaceId}/{collection}/{clientId}`; the Supabase mirror stamps `workspace_id` on every row (`js/core/aaa-data.js:140–178`).
- OBSERVED: `firestore.rules` (L10–21, L137–185) enforces membership server-side: only users with a `workspaces/{ws}/members/{uid}` doc touch that workspace; financial collections owner-only; audit ledgers append-only, owner-read, no update/delete. **This is the strongest tenancy asset in the system** — a real per-workspace authorization model with role gates enforced where a tampered client can't bypass them.
- INFERRED (limit): Supabase RLS policies could not be verified from this repo (client uses anon key + `workspace_id` columns, `js/core/aaa-supabase.js`); whether the Postgres side enforces workspace isolation is unverified here.

#### Where the discipline breaks — CRITICAL for the ATLAS bar

1. **Scoping is per-module convention, not a data-layer guarantee.** OBSERVED: `js/core/aaa-data.js:31` — `async list(collection) { return store().getAll(collection); }` — the unified data layer is tenant-blind. The identical filter `function mine(r) { return r && (r.workspaceId == null || r.workspaceId === ws()); }` is **copy-pasted into 69 modules** (e.g. `js/quotes/quote-store.js:58`, `js/legal/legal-store.js:46`, `js/revenue/ads-governance.js:62`). One forgotten filter = silent cross-tenant read, and there is no lint/test enforcing the pattern.
2. **~40 modules list shared collections with no workspace filter at all.** OBSERVED via sweep (files calling `data().list(` with zero `workspaceId` mentions): includes `js/governance/audit-ledger.js:150` (the audit chain itself lists unscoped), `js/governance/agent-scorecards.js`, `js/governance/prompt-registry.js`, `js/agents/supervisor.js`, `js/legal/legal-risk-engine.js`, `js/ui/business-ui.js`, and 11 revenue engines. Today this is harmless (one tenant per browser store); at the ATLAS bar it means the governance and intelligence layers have **no tenant boundary of their own**.
3. **Core PII entities are never stamped.** OBSERVED: `js/leads/lead-store.js` and the customers/jobs paths through `aaa-data.put()` contain zero `workspaceId` handling — only newer modules (e.g. `js/measurements/field-capture-session.js:40`) stamp records. Combined with the `mine()` grandfather clause (`workspaceId == null` always passes, `tenant-guard.js:49`), **switching `workspaceId` on a shared device leaves every prior tenant's customers, jobs, and leads visible** — `js/core/local-first-storage.js` has no per-workspace partitioning (zero `workspaceId` references).
4. **Serverless functions are tenant-blind and unauthenticated.** OBSERVED: `netlify/functions/claude.mjs` sets `access-control-allow-origin: '*'` (L21) and forwards to Anthropic with the server key (L48) with **no auth token check, no tenant identity, no per-tenant quota** — one shared API key, burnable by any caller who finds the URL. Only `sense.mjs` mentions workspace at all. At SaaS scale this is both a cost-isolation and noisy-neighbor failure.
5. **RBAC is a fixed 3-role, client-side model.** OBSERVED: `js/core/aaa-rbac.js:26` (`owner/manager/crew`), role is device/session state and `role()` **defaults to `'owner'`** (L84–88). Firestore rules re-enforce roles server-side (good), but the ATLAS role-matrix/delegation-chain target (Team 2) has no substrate: no custom roles, no org hierarchy, no per-tenant role administration (member docs are console-managed only, `firestore.rules:143`).
6. **`tenant-guard.js` is sound but advisory.** OBSERVED: it refuses foreign-workspace records and deep-scans mission contexts (L69–74) — the right idea — but it is a library callers must remember to invoke; nothing forces it into the read path.

#### Custonllm: structurally single-tenant — HIGH

- OBSERVED: `agent/api/auth.py` — one master secret (`API_AUTH_KEY`), stateless HMAC tokens carrying only `{name, role, expiry}` (L60); five hardcoded roles (L15). **No tenant/org/workspace claim exists in the token or anywhere in the agent code** (repo-wide grep for `tenant|org_id|organization` outside tests: zero hits in `agent/`). Revocation is expiry-or-rotate-everything (L5–6) — no per-user, let alone per-tenant, revocation.
- OBSERVED: the audit sink is a single filesystem JSONL (`agent/governance/audit.py:89–92`, `.data/audit/tool_calls.jsonl`); personas and ledger are filesystem directories (`agent/personas/`, `agent/ledger/`). INFERRED: serving two businesses means two deployments — there is no data-model path to co-tenancy.
- Consequence for ATLAS: the "thousands of businesses" target requires adding an org model, per-org key scoping, per-org ledgers/personas/cost caps, and org-aware governance to Custonllm essentially from scratch.

### 4.4 Distance to multi-tenant SaaS — honest rating

**Rating: FAR (est. the largest single gap in the ATLAS program, alongside availability).** What exists is a *disciplined single-tenant system with tenant-tagging habits*: correct Firestore per-workspace rules, workspace-pathed cloud docs, a real (if advisory) tenant guard, and a real (if unwired) country layer. What multi-tenant SaaS at 99.95%/multi-country requires and does not exist: (1) server-authoritative tenant identity (today the client asserts `workspaceId` from local config); (2) tenancy enforced **once** in the data layer instead of 69 copy-pasted filters with ~40 known gaps and unstamped core entities; (3) partitioned or workspace-keyed local storage; (4) authenticated, tenant-quota'd serverless functions; (5) any org model at all in Custonllm; (6) an i18n string layer and country-pack wiring into the actual quote/invoice/display pipeline; (7) currency conversion. Items 1–4 are architectural (Phase 2 blueprint work), not patches.

### 4.5 Findings register (this lens)

| # | Finding | Severity | Evidence |
|---|---|---|---|
| L4-1 | Tenant isolation is convention: unscoped data layer (`list()`), 69 copy-pasted `mine()` filters, ~40 unfiltered listing modules incl. audit-ledger, core entities (customers/jobs/leads) never stamped, null-workspaceId grandfathering | **Critical** (vs. ATLAS bar) | js/core/aaa-data.js:31; js/core/tenant-guard.js:14–17,49; js/leads/lead-store.js; js/governance/audit-ledger.js:150 |
| L4-2 | Serverless AI proxy unauthenticated + tenant-blind (CORS `*`, shared key, no quota) | **Critical** | netlify/functions/claude.mjs:21,48 |
| L4-3 | Country-pack layer has only 3 consumers; quote/invoice/display pipeline hardcoded USD/sqft/`$`/en-US (17+ duplicated formatters, USD rate card, `conversionValueUSD` schema field) | **High** | js/core/country-packs.js; js/quotes/integrations/measurement-to-quote.js:24–33,150; js/ui/*-ui.js money(); schemas/google-ads-attribution.json:64 |
| L4-4 | No i18n/string-catalog layer exists; ~58 UI modules embed English literals; packs declare languages nothing renders | **High** | grep AAA_I18N = 0; js/ui/ |
| L4-5 | Custonllm has no org/tenant model: single master secret, role-only tokens, filesystem ledger/personas, USD-typed cost contracts | **High** | agent/api/auth.py:15–32,60; agent/governance/audit.py:89–92; agent/api/copilot_contracts.py:76,137 |
| L4-6 | Client-asserted tenancy: `workspaceId` from device-local config; shared unpartitioned local store across workspace switches | **High** | js/core/aaa-config.js:36; js/core/local-first-storage.js |
| L4-7 | US phone assumptions: digit-strip normalization, `slice(-10)` in SMS command auth | **Medium** | js/leads/lead-store.js:85; js/copilot/sms-command-router.js:18 |
| L4-8 | RBAC fixed at 3 roles, client-side default `'owner'`; no role matrices/delegation substrate | **Medium** | js/core/aaa-rbac.js:26,84–88 |
| L4-9 | Tax/invoice-law logic exists in packs but is uncalled by the quote/invoice flow (quotes carry no tax math) | **Medium** | js/core/country-packs.js:160–223; js/quotes/quote-store.js |
| L4-10 | Mixed date/time locale handling (browser-default vs pinned en-US); contract layer itself is clean ISO-8601 | **Low** | js/ui/job-list-ui.js; js/copilot/copilot-contract.js:37 |

### 4.6 Assets to build on (credit where due)

- `firestore.rules` is a real, server-enforced per-workspace membership + role model with append-only audit collections — the correct kernel of a tenancy story (OBSERVED, L137–185).
- `js/core/country-packs.js` + `js/agents/global-desk.js` + `decision-envelope.localizeImpact()` form a correct, honest-by-construction i18n seam; the Phase 2 work is *wiring*, not *invention*.
- 82 modules already stamp `workspaceId` at write; the newer the module, the better the discipline (e.g. `js/measurements/field-capture-session.js:40`) — the codebase is trending the right way.

### 4.7 Limits of what was verified

- Supabase RLS policies live server-side and could not be audited from this repo — Supabase workspace isolation is **unverified**.
- Firestore rules were read, not emulator-tested; rule behavior under `list` queries vs `get` was not exercised.
- Language claims are based on sampling large UI modules and a repo-wide catalog search, not an exhaustive string census.
- Custonllm conclusions are from `agent/api`, `agent/governance`, and repo-wide greps; `agent_platform/` was not exhaustively read.
- No runtime testing of workspace-switch data-bleed was performed; that failure mode is deduced from the storage/filter code (marked INFERRED above).

---

## Lens 5 — Reliability & Security

**Scope audited:** HyperKernel Netlify functions (`netlify/functions/*.mjs`), service worker (`sw.js`), local-first sync (`js/core/sync-engine.js`), Firestore rules (`firestore.rules`), the security/privacy/tenant modules (`js/core/aaa-security.js`, `aaa-privacy.js`, `tenant-guard.js`), `package.json`; Custonllm auth spine and rate limiter (`agent/api/__init__.py`, `agent/api/auth.py`), deploy config (`render.yaml`, `Procfile`, `DEPLOY.md`, `SECURITY.md`), ledger store backends.

**Bottom line vs the ATLAS bar (multi-tenant SaaS, multi-country, 99.95% availability, government-grade governance, zero-trust):** The single-tenant client-side security model is genuinely thoughtful — Firestore rules enforce workspace-membership and owner-only financial isolation well, and `aaa-security.js` implements a real WebCrypto hash-chained audit and step-up MFA. But the **server perimeter is effectively unauthenticated**, secrets and audit-signing keys live client-side, the sync/blob layer has **no tenant isolation at all**, and neither system has the redundancy, secret-rotation, token-revocation, or data-residency controls the target state requires. Against 99.95% and zero-trust, the posture is **early-stage**.

### Reliability

**Single points of failure / availability.** Custonllm ships to Render on `plan: free` (`render.yaml:7`) — one instance that spins down on idle, cold-starts on wake, with no horizontal replicas, no load balancer, and no documented failover. That alone makes 99.95% (~4.4 h downtime/yr) unreachable. There is no disaster-recovery runbook, backup/restore procedure, or regional-failover design for either the Netlify Blobs store or Firestore. **(OBSERVED config; INFERRED availability ceiling.)**

**Rate limiter does not survive scale-out.** The Custonllm limiter is a process-local dict `_RATE` (`agent/api/__init__.py:53`, enforced `:207-215`). It resets on every cold start/redeploy and, the moment more than one instance runs, the effective per-IP limit multiplies by instance count. It is a cost-abuse speed bump, not a control — and it is structurally incompatible with the HA the availability target demands (no shared/Redis backing).

**Sync conflict handling is last-write-wins with no causality.** `sync.mjs` merges entity snapshots by overwriting stored entries by id (`mergeMaps`, `:32-38`, "incoming overwrite stored") — no vector clocks, no per-field merge, no tombstones for deletes. Two devices editing the same job silently clobber each other. Mutations dedup by `mutationId` but the store keeps only the most recent `MAX_MUTATIONS = 2000` (`:19,:49`), silently dropping the oldest — at multi-tenant scale that is unbounded audit/mutation loss. The client engine (`sync-engine.js`) marks everything `SYNCED` on any 2xx and mirrors best-effort to Supabase, so a partial server merge still reports success.

**Service-worker update discipline.** `sw.js` calls `skipWaiting()` + `clients.claim()` immediately (`:377,:387`), so a fresh worker can take control of a live tab whose ~330 already-parsed IIFE module globals are the *old* version — mid-session version skew with no reload prompt. The atomic `cache.addAll(PRECACHE)` is wrapped in `.catch(() => {})` (`:379`), so a single 404 among the 330 precached files yields a silently empty/partial cache with no signal. The only cache-bust is a hand-bumped `CACHE_NAME = 'hyperkernel-v110'` (`:9`); there is no content hashing or SRI on any script.

**Unpinned production dependencies.** `package.json:15-18` pins `@anthropic-ai/sdk: "latest"` and `@netlify/blobs: "latest"`. Builds are non-reproducible and a broken or compromised upstream publish reaches production on the next deploy with no review — a direct contradiction of the Team 6 "supply-chain verification" objective. (Custonllm, by contrast, pins floors with `>=` in `pyproject.toml` — better, though still unpinned ceilings.)

### Security

**The Netlify function perimeter is unauthenticated.** None of the LLM/data proxies verify a caller identity: `claude.mjs` (`:28-33`, plus `access-control-allow-origin: *` at `:20-24`), `vision.mjs`, `research.mjs`, `nemotron.mjs`, `private-gpu.mjs`, `receipt-ocr.mjs`, `transcribe.mjs` all read only `process.env` provider keys and dispatch. Anyone who knows the URL can spend the owner's Anthropic/OpenAI/NVIDIA budget without limit — a cost-exhaustion DoS with no per-tenant metering. **(OBSERVED.)**

**`/api/sync` has no auth and no tenant isolation whatsoever.** `sync.mjs` writes every device's jobs/customers/mutations into a *single global* Netlify Blob (`STORE_NAME = 'hyperkernel-sync'`, `STATE_KEY = 'state'`, `:17-18`); the GET path returns that blob to any unauthenticated caller (`:60-63`). There is no `workspaceId` anywhere in the function. In a multi-tenant deployment this merges all tenants into one document and serves it to anyone — a catastrophic tenant-isolation and PII-exposure failure. The client-side `tenant-guard.js` (pure, browser-only, `:43-75`) cannot compensate: it is advisory and bypassed by a tampered client, and the server layer it would need to back it does not enforce workspaces at all. **(OBSERVED.)**

**Receipt store is an IDOR / PII exposure.** `receipt-blob.mjs` GET `?key=` returns the raw receipt image/PDF (financial PII) with no auth; the header comment concedes "Auth/isolation is layered by the caller + site access controls" (`:12-15`) — none exists in the function. Keys are caller-supplied and namespaced per receipt id, so they are enumerable/guessable.

**Webhooks are not authenticated.** `transport-webhook.mjs` accepts Twilio and SendGrid delivery/bounce callbacks with **no signature verification** (no `X-Twilio-Signature`, no SendGrid Ed25519 check; `:47-68`) and persists them to the feed the client drains and applies as delivery truth. Anyone can forge status events. (By contrast `sense.mjs:32-35` at least supports an optional shared secret, and Custonllm's GitHub webhook fails **closed** on an unset HMAC secret — the correct pattern that transport-webhook lacks.)

**Audit-sealing and vault keys live client-side.** `aaa-security.js` generates and stores the HMAC `signingKey`, `pinHash/pinSalt`, and `totpSecret` in the `security_config` Firestore doc (`:103`), which is owner-readable — and the owner is a browser client. The module's own header admits: "in a multi-tenant deployment these belong server-side entirely" (`:24-25`). The consequence is decisive for government-grade governance: the "tamper-evident" hash chain (`sealAudit`/`verifyAuditChain`, `:233-264`) is both computed and verifiable with a key the client holds, so a party who can read `security_config` can forge or re-seal the chain and its approval signatures. The same defect applies to the AES-256-GCM "encrypted vault" — `aaa-privacy.js:66-71` stores `vaultKeyHex` in the client-readable `privacy_config` doc, next to the ciphertext. Encryption-at-rest is real; key custody is not. This does not meet a legal-evidence / court-admissibility bar.

**Audit entries are client-created with no server recomputation.** Firestore rules make `audit_log` and `governance_audit` append-only and owner-read (`firestore.rules:148-160`) — good — but any member can `create` arbitrary entries, and nothing server-side recomputes the hash chain. Integrity depends entirely on the browser voluntarily sealing correctly with a key it also holds.

**Custonllm auth has no revocation.** `auth.py` mints stateless HMAC tokens (`mint_token/verify_token`, `:56-76`) revocable *only* by expiry or rotating the master `API_AUTH_KEY` — which invalidates **every** user at once (confirmed in `admin.html:154`). There is no denylist, so a leaked estimator/crew token is valid for its full TTL and a single-user offboarding is impossible without a global rotation. Additionally, auth **fails open**: if `API_AUTH_KEY` is unset, `_resolve_identity` returns `Identity(role="owner")` for everyone (`__init__.py:103-104`) — a deploy misconfiguration yields full owner access to the business copilot and tools. (Trusted-proxy IP resolution at `:171-204` is, in contrast, carefully done and fails safe.)

**Data residency / PII sovereignty is absent.** The mission requires EU/UK/Canada/Australia operation under GDPR/UK-GDPR/PIPEDA/Australian Privacy Act. Netlify Blobs and Firestore are configured as single global stores with no regional partitioning, and `sync.mjs` merges all tenants into one (default-US) blob. There is no data-residency control, per-country partitioning, or residency policy anywhere in the configs I read. At the target bar this is a direct residency-compliance gap. **(INFERRED from store configs; not empirically located a residency control to disprove.)**

### What a red team would try first
1. Unauthenticated `GET /api/sync` → full customer/job/mutation dump across all tenants.
2. Enumerate `GET /api/receipt-blob?key=…` → financial-document PII.
3. Spray `POST /api/claude` (and the other proxies) → drain the LLM budget; no auth, no metering.
4. Forge Twilio/SendGrid POSTs to `/api/transport-webhook` → corrupt delivery truth.
5. Read `security_config` / `privacy_config` as any owner-role client → extract the audit-signing and vault keys, then forge or re-seal the "immutable" audit chain.

### Limits of what I could verify
I read source and configuration; I did **not** run either app, exercise a live Netlify deploy, or test Firestore rules against the emulator. The tenant-isolation and unauthenticated-perimeter findings are OBSERVED in code. Availability ceilings and data-residency gaps are INFERRED from deploy/store configuration — a residency control could exist outside the files I examined, though I found none. Test suites are reported green (4062 assertions / 808 pytest) but the harness is zero-dependency and does not exercise the deployed serverless perimeter, which is where the critical gaps concentrate.

---

## Lens 6 — Bottlenecks & Scalability Limits

Scope: load-bearing full scans, storage ceilings, sync fan-out, process-local state vs horizontal scaling, and dev-loop cost — measured against the ATLAS bar (multi-tenant SaaS, multi-country, 99.95% availability), not the current single-tenant mission. All claims OBSERVED (file read) unless marked INFERRED.

### 6.1 The universal full-scan data plane (HyperKernel) — HIGH

The entire HyperKernel data layer is one pattern: `data().list(collection)` → `store().getAll(collection)` → `Object.values(inMemoryMap)`, then filter in JS.

- OBSERVED: `js/core/aaa-data.js:31` — `async list(collection) { return store().getAll(collection); }`. There is no query, index, cursor, or limit anywhere in the data API.
- QUANTIFIED (grep, OBSERVED): **233 `data().list(` call sites across 130 files** (of 346 JS files, ~50.9k LOC, 26 domain directories); **407 `.list(` sites** including store-level wrappers that delegate to the same full scan.
- QUANTIFIED (OBSERVED): **121 occurrences of `.filter(mine)` in 67 files** — tenant/workspace scoping is applied *in JavaScript after the full scan*, e.g. `js/core/aaa-runtime-gateway.js:231` (`(await data().list('audit_log')).filter(e => e.workspaceId == null || e.workspaceId === ws)`). Note the `workspaceId == null ||` pass-through: unscoped records are visible to every workspace — an isolation *and* a scale smell.
- Hottest listed collections by call-site count (OBSERVED): `agent_decisions` (18), `outcomes` (15), `quotes` (8), `jobs`/`agent_logs` (5 each), `audit_log` (4), plus ~30 more collections listed at least once and dozens referenced via constants (`COLLECTION`, `EVENTS`, `SNAPSHOTS`, …).

This is tolerable at hundreds of records per collection in one browser. It is the single largest structural obstacle to the ATLAS target: any move of this data server-side inherits 233 call sites that assume the whole collection fits in memory and arrives in one call.

### 6.2 Unbounded collections × hot paths that re-scan them — HIGH

Collections that grow without bound per tenant (no pruning/compaction code found; grep for prune/retention found only the PII-retention *reporting* in `js/core/aaa-privacy.js`, which reports expired records but nothing auto-deletes hot-path collections):

`leads`, `quotes`, `outcomes`, `jobs`, `customers`, `agent_decisions`, `agent_logs`, `audit_log` (one record per *every* gateway action attempt, allowed or denied — `js/core/aaa-runtime-gateway.js:221`), `ads_conversion_events` (`js/revenue/ads-conversion-ledger.js:36`), `ads_conversion_exports`, spatial events (`js/core/spatial-event-ledger.js`), governance ledger records (`js/governance/audit-ledger.js`), and the local `mutations` queue (see 6.4).

Hot paths that re-scan them per call (all OBSERVED):

| Hot path | Scans per invocation |
|---|---|
| `campaignScorecard` (`js/revenue/ads-reporting.js:69–146`) | 5 full scans: `attr.list()`, `conv.list()` **twice** (lines 89, 100), `leadsOS().listLeads()`, `quotes().list()` |
| `ownerBrief` (`ads-reporting.js:177–191`) | scorecard's 5 scans + `diagnostics()` → `missingAttribution()` which full-scans leads then does **one sequential `await attrLedger.get()` per paid lead** (`js/leads/lead-store.js:164–176`) |
| `createLead` dedup (`lead-store.js:129`) | full scan of `leads` on **every lead creation** — O(N²) cumulative intake cost |
| `followUpQueue` (`js/quotes/quote-store.js:71–75`) | full scan of `quotes` per call |
| Copilot context packet `attention_today` (`js/copilot/context-packet.js:126–167`) | `followUpQueue()` (quotes scan) + `listLeads()` (leads scan) + `envelopes.list()` + `listJobs()` — four full scans per assembled packet, i.e. per copilot question |
| Context packet customer lookup (`context-packet.js:263`) | full scan of `customers` via `listCustomers().filter(id===…)` for a **point lookup** that `data().get()` already supports |
| `estimate_risk` comparables (`context-packet.js:213`) | full scan of `outcomes` per quote analyzed |
| Gateway `recentAudit` (`aaa-runtime-gateway.js:231`) | full scan of `audit_log` to return 10 rows — and `agentActivityItems` calls it inside every `agent_activity` packet |

INFERRED: since every copilot chat turn assembles a packet, one conversation of 10 turns performs ~40 full collection scans of the business's entire history.

### 6.3 Ledger appends are O(N): hash chains re-read their whole history — HIGH

Government-grade auditability is a stated ATLAS objective, and the audit primitives will not survive audit-scale write volume:

- OBSERVED `js/core/spatial-event-ledger.js:71,112` — every append calls `chain()` = full scan **plus sort** of the entire collection to find the previous hash. O(N) per append, O(N²) lifetime.
- OBSERVED `js/governance/audit-ledger.js:150–151,169` — same pattern: append reads and sorts the full ledger to compute `prevHash`.
- Compounding: every `put()` rewrites the **entire collection** to localStorage (`js/core/local-first-storage.js:62–73` — `_flush` does `JSON.stringify(this.data[collection])` per write, synchronously, on the UI thread). So audit append cost = O(N) scan + O(N) serialize, per governed action, forever.

### 6.4 localStorage is the entire database — CRITICAL

- OBSERVED `js/core/local-first-storage.js`: the backbone store is **localStorage only**. IndexedDB appears solely in a comment as "a future implementation" (line 10). Browsers cap localStorage at ~5–10 MB per origin.
- OBSERVED lines 69–72: on quota exceedance, `_flush` catches, logs `console.warn`, and **silently degrades to memory-only** — "Writes never throw". At quota, a tenant's new jobs, audit entries, and governance records silently stop persisting and are lost on reload. For a system whose audit chain is a compliance claim, this is silent evidence loss.
- OBSERVED lines 36–59: `boot()` parses every collection into memory at startup — boot time and heap grow linearly with tenant history.
- OBSERVED: the `mutations` sync queue is marked `SYNCED` but **never pruned** — `js/core/sync-engine.js:92–97` maps statuses in place; `setMutations` has no other caller that truncates (grep confirmed). The queue grows until it alone exhausts quota.
- INFERRED sizing: at ~0.5 KB/record, ~10k total records (jobs + audit_log + decisions + events) reaches the 5 MB ceiling — a single active service business plausibly hits this within months; the gateway's write-per-action audit log gets there fastest.

### 6.5 Sync fan-out: full snapshots into one global blob — CRITICAL

- OBSERVED `js/core/sync-engine.js:55–64,83–87`: every sync POSTs the **complete** `jobs` + `customers` snapshot plus pending mutations; a 60-second poll (line 34–38) triggers whenever anything is pending. Payload grows linearly with business size, per device, per minute.
- OBSERVED `netlify/functions/sync.mjs:17–18,60–89`: the server stores everything under **one blob key** (`STORE_NAME='hyperkernel-sync'`, `STATE_KEY='state'`) with **no auth and no tenant/workspace dimension** — GET returns the full state (customer PII included) to any caller; POST does read-modify-write with no concurrency control (last-writer-wins between devices) and rewrites the whole blob. Server-side cap `MAX_MUTATIONS=2000` silently drops history beyond that.
- OBSERVED `js/core/aaa-data.js:117–136`: `mirrorToCloud()` (invoked after every successful sync, `sync-engine.js:101–103`) re-uploads **every customer, job, and estimate one network call each** for non-Supabase backends — O(total records) network calls per sync cycle.

Scaling verdict: this design breaks at **2** tenants (their data merges into the same blob), not 10. It also races with itself at 2 devices of one tenant.

### 6.6 Custonllm: process-local state vs horizontal scaling — HIGH

The 99.95% availability target implies ≥2 replicas behind a load balancer. Several load-bearing components are single-process by construction:

- OBSERVED `agent/api/__init__.py:53,207–215`: rate limiter is a module-level `_RATE: dict[str, list[float]]`. Per replica: effective limit multiplies by instance count; per process: keys are **never evicted** (unbounded memory growth per unique client IP); `list.pop(0)` is O(n) per request.
- OBSERVED `agent/api/__init__.py:232–238`: `ledger`, `reviewer`, `reconciler` are module-level singletons built at import.
- OBSERVED `agent/ledger/__init__.py:97–152`: `MemoryStore` is the **default** (`make_store`, line 199 — `"memory"` unless env overrides); `FileStore` rewrites the whole JSON ledger on every mutation under a `threading.Lock` and serves reads from an in-process dict — two replicas sharing (or not sharing) the file diverge silently.
- OBSERVED `agent/workspace/event_ledger.py:81–104`: `FirestoreEventLedger` — the *production* driver — streams the **entire** `work_events` collection into memory at construction and serves all reads (`all()`, `seen()`, `for_packet()`) from that in-process cache; appends write through. With 2 replicas, replica A never sees replica B's events: idempotency (`seen()`) and packet state are **wrong across instances**, and cold-start time grows linearly with total event history (an availability tax on autoscale/redeploy).
- INFERRED: no tenancy dimension exists in either store — collection names are fixed (`calibration_predictions`, `work_events`), records carry agent/packet ids but no tenant id — so multi-tenant means either shared ledgers (isolation failure) or a collection-per-tenant refactor.

### 6.7 Custonllm: full-ledger scans in request paths — HIGH

`store.all()` — a full collection stream on the Firestore driver (`agent/ledger/__init__.py:184–185`) — sits in hot paths:

- OBSERVED `agent/workspace/department.py:116`: `select_model(self.calib_ledger.store.all(), …)` — **every model-routing decision scans the entire calibration ledger**.
- OBSERVED `agent/api/routers/calibration.py:93,106` and `agent/council/__init__.py:134`: trust accounts recomputed from `store.all()` per request / per council session.
- OBSERVED `agent/ghfeed/__init__.py:29`: webhook dedup is `any(p.commit_sha == sha … for p in ledger.store.all())` — O(N) per GitHub event.
- OBSERVED `agent/reconcile/__init__.py:52,66,138` and `agent/ledger/__init__.py:352` (`report()` → `compute_calibration(self.store.all())`).

At 10 tenants this is latency; at 1000 tenants with years of predictions it is seconds of Firestore streaming and real read cost **per routed request**.

### 6.8 Test-suite runtime as a dev bottleneck — LOW

- OBSERVED (executed): `node test/run.js` = **26.4 s wall** for 4062 assertions/198 suites (child-process per suite, `test/run.js`); `python -m pytest` = **7.5 s** for 831 tests. Neither is a bottleneck today. Risk is trend-only: the JS harness is serial and process-per-suite; at ATLAS scope (multi-country packs, more domains) suite count growth is linear in wall time. No action needed in Phase 2 beyond parallelizing the runner when it crosses ~2 min.

### 6.9 Where the limits bite: 10 tenants vs 1000

| Limit | Bites at | Why |
|---|---|---|
| Single global sync blob, no auth (`netlify/functions/sync.mjs`) | **2 tenants** (and 2 devices) | all tenants merge into one state; last-writer-wins |
| localStorage ~5 MB + silent quota degradation | **1 busy tenant, months** | audit_log write-per-action + unpruned mutation queue |
| O(N) hash-chain appends (`spatial-event-ledger.js`, `audit-ledger.js`) | 1 tenant, ~10k events | UI-thread scan+sort+full-serialize per governed action |
| Full-scan data plane (233 sites) | blocks the server-side move itself | every feature assumes whole-collection-in-memory |
| Custonllm in-process rate limiter / caches | **first moment replicas ≥ 2** | limits multiply, idempotency and packet state diverge |
| `store.all()` in routing/webhook paths | ~10 tenants (latency), 1000 (cost/timeout) | full Firestore stream per decision |
| `FirestoreEventLedger` full replay at boot | 100s of tenants | cold-start grows with total history → autoscale lag vs 99.95% |
| Per-record `mirrorToCloud` fan-out | ~10 tenants | O(records) network calls per device per sync cycle |

### Limits of what was verified

- Call-site counts are grep-based over `js/` and `netlify/` (patterns `data().list(`, `.list('…')`, `.filter(mine)`); constant-named collections mean per-collection counts are a floor, not exact.
- No load/volume testing was performed; record-size and quota-timeline estimates in 6.4 are INFERRED from code shape, not measured.
- Firestore rules, Netlify Blobs quotas, and Supabase-side indexing were not exercised; conclusions about the cloud mirrors are from client code only.
- Custonllm was audited at the composition root, ledger, workspace, council, ghfeed, and reconcile layers; `agent_platform/` and `training/` were not read under this lens.

---

## What Phase 2 (ATLAS_TARGET_ARCHITECTURE.md) must resolve

Ranked from the themes above:

1. **A server-side trust boundary.** Move AI-block, tenant scoping, and action authorization behind an authenticated server (or Firestore rules + authenticated functions) so no browser client — hostile or buggy — can assert its own workspace, bypass `aiAllowed:false`, or reach another tenant's data. This single change closes C1–C4.
2. **Tenancy as a data-layer invariant.** `AAA_DATA` reads/writes must carry and enforce `workspaceId` at the store, not per-module `mine()` convention; the unified `list()` must be tenant-scoped by construction.
3. **Durable system-of-record.** Promote the cloud store from best-effort mirror to source of truth with local-first as cache; end silent localStorage-quota data loss (C5).
4. **Audit integrity by default.** Hash-chain `audit_log` unconditionally, not only when the security module loads (C6); wire decision replay + legal retention onto that chain.
5. **One event spine + a module system.** Collapse `AAA_EVENTS` into the typed, hash-chained `AAA_EVENT_BUS`; replace 345 hand-ordered script tags with a real dependency graph; break the kernel gateway↔security cycle.
6. **Regulatory abstraction + i18n seam.** Externalize currency/tax/phone/date/language and the compliance packs (GDPR/CCPA/PIPEDA/AU/UK) so no business rule is hardcoded — prerequisite for multi-country.
7. **Horizontal-scale the hot paths.** Replace full-collection `data().list()` scans on per-tenant-growing collections (leads, quotes, events, audit_log, ads_conversion_events) with indexed/paginated queries before they bite at ~10–100 tenants.

These are the Phase-2 inputs; none require weakening any existing human-authority guarantee — they move each guarantee to a boundary a tenant cannot cross.
