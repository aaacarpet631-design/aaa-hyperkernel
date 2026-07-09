# Lead OS Agent API Contract

## Principle

Agents are workers, not owners. Lead OS owns the business record. Agents may only act through authenticated, scoped API calls that create auditable events.

## Agent identity

Every request from an agent must resolve:

```json
{
  "agent_id": "sales-agent-v1",
  "agent_type": "sales",
  "display_name": "Sales Agent",
  "scopes": ["leads:read", "tasks:write"],
  "status": "active"
}
```

## Scope naming

Use `resource:action` scopes:

- `customers:read`
- `customers:write_note`
- `leads:read`
- `leads:update_stage`
- `estimates:read`
- `estimates:create_draft`
- `estimates:request_approval`
- `jobs:read`
- `jobs:schedule_request`
- `tasks:read`
- `tasks:create`
- `tasks:update_status`
- `messages:create_template_followup`
- `messages:create_custom_draft`
- `reviews:request`
- `reviews:draft_reply`
- `accounting:read`
- `accounting:sync_suggestion`
- `supervisor:read_queue`
- `supervisor:approve_action`
- `supervisor:reject_action`

## Required request headers

```http
Authorization: Bearer <agent-api-key>
X-Agent-Id: sales-agent-v1
X-Request-Id: <uuid>
```

`X-Request-Id` supports idempotency and traceability.

## Standard response envelope

```json
{
  "ok": true,
  "data": {},
  "event_id": "evt_...",
  "agent_action_id": "act_...",
  "approval_required": false,
  "warnings": []
}
```

Failure envelope:

```json
{
  "ok": false,
  "error": {
    "code": "SCOPE_DENIED",
    "message": "Agent does not have estimates:create_draft scope",
    "request_id": "..."
  },
  "agent_action_id": "act_..."
}
```

Even denied actions should be recorded when the agent identity is known.

## Approval rules

The following actions must be `pending_approval` unless the policy engine explicitly marks the action as pre-approved:

- Customer-visible final price
- Discount, refund, callback, or warranty promise
- Public Google Business Profile reply
- Non-template SMS/email
- Payment/invoice mutation
- Legal/compliance-sensitive language
- High-risk estimate confidence below threshold
- Any action with missing required source evidence

## Route contract examples

### Create follow-up task

```http
POST /api/v1/agent/tasks
```

Required scope: `tasks:create`

```json
{
  "lead_id": "lead_123",
  "task_type": "follow_up",
  "due_at": "2026-07-10T15:00:00-05:00",
  "note": "Follow up on carpet repair estimate",
  "source_action": "estimate_sent_followup_sequence"
}
```

### Draft estimate

```http
POST /api/v1/agent/estimates/draft
```

Required scope: `estimates:create_draft`

```json
{
  "lead_id": "lead_123",
  "service_type": "carpet_stretching",
  "customer_safe_summary": "Carpet stretching for living room and hallway.",
  "internal_notes": "Review wrinkles near transition strip.",
  "confidence_score": 0.78,
  "risk_score": 0.31
}
```

### Request review

```http
POST /api/v1/agent/reviews/request
```

Required scope: `reviews:request`

```json
{
  "job_id": "job_123",
  "customer_id": "cust_123",
  "template_id": "review_request_default",
  "channel": "sms"
}
```

## Enforcement checklist

For each agent route:

- Resolve agent identity from API key.
- Verify agent status is active.
- Verify scope.
- Validate target resource exists.
- Validate business state transition.
- Apply approval rule.
- Emit `AGENT_ACTION`.
- Emit business event if action changes business state.
- Return standard response envelope.
