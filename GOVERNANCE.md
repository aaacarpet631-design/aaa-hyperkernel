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
