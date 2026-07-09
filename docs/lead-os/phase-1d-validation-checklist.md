# Lead OS Phase 1D Validation Checklist

Use this checklist before marking Phase 1D complete.

## Repository safety

- [ ] Work is on a feature branch, not direct-to-main.
- [ ] Existing MVP files are not rewritten unnecessarily.
- [ ] Backward compatibility is preserved for existing Phase 1A–1C flows.
- [ ] New behavior is covered by tests or explicit manual verification notes.

## Authentication and authorization

- [ ] Agent API keys are stored hashed or otherwise protected.
- [ ] API key lookup resolves `agent_id`, `agent_type`, status, and scopes.
- [ ] Disabled agents cannot act.
- [ ] Missing credentials fail closed.
- [ ] Missing scopes fail closed.
- [ ] Scope-denied attempts are logged when identity is known.
- [ ] Customer-facing write actions require explicit write scopes.

## Agent route coverage

- [ ] Sales Agent can read leads/customers and create follow-up tasks.
- [ ] Estimator Agent can draft estimates but cannot send final customer price without approval.
- [ ] Follow-Up Agent can send only approved template follow-ups without approval.
- [ ] Review Agent can request reviews but public GBP replies require approval.
- [ ] Accounting Agent cannot mutate invoices/payments without approval.
- [ ] Supervisor Agent can read the queue and approve/reject gated actions.

## Supervisor ledger

- [ ] Every successful agent action emits an `AGENT_ACTION` event or record.
- [ ] Every blocked/denied agent action emits an audit record where possible.
- [ ] Agent action includes confidence score when available.
- [ ] Agent action includes risk score when available.
- [ ] Agent action includes target type and target id.
- [ ] Agent action records approval status.
- [ ] Risky actions are visible in supervisor queue.

## Approval rules

- [ ] Customer-visible final price requires approval.
- [ ] Discount/refund/warranty/callback promise requires approval.
- [ ] Non-template SMS/email requires approval.
- [ ] GBP public reply requires approval.
- [ ] Negative review reply receives high priority.
- [ ] Low confidence or high risk estimate is not exposed to customer.
- [ ] Legal/compliance-sensitive content is blocked or escalated.

## Outcome learning

- [ ] Outcomes can be created for won/lost leads.
- [ ] Outcomes can be created for job completion.
- [ ] Revenue and margin outcomes are supported.
- [ ] Review outcomes are supported.
- [ ] Complaint/callback outcomes are supported.
- [ ] Outcomes can link to one or more agent actions.
- [ ] Agent scorecards derive from actions and outcomes.

## Dashboard

- [ ] Supervisor Queue view exists.
- [ ] Agent Performance Leaderboard exists.
- [ ] Lead Velocity metric exists.
- [ ] Close Rate metric exists.
- [ ] Follow-Up Health Score exists.
- [ ] Review Conversion Rate exists.
- [ ] Revenue Forecast exists.
- [ ] Pipeline Leakage Analysis exists.

## Integration readiness

- [ ] AI Quote Assistant has a safe Lead OS contract.
- [ ] Missed Call Recovery has a safe Lead OS contract.
- [ ] SMS Follow-Up Engine has a safe Lead OS contract.
- [ ] Review Harvester has a safe Lead OS contract.
- [ ] Google Ads/SEO agents are read-only unless explicitly approved.
- [ ] Accounting integration uses approval-gated mutation rules.
- [ ] Future Multi-Agent Council can read supervisor telemetry.

## Production hardening

- [ ] Rate limiting applies to agent APIs.
- [ ] Request IDs are required or generated.
- [ ] Idempotency is supported for write actions.
- [ ] Secrets are not committed.
- [ ] Health checks cover agent auth and event emission.
- [ ] Error responses use a standard envelope.
- [ ] Backup/recovery notes exist for new tables.
- [ ] Migration rollback notes exist.

## Acceptance statement

Phase 1D is accepted only when Lead OS can safely answer:

1. Which agent acted?
2. What did it try to do?
3. Was it allowed?
4. Did a human approve it when needed?
5. What business record did it affect?
6. What happened afterward?
7. Did that agent make the business better or worse?
