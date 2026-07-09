# Lead OS Phase 1D Core

This package starts the Lead OS Agent Integration build.

It is deliberately framework-light so it can be mounted into the Hermes/FastAPI Lead OS service without forcing an app refactor before the policy core is stable.

## Included so far

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
- `storage.py`
  - SQLite migration runner
  - Durable agent credential storage
  - Durable supervisor action + queue storage
  - Durable outcome + attribution storage
  - Reload support for scorecard generation after process restart
- `tests/test_lead_os_phase_1d.py`
  - Auth/scope tests
  - Approval policy tests
  - Supervisor queue tests
  - Outcome-scorecard tests
- `tests/test_lead_os_storage.py`
  - Credential persistence tests
  - Supervisor persistence tests
  - Outcome/scorecard persistence tests
- `migrations/lead_os_phase_1d.sql`
  - Idempotent SQLite migration artifact for the MVP service

## Example

```python
from lead_os import AgentCredentialStore, default_agent_identities

store = AgentCredentialStore()
store.add_plaintext_key("dev-sales-key", default_agent_identities()[0])
agent = store.require_scope("dev-sales-key", "leads:read")
```

## Durable storage example

```python
from lead_os import LeadOsSQLiteStore, default_agent_identities

store = LeadOsSQLiteStore("data/lead_os.db")
store.save_credential(raw_key="dev-sales-key", identity=default_agent_identities()[0])
agent_store = store.load_credential_store()
agent = agent_store.require_scope("dev-sales-key", "leads:read")
```

## Next build slice

Mount this into the existing Lead OS FastAPI service:

1. Add a request dependency that resolves `Authorization: Bearer <key>`.
2. Require route scopes on agent-facing APIs.
3. Record allowed and denied actions to durable storage.
4. Expose Supervisor Queue and Agent Scorecards to the dashboard.
