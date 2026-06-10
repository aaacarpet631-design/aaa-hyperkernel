# Genesis Council — the Dynamic Agent Foundry

> Static agents are permanent employees. Ephemeral agents are temporary
> specialists. The kernel only hires a temp when no employee can do the job —
> and every hire is governed, logged, evaluated, and terminated.

The foundry replaces "a static directory of hundreds of hardcoded subagent
files" with **agent DNA**: every dynamic agent is generated from

```
Action + Entity + Context/Event  =  Ephemeral Agent

verify    + invoice + over $10,000   →  large-invoice-verification-agent
detect    + damage  + bleach stains  →  bleach-damage-vision-agent
calculate + margin  + holiday OT     →  holiday-margin-calculator-agent
translate + review  + korean         →  korean-review-translation-agent
```

## One transposition, stated up front

The directive asked for `src/hyperkernel/genesis/*.ts` with Zod schemas. This
kernel is a zero-dependency, browser-global JS PWA — there is no TypeScript
toolchain, no bundler, and no npm runtime dependency to hang Zod on; `.ts`
files would be dead code nothing loads. The architecture is therefore realized
**natively** (the same transposition every existing subsystem made — see the
Event Bus header), 1:1 with the requested modules:

| Requested (`src/hyperkernel/genesis/`) | Native module (`js/genesis/`) | Global |
|---|---|---|
| `genesis-council.ts` | `genesis-council.js` | `AAA_GENESIS_COUNCIL` |
| `agent-factory.ts` | `agent-factory.js` | `AAA_AGENT_FACTORY` |
| `capability-registry.ts` | `capability-registry.js` | `AAA_CAPABILITY_REGISTRY` |
| `spawn-policy.ts` | `spawn-policy.js` | `AAA_SPAWN_POLICY` |
| `ephemeral-agent-runtime.ts` | `ephemeral-agent-runtime.js` | `AAA_EPHEMERAL_RUNTIME` |
| `promotion-engine.ts` | `promotion-engine.js` | `AAA_PROMOTION_ENGINE` |
| `termination-engine.ts` | `termination-engine.js` | `AAA_TERMINATION_ENGINE` |
| `agent-template.schema.ts` (Zod) | `agent-template-schema.js` (deterministic validator) | `AAA_AGENT_TEMPLATE` |
| `capability-gap-detector.ts` | `capability-gap-detector.js` | `AAA_GAP_DETECTOR` |

## The four classes of agents

| Class | Nature | Examples |
|---|---|---|
| **A — Kernel** | permanent, immutable physics | governance, audit, provenance, graph |
| **B — Council** | persistent domain managers | scheduling, accounting, estimator |
| **C — Specialist** | ephemeral, single-task, spawned on demand | `bleach-damage-vision-agent` |
| **D — Swarm** | massively parallel disposables (map-reduce) | reserved; schema-supported |

Genesis can only mint C and D — the template validator **rejects** a spec
claiming class A or B. Permanence is earned through promotion, never asserted.

## The ten-step flow (all enforced, all tested)

```
1  Event → typed Event Bus (contract-validated, hash-chained)
2  Supervisor checks the permanent Capability Registry      (canHandle)
3  No handler → Capability Gap Detector fires               (capability_gaps)
4  Genesis Council splices DNA → ephemeral spec             (agent-factory)
5  Spawn Policy validates permissions, risk, cost           (audited; held cases → governance)
6  Ephemeral Runtime executes ONE narrow task               (hard sandbox)
7  Decision Log written                                     (runtime-owned — bypass impossible)
8  Approved facts → Knowledge Graph substrate               (graph_facts + entity collection)
9  Promotion Engine evaluates keep / improve / discard      (computed from real runs)
10 Termination Engine scrubs temp context, closes the run   (genesis.terminated)
```

## The ephemeral agent schema

Every generated spec carries all required fields — `agentId, name, council,
action, targetEntity, triggerEvent, allowedReads, allowedWrites,
forbiddenActions, tools, maxRuntimeMs, maxCostUsd, riskLevel,
approvalRequired, expectedOutputSchema, rollbackPlan, terminationCondition`
(plus `klass` and `context`) — and is validated before it can spawn. An
invalid genome is never returned, only the validation failure.

## Safety rules (mechanical, not advisory)

The ten baseline prohibitions (contact customers, change prices, issue
refunds, delete records, modify payroll, alter legal contracts, bypass the
event bus / knowledge graph / decision logging, spawn another agent) are
**part of the schema**: a spec that drops one is invalid. Beyond the list:

