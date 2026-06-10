# AAA HyperKernel — Founding Architecture (Phase 1)

> **Status:** canonical architecture of record. This document is *normative*: where
> it and the code disagree, that is a bug in one of them, not a matter of taste.
> Every claim below names the real module that realizes it (`js/...`), so the
> architecture stays falsifiable against the codebase, not aspirational.

AAA HyperKernel is not an app with AI bolted on. It is an **operational
intelligence layer** — an enterprise operating system that records what happens,
remembers what it caused, governs what may be done, and learns from the result.
The first business it runs is **AAA Carpet** (repair, stretching, installation,
cleaning, apartment turns, residential & commercial flooring). The kernel itself
knows nothing about carpet — the domain lives in data and contracts, so the same
kernel can run the next physical business unchanged.

This document is the Phase-1 deliverable set. It defines the architecture **before**
any further feature, in this fixed order:

1. [The 25 highest-value business events](#1-the-25-highest-value-business-events)
2. [Event taxonomy](#2-event-taxonomy)
3. [Graph schema](#3-graph-schema)
4. [Primitive schemas](#4-primitive-schemas)
5. [Governance model](#5-governance-model)
6. [Learning loops](#6-learning-loops)
7. [Council structure](#7-council-structure)
8. [Agent lifecycle](#8-agent-lifecycle)
9. [Memory lifecycle](#9-memory-lifecycle)
10. [Audit architecture](#10-audit-architecture)

It ends with the [architectural debates](#architectural-debates) the design had to
survive, and the [invariants](#kernel-invariants) that every future change must hold.

---

## The kernel in one diagram

No agent ever calls another agent. The only legal path is:

```
            ┌──────────────────────────────────────────────────────────┐
            │                       HYPERKERNEL                          │
            │                  (management / control plane)              │
            └──────────────────────────────────────────────────────────┘
                                       │ governs
   Agent ──emits──►  EVENT  ──►  GRAPH  ──read──►  Agent
     ▲                 │           │                  │
     │                 │           │                  └─ proposes a DECISION
     │            (immutable    (current state             │
     │             hash-chained  + provenance)             ▼
     │             EVENT BUS)        │              GOVERNANCE validates
     │                 │             │              (confidence · risk ·
     │                 ▼             ▼               reversibility · approval)
     │            MEMORY records  AUDIT records           │
     │            the OUTCOME     every governed act       │ emits governance record
     │                 │                                   │
     └─────────────────┴────── LEARNING re-scores ◄────────┘
                         (every outcome → training data)
```

| Plane | Responsibility | Realized by |
|---|---|---|
| **Event Bus** | records *activity* (what happened), immutably | `js/core/aaa-event-bus.js`, `js/core/aaa-events.js` |
| **Knowledge Graph** | records *state* (what is, and how it connects) | `js/core/knowledge-graph.js`, `js/intelligence/knowledge-fabric.js` |
| **Memory Engine** | records *outcomes* (what it caused) | `js/intelligence/learning-fabric.js`, `js/intelligence/vector-memory.js`, `js/intelligence/outcome-spine.js` |
| **Governance Engine** | validates *actions* (may this be done, by whom) | `js/governance/governance-engine.js`, `js/core/aaa-runtime-gateway.js`, `js/core/aaa-rbac.js`, `js/agents/action-safety-gate.js` |
| **Learning Engine** | modifies *future behavior* | `js/intelligence/outcome-intelligence.js`, `js/intelligence/prediction-closure.js`, `js/governance/agent-scorecards.js`, `js/intelligence/evolution-engine.js` |
| **Agent Runtime** | runs the workers under contract | `js/agents/agent-os.js`, `js/agents/agent-registry.js`, `js/agents/model-router.js` |
| **Human Oversight** | final authority; approve / override / audit | RBAC + Governance override + `GOVERNANCE.md` |

---

## 1. The 25 highest-value business events

These are the events that, when reliably captured, let the kernel reconstruct the
entire economic life of the company. Each is a registered, schema-validated
contract on the Event Bus (machine-readable source of truth:
[`js/core/aaa-event-taxonomy.js`](js/core/aaa-event-taxonomy.js); committed manifest:
[`schemas/event-taxonomy.json`](schemas/event-taxonomy.json)). The code is
authoritative; this table is its human-readable face.

| # | Event `type` | Why it is high-value | Closes which learning signal |
|--:|---|---|---|
| 1 | `lead.captured` | Top of funnel; the unit of demand | — |
| 2 | `lead.qualified` | Demand the company chose to pursue | — |
| 3 | `lead.disqualified` | Negative signal — *why* we say no is training data | recommendation (routing) |
| 4 | `quote.created` | An estimate is a **prediction of price & win** | estimate → won/lost/expired |
| 5 | `quote.sent` | The moment the customer can react | — |
| 6 | `quote.viewed` | Engagement signal, no human effort to capture | — |
| 7 | `quote.accepted` | **WON** — the estimate prediction resolved | estimate (won) |
| 8 | `quote.rejected` | **LOST** — and the reason is the lesson | estimate (lost) |
| 9 | `quote.expired` | **EXPIRED** — silent loss; follow-up signal | estimate (expired) |
| 10 | `job.scheduled` | Commitment of capacity (crew + time) | — |
| 11 | `job.dispatched` | Crew + vehicle committed to the field | — |
| 12 | `job.completed` | Work done; cost is now knowable | — |
| 13 | `job.closed` | Final outcome of the engagement | prediction (margin/cost) |
| 14 | `crew.assigned` | Links labor & vehicle to a job (capacity graph) | — |
| 15 | `invoice.issued` | Revenue recognized; AR clock starts | — |
| 16 | `payment.received` | Cash — the only outcome that pays the bills | prediction (collection) |
| 17 | `payment.failed` | Risk signal; collections trigger | — |
| 18 | `review.requested` | Reputation flywheel input | recommendation (timing) |
| 19 | `review.received` | Reputation outcome; CSAT signal | recommendation (validated/invalidated) |
| 20 | `referral.created` | Lowest-CAC demand; loyalty outcome | — |
| 21 | `campaign.launched` | Marketing spend; attribution anchor | prediction (ROI) |
| 22 | `recommendation.created` | An AI advisory was surfaced to a human | recommendation → validated/invalidated |
| 23 | `recommendation.validated` | The advisory was proven right or wrong | recommendation (resolved) |
| 24 | `decision.recorded` | A governed action was taken (or held) | decision → outcome |
| 25 | `outcome.recorded` | The ground-truth label arrives | scores everything upstream |

Three of these — `recommendation.created`, `decision.recorded`, `outcome.recorded`
— are **kernel** events, not domain events. They are how the intelligence layer
narrates itself onto the same immutable log as the business, so an auditor sees the
business and the AI in one timeline.

---

## 2. Event taxonomy

Every event name is `domain.action`, present-tense-perfect (`captured`, `closed`,
`received`). The taxonomy classifies each event on five orthogonal axes so that
generic machinery (routing, governance, learning, dashboards) can reason about an
event it has never seen before. These axes are carried as metadata in
`js/core/aaa-event-taxonomy.js`.

**Axis 1 — Domain** (the noun): `lead · quote · job · crew · invoice · payment ·
review · referral · campaign · recommendation · decision · outcome`.

**Axis 2 — Stage** (where in the value chain):

```
acquisition → sales → delivery → billing → retention → growth
                       └─ ops (cross-cutting capacity) ─┘
                       └─ intelligence · governance (cross-cutting) ─┘
```

**Axis 3 — Primitive** the event most changes: `Entity · Relationship · Event ·
Decision · Memory` (see §4). Example: `crew.assigned` primarily writes a
**Relationship**; `outcome.recorded` writes a **Memory**.

**Axis 4 — Reversible?** Booleans drive the action-safety gate
(`js/agents/action-safety-gate.js`): a reversible event may be produced by
automation; an irreversible one (`payment.received`, `invoice.issued`) is
human-confirmed or carefully gated.

**Axis 5 — Risk** (`low · medium · high`): feeds the escalation policy. High-risk
events (`payment.*`, `decision.recorded`) always emit a governance record.

### Contract discipline (no drift, no fake success)

A publish is **validated against its contract before it is logged**
(`aaa-event-bus.js` → `validate()`): a payload missing a required field or with a
wrong type is *rejected and never written*. This is the kernel's honesty rule made
mechanical — the log can only ever contain well-formed truth. Unknown event types
are rejected (`UNKNOWN_EVENT_TYPE`). The contract catalog exports to AsyncAPI 2.6
(`asyncapi()`), and a test asserts the committed schema matches the live contracts
so the taxonomy cannot silently drift from the code.

### Versioning

Contracts are versioned (`version: n`). A breaking payload change mints a new
version; old events keep their recorded version forever (they are immutable). The
graph and learning layers read by `type@version`, so a schema evolution never
rewrites history.

---

## 3. Graph schema

The graph is the **source of organizational intelligence** — the current state and,
crucially, the *provenance* behind every recommendation. It is built deterministically
from shared memory (`js/core/knowledge-graph.js` `build()`); nothing in it is invented.

### Node types

```
Customer ─< Job >─ Estimate(quote)         Lead ─► Customer (on conversion)
   │         │  └─ Outcome                 Crew ─┐
   │         ├─ Review                      Vehicle ─┴─► Job (assigned)
   │         └─ Invoice ─ Payment          Campaign ─► Lead (attribution)
   └─ Referral ─► Lead                      Agent ─< Decision >─ Outcome
                                            Recommendation ─► Decision
```

| Node | Source collection | Key edges |
|---|---|---|
| `customer` | `customers` | `from_source`, `has_job`, `made_referral` |
| `lead` | `leads` (`AAA_LEADS`) | `from_campaign`, `converted_to` (customer) |
| `job` | `jobs` | `has_estimate`, `has_outcome`, `has_review`, `has_invoice`, `assigned_crew` |
| `estimate` | `jobs[].estimates` / `quotes` | `predicts` (outcome) |
| `outcome` | `outcomes`, `outcome_labels` | `has_outcome` (←job), `scores` (→decision) |
| `review` | `review_requests` | `has_review` (←job) |
| `invoice` / `payment` | accounting (`AAA_ACCOUNTING`) | `has_invoice`, `paid_by` |
| `referral` | `customers`/leads | `made_referral`, `produced` (lead) |
| `crew` / `vehicle` | scheduling/crew | `assigned_crew`, `drove` |
| `campaign` | marketing | `from_campaign`, `attributed` |
| `agent` | `agent_decisions` | `by_agent` |
| `decision` | `agent_decisions` | `about_job`, `by_agent`, `governed_by` |

### Provenance is a first-class query

For **any** recommendation the kernel must answer five questions
(`js/intelligence/provenance-builder.js` + `provenance-store.js`, an append-only
ledger):

1. **What created this?** → the agent + the `recommendation.created` event id
2. **Why?** → the decision rationale + the debate transcript
3. **What information was available?** → the source quotes/outcomes read at the time
4. **Who approved it?** → the governance case + override record (if any)
5. **What happened afterward?** → the linked `outcome.recorded` + its score

Provenance traces are **immutable and append-only** — a new trace is a new
document, never a rewrite, so *"what did the system know at the time?"* is always
answerable after the fact.

### Why a derived graph, not a graph database

The graph is **projected from the event log + entity store on read**, not stored as
a separate mutable structure. Consequences: (a) the graph can never disagree with
the source records, because it *is* them; (b) it is offline-first and
zero-infrastructure; (c) "rebuild the world at time T" is just replaying the log to
T. This is debated in [Debate B](#debate-b--derived-graph-vs-graph-database).

---

## 4. Primitive schemas

Five primitives, and no more (a sixth requires explicit justification and a
recorded debate — see [invariants](#kernel-invariants)). Everything in the platform
is one of these.

### Entity
A thing that exists and persists. `Customer, Lead, Estimate, Job, Invoice, Payment,
Review, Referral, Crew, Vehicle, Campaign, Agent`.
```
{ id, type, workspaceId, createdAt, updatedAt, ...domainFields }
```
Stored in `AAA_DATA` collections; identity minted by `js/core/id-factory.js`
(prefix + ms + monotonic counter + random → collision-resistant, sortable).

### Relationship
A typed, directed edge between two entities. Not stored as its own row in Phase 1 —
it is the foreign key on an entity, **lifted into an edge** by the graph builder.
```
{ from: nodeId, to: nodeId, rel: 'has_job' | 'from_source' | 'assigned_crew' | ... , dir }
```

### Event
An immutable fact that something happened, on the hash-chained log (§1–2).
```
{ id, workspaceId, type, version, payload, source, actor, seq, prevHash, hash, at }
```
`seq + prevHash + hash` make the log **tamper-evident**: any edit breaks the chain
and `verifyChain()` reports the exact break.

### Decision
A proposed or taken action by an agent, with its reasoning, scored later.
Enforced shape (`DECISION_SCHEMA`, `js/agents/agent-registry.js`):
```
{ recommendation, rationale, confidence:0-100, risks:[], next_actions:[] }
```
Persisted to `agent_decisions` with the model that ran, the task, and (later) the
supervisor `score`.

### Memory
A retained outcome that conditions future behavior. Three shapes:
- **episodic** — `job_memory` (what happened with jobs like this) `learning-fabric.js`
- **semantic** — `memory_vectors` (recall by meaning) `vector-memory.js`
- **canonical outcome** — the normalized, labeled outcome `outcome-spine.js`

> **Decision vs Memory** is the subtle pair. A Decision is *forward* (a proposal at
> time T). A Memory is *backward* (what a decision turned out to cause). The
> `outcome.recorded` event is the hinge that converts one into the other.

---

## 5. Governance model

**Humans are the final authority.** The kernel may recommend, learn, and automate;
it may **never silently override a governance policy**. Governance is not a
checkpoint at the end — it is the membrane every action crosses.

### Every action must be six things

`explainable · reversible · attributable · auditable · confidence-scored ·
risk-scored`. These are not aspirations; they are enforced at distinct seams:

| Property | Enforced by |
|---|---|
| explainable | `DECISION_SCHEMA.rationale` + debate transcript (`debate-engine.js`) |
| reversible | action-safety gate classifies blast radius (`action-safety-gate.js`) |
| attributable | event `actor` + decision `agent` + RBAC identity (`aaa-rbac.js`) |
| auditable | append-only hash-chained ledger (`audit-ledger.js`) |
| confidence-scored | `confidence:0-100` on every decision; calibrated by supervisor |
| risk-scored | taxonomy risk axis + escalation policy (`governance-escalation.js`) |

### The governed action pipeline

```
agent proposes DECISION
   │
   ▼ action-safety gate: classify (allow | needs_approval | deny)
   │        deny  → never auto-run (rm -rf /, DROP DATABASE class)
   │        allow → reversible, local, internal
   ▼
governance-engine.record()  → CASE  (every guardrail verdict becomes a case)
   │
   ├─ held → human sees "Review decision"; only Admin (RBAC OVERRIDE_AI_DECISION)
   │         can unlock, with a ≥20-char written justification
   │
   ▼ every step → immutable AUDIT LEDGER + supervisor REVIEW QUEUE (training data)
   │
   ▼ repeated overrides of one category → DRIFT ALERT (governance-escalation.js)
   │
human executes → recordSent()  (a separate, explicitly-human, audited act)
```

Design rules (from `js/governance/governance-engine.js`, `GOVERNANCE.md`):
**fail-closed** (only an explicit Admin override unlocks a held case); the gate uses
**RBAC authority, not a client-supplied role**, so it cannot be spoofed; cases are
mutable state but the **ledger is the immutable record**; **never auto-resend** — an
override only *unlocks*, a human still acts. The whole pipeline is **domain-generic**
across a `DOMAINS` registry (content-safety was merely its first consumer; legal,
accounting, contracts, compliance, ad-copy, SMS/email all inherit it).

### Governance record

Every governed action emits one — the audit ledger entry — carrying actor, role,
timestamp, the original verdict, the categories, the context id, the justification,
and the final action, hash-chained so it cannot be altered after the fact.

---

## 6. Learning loops

**Every outcome becomes training data. No learning signal is discarded.** The
kernel is built so that every *prediction* has a *closure* and every *recommendation*
has a *verdict*.

### The three closure loops

```
ESTIMATE loop:    quote.created ──► (sent/viewed) ──► quote.accepted | rejected | expired
                       prediction                          ground truth
                          └──────────► outcome.recorded ──► scores the estimate

RECOMMENDATION loop: recommendation.created ──► human acts ──► recommendation.validated
                          advisory                                  (validated|invalidated)

PREDICTION loop:   any scored forecast ──► prediction-closure.js ──► scored vs reality
```

- **Outcome Spine** (`outcome-spine.js`) normalizes fragmented outcomes (generic
  `outcomes`, resolved `quotes`, lead outcomes, governance outcomes) into **one
  canonical labeled view** — without mutating any source — supplying missing labels
  through an additive `outcome_labels` overlay. This is the single surface
  backtesting and scoring read from.
- **Prediction Closure** (`prediction-closure.js`) guarantees every estimate
  eventually becomes `won | lost | expired` and every recommendation
  `validated | invalidated` — nothing is left dangling.
- **Outcome Intelligence** (`outcome-intelligence.js`) turns closed outcomes into
  the next forward recommendation.
- **Learning Fabric** (`learning-fabric.js`) builds `job_memory` and answers
  `recall(context)` / `recommendFor(context)` for a new job from data **alone — no
  hardcoded rules**. Change the data, the recommendations change.
- **Agent Scorecards / Rankings** (`agent-scorecards.js`, `analyst-rankings.js`)
  re-score every contributor on accuracy/calibration, realized impact, risk
  detection, learning, and trust — an axis is `null` (not zero) when the sample is
  too thin, so a new agent is *unproven*, never falsely *bad*.
- **Evolution Engine** (`evolution-engine.js`) reads real blind-spots (domains
  stuck at low confidence, rejected debates, coverage gaps) and proposes new
  analysts/metrics — spawning is **on request, never silent**.

### Honest-by-construction

When the model proxy is not configured, learning steps return
`AI_NOT_CONFIGURED` and the system falls back to **real deterministic data** rather
than fabricating analysis. A learning signal is never invented to fill a gap.

---

## 7. Council structure

**Agents are workers. Councils are departments. The HyperKernel is management.**
A council is a *debate venue* with a charter and a roster, not a mailbox — members
do not message each other; they each read the graph and vote, and a supervisor
arbitrates (`js/intelligence/agent-council.js`, `executive-council.js`,
`supervisor-council.js`).

| Council | Charter | Anchored in |
|---|---|---|
| **Executive** | strategy, final call, conflict resolution | `executive-council.js`, CEO agent |
| **Operations Intelligence** | scheduling, crew/vehicle capacity, dispatch | `analysis-division.js` (operations team) |
| **Business** | revenue, pricing, customer, marketing | `analysis-division.js` teams + `financial-intelligence.js` |
| **Learning** | calibration, rankings, evolution, eval | `analyst-rankings.js`, `evolution-engine.js`, `eval-golden-store.js` |
| **Engineering** | prompts, models, self-improvement, reliability | `prompt-architect.js`, `self-improvement.js`, `reliability-center.js` |
| **Security** | RBAC, privacy, content/review safety, action gate | `aaa-security.js`, `aaa-privacy.js`, `action-safety-gate.js` |
| **Infrastructure** | runtime gateway, sync, transport, storage | `aaa-runtime-gateway.js`, `sync-engine.js`, `js/transport/*` |

### How a council decides (the adversarial core)

```
Recommendation ─► Critic (strongest weakness) ─► Risk (what breaks; can BLOCK) ─► Supervisor verdict
```
A recommendation is accepted because it **survived challenge**, not because it
sounded good (`debate-engine.js`). A blocking risk caps an "accept" down to
"revise". The full transcript + verdict is stored in `debates`, and the arbitrated
decision is logged so the supervisor scores it once the real outcome is known.
Domain supervisors vote `approve | reject | revise`; votes and the tally are stored
and later linked to the real outcome (`council_votes` → `linkOutcome()`), so the
council's own judgment becomes a scorable track record.

---

## 8. Agent lifecycle

An agent is a **persona under contract**, not free-floating code
(`agent-registry.js`, `agent-os.js`, `agent-marketplace.js`).

```
DEFINE ─► REGISTER ─► ROUTE ─► RUN ─► GOVERN ─► RECORD ─► SCORE ─► RANK ─► EVOLVE/RETIRE
```

1. **Define** — id, title, reports-to, default model, charter/system prompt. Every
   agent's output is constrained to `DECISION_SCHEMA` so it is parseable and scorable.
2. **Register** — joins the org chart (`AAA_AGENTS`) under a council.
3. **Route** — `model-router.js` picks the model by *task kind* (Opus for
   planning/synthesis/security-review; Sonnet for coding/execution; Haiku for
   triage/classification) with advisory cost/effort metadata. Backward compatible:
   no task kind → the agent's declared model.
4. **Run** — `agent-os.runAgent(role, task, ctx)` calls the real proxy; returns
   `AI_NOT_CONFIGURED` rather than fabricating when no proxy is set.
5. **Govern** — `next_actions` pass the action-safety gate; anything
   `needs_approval` is attached for human confirmation before execution.
6. **Record** — the decision (with the model that actually ran) is written to
   `agent_decisions` and narrated as a `decision.recorded` event.
7. **Score** — the supervisor scores it once the linked outcome arrives.
8. **Rank** — scorecards/rankings aggregate calibration & realized impact.
9. **Evolve / Retire** — the Evolution Engine proposes new agents to fill blind
   spots; prompt changes flow through a governed change pipeline
   (`prompt-change-pipeline.js`, `prompt-registry.js`) — versioned, reviewed,
   auditable. An agent is never silently mutated in place.

**Prompt & model changes are governed artifacts**: versioned in a registry, reviewed
before activation, and recorded — so the question *"which prompt/model was in force
when this decision was made?"* is always answerable (and is part of provenance §3).

---

## 9. Memory lifecycle

Memory is what separates an operating *system* from a logging tool. It has a
deliberate lifecycle so it stays honest and bounded.

```
CAPTURE ─► NORMALIZE ─► INDEX ─► RECALL ─► SCORE ─► DECAY/PROMOTE
```

1. **Capture** — an `outcome.recorded` event (or a resolved quote/job) is the raw
   signal. Sensing ingress (`sensing-ingress.js`) admits external signals under the
   same contract discipline.
2. **Normalize** — the Outcome Spine maps every dialect of "won/lost/paid/refund"
   into a canonical `resultClass` (`success | failure | neutral | unknown`) without
   touching the source.
3. **Index** — episodic memory into `job_memory` (by service/zip/lead-source/price
   band); semantic memory embedded into `memory_vectors` (256-dim, deterministic
   offline feature-hashing embedder by default, pluggable for a governed model).
4. **Recall** — `learning-fabric.recall()` (structured) and
   `vector-memory.search()` (by meaning) answer "what happened with cases like
   this?" — **permission-aware**: financial/legal memory is gated by role.
5. **Score** — recalled memory that fed a decision is scored when the new outcome
   lands, closing the loop back to §6.
6. **Decay / Promote** — thin-sample memory yields `null` confidence (unproven, not
   wrong) until it earns weight; minimum-sample thresholds (`fabricMinSample`)
   prevent one anecdote from becoming a "pattern".

Memory is **owner-scoped and workspace-scoped** (`mine()` everywhere), additive
(overlays, never destructive rewrites), and reproducible (deterministic embedder →
CI-green with no credentials).

---

## 10. Audit architecture

Auditability is the property that makes autonomy *safe*. Two independent
hash-chained ledgers plus immutable provenance give the kernel a tamper-evident
spine.

| Ledger | Module | Chain | Purpose |
|---|---|---|---|
| **Event log** | `aaa-event-bus.js` | `seq + prevHash + cyrb53 hash` | every business/kernel fact |
| **Governance audit** | `audit-ledger.js` | FNV-1a chain **+** SHA-256 chain, deep-frozen | every governed action |
| **Provenance** | `provenance-store.js` | append-only documents | why each recommendation exists |

Properties:

- **Append-only & immutable.** Entries are never mutated; the governance ledger
  deep-freezes each entry. A new fact is a new entry, never an edit.
- **Tamper-evident.** `verifyChain()` / `verify()` recompute the chain and report
  the **exact** index/seq of any break (`hash_mismatch`, `chain_break`, `seq_gap`).
  The event-bus test literally tampers a record and asserts detection.
- **Independently verifiable.** The governance ledger's SHA-256 lane uses
  deterministic canonical serialization identical on client and server, so a
  third party can re-verify without trusting the app.
- **Conflict-safe multi-writer.** Each entry carries a `writerId` + per-writer
  sequence and chains off the previous entry *from the same writer*; two devices
  append concurrently into their own lanes, a cloud merge unions the lanes, and
  verification validates each lane independently. Single-writer behaves as a linear
  chain.
- **Replayable.** Because state is derived from the immutable log (§3), the system
  can reconstruct "the world as of time T" by replaying — the basis of the replay
  sandbox (`replay-sandbox.js`).

---

## Architectural debates

Per the kernel's own adversarial principle, the founding decisions were not adopted
because they sounded good — they had to survive `Critic → Risk → Supervisor`. The
ones that shaped the architecture:

### Debate A — One bus or two?
**Proposal (Engineering):** keep the lightweight synchronous `AAA_EVENTS` pub/sub
for in-app reactions, *and* the typed, contract-validated, hash-chained
`AAA_EVENT_BUS` for the durable record.
**Critic:** two buses invite drift — emitters forget to publish to the durable one.
**Risk (blocking?):** if reactions and the record diverge, the audit log lies.
**Supervisor verdict — ACCEPT with constraint:** keep both, but the durable bus
*bridges* selected `AAA_EVENTS` topics automatically (`Bus.bridge()`), so real
activity is captured **without editing emitters**, and a bridged mirror that fails
its contract is dropped, never half-written. The synchronous bus is for *reactions*;
the durable bus is the *truth*. Resolved: drift is closed by the bridge + contract
validation, not by discipline.

### Debate B — Derived graph vs graph database?
**Proposal (Infrastructure):** project the graph from the event log + entity store
on read, rather than running a graph DB.
**Critic:** rebuilding on every query won't scale; a real graph DB gives indexes
and Cypher.
**Risk:** a separate mutable graph can disagree with source records — two sources of
truth is a correctness hazard, worse than a perf hazard.
**Supervisor verdict — ACCEPT:** a derived graph **cannot** disagree with reality
because it *is* reality re-shaped; it is offline-first, zero-infra, and makes
"rebuild at time T" trivial. Performance is a future caching concern (memoize
`build()`), not an architecture change. Correctness beats convenience. The graph DB
remains an optional projection target later, never the system of record.

### Debate C — May agents act autonomously?
**Proposal (Operations):** let high-confidence, low-risk recommendations execute
without a human, to actually save labor.
**Critic:** "high confidence" is the model's self-report, which can be wrong and
miscalibrated.
**Risk (BLOCKING):** an irreversible autonomous action (a sent message, a
payment, a DB drop) cannot be un-sent; silent autonomy violates the human-authority
principle.
**Supervisor verdict — REVISE (capped):** autonomy is **bounded by reversibility,
not confidence**. The action-safety gate classifies *allow / needs_approval / deny*
by blast radius; only `allow` (local, reversible, internal) may auto-run; `deny`
(catastrophic) never runs; everything else waits for a human with a reason. The
kernel may *recommend* freely and *act* only where a mistake is cheap and undoable.
This is why §5 enforces reversibility as a hard gate.

### Debate D — Six primitives, or just five?
**Proposal (Engineering):** add a sixth primitive, `Policy`, so governance rules are
first-class.
**Critic:** a Policy is just an Entity whose Decisions are about other Decisions.
**Risk:** every new primitive multiplies the surface every subsystem must handle.
**Supervisor verdict — REJECT:** Policy = Entity + Decision; no new primitive
justified. The five (Entity, Relationship, Event, Decision, Memory) are *closed*. A
sixth requires a recorded debate that proves it is irreducible to the five. (This is
now an [invariant](#kernel-invariants).)

### Debate E — Where does honesty live?
**Proposal (Learning):** when the model proxy is missing, fall back to heuristic
estimates so the dashboards are never empty.
**Critic:** a heuristic dressed as analysis is a lie the operator will trust.
**Risk (BLOCKING):** fabricated learning signal poisons the training data
permanently — the one thing the kernel must never do.
**Supervisor verdict — ACCEPT critic:** honest-by-construction. No proxy →
`AI_NOT_CONFIGURED` and a fall-back to **real deterministic numbers**, clearly
labeled, never invented analysis. An empty truth beats a full fiction.

---

## Kernel invariants

Every future change must preserve all of these. A PR that violates one is wrong by
definition, regardless of what it enables.

1. **The only path is `Agent → Event → Graph → Agent`.** No agent calls another
   agent directly.
2. **Five primitives, closed.** Entity, Relationship, Event, Decision, Memory. A
   sixth requires a recorded debate proving irreducibility (Debate D).
3. **No fake success.** An action that did not happen is never reported as success;
   an invalid event is rejected, not logged.
4. **No silent governance override.** High-risk/irreversible actions require a
   human with an attributable, recorded justification. Fail-closed.
5. **No discarded learning signal.** Every estimate resolves to won/lost/expired;
   every recommendation to validated/invalidated; every prediction is scored.
6. **Everything is attributable, auditable, reversible-or-gated, explainable,
   confidence-scored, risk-scored.**
7. **State is derived from the immutable log.** The log is the system of record; the
   graph is a projection; "rebuild at time T" must always be possible.
8. **Honest by construction.** Missing capability degrades to real, labeled data —
   never to fabrication.
9. **Industry-agnostic kernel.** Carpet lives in data and contracts, never in the
   kernel. The next business reuses the kernel unchanged.
10. **Humans are the final authority.** Always.

---

*Phase 1 output order honored: architecture first. Implementation second
(`js/core/aaa-event-taxonomy.js` registers the 25 events as validated contracts;
`schemas/event-taxonomy.json` is the committed manifest; `test/unit/event-taxonomy.test.js`
holds it to this document). Code only after the architecture above is internally
consistent.*
