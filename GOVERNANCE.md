# AAA Governance Engine — enterprise review/override/audit for AI decisions

As HyperKernel grows to dozens of AI agents, **every high-risk AI decision**
needs the same disciplined path: be reviewable, be overridable only by the right
person with a reason, be permanently auditable, feed supervisor training, and
roll up into analytics. The Governance Engine is that path. Content-safety on
review requests is its **first consumer** — not a one-off feature.

## The pipeline

```
guardrail verdict → record() → CASE ──(held)──► Review Safety Decision (UI)
                                              │
                          Admin + justification│ requestOverride()  ── immutable AUDIT LEDGER
                                              ▼                     ── Supervisor REVIEW QUEUE (training)
                                         unlocked (NOT sent)        ── drift PATTERN ALERTS
                                              │
                                  human clicks Send → recordSent()  ── AUDIT LEDGER
```

## Components

- **`AAA_GOVERNANCE`** (`js/governance/governance-engine.js`) — records guardrail
  decisions as **cases**, gates overrides, copies overrides to the supervisor
  **review queue**, runs **drift detection**, and computes **metrics**. Generic
  across a `DOMAINS` registry (content_safety, legal, accounting, contract,
  compliance, review_generation, ad_copy, sms, email).
- **`AAA_AUDIT_LEDGER`** (`js/governance/audit-ledger.js`) — append-only,
  **hash-chained, deep-frozen** record. `verify()` recomputes the chain and
  reports the exact index of any tampering. Domain-agnostic event payloads.

## The rules (fail-closed)

1. **No direct override from the job list.** A held draft only exposes
   *“Review Safety Decision”*, which opens the full verdict (draft, verdict,
   categories, raw response, model, timestamp, reason).
2. **Admin-only override.** Gated by RBAC `OVERRIDE_AI_DECISION` — granted to
   `owner` only, by construction. The gate uses RBAC authority, not a
   client-supplied role, so it can't be spoofed. Non-admins see no override.
3. **Mandatory justification.** Minimum `MIN_REASON` (20) characters; blank/short
   reasons are rejected and the refused attempt is itself audited.
4. **Immutable audit trail.** Every override logs user id, role, timestamp,
   original verdict, categories, messageContextId, reason, and final action —
   hash-chained so it can't be altered after the fact.
5. **Supervisor review queue.** Every override is copied to
   `governance_review_queue` as labeled training data (model said X; an Admin
   overrode with reason Y) for the AAA Supervisor Agent.
6. **Pattern detection.** Repeated overrides of the same category
   (`PATTERN_THRESHOLD`) raise a drift alert — a signal of model drift or an
   overly aggressive classifier.
7. **Never auto-resend.** An override only **unlocks** the Send button.
   `recordSent()` is a separate, explicitly-human, separately-audited action.
8. **Metrics.** `metrics()` exposes Safety Checks, Blocked, Queued, Overrides,
   Override Rate, False-Positive Candidates, Review-Queue depth, and Drift
   Alerts — surfaced on the Executive Intelligence dashboard.

## Escalation & notification (`AAA_GOVERNANCE_ESCALATION`)

The dashboard signal is passive. The escalation layer decides when to actively
**alert the owner/admin** — without spamming. It is generic (drift is the first
trigger; legal/accounting/contract/ad-copy/SMS/email/agent risks use the same
`escalate({ kind, domain, category, count, threshold, … })`).

- **Threshold windowing** — an escalation is keyed by `(kind, domain, category,
  windowIndex = floor(count / threshold))`. One escalation per window, so it does
  **not** fire on every override — only on a crossing.
- **Cooldown** — while an escalation is `open` and its count keeps climbing in the
  same window, re-notification is rate-limited (`governanceEscalationCooldownMs`,
  default 6h). No spam.
- **Duplicate suppression** — re-evaluating the same window updates the count/cases
  in place; it does not raise or re-notify (unless cooldown elapsed while open).
