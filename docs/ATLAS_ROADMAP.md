# PROJECT ATLAS — Phase 3: Execution Roadmap (6–12 months)

**Inputs:** `SYSTEM_AUDIT.md` (Phase 1, reconciled), `ATLAS_TARGET_ARCHITECTURE.md`
(Phase 2), `PDP_DEPLOY_PLAN.md` (keystone), and the keystone decision the owner has
made: **the PDP lives in Firebase Auth + Cloud Functions**, behind the shared
versioned policy artifact so it can migrate to a dedicated backend later with no
contract change.

**What this document is:** the single dependency-ordered sequencing of the eight
domains' migration steps into waves, with entry/exit gates, rollback per wave, and
the owner decision checkpoints marked where they gate work. It does not re-argue the
designs — each wave line references the domain sequence it executes.

**Standing constraints (apply to every wave, non-negotiable):**
- Human authority: no step weakens an `aiAllowed:false` constant, the human-approver
  rule, `OVERRIDE_AI_DECISION`, or reversibility. Waves only ever *add* constraints.
- Nothing begins with payments, final pricing, legal actions, or production model
  deployment (mission Phase-5 gate).
- Every step is feature-flagged, independently reversible, and lands with both
  suites green (currently 4143 JS / 202 suites + 818 py). No big-bang.
- No fake automation: infra steps that need live Firebase/GCP are owner-executed;
  repo work ships them as tested code + runbooks, never simulated success.

---

## Wave 0 — DONE (the common enabling move, already landed)

The architecture's shared **STEP 0** — versioned, cross-repo-mirrored policy
artifacts with conformance tests — plus the keystone core:

| Landed | Where |
|---|---|
| Governance-policy artifact (ACTIONS + RBAC + custonllm routePerms), sha256 MANIFEST, conformance tests both repos | `js/core/aaa-policy-contract.js` → `schemas/governance-policy-v1.json` ↔ custonllm `contracts/` |
| Model-record artifact (Domain 8 STEP 0): openness classes, lifecycle machine, shared ID space, conservative seed, tests both repos | `js/ai/model-record-contract.js` → `schemas/model-record-v1.json` ↔ custonllm `agent/core/model_record.py` |
| PDP decision core, golden-fidelity-tested vs the live gateway (full action × origin × role), C4 origin backstop | `js/core/aaa-policy-decision.js` + `test/unit/policy-decision.test.js` |
| PDP Cloud Function thin shell as tested code (fail-closed claims, sha256-verified artifact, shadow-default) | `functions/pdp-authorize/` |

Everything below sequences on this base.

---

## Wave 1 — Boundary live in shadow + loss made visible (Months 1–2)

Goal: the server boundary EXISTS and observes everything; nothing is blocked yet;
silent failure modes become visible. Zero behavior change for legitimate users.

1. **(owner infra)** Deploy `pdpAuthorize` (`PDP_MODE=shadow`); stamp custom claims
   `{workspaceId, role, principalType}` at sign-in from `workspaces/{ws}/members/{uid}`
   (Domain 1 STEP 1). Ship the agent service-credential class alongside, unused.
2. Client sends its advisory verdict with each governed proxy call so
   `shadowCompare` logs divergence (`PDP_SHADOW_DIVERGENCE` in Cloud Logging).
3. **custonllm fail-closed auth** (Domain 1 STEP 5, first half): deny when
   `API_AUTH_KEY` unset (today fail-open → `role=owner`), add workspace claim +
   revocation store. This is a straight bug-class fix; it does not wait for the PDP.
4. **Durability visibility** (Domain 2/D0): additive `{ok, durable}` on `put()`,
   durability-health signal replacing swallowed `_flush` errors. The C5 *detection*
   half; no behavior change.
5. **Audit dual-write** (Domain 4 Step 1): gateway `_audit` also appends to
   `AAA_AUDIT_LEDGER` behind `flag('gatewayLedgerSeal')` (shadow/dual-write,
   reconciliation asserted in tests).
6. **Event spine instrumentation** (Domain 5 step 1): dead-letter + health counter
   on `publish()`, dev-warning on raw `emit()` of contracted types.

**Exit gate:** shadow burn-in shows **zero unexplained `match:false`** over an
owner-chosen window; durability health and audit dual-write reconcile clean.
**Rollback:** every item is a flag or a log line; shell reverts to off.

