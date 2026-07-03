# Agent Architecture Audit — AAA HyperKernel

Read-only audit of the agent, supervisor, governance, routing, and
multi-agent coordination code as of branch
`claude/aaa-hyperkernel-architecture-l0cen2` (July 2026). Produced before the
mission-manager layer was added, to answer one question honestly: **what
exists, what is duplicated nowhere, and what was actually missing?**

## 1. Existing standalone agents

| Agent | Module | Notes |
|---|---|---|
| Estimator | `js/agents/estimator-agent.js` | vision estimating |
| Job Notes | `js/agents/job-notes-agent.js` | |
| Marketing Intel | `js/agents/marketing-intel.js` | |
| Research Brain | `js/agents/research-brain.js` | |
| Review Requests | `js/agents/review-request-engine.js` | |
| Pricing Optimizer | `js/agents/pricing-optimizer.js` | |
| Persona registry | `js/agents/agent-registry.js` | CEO + 8 sub-agents + supervisor, shared `DECISION_SCHEMA`, runtime custom personas, self-improvement tunings |
| Ephemeral specialists | `js/genesis/ephemeral-agent-runtime.js` | hard sandbox: allowedReads/Writes, output-schema enforcement, budget enforcement, mandatory decision log |

## 2. Existing supervisor / manager agents

- `js/agents/supervisor.js` — **outcome** manager: links decisions to real
  outcomes, Brier-style confidence calibration, writes scores back.
- `js/governance/governance-supervisor.js` — governance-side supervision.
- `js/intelligence/executive-council.js`, `js/intelligence/agent-council.js`,
  `js/revenue/…`, `js/innovation/…` — deliberation councils.
- `js/agents/agent-os.js` `runMeeting()` — fan-out to sub-agents with CEO
  synthesis (a flat meeting, not a task-graph hierarchy).

**Honest classification:** these are *scoring, deliberation, and synthesis*
managers. Before this branch, none of them decomposed a mission into a task
graph, delegated per-task, or paused a graph on a human gate.

## 3. Existing governance / approval managers

- `js/agents/action-safety-gate.js` — allow / needs_approval / deny by blast radius; deny is terminal.
- `js/agents/escalation-policy.js` — auditable "what is high-stakes" policy (money, exposure, discounts, low confidence).
- `js/agents/challenge-protocol.js` + `js/intelligence/debate-engine.js` — critic/risk/counter review for high-stakes proposals.
- `js/intelligence/decision-inbox.js` — schema-locked decision cards, dry-run-only dispatch, governed approval.
- `js/governance/audit-ledger.js` — hash-chained, tamper-evident ledger.
- `js/governance/prompt-registry.js` + `prompt-change-pipeline.js` — governed prompts.
- `js/governance/decision-envelope.js` *(this branch)* — the ONE schema-locked
  contract every decision ships in; composes gate + escalation + ledger;
  gate-denied can never be human-approved.

## 4. Existing routing / orchestration logic

- `js/agents/agent-os.js` — persona execution through the real proxy, schema-enforced output, decision logging, gated next_actions.
- `js/agents/hermes-gateway.js` — channel router (UI/voice/automation → agent → reply).
- `js/agents/model-router.js` + `js/ai/model-router.js` — model/task-tier routing.
- `js/core/aaa-event-bus.js` — typed, contract-validated domain events.
- `js/agents/global-desk.js` *(this branch)* — market-scoped dispatch: country
  pack context injected, department → persona routing, envelope-sealed results.

## 5. What was genuinely missing (hierarchical agent-team management)

1. **Task-graph planning with mechanical validation** — closed by
   `js/agents/planning-desk.js`: cycles/unknown deps refused, mutating tasks
   require rollback + verification, approval phases require an APPROVED
   envelope.
2. **Independent reviewer with enforcement asymmetry** — closed by
   `js/agents/review-protocol.js`: schema-locked verdicts; can auto-reject,
   can never approve.
3. **A mission manager that ties 1+2 to delegation** — accept mission →
   classify risk → plan → delegate per task → review each result → pause on
   human gates → ledger everything → reroute failed work. **Closed by
   `js/agents/mission-manager.js` (this commit).**
4. **An explicit tenant boundary guard** — `workspaceId` scoping existed in
   every store read, but nothing REFUSED cross-tenant work by policy.
   **Closed by `js/core/tenant-guard.js` (this commit).**

## 6. International / company-scale architecture

- `js/core/country-packs.js` *(this branch)* — markets as configuration
  (currency, tax regime, units, invoice legal fields, privacy regime);
  runtime registration; unknown codes refused.
- Tenant seam: `AAA_CONFIG.workspaceId` flows through every collection write;
  the tenant guard now enforces it as a boundary, not just a filter.
- Still open (deliberate, not oversight): per-tenant model routing for
  retention/residency-restricted tenants (the model-router seam is where it
  goes), country-pack-aware quote/invoice UI flows, and an approval-inbox UI
  over `decision_envelopes`.

## Requested component map (the 10-item enterprise layer)

| Requested component | Status | Where |
|---|---|---|
| GlobalAgentManager | **built this commit** | `js/agents/mission-manager.js` |
| DepartmentAgentManager | existing + this branch | department→persona routing in `global-desk.js`; personas in `agent-registry.js` |
| AgentTaskRouter | existing | `global-desk.js` (departments), `model-router.js` (models), `hermes-gateway.js` (channels) |
| AgentTaskGraph | built (prev commit) | `planning-desk.js` |
| AgentResultReviewer | built (prev commit) | `review-protocol.js` |
| HumanApprovalGate | existing + this branch | `decision-envelope.js` approval states; `decision-inbox.js`; planning-desk approval phases |
| AgentRunLedger | existing | `genesis_runs` + `agent_decisions` + hash-chained `audit-ledger.js` |
| AgentPerformanceScorecard | existing | `agent-evaluation-lab.js`, `governance/agent-scorecards.js`, `supervisor.js` |
| CountryPolicyPackLoader | built (prev commit) | `country-packs.js` `register()/contextFor()` |
| TenantContextGuard | **built this commit** | `js/core/tenant-guard.js` |

**Design rule followed throughout:** nothing replaced. Every new module
composes the existing gate/escalation/ledger/orchestrator through their
public globals, degrades honestly when a dependency is absent, and refuses
rather than fabricates.