- **Status lifecycle** — `open → acknowledged → resolved`. Acknowledging silences
  re-notification; resolving closes the window. A **resolved window never
  re-opens** — only a *new* window (another threshold's worth of overrides) raises
  a fresh escalation.
- **Payload** — every escalation carries domain, category, override count,
  threshold, affected case IDs, and a recommended action.
- **Audited** — `escalation_raised`, `escalation_notified`, `escalation_acknowledged`,
  and `escalation_resolved` are all written to the immutable audit ledger.
- **Surfaced** — open escalations appear on the dashboard ("Open Escalations"),
  alongside the unchanged "Drift Alerts" signal, and emit a `governance.escalation`
  event for any notifier to consume.

`AAA_GOVERNANCE.requestOverride()` calls `evaluateDrift()` per category after an
override, so escalation is automatic — but additive: if the module is absent the
override path is unaffected.

## Delivery channels (`AAA_GOVERNANCE_NOTIFIER` + `/api/governance-alert`)

Escalation *events* become real notifications through a pluggable channel
registry. **Email is the only channel today**; SMS/push register later via
`registerChannel('sms', …)` with no change to the escalation engine.

- **Subscribe + gate** — the notifier subscribes once to `governance.escalation`
  and only delivers events whose `priority` meets `governanceAlertMinPriority`
  (default `high`). Because the engine emits *after* window/cooldown suppression,
  cooldown is honored for free — no spam.
- **PII-free by allowlist** — the payload forwarded to a channel is built from an
  explicit allowlist (domain, category, count, threshold, affected case IDs,
  recommended action, dashboard link, priority). Customer name/phone/email and
  the drafted message can never be included.
- **Audited** — every delivery writes `alert_attempt` then `alert_delivered` (with
  provider response + timestamp) or `alert_failed` to the immutable ledger.
- **Safe** — a channel error is caught; delivery failure never throws into the app.

The email channel POSTs to the Netlify function **`/api/governance-alert`**
(`netlify/functions/governance-alert.mjs`), which renders a PII-free email and
sends it via the configured provider (`resend` | `postmark` | `sendgrid`).

```bash
# Netlify site env:
GOVERNANCE_ALERT_EMAIL_TO=owner@yourco.com
GOVERNANCE_ALERT_EMAIL_FROM=alerts@yourco.com      # verified sender
GOVERNANCE_ALERT_EMAIL_PROVIDER=resend             # resend | postmark | sendgrid
GOVERNANCE_ALERT_EMAIL_API_KEY=...                 # provider key
```
Optional client config: `dashboardUrl` (deep-link in the email),
`governanceAlertEndpoint` (default `/api/governance-alert`),
`governanceAlertMinPriority` (default `high`). With env missing, the function
returns `MISSING_CONFIG` (500) and the app keeps running.

## Governance Intelligence Layer (Phase 1 — measurement infrastructure)

Governance no longer only reacts to safety events; it **supervises AI
performance**. Every measurable agent decision (quote, accounting, estimator,
contract, SEO, ads, review, scheduling, BI …) is registered, linked to its
real-world outcome, scored, and — when a line is crossed — escalated. This phase
builds the measurement infrastructure only. **No autonomous prompt
modification.**

- **Agent Outcome Registry** (`AAA_AGENT_OUTCOMES`) — `recordDecision({ agentId,
  agentType, confidence, recommendation, … })` → a record with `outcomeStatus`
  (`pending → successful | unsuccessful | overridden | abandoned`).
  `attachOutcome(decisionId, { result, value })` links a real result
  (won_job, lost_job, refund, complaint, chargeback, review_received,
  contract_signed, ad_conversion) and is written to the immutable ledger.
- **Training Queue** — every unsuccessful or overridden decision is queued
  (`gov_training_queue`) with decision, outcome, override reason, human
  correction, and final result. Labeled data for the future supervisor.
- **Agent Scorecards** (`AAA_AGENT_SCORECARDS`) — per agent: accuracy, override
  rate, success rate, average confidence, confidence calibration (Brier),
  ROI impact, revenue influenced, false-positive/negative rates. Metrics are
  `null` when the sample is thin (unproven, never falsely "bad"). `recompute()`
  persists the card, audits a **material score change** (`score_changed`), and
  raises **breach escalations** for low accuracy / override spike / broken
  calibration / ROI drop / accuracy drift.
- **Escalation integration** — breaches use `AAA_GOVERNANCE_ESCALATION.escalateBreach()`
  (condition-based sibling of count-windowed drift): one open breach per
  (kind, domain, agent), cooldown-gated re-notify, status lifecycle, and a
  resolved breach **re-opens on recurrence**. These flow through the same
  notifier → email channel as every other escalation.
- **Governance Supervisor foundation** (`AAA_GOVERNANCE_SUPERVISOR`) —
  `review(agentType)` turns a scorecard into retraining **recommendations**
  (logged as `retraining_recommendation`, flagged `autonomous:false`).
  `registerAnalyzer(fn)` is the hook for future supervisor agents. `applyChange()`
  is deliberately disabled — measurement first, no autonomous changes.
- **Dashboard** — Executive Intelligence shows top/worst agents, drifting agents,
  excessive-override agents, and agents needing retraining.

Audit (immutable ledger): every `outcome_attached`, `score_changed`,
`retraining_recommendation`, and escalation transition is recorded and
hash-chain verified.

## Automatic measurement (Phase 2 — instrumentation & linkage)

Governance is now active, not passive: important agent outputs and real business
outcomes feed the registry automatically. Pure instrumentation — no behavior
change to pricing, contracts, or customer-facing sends; every hook is wrapped so
a failure can never break the originating flow.

- **Bridge** (`AAA_GOVERNANCE_BRIDGE`) — `measure(agentType, opts)` records a
  decision (idempotent, audited); business events auto-attach outcomes. It
  subscribes to the app's existing `outcome.recorded` (won/lost/review/refund…)
  and `contract.signed` events and maps the app's vocabulary to registry results.
- **Decision linking** — every decision carries subjectType, subjectId, jobId,
  quoteId, customerId (internal reference only — never emailed), sourceModule,
  and agentVersion.
- **Idempotency** — the same agent + subject with an unchanged recommendation
  REUSES the pending decision; a materially-changed one UPDATES it in place
  (audited `decision_updated`). No duplicate rows on re-runs.
- **Backfill-safe** — `attachOutcomeByJob` / `attachOutcomeBySubject` simply
  attach nothing for legacy jobs that have no recorded decision; they never throw.
- **Wired today** — the **estimator** (`measurement-ai-assistant`) and the
  **review-request** agent record decisions; job won/lost, review received, and
  contract signed auto-attach. Scheduling/contract/ad/SEO agents inherit the same
  `measure()` call when present.
- **Visibility** — agent-drafted outputs show an unobtrusive **"Measured by
  Governance"** chip (`AAA_GOV_BADGE.badge(decisionId)`) opening a drawer with the
  decision id, agent, confidence, status, attached outcome, and audit ref. The
  main job list is left uncluttered.
- **Audit** — every auto-recorded decision (`decision_recorded`/`decision_updated`)
  and every auto-attached outcome (`outcome_attached`) enters the immutable ledger.

No autonomous retraining or prompt modification — this phase is instrumentation,
linkage, audit, and visibility only.

## Human-governed learning (Phase 3 — command center)

Closes the loop **without autonomy**: a human can see what agents are learning
from, what they get wrong, and what the supervisor recommends — but no prompt,
price, or send ever changes automatically. (`AAA_GOVERNANCE_LEARNING` + the
`AAA_GOVERNANCE_LEARNING_UI` screen, opened from Executive Intelligence.)

- **Training Queue** — unsuccessful / overridden / abandoned / refund /
  complaint / chargeback cases with agent, decision, recommendation, confidence,
  outcome, human correction, override reason, final result, and date. Filters by
  agentType, outcome type, severity, date, and status.
- **Supervisor Recommendations** — runs the supervisor in recommendation-only
  mode; each rec shows agent, issue, evidence, recommended change, expected KPI
  impact, risk level, and confidence. Nothing auto-applies.
- **Human actions (all audited)** — mark reviewed, accept (→ creates a task),
  reject, export training sample, create improvement task.
- **Improvement Task Ledger** — accepted recommendations create tasks (taskId,
  agentId, issue, recommended change, priority, owner, status
  open/in_progress/implemented/rejected, source training cases). Code/prompts are
  never changed automatically.
- **Performance Timeline** — per-agent accuracy/override/success/calibration/ROI
  trend via a lightweight unicode sparkline (no chart library).
- **Data-quality guardrails** — thin agents are labeled `insufficient_data` and
  excluded from harsh ranking; **missing outcomes (pending) are counted and
  flagged separately from bad outcomes** and never lower accuracy.
- **Export** — selected training samples as PII-stripped JSONL (allowlisted
  fields; emails/phones redacted; customer fields never included).

Audit (immutable ledger): `training_reviewed`, `recommendation_accepted`,
`recommendation_rejected`, `improvement_task_created`, `task_status_changed`,
and `training_exported` (ids + count only — never PII).

## Business-event completion + prompt-change pipeline (Phase 4)

**Part A — complete business-event wiring.** The bridge now subscribes to every
outcome event and credits only the agents each result actually validates:

| Event | Validates |
|-------|-----------|
| `quote.accepted` / `quote.rejected` | quote + estimator |
| `payment.completed` | quote + accounting + pos |
| `ad.lead.converted` | ads + seo |
| `review.received` (+ `outcome.recorded:review`) | review_request |
| `contract.signed` | contract + quote + estimator |

Attachment is idempotent at the decision level — a decision is validated by the
**first** real outcome only, so duplicate/late events can never double-count.
Missing agent types attach nothing and never throw. Every attachment is audited.

**Part B — human-approved prompt change pipeline** (`AAA_PROMPT_PIPELINE`).
A safe path from an accepted improvement task to a reviewed change — **no
autonomy**:

- Lifecycle: `draft → submitted → approved → implemented (→ rolled_back) | rejected`.
- A proposal carries proposalId, taskId, agentId, current prompt/version,
  proposed change, reason, evidence cases, expected KPI impact, risk level, and
  rollback notes.
- **Approval is Admin(owner)-only** and requires a written note (≥10 chars), a
  test-checklist confirmation, and a rollback note.
- **Implementation never auto-edits a prompt.** With no safe prompt registry it
  emits a manual *implementation patch/task* (`applied:false`). A versioned
  registry can be plugged in via `registerRegistry(adapter)`; then implementation
  applies the change behind Admin approval (`applied:true`) with `rollback()`.
- **Rollback** is tracked even when manual, linked to the proposal and task.
- The Diff Review UI (in the Learning Command Center) shows current vs proposed,
  linked evidence, and the approval gate; evidence export is PII-stripped.

Audit (immutable ledger): `prompt_proposal_created / _submitted / _approved /
_approval_denied / _rejected / _implemented / _rolled_back` and
`prompt_evidence_exported`.

## Governed versioned prompt registry (Phase 5)

The safe registry that lets approved prompt/process changes apply **for real** —
only through governance, fully reversible, fully audited. (`AAA_PROMPT_REGISTRY`,
auto-wired as the Phase-4 pipeline's registry.)

- **Versioned + hash-chained** — each agent has an entry (agentId, agentType,
  name, currentVersion, status active/archived/rollback, createdBy/approvedBy,
  timestamps) with an append-only `versions[]`, every version carrying a
  checksum chained to the previous one.
- **Safe API** — `getCurrent`, `getVersion`, `proposeVersion`, `approveVersion`,
  `applyVersion`, `rollback`. Approve/apply/rollback are **Admin(owner)-only**;
  apply requires an approved proposal + checklist confirmation + rollback note,
  and records the ledger audit ref on the version.
- **Governance integration** — the Phase-4 pipeline applies through this registry
  (an approved Phase-4 proposal → propose→approve→apply, carrying its approval
  context and source proposal id). Unapproved proposals cannot apply.
- **Runtime** — agents call `resolve(agentId, fallback)` and get the active
  version when one exists, else their built-in prompt. Nothing changes until an
  Admin approves and applies — verified for the estimator and review-request
  agents.
- **Rollback** appends a NEW version carrying the target's text; history is never
  deleted.
- **Tamper resistance** — `verify(agentId)` recomputes the checksum chain;
  `verifyAgainstLedger(agentId)` recomputes from stored text and compares to the
  immutable ledger checksum — a direct mutation is detected either way.
- **Export** — prompt history + approved proposals as JSON, with PII stripped
  from evidence/reason fields.
- **Diff + Rollback UI** — active version, full history with diffs, checksums,
  audit refs, and an Admin-only rollback, in the Learning Command Center.

Audit (immutable ledger): `prompt_version_proposed / _approved / _applied /
_rolled_back` and `prompt_registry_exported`.

## Org-wide governed prompts + staging channel (Phase 6)

- **Every agent governable** — `resolve()` is wired into the generic agent-os
  runner (so every sub-agent: sales, operations, marketing, accounting,
  customer_success, kpi, data_scientist, compliance, ceo) plus the job-notes,
  estimator, and review-request agents. Each uses the registry's active version
  when one exists, otherwise its built-in prompt — verified, no breakage.
- **Staging → production (canary)** — `applyVersion(proposalId, { channel:
  'staging' })` registers a version on the staging channel without touching
  production; `resolve(agentId, fallback, { channel: 'staging' })` reads it.
  `promote(agentId)` (Admin-only) swaps staging into production and clears
  staging. Version numbers are monotonic across channels and share one checksum
  chain, so integrity verification spans both. Apply (with channel) and
  `promote` are audited.

## Adding the next guardrail

A new high-risk guardrail (say contract-clause review) needs only to:
1. produce a decision (`allow` / `block` / `queue`) + verdict + categories,
2. call `AAA_GOVERNANCE.record({ domain: 'contract', subjectType, subjectId, … })`,
3. gate its own send/commit on the returned case status.

It then inherits the entire review → override → audit → training → analytics
pipeline for free. See `js/agents/review-request-engine.js` for the reference
integration.

## Tests

```
node test/run.js   # includes: audit-ledger, governance, review-governance, review-safety
```
Covers hash-chain integrity + tamper detection, the RBAC override gate,
mandatory justification, the full audit-field set, the review-queue copy, drift
alerts, never-auto-send, and the metrics math.