## Wave 2 — Enforcement flips + tenancy becomes real (Months 2–4)

Goal: the four cheapest criticals close. Entry requires Wave-1 exit gate.

1. **Proxy enforcement** (Domain 1 STEP 2, closes **C2**): route claude/nemotron/
   vision proxies through the PDP — auth + workspace scope + tenant-model-policy +
   `RUN_MODEL` + bounded model/max_tokens + per-tenant quota. `PROXY_REQUIRE_AUTH`
   off → per-tenant → global; the open CORS relay dies with the flag.
2. **Origin backstop hard-on** (Domain 1 STEP 4, closes **C4** server-side): flip
   `PDP_MODE=enforce`; agent-class tokens categorically rejected on
   `aiAllowed:false` actions. Browser gateway stays as the fast-fail advisory.
3. **Tenancy phases 0–3** (Domain 2, closes the client-asserted half of **C3** with
   Wave 1's claims): canonical `mine()` predicate + `activeTenant()` (pure refactor);
   `AAA_DATA` stamping/refusal behind `tenantScopedData` with shadow dual-read;
   gateway-governed idempotent backfill (`RUN_MIGRATION`, human-only) with sealed
   receipt; route the direct-to-storage writers through `put()`.
4. **Audit ledger authoritative** (Domain 4 Step 2, closes **C6**): flip
   `gatewayLedgerSeal`, demote `sealAudit` to a shim, one-time legacy backfill.
5. **Model-record shadow reads** (Domain 8 STEPs 1–2): canonical records dual-written
   and diffed in CI; both registries learn to build FROM the canonical projection
   behind `canonicalModelRegistry`, dual-read asserted equal.

**Exit gate:** C2/C4 enforcement live with no legitimate-traffic regressions;
tenant backfill verification counts zero remaining nulls; ledger reconciliation
green. **Owner checkpoint:** per-tenant seal granularity (Domain 4 decision) before
Wave 3's server seal.

## Wave 3 — Durable system-of-record + sync cutover (Months 4–6)

Goal: the storage layer stops lying (**C5**) and the global blob dies (**C1**).

1. **IndexedDB cache** (Domain 2/D1) per-workspace partitioned behind
   `storageBackend`, one-way localStorage import on boot.
2. **Durable put() contract** (D2): non-durable writes reported, never silent
   success — the literal C5 fix.
3. **Outbox-v2 + authenticated per-tenant drain** (D3) in SHADOW alongside the blob
   push (dual-write, blob authoritative, divergence telemetered). Rides the Wave-1/2
   PDP boundary — same trust chokepoint, same `origin` field.
4. **Promote per-tenant partition to source-of-record** (D4) with
   reconcile-on-connect; then **decommission `/api/sync` global blob** (D5, closes
   **C1**) after shadow parity, backfilling blob-only records.
5. **Tenancy strict flip** (Domain 2 Phases 4–6): workspace-namespaced keys,
   `tenantStrict` on (null refused/quarantined), Firestore rule path/body agreement +
   presence requirement — rules monitor-first so no in-flight write is rejected.
6. **Server seal authority + origin stamp** (Domain 4 Step 7, per the Firebase
   topology decision): server HMAC co-sign; seal custody leaves the client.

**Exit gate:** shadow parity zero-divergence over a full cycle before each
authority flip; all six audit criticals **C1–C6 now closed**.

## Wave 4 — Governance-grade + the model fabric (Months 6–9)

1. **SoD / quorum / risk scoring** (Domain 4 Steps 3–4): `riskScore` on envelopes
   (additive), `AAA_DUTIES` in `approve()` log-only → enforcing above threshold.
2. **Legal hold** (Domain 4 Step 5): `AAA_LEGAL_HOLD` + `PLACE/RELEASE_LEGAL_HOLD`
   (human-only, SoD: releaser ≠ placer), wired into erasure/expiry.
3. **Governed writes** (Domain 4 Step 5b): `putGoverned` + registry + CI raw-put
   guard; memory stores migrate one collection per PR. Shrinks the ungoverned
   AI-writable surface (221 → 30 finding).
4. **Delegation grants** (Step 6) and **custonllm audit parity** (Step 8):
   `prev_hash` chain + shared canonical ID space, mirrored contract test.
5. **Model lifecycle onto governance** (Domain 8 STEP 3): record lifecycle mapped
   onto the existing governance-registry state machine (no new approval path);
   `tenant-model-policy` re-keyed to `modelUid`.
6. **Promotion gate + neutrality guard** (Domain 8 STEP 4): `PRODUCTION_APPROVED`
   refuses unless license+integrity verified (HyperKernel half) AND eval+health
   present (custonllm half) AND the no-lab-indispensable share threshold holds.
7. **Event spine collapse** (Domain 5 steps 2–5): dual-deliver → shadow → reroute
   contracted emits through `publish()`; centralize contracts; wire the taxonomy.
8. **Scale items as limits bite** (Domain 7 steps 0–3): `query()` seam + ledger O(1)
   append (first at ~10 tenants); custonllm shared rate limiter **before any
   replica ≥ 2**; indexed reads.

**Exit gate:** every governance addition lands log-only first; the promotion gate
proves a real model can be walked DISCOVERED → PRODUCTION_APPROVED by a human
without code edits — and that nothing reaches it otherwise.

## Wave 5 — Global-ready + retire the scaffolding (Months 9–12)

1. **i18n substrate** (Domain 6 Phase A): EN catalog as identity of today's
   literals; module-at-a-time migration; then ES/FR/PT/DE.
2. **Currency/quote localization** (Phase B, `localize` default OFF → ON for
   non-US) and **regulatory packs** (Phase C: retention overrides, consent/DSAR
   metadata on existing gateway paths). **Owner checkpoint:** currency-engine
   build-vs-adopt.
3. **E.164 phone identity** (Phase D, failing-test-first) and the **custonllm
   currency field** (Phase E).
4. **Projections + query-seam migration** (Domain 7 steps 4–5): shadow-parity, then
   flip readers.
5. **Model fabric default flip** (Domain 8 STEP 5): `FRONTIER_MODELS`/`MODEL_REGIONS`
   demoted to alias/seed data.
6. **Module loader** (Domain 5 step 7): manifest generated from today's load order,
   CI-asserted byte-identical ordering, tag list kept as fallback.
7. Residency routing (Domain 6 Decision 4) — only now, on top of the tenancy +
   boundary substrate.

**Exit gate = mission success criteria:** the system *knows* (unified sealed audit +
event spine + organizational memory hooks), *supports* (tenancy invariant, i18n,
regulatory packs, scale seams), and *remains* (explainable, governed,
human-controlled).

---

## Critical-theme closure map

| Critical | Closes in | By |
|---|---|---|
| C2 open LLM proxies | Wave 2.1 | PDP proxy enforcement + quota |
| C4 browser-only AI-block | Wave 2.2 | `PDP_MODE=enforce` origin backstop (core + shell already built) |
| C3 client-asserted tenancy | Wave 2.3 | claims-bound workspace (W1) + data-layer stamping/backfill |
| C6 audit seal sequencing | Wave 2.4 | per-writer ledger chaining authoritative |
| C5 silent quota loss | Wave 3.1–3.2 | IndexedDB + durable put() contract (visibility lands Wave 1.4) |
| C1 unauthenticated sync blob | Wave 3.3–3.4 | authenticated per-tenant drain → blob decommissioned |

## Owner decision checkpoints (in order of arrival)

1. **Made:** PDP topology — Firebase Auth + Cloud Functions. ✔
2. Wave-1 exit: shadow burn-in window length + "zero unexplained divergence" sign-off.
3. Wave-2 entry per-flag flips (proxy auth per-tenant → global; enforce mode).
4. Wave-2 exit: per-tenant seal granularity (Domain 4).
5. Wave-3: sync cutover + blob decommission moment (data-destructive step: backfill
   verified first, blob archived not deleted).
6. Wave-4: model promotion — every `PRODUCTION_APPROVED` transition is individually
   human-approved, by design, forever.
7. Wave-5: currency-engine build-vs-adopt; residency routing scope.

## What can safely run in parallel

- Wave 1 items 3–6 are independent of the infra deploy (1–2).
- Domain 8 shadow work (W2.5) is independent of enforcement flips (W2.1–2.2).
- Domain 5 event-spine steps and Domain 7 scale steps float — they gate nothing on
  the critical path and can absorb slack.
- The i18n substrate (W5.1) is purely additive and may start any time capacity
  exists; it is sequenced late only for focus.
