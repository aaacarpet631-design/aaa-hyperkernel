# HYPERMIND — Repository Audit, Dependency Graph & Gap Analysis (Phase 0)

**Date:** 2026-06-07 · **Branch:** `claude/brev-cli-setup-Lrbxf` · **Scope:** full repo
audit before any HyperMind code is written (per the mission's Rule "audit first").

> **Method.** Five parallel deep-dive audits over `js/`, `functions/`, `netlify/`,
> `supabase/`, `schemas/`, and `index.html`: (1) agent/deliberation, (2)
> learning/outcome/calibration, (3) model router/providers/governance, (4)
> memory/graph/events/sync, (5) digital-twin/command-center/UI. Each classified
> every module **REAL vs STUB** and **WIRED vs DISCONNECTED**, with file/line refs.

---

## 0. Headline

**The "continuously learning autonomous business intelligence system" the mission
describes is ~85% already built, real, and wired.** This is not a greenfield
build. Nearly every named subsystem maps to a concrete, functioning module:

| Mission phase | Already exists? | Where | Status |
|---|---|---|---|
| **P1** Observe→…→Learn loop | Primitives yes, **driver no** | `aaa-event-bus`, `intelligence-pipeline`, `intelligence-collectors`, `learning-fabric` | **No autonomous heartbeat** |
| **P2** Shared memory graph | **Yes, but dormant** | `core/knowledge-graph.js`, `intelligence/knowledge-fabric.js` | **Built, DISCONNECTED** |
| **P3** Model cluster + router | Yes | `ai/model-router.js` (governed), `agents/model-router.js` (Claude tiers), `model-registry`, providers | **Static routing; no cost/latency optimization** |
| **P4** Executive council | Pipeline yes; **persistent C-suite no** | `debate-engine`, `agent-council`, `executive-council`, `supervisor`, `challenge-protocol`, `escalation-policy` | **Real & wired; roles are stateless** |
| **P5** Outcome reinforcement | Yes, **gated** | `supervisor`, `self-improvement`, `calibration-registry`, `native-model`, `prediction-closure` | **Loop OPEN at human approval (by design)** |
| **P6** Digital twin | Yes | `intelligence/business-digital-twin.js`, `replay-sandbox.js` | **Real; 2 levers missing** |
| **P7** Command center | Yes | `ai-operations-center`, `reliability-center`, `owner-copilot` + 47 UI modules | **Real, live, no mock dashboards** |

**Therefore the real mission is four targeted deltas, not a rebuild:**
1. **Give the brain a heartbeat** — an autonomous loop driver (P1).
2. **Connect the memory graph that already exists** — wire `AAA_GRAPH`/`AAA_KNOWLEDGE` (P2).
3. **Widen the senses** — ingest the missing event sources + add entity tables (P1/P2).
4. **Decide how much the loop may act without the human gate** — the central governance decision (P5).

Plus smaller deltas: P3 cost/latency routing, P4 persistent council memory, P6 two
missing levers.

---

## 1. The central tension (must be resolved before P1/P5 code)

This codebase is **deliberately "honest by construction" and owner-gated**, enforced
in *code*, not config:

- `aaa-runtime-gateway.js:142` — **AI-origin calls are hard-blocked** on human-only
  actions (`aiAllowed:false`), with **no config override**. `MANAGE_MODEL_SETTINGS`,
  pricing application, estimate finalize, calibration apply are all human-only.
- `calibration-registry.js` — outcome signals → proposals → **[human generates]** →
  **[human approves via audited gateway]** → tuning installs. Two human keys.
- `model-router.js` — every external model call is **advisory-only**; "the owner is
  the authority layer." Fallbacks are neutral, never fabricated.
- `governance-registry.js` — every artifact version is append-only, checksum-chained,
  and **cannot go ACTIVE without human approval**.

The mission's **P5 says: "No manual intervention. Learning must be automatic."**
That directly conflicts with the above. **This is the architecture decision of the
whole project** and it is the user's to make (see §7). Everything in P1/P5 depends
on the answer. The recommended resolution is a **bounded autonomy** model (auto-act
inside owner-set guardrails; escalate beyond them) — detailed in §7.

---

## 2. Dependency graph (the 10 named components)

```
                          EXTERNAL EVENT SOURCES
   SMS/email in ─┐  job created/closed ─┐  estimates ─┐   won/lost outcomes ─┐
 (transport-core)│  (UI flows)          │ (HUDs)      │  (closure-hud)       │
   ❌ calls/leads/refunds/invoices/ad-clicks: NO INGESTION                   │
                 ▼                       ▼             ▼                      ▼
        ┌───────────────────────────────────────────────────────────────────────┐
        │  EVENT BUS   AAA_EVENTS (sync pub/sub)  +  AAA_EVENT_BUS (typed,        │
        │              hash-chained immutable log, 6 contracts)   [REAL, WIRED]   │
        └───────────────┬───────────────────────────────────────────┬───────────┘
            subscribers: │ agent-automation (3 events, flag-gated)    │ (sparse)
                         ▼                                            ▼
   ┌─────────────┐   ┌──────────────────────────────┐      ┌──────────────────────┐
   │  AGENT OS    │──▶│  DELIBERATION                 │      │  SUPABASE MEMORY      │
   │ agent-os     │   │  debate-engine: Proposal→     │      │  aaa-data (local-1st) │
   │ +registry    │   │  Critic→Risk→[Counter]→       │◀────▶│  +aaa-cloud/-supabase │
   │ +automation  │   │  SUPERVISOR verdict           │      │  +sync-engine (60s)   │
   │ [REAL,WIRED] │   │  agent-council/exec-council   │      │  schema.sql (12 tbl)  │
   └──────┬───────┘   │  challenge/escalation-policy  │      │  [REAL,WIRED]         │
          │           │  [REAL, WIRED end-to-end]     │      └──────────┬───────────┘
          │           └───────────┬──────────────────┘                 │
          │ callAgent()           │ logs decisions                     │ reads
          ▼                       ▼                                    ▼
   ┌──────────────┐      ┌─────────────────┐   ┌────────────────────────────────┐
   │ CLAUDE        │      │  SUPERVISOR      │   │  KNOWLEDGE GRAPH  AAA_GRAPH     │
   │ aaa-data      │      │  Brier scoring   │   │  + KNOWLEDGE FABRIC            │
   │ →callProxy    │      │  per-agent track │   │  nodes+edges, queryable        │
   │ →/api/claude  │      │  [REAL, WIRED]   │   │  ❌ DISCONNECTED (built,unused)│
   │ [LIVE default]│      └────────┬─────────┘   └────────────────────────────────┘
   └──────────────┘               │ scores feed
                                  ▼
   ┌───────────────────────────────────────────────────────────────────────────┐
   │  OUTCOME LEARNING            CALIBRATION REGISTRY        PRICING OPTIMIZER    │
   │  outcome-learning-store      signals→proposal→[human]    learns from outcomes │
   │  outcome-intelligence        →[human approve]→install    →recs (never applies)│
   │  prediction-closure          tuning  [REAL; loop OPEN]   [REAL, WIRED]        │
   │  native-model (logistic)     ▲                                               │
   │  [REAL, WIRED]               └── read back by pricing-optimizer.registryBias()│
   └───────────────────────────────────────────────────────────────────────────┘
                                  │ provenance of every recommendation + model call
                                  ▼
   ┌──────────────────────┐   ┌──────────────────────────────────────────────────┐
   │  PROVENANCE STORE     │   │  GOVERNED MODEL ROUTER  AAA_GOVERNED_MODEL_ROUTER │
   │  provenance-store     │◀──│  registry→GATEWAY(RUN_MODEL,audit)→governance     │
   │  provenance-builder   │   │  active+enabled→adapter→TRANSPORT→proxy           │
   │  model-call-provenance│   │  advisory envelope; neutral fallback              │
   │  [REAL, WIRED]        │   └───────┬──────────────────────────┬───────────────┘
   └──────────────────────┘           │                          │
                            ┌──────────▼─────────┐    ┌───────────▼────────────┐
                            │ NVIDIA INTEGRATION  │    │ TRANSPORT LAYER (model)│
                            │ nvidia adapter →    │    │ nemotron-transport &   │
                            │ nemotron-transport →│    │ private-gpu-transport  │
                            │ /api/nemotron →     │    │ off-by-default,        │
                            │ integrate.api.nvidia│    │ stub when uninstalled, │
                            │ [OFF by default]    │    │ circuit breaker (GPU)  │
                            └─────────────────────┘    └────────────────────────┘

   GOVERNANCE-REGISTRY (versioned, human-gated, checksum-chained) gates models,
   prompts, policies, calibrations.  RUNTIME-GATEWAY audits every mutation and
   hard-blocks AI on human-only actions.  RELIABILITY-CENTER + AI-OPS-CENTER +
   OWNER-COPILOT observe all of the above (read-only command center).  [ALL REAL]
```

**Control-flow legend:** every external model call →
`router.call()` → `registry.get` → `gateway.run(RUN_MODEL)` → `governance.getActive` →
`adapter.invoke` → `transport` → netlify proxy → provider → `model-call-provenance.record`
→ advisory envelope. No component bypasses the gateway.

---

## 3. Fake / stub / placeholder / disconnected AI inventory

The audit found **no dishonest fakes** — no hardcoded "AI" outputs masquerading as
real inference, no mock dashboards. What exists falls into three honest categories:

### 3a. Deterministic offline STUBS (intentional, CI-safe — not "fake")
- `nvidia-nemotron-adapter.js` / `private-gpu-adapter.js` — return a **deterministic
  hash-based stub** when no transport is installed, flagged `raw.stub:true` and
  `fallback:true` in provenance. This keeps CI green without GPUs/keys. **Correct by
  design**, not a fake. Goes live when transport `.install()` + governance enable.
- `analysis-division.runRole()` — returns `{ok:false, error:'AI_NOT_CONFIGURED'}`
  when no proxy. Honest degradation; agents fall back to real data, never fabricate.

### 3b. DISCONNECTED (built, real, but nothing calls it) — **the actionable gaps**
- **`core/knowledge-graph.js` (`AAA_GRAPH`)** — full entity/relationship graph
  (8 node types, 7 edge types) + `insights()`. **No caller anywhere.** (P2)
- **`intelligence/knowledge-fabric.js` (`AAA_KNOWLEDGE`)** — permission-aware
  queryable index with intent routing (`ask()`/`search()`). **No UI/agent calls it.** (P2)
- **`provenance-builder.js`** — assembles full origin→outcome traces; **no automatic
  caller** (only manual would invoke).
- **`action-safety-gate.js`** — only partially used (gates `agent-os` next_actions;
  no UI surface).

### 3c. OPEN loops (write-but-not-auto-read-back) — **the autonomy gap**
- Outcome signals, closures, agent scores, learning patterns, self-improvement
  tunings, calibration proposals are all **computed and stored**, but the
  apply-back step requires **manual proposal + manual approval**. The loop is
  closed only *through a human*. (P5 — see §1 and §7.)

---

## 4. Per-phase gap analysis (what to actually build)

### P1 — HyperMind continuous loop · **GAP: the driver**
- **Have:** event bus, deterministic collectors (Layer 1 always runs), 6-layer
  pipeline, learning fabric, meetings cadence with `due()` checks.
- **Missing:** a continuous **loop driver** (a governed clock/scheduler) that ticks
  Observe→Remember→Predict→Plan→Execute→Measure→Learn→Update without a button.
  Today everything is button- or event-triggered; `intelligence-meetings` even has
  `due()` but nothing calls it on a timer.
- **Also missing (senses):** ingestion for **phone calls, missed calls, refunds,
  invoices, ad clicks, website leads** (SMS/email/jobs/estimates/outcomes already in).

### P2 — Shared memory graph · **GAP: connect + extend**
- **Have:** `AAA_GRAPH` + `AAA_KNOWLEDGE`, both real, both dormant.
- **Missing:** wire them into the loop and a UI; **add node types** the schema lacks
  (technician, supplier, product, campaign, lead, invoice) and the relationships
  (`Lead Source→Quote→Win Rate`, `Technician→Job→Margin` partially derivable today).

### P3 — Model cluster + router · **GAP: optimization + a real served model**
- **Have:** governed router, two-layer routing, NVIDIA + private-GPU adapters,
  provenance, governance, reliability.
- **Missing:** the router does **static task→model mapping only** — no cost,
  latency, or complexity optimization (mission asks for all three).
- ⚠️ **`google/gemma-4-31b-it` does not exist** (no Gemma 4, no 31B). It is **not**
  in the registry and never was. Use a real served id (`google/gemma-3-27b-it` or a
  Nemotron variant), governed through the existing registry. See §6.

### P4 — Executive council · **GAP: persistence**
- **Have:** Proposal→Critic→Risk→Supervisor→Decision is real and wired; multi-seat
  councils exist; track records computed from outcomes.
- **Missing:** **persistent CEO/COO/CFO/CMO/CTO agents with durable memory + KPIs.**
  Today roles are **stateless** (re-instantiated per call; "memory" recomputed). The
  delta is materializing per-executive memory/KPI state and a standing council, not
  inventing the deliberation (which exists).

### P5 — Outcome reinforcement · **GAP: bounded autonomy (decision-gated)**
- **Have:** Brier scoring, self-improvement (Claude diagnosis + clamped bias),
  calibration registry, native logistic model, prediction closure — all real.
- **Missing:** the **automatic** apply-back the mission demands. Blocked on §1/§7.

### P6 — Digital twin · **GAP: two levers**
- **Have:** simulate hiring / add-truck / ad-spend / price-change / new-territory →
  revenue/profit/capacity/risk over a 12-mo path with stated confidence.
- **Missing:** **crew removal** and **lead-volume −20%** levers; multi-lever combos.

### P7 — Command center · **GAP: surface the new signals**
- **Have:** AI-Ops action queue, Reliability Center, Owner Copilot — all live, no
  mocks, fully bound.
- **Missing:** panels for **loop activity / heartbeat**, **graph insights**, and
  (if §7 approves) **autonomous-action audit feed**. Mostly additive.

---

## 5. What is REAL + WIRED today (do not rebuild)

`agent-os`, `agent-registry`, `agent-automation`, `supervisor`, `debate-engine`,
`challenge-protocol`, `escalation-policy`, `agent-council`, `executive-council`,
`supervisor-council`, `proposal-engine`, `intelligence-meetings`, `analysis-division`,
`intelligence-pipeline`, `intelligence-collectors`, `outcome-learning-store`,
`outcome-intelligence`, `prediction-closure`, `calibration-registry`, `native-model`,
`self-improvement`, `pricing-optimizer`, `analyst-rankings`, `agent-evaluation-lab`,
`financial-intelligence`, `business-digital-twin`, `replay-sandbox`,
`ai-operations-center`, `reliability-center`, `owner-copilot`, `governance-registry`,
`provenance-store`, `model-call-provenance`, `model-registry`, both routers, all
provider adapters/transports, `aaa-event-bus`, `aaa-data`, `sync-engine`, gateway.

**All 28 intelligence + 17 agent modules are loaded in `index.html`. Zero dead code.**

---

## 6. The `gemma-4-31b-it` problem (must not vendor a fiction)

The mission's P3 says *"Install and configure `google/gemma-4-31b-it`."* That model
**does not exist** — there is no Gemma 4 and no 31B variant; real ids are
`google/gemma-2-27b-it`, `google/gemma-3-27b-it`, etc. Cloning
`git@hf.co:google/gemma-4-31B-it` already 404s (and egress is firewalled in this
env). **Recommendation:** register a *real* served model as a governed artifact via
the existing `model-registry` + `governance-registry` (no schema change needed), run
it through the same governed router. Either NVIDIA-hosted (`google/gemma-3-27b-it`
via `/api/nemotron`) or self-hosted on the Brev GPU box (`SETUP-BREV.md`) behind
`/api/private-gpu`. No fictional weights enter the repo.

---

## 7. Recommended path & the decision needed

**Proposed incremental, test-backed roadmap (each step: tests + observability +
implementation report; never breaks existing behavior):**

- **HM-1 (P1 heartbeat):** a governed **loop driver** (`AAA_HYPERMIND`) on
  `runtime-clock` that, when an owner flag is on, ticks the *existing* pipeline /
  graph / learning on an interval, every tick audited + visible in the command
  center. Default OFF. *No new cognition — just a heartbeat for what exists.*
- **HM-2 (P2):** wire `AAA_GRAPH` + `AAA_KNOWLEDGE` into the loop + a UI panel;
  add missing entity nodes.
- **HM-3 (P1 senses):** ingestion adapters + schema tables for calls/leads/refunds/
  invoices/ad-clicks (migrations).
- **HM-4 (P5):** **bounded autonomy** — auto-apply learning **only inside
  owner-set guardrails** (e.g. |confidenceBias|≤cap, reversible, below $ threshold),
  everything else still escalates to the human gate. Full audit + one-click rollback.
- **HM-5 (P4):** persistent executive council memory/KPIs.
- **HM-6 (P3/P6):** cost/latency-aware routing; the two missing twin levers.

**Blocking decision (yours):** how autonomous may the loop be? The whole codebase is
built around *owner approval*; P5 demands *no manual intervention*. These can be
reconciled (HM-4 bounded autonomy) but the boundary is a business/risk call, not an
engineering one. See the question posed alongside this audit.
</content>
