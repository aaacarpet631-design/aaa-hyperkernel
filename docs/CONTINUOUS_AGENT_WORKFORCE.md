# Continuous Agent Workforce — Architecture (Slice 1)

How AAA HyperKernel runs an always-on agent workforce without pretending a
browser tab is a server, and without letting "continuous" mean "ungoverned."

## Why browser-only continuous agents are insufficient

A PWA sleeps. Tabs are frozen, phones lock, service workers get evicted, and
`setInterval` stops the moment the OS decides it should. Any design that
treats the browser as the continuous runtime produces agents that *appear*
always-on and silently aren't — the worst possible failure mode for a system
whose selling point is trustworthiness. The browser's job is **visibility
and control** (the Workforce Command Center, the Approval Inbox), never
**liveness**.

## The split: scheduler core vs. runner

The scheduler (`js/agents/workforce-scheduler.js`) is deliberately split
from whatever drives it:

- **Scheduler core** — pure, deterministic, timer-free. `runDue(at)` computes
  due work from each agent's **persisted `nextRunAt`** in the Workforce
  Registry and executes it through the Mission Manager. Calling it twice for
  the same instant does not double-run agents (nextRunAt advances on run;
  in-flight agents are skipped).
- **Runner** — whoever calls `runDue()`. Today: tests, the "Run now"/tick
  controls in the app, or an open tab. Next slice: a **server-side cron**
  (Netlify scheduled function / Cloud Function / small worker) that calls the
  same tick against the shared datastore. Because due-ness lives in data,
  moving from "tab-driven" to "server-driven" changes *who calls the
  function*, not the function.

## Current local/test runner

In this slice everything is local-first and test-driven: `runDue()` is
invoked manually (tests, UI). This is intentional — the control plane must
be provably correct before anything is allowed to run it unattended.

## Future server runner (next slice)

A scheduled serverless function (the repo already runs Netlify functions)
that: loads the workspace datastore, calls `AAA_WORKFORCE_SCHEDULER.runDue()`,
and exits. Event triggers arrive the same way (webhook → `onEvent(type,
payload)`). GitHub notifications fit here: a GitHub webhook or scheduled poll
feeds `onEvent('repo.activity', …)`, which the Repo Watcher agent consumes to
draft owner summaries — read-only analysis, no repository actions from the
workforce itself.

## Secrets

The client never holds provider keys — model calls already go through the
server proxy (`AAA_DATA.callAgent` → Netlify function). The server runner
uses the same proxy path with function-scoped environment secrets. Workforce
records contain **no** secrets, and `allowedTools`/`dataScopes` are
capability *declarations* enforced at dispatch, not credentials.

## Owner approvals

Nothing changes: workforce missions run through `AAA_MISSION_MANAGER`, so an
approval-mode phase pauses the mission, the job parks in `awaiting_approval`,
and it surfaces in the **Approval Inbox** (and as a count in the Workforce
panel). Approval requires a human with `OVERRIDE_AI_DECISION` (owner-only by
matrix); the envelope layer refuses non-human approver identities — the
workforce cannot approve its own work, by construction.

## Failure modes and containment

| Failure | Behavior |
|---|---|
| Model not configured | Mission refuses (`AI_NOT_CONFIGURED`); job → `failed`; agent health degrades; tick continues |
| Agent throws | Caught; its job fails; other agents in the tick still run |
| Risk above ceiling | Job → `blocked` (`RISK_CEILING`) **before any model call** |
| Cross-tenant context | Tenant guard refuses before any model call; job → `failed` |
| Critical review rejection | Mission `needs_revision`; job → `blocked`; nothing completes |
| Governance module missing | The whole tick refuses (`GOVERNANCE_MISSING`) — absence of a guard is not permission |
| Runaway mission | `MAX_STEPS` bound → job `failed` (`STEP_BUDGET_EXCEEDED`) |

## Kill switch

`continuousAgentsEnabled` (config flag, **default `false`**) gates all
scheduled and event-driven execution. When off, `runDue()`/`onEvent()` are
no-ops that say so, while the UI still renders full state. `runNow()` is the
single deliberate exception: a manual, in-session owner action (RBAC
`MANAGE_AUTOMATION`), still subject to enablement and full governance. A
future server runner must check the same flag — it reads the same config.

## Cost controls

Per-agent `costUsd` counters accumulate from runs; risk ceilings and the
draft-only mission texts of the default agents bound blast radius; the
mission layer's model routing (per-tenant policy, task-kind tiers) applies
unchanged. Next slice adds per-agent budget ceilings that block scheduling
when exceeded.

## Tenant isolation

Workforce records, jobs, and missions are all workspace-scoped. Mission
contexts are deep-scanned by the tenant guard before any model sees them; a
foreign `workspaceId` anywhere in an agent's data scopes fails the job with
`TENANT_BOUNDARY` and zero provider calls.

## Auditability

Every job transition, enable/disable, and registration appends to the
hash-chained audit ledger; job records carry the audit entry ids
(`auditRefs`). Missions add their own trail (start, phases, gates, reroutes,
envelopes, reviews). "What did the workforce do overnight" is a ledger
query, not a reconstruction.
