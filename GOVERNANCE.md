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
