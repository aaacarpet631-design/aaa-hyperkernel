# Lead OS Phase 1D — Agent Integration

## Mission

Turn the Phase 1 Lead OS MVP into the governed customer-intelligence backbone for AAA HyperKernel. Phase 1D connects agents to Lead OS through scoped APIs, supervisor monitoring, outcome learning, and dashboard-ready telemetry without allowing any agent to own or directly mutate core business data.

## Build status

First build slice started in this PR:

- Added framework-light `lead_os` Python package.
- Added hashed agent API key resolution and fail-closed scope enforcement.
- Added least-privilege default scopes for Sales, Estimator, Follow-Up, Review, Accounting, and Supervisor agents.
- Added supervisor action ledger, approval policy helper, and queue projection.
- Added outcome registry, weighted action-outcome attribution, and agent scorecard builder.
- Added unit tests covering auth, denied scopes, approval rules, supervisor queueing, and scorecards.

Remaining implementation work:

- Mount package into the live Lead OS FastAPI service.
- Persist credentials, supervisor actions, queue items, outcomes, and links in the production database.
- Wire route dependencies and dashboard cards.
- Run CI/local tests in the target environment.

## Current baseline from Hermes

Phase 1A–1C delivered:

- 6 MVP tables: `customers`, `leads`, `estimates`, `jobs`, `tasks`, `events`
- 9 pipeline stages from `NEW_LEAD` through review collection
- 9 immutable business events
- 7 core APIs for lead, estimate, job, won/lost, and review workflows
- HTMX/Alpine dashboard with Kanban, Jobs, Follow-Up, Revenue, and Reviews
- Webhooks for website forms, CallRail, Twilio SMS, SendGrid email, Google LSA, QuickBooks, health, and related integrations
- HMAC verification, dedupe, sentiment detection, QuickBooks sync, field-service sync, and Google Business Profile review support

## Phase 1D deliverables

### 1. Agent API keys and permission scopes

Create an agent access layer with explicit scope checks per route. Agents receive API keys with least-privilege permissions and never bypass Lead OS APIs.

Initial agents:

| Agent | Read scopes | Write scopes | Approval requirement |
| --- | --- | --- | --- |
| Sales Agent | leads, customers, estimates, tasks | notes, tasks, followups | Required for quote-send or discount changes |
| Estimator Agent | leads, estimates, jobs, pricebook, photos | estimate drafts, notes, review requests | Required before customer-visible price |
| Follow-Up Agent | leads, tasks, estimates, events | followups, notes, task status | Required for non-template message |
| Review Agent | jobs, customers, reviews, tasks | review requests, review replies draft | Required for public GBP reply |
| Accounting Agent | customers, jobs, estimates, invoices, payments | invoice sync notes, payment status suggestions | Required for invoice/payment mutation |
| Supervisor Agent | all telemetry, all events, agent actions | approvals, risk flags, escalation notes | Owner/system only |

### 2. Supervisor action ledger

Every agent action must emit an `AGENT_ACTION` event containing:

- `agent_id`
- `agent_type`
- `action_type`
- `target_type`
- `target_id`
- `input_summary`
- `output_summary`
- `confidence_score`
- `risk_score`
- `business_impact_estimate`
- `approval_status`
- `policy_flags`
- `created_at`

Policy default: fail closed. Missing scope, missing target, invalid transition, risky content, or missing required approval blocks execution and records the attempted action.

### 3. Outcome registry

Add an outcome-learning layer that records whether agent-influenced work improved the business.

Outcome types:

- `LEAD_WON`
- `LEAD_LOST`
- `JOB_COMPLETED`
- `REVENUE_RECORDED`
- `MARGIN_RECORDED`
- `REVIEW_RECEIVED`
- `CUSTOMER_COMPLAINT`
- `REFUND_OR_CALLBACK`
- `AD_CONVERSION`

Each outcome should link back to the lead/job/customer/estimate plus any contributing agent actions.

### 4. Agent scorecards

Create a scorecard projection for each agent:

- action volume
- approval rate
- blocked-action rate
- won/lost influence
- revenue influenced
- review-score influence
- complaint/callback influence
- average confidence
- average risk
- human override rate

### 5. Dashboard upgrades

Phase 1D dashboard cards:

- Agent Performance Leaderboard
- Supervisor Queue
- Lead Velocity
- Close Rate
- Follow-Up Health Score
- Review Conversion Rate
- Revenue Forecast
- Pipeline Leakage Analysis

### 6. Integration seams

Lead OS becomes the API source for:

- AI Quote Assistant
- Missed Call Recovery
- SMS Follow-Up Engine
- Review Harvester
- Google Ads Agents
- SEO Agents
- Accounting System
- KPI Dashboard
- Future Multi-Agent Council

## Implementation boundaries

- Do not mutate existing Phase 1 MVP routes unless needed for scope checks or event emission.
- Do not let agents write directly to database tables.
- Do not expose internal cost, margin, waste, labor, or risk fields to customer-facing agents unless explicitly scoped.
- Do not send SMS/email/GBP replies automatically unless the action is template-approved and policy-safe.
- Do not overwrite immutable event history.

## Slice plan

### Slice 1 — Readiness audit and contracts

- Confirm existing API route names, schemas, and state transitions.
- Add agent contract docs and validation checklist.
- Identify all places where events must be emitted.

### Slice 2 — Auth and RBAC

- Add `agent_api_keys` or equivalent credential table.
- Add middleware/dependency to resolve agent identity.
- Enforce scopes route-by-route.
- Add audit tests for denied actions.

### Slice 3 — Supervisor ledger

- Add `AGENT_ACTION` event emission.
- Add supervisor queue projection.
- Add approval-required classification.

### Slice 4 — Outcome registry

- Add outcome records/projection.
- Link outcomes to agent actions.
- Build scorecard metrics.

### Slice 5 — Dashboard and integration hardening

- Add dashboard cards.
- Add health checks and test fixtures.
- Add production-readiness notes.

## Definition of done

Phase 1D is complete when:

- Each named agent can authenticate with a scoped key.
- Each route enforces least-privilege scope checks.
- Every agent action emits supervisor telemetry.
- Risky/customer-visible actions require human approval.
- Outcomes link back to agent actions.
- Scorecards expose agent performance without manual spreadsheet work.
- Existing MVP flows remain backward compatible.
