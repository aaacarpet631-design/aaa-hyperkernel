# Lead OS Phase 1D Validation Checklist

Use this checklist before marking Phase 1D complete.

## Current build status

- [x] Phase 1D documentation contract added.
- [x] Framework-light `lead_os` package scaffold added.
- [x] Agent identity, hashed API key lookup, and fail-closed scope checks added.
- [x] Least-privilege default scopes added for Sales, Estimator, Follow-Up, Review, Accounting, and Supervisor agents.
- [x] Supervisor action ledger and queue projection added.
- [x] Approval policy helper added for risky/customer-visible actions.
- [x] Outcome registry, action-outcome links, and scorecard builder added.
- [x] Unit tests added for auth, denied scopes, approval rules, supervisor queue, and scorecards.
- [x] Core enums use portable `str, Enum` pattern instead of Python 3.11-only `StrEnum`.
- [ ] Durable DB-backed storage wired.
- [ ] FastAPI route dependencies wired.
- [ ] Dashboard cards wired.
- [ ] CI test run confirmed in GitHub Actions or local dev environment.

## Repository safety

- [x] Work is on a feature branch, not direct-to-main.
- [x] Existing MVP files are not rewritten unnecessarily.
- [x] Backward compatibility is preserved for existing Phase 1A–1C flows.
- [x] New behavior is covered by tests or explicit manual verification notes.

## Authentication and authorization

- [x] Agent API keys are stored hashed or otherwise protected.
- [x] API key lookup resolves `agent_id`, `agent_type`, status, and scopes.
- [x] Disabled agents cannot act.
- [x] Missing credentials fail closed.
- [x] Missing scopes fail closed.
- [ ] Scope-denied attempts are logged when identity is known in durable storage.
- [x] Customer-facing write actions require explicit write scopes or approval policy.

## Agent route coverage

- [x] Sales Agent scope contract exists for leads/customers and follow-up tasks.
- [x] Estimator Agent scope contract exists for draft estimates and approval requests.
- [x] Follow-Up Agent scope contract exists for approved template follow-ups.
- [x] Review Agent scope contract exists for review requests and draft replies.
- [x] Accounting Agent scope contract blocks direct invoice/payment mutation by default.
- [x] Supervisor Agent scope contract can read the queue and approve/reject gated actions.
- [ ] Agent route dependencies are mounted into the live API service.

## Supervisor ledger

- [x] Successful agent actions can emit an `AgentAction` record.
- [x] Blocked/denied actions have a model path for audit recording.
- [x] Agent action includes confidence score when available.
- [x] Agent action includes risk score when available.
- [x] Agent action includes target type and target id.
- [x] Agent action records approval status.
- [x] Risky actions are visible in supervisor queue projection.
- [ ] Supervisor ledger is persisted to the production database.

## Approval rules

- [x] Customer-visible final price requires approval.
- [x] Discount/refund/warranty/callback promise requires approval.
- [x] Non-template SMS/email requires approval.
- [x] GBP public reply requires approval.
- [x] Low confidence or high risk estimate is not exposed to customer by default.
- [x] Legal/compliance-sensitive content is escalated.
- [ ] Negative review reply receives high priority as a route-level integration rule.

## Outcome learning

- [x] Outcomes can be created for won/lost leads.
- [x] Outcomes can be created for job completion.
- [x] Revenue and margin outcomes are supported.
- [x] Review outcomes are supported.
- [x] Complaint/callback outcomes are supported.
- [x] Outcomes can link to one or more agent actions.
- [x] Agent scorecards derive from actions and outcomes.

## Dashboard

- [ ] Supervisor Queue view exists in the live dashboard.
- [ ] Agent Performance Leaderboard exists in the live dashboard.
- [ ] Lead Velocity metric exists in the live dashboard.
- [ ] Close Rate metric exists in the live dashboard.
- [ ] Follow-Up Health Score exists in the live dashboard.
- [ ] Review Conversion Rate exists in the live dashboard.
- [ ] Revenue Forecast exists in the live dashboard.
- [ ] Pipeline Leakage Analysis exists in the live dashboard.

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
- [x] Secrets are not committed.
- [ ] Health checks cover agent auth and event emission.
- [x] Error responses have a documented standard envelope.
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