- **Sandboxed reads/writes** — the runtime denies reads outside
  `allowedReads` and writes facts only into `allowedWrites`; protected
  collections (payroll, contracts, rate card, the audit chain itself…) are
  unclaimable at the schema level.
- **Output contract** — output failing `expectedOutputSchema` fails the run
  and writes **zero** facts.
- **Budgets enforced** — wall-clock `maxRuntimeMs` and `maxCostUsd` fail the
  run when exceeded; the spawn policy caps what a spec may even request.
- **Spawn-of-spawn denied** — `spawnedByAgent` without explicit Council
  approval is a hard deny.
- **High risk → held** — `needs_approval` parks the spec in `genesis_holds`
  and opens a governance case; only a human with `OVERRIDE_AI_DECISION`
  authority and a ≥ 20-char written reason releases it. Fail-closed.
- **Honest by construction** — no executor + no proxy → the run records
  `AI_NOT_CONFIGURED`; nothing is fabricated, and the failure itself is
  decision-logged.

## Promotion rules (a temp earns the desk)

All five must hold: **≥ 5 spawns**, **≥ 80% success**, **only low-risk
decisions**, **measurable time/money saved** — all computed from real
`genesis_runs`, never asserted — and **governance approval** (RBAC
`MANAGE_GOVERNANCE` + written reason, audited). Approval registers the
agent's signature in the Capability Registry as a permanent class-B handler,
so the next matching event is *handled*, not *spawned for*. Termination's
`rollback()` executes the spec's rollback plan: graph facts are tombstoned
(`retracted: true`), never erased.

## The Tool Forge — dynamic interface generation (Tool DNA)

Dynamic agents bolted to static tools just move the bottleneck, so tool
generation mirrors agent generation (`js/genesis/tool-forge.js`,
`AAA_TOOL_FORGE`). There is no repository of OpenAPI specs; tools are
synthesized from **Tool DNA**:

| Vector | Registry |
|---|---|
| Protocol | `GraphQL · REST · Cypher · Local_RPC · BLE_Telemetry` |
| Target | `KnowledgeGraph · PWALedger · SquarespaceWebhook · HardwareSensor` |
| Action | `Mutate · Query · Validate · Revert · Hash` |

When the runtime spawns a Class C specialist it calls `forgeFor(spec, runId)`:
a microscopic, schema-strict toolset **bound to that agent and run** — a
ledger mutator per allowed write collection (single-use), a graph query, a
validator, a hasher. The executor receives only `{tools, invoke, request}`;
`invoke()` mechanically enforces binding (another agent's call →
`TOOL_NOT_YOURS`), discard state, the invocation budget (`TOOL_EXHAUSTED` on
the second swing of a single-use wrench), and args-vs-`inputSchema`
(`INVALID_ARGS`). The agent cannot hallucinate a capability: unknown DNA is
unrequestable (`INVALID_TOOL_DNA`), and protocols without a registered driver
return `TOOL_TARGET_UNBOUND` — telemetry is never simulated. Hardware/external
drivers plug in through `registerHandler(protocol, target, fn)` (the governed
seam used for e.g. Roberts-stapler burn-rate or Crain-knife maintenance reads).

**BYOT** (bring-your-own-tool): a running agent may request a tool it lacks.
`Local_RPC` requests forge immediately; external protocols are **held
fail-closed** until a human approves with a ≥ 20-char written reason. Every
forged bridge is written to the Knowledge Graph (`agent —forged→ tool`), and
every forge / invocation / discard is audited.

**One deliberate divergence** from the "delete the code before a human even
realizes there was a gap" framing: at termination the run's tools are
*discarded* — they refuse to execute forever — but their definitions and
invocation logs are immutable audit state. Nothing in this kernel dissolves
silently; that is kernel invariant #4, and it outranks the aesthetic.

## First demonstration (in `test/unit/genesis-foundry.test.js`, 51 assertions)

```
photo.uploaded {photoId, jobId, tags:[bleach, stain]}
→ no permanent detect+damage handler            (canHandle → null, gap recorded)
→ Council spawns bleach-damage-vision-agent     (class C, council: operations_intelligence)
→ agent reads Photo/Job/Customer context        (its allowedReads — payroll read: DENIED)
→ writes DamageAssessment                       (damage_assessments)
→ decision logged                               (agent_decisions, genesis-flagged, audited)
→ Knowledge Graph: Photo —indicates→ BleachDamage  (graph_facts, full provenance)
→ run terminated                                (context scrubbed, genesis.terminated on the bus)
→ after 5 clean runs: promotion proposed → governance-approved → PERMANENT
→ the next bleach photo is handled by the permanent agent — no spawn
```

Run it: `npm test` (suite `genesis-foundry`).
