# Lead OS Supervisor and Outcome Learning Spec

## Purpose

Phase 1D needs a closed loop: agents act, the supervisor observes, humans approve risky decisions, outcomes are attached, and future agent decisions improve from measured business results.

## Core objects

### Agent action

An agent action is the audit unit for anything an agent attempts.

Suggested fields:

```sql
agent_actions (
  id text primary key,
  request_id text not null,
  agent_id text not null,
  agent_type text not null,
  action_type text not null,
  target_type text not null,
  target_id text,
  input_summary text not null,
  output_summary text,
  confidence_score real,
  risk_score real,
  business_impact_estimate text,
  approval_status text not null,
  policy_flags text,
  error_code text,
  created_at text not null
)
```

Allowed `approval_status` values:

- `not_required`
- `pending_approval`
- `approved`
- `rejected`
- `blocked`

### Supervisor queue item

The queue is a projection derived from agent actions and business state.

Suggested fields:

```sql
supervisor_queue (
  id text primary key,
  agent_action_id text not null,
  priority text not null,
  reason text not null,
  target_type text not null,
  target_id text,
  recommended_decision text,
  status text not null,
  created_at text not null,
  resolved_at text
)
```

Priority levels:

- `low`
- `normal`
- `high`
- `critical`

Queue status:

- `open`
- `approved`
- `rejected`
- `dismissed`

### Outcome record

Outcome records attach real business results to work done by humans and agents.

Suggested fields:

```sql
outcomes (
  id text primary key,
  outcome_type text not null,
  customer_id text,
  lead_id text,
  estimate_id text,
  job_id text,
  revenue_cents integer,
  margin_cents integer,
  review_score integer,
  complaint_flag integer not null default 0,
  callback_flag integer not null default 0,
  source_event_id text,
  created_at text not null
)
```

### Agent action outcome link

A many-to-many bridge supports attribution without pretending one agent always caused one outcome.

```sql
agent_action_outcomes (
  agent_action_id text not null,
  outcome_id text not null,
  influence_type text not null,
  weight real not null default 1.0,
  primary key (agent_action_id, outcome_id)
)
```

Influence types:

- `created_lead`
- `qualified_lead`
- `drafted_estimate`
- `followed_up`
- `scheduled_job`
- `requested_review`
- `recovered_payment`
- `prevented_risk`

## Supervisor policy examples

### Estimate draft

- Confidence >= 0.80 and risk <= 0.25: store as draft, human review still required before sending.
- Confidence 0.60–0.79 or risk 0.26–0.50: supervisor queue, normal priority.
- Confidence < 0.60 or risk > 0.50: supervisor queue, high priority, do not expose to customer.

### Follow-up message

- Approved template + normal lead state: allowed.
- Custom message: pending approval.
- Angry customer sentiment: pending approval, high priority.
- Legal, payment dispute, refund, or warranty language: blocked or pending owner approval.

### Review reply

- Draft only by default.
- Public reply requires approval.
- Negative review reply requires high priority supervisor queue.

## Scorecard metrics

Each scorecard should be computable from `agent_actions`, `outcomes`, and bridge records.

```json
{
  "agent_id": "follow-up-agent-v1",
  "window_days": 30,
  "actions_attempted": 240,
  "actions_completed": 221,
  "blocked_actions": 3,
  "approval_rate": 0.92,
  "human_override_rate": 0.08,
  "revenue_influenced_cents": 1850000,
  "wins_influenced": 18,
  "losses_influenced": 7,
  "average_confidence": 0.84,
  "average_risk": 0.18,
  "review_requests_sent": 35,
  "reviews_received": 11,
  "complaints_linked": 1,
  "callbacks_linked": 0
}
```

## Dashboard card definitions

### Agent Performance Leaderboard

Sort by a weighted score:

```text
business_score = revenue_influence + win_influence + review_influence - complaint_penalty - callback_penalty - override_penalty
```

### Supervisor Queue

Show open items grouped by priority with target, agent, reason, and recommended decision.

### Pipeline Leakage Analysis

Show drop-off by stage:

- New lead not contacted
- Contacted but no estimate
- Estimate sent but no follow-up
- Follow-up active but no win/loss
- Job complete but no review request
- Review request but no review received

### Follow-Up Health Score

Combine:

- overdue task count
- untouched estimate count
- average time since last contact
- high-value lead staleness

## Event mapping

Agent behavior should create both audit events and business events when appropriate.

| Action | Agent action | Business event |
| --- | --- | --- |
| Lead note added | yes | optional `LEAD_CONTACTED` if state changes |
| Estimate drafted | yes | `ESTIMATE_DRAFTED` or existing estimate event if supported |
| Estimate sent | yes | `ESTIMATE_SENT` |
| Follow-up task created | yes | task event if supported |
| Job scheduled | yes | `JOB_SCHEDULED` |
| Job completed | yes | `JOB_COMPLETED` |
| Review requested | yes | `REVIEW_REQUESTED` |
| Review received | optional | `REVIEW_RECEIVED` |

## Non-negotiables

- Every agent action is traceable.
- Every blocked action is visible.
- Every customer-visible decision is reviewable.
- Every business outcome can be linked back to prior actions.
- Scorecards are generated from events and outcomes, not manual opinions.
