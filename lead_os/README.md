# Lead OS Phase 1D Core

This package starts the Lead OS Agent Integration build.

It is deliberately framework-light so it can be mounted into the Hermes/FastAPI Lead OS service without forcing an app refactor before the policy core is stable.

## Included in this slice

- `agent_auth.py`
  - Hashed API key lookup
  - Agent identity model
  - Least-privilege default agent scopes
  - Fail-closed scope checks
- `supervisor.py`
  - Agent action ledger
  - Approval policy helper
  - Supervisor queue projection
  - Risk/priority classification
- `outcomes.py`
  - Outcome registry
  - Agent-action outcome links
  - Agent performance scorecards
- `tests/test_lead_os_phase_1d.py`
  - Auth/scope tests
  - Approval policy tests
  - Supervisor queue tests
  - Outcome-scorecard tests

## Example

```python
from lead_os import AgentCredentialStore, default_agent_identities

store = AgentCredentialStore()
store.add_plaintext_key("dev-sales-key", default_agent_identities()[0])
agent = store.require_scope("dev-sales-key", "leads:read")
```

## Next build slice

Mount this into the existing Lead OS FastAPI service:

1. Hydrate `AgentCredentialStore` from SQLite/Postgres/secrets.
2. Add a request dependency that resolves `Authorization: Bearer <key>`.
3. Require route scopes on agent-facing APIs.
4. Record allowed and denied actions to durable storage.
5. Expose Supervisor Queue and Agent Scorecards to the dashboard.
