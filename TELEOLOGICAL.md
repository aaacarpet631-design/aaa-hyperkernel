# Teleological Engine (HyperKernel 2.5)

> The break from reactive cybernetics. Instead of "If X → Do Y," the kernel
> holds a **target system-state vector** and continuously synthesizes the path
> that most reduces the delta between current reality and that target — under
> hard, un-bypassable boundaries.

## The bridge

```
Reality (Event Bus / Graph / World Model)
  → Teleological Goal Engine   (delta to target vector, total system effect)
  → Resource Allocator         (finite cash/crew/inventory → highest-yield paths)
  → Simulation Council         (forward-test the chosen path)
  → Council Governance         (HUMAN_APPROVAL_REQUIRED before any policy change)
  → Outcome Learning           (reality re-scores the prediction)
```

## Modules (`js/intelligence/`)

| Module | Global | Role |
|---|---|---|
| `teleological-schema.js` | `AAA_TELEOLOGICAL_SCHEMA` | the six-dimension SystemStateVector + OperationalGoal validators (native "Zod") |
| `goal-engine.js` | `AAA_TELEOLOGICAL_GOAL_ENGINE` | weighted state delta, total system effect, current-vector resolution, governed pursuit |
| `resource-allocator.js` | `AAA_RESOURCE_ALLOCATOR` | multi-objective greedy allocation of finite resources by teleological yield |

**System state vector:** `grossMargin · reviewVelocity · crewUtilization ·
materialYield · customerSentiment · riskExposure`.

## What it does

- **Total System Effect** — `evaluateTotalSystemEffect(current, projectedImpact,
  goal)` returns a `strategicScore` (how much the *whole* ecosystem moves toward
  target) so the kernel can accept a lower-margin job when it advances a
  higher-weighted goal (e.g. review velocity) — without single-point myopia.
- **Un-bypassable boundaries** — any path that drops margin below the floor or
  pushes risk past the ceiling is `REJECT_CRITICAL_BOUNDARY_VIOLATION`, no matter
  how attractive its score. Tested directly.
- **Finite resource reality** — cash, ad budget, crew hours, and staged
  inventory are scarce; the allocator funds the highest-yield paths that fit and
  have positive efficiency, and **nothing** when the pool is empty.
- **Honest current vector** — `currentVector()` reads live World Model signals
  (margin, review velocity, utilization) and the reputation engine (sentiment);
  dimensions with no live source are filled from labeled assumptions and named in
  `assumed[]`, lowering confidence — never silently fabricated.
- **Governed pursuit** — `pursue(goal, proposals, {resources, simulate})` scores
  proposals, drops boundary violators, allocates resources, optionally runs the
  Simulation Council, and proposes the top path into Council Governance
  (`strategy.recommendation_proposed` → human approval). It mutates no production
  state.

## Governance guarantees

Hard boundaries live in the core evaluation and cannot be routed around. No
goal pursuit allocates cash, changes pricing, or schedules crews — it only
*proposes*, and a human with `MANAGE_GOVERNANCE` + a written reason must approve
before `policy.change_applied`. Goals are append-only (`teleological_goals`).

## Tests

`test/unit/teleological.test.js` (21 assertions): state-delta math + the three
reference cases (approve net-positive low-margin path, reject margin-floor
breach, optimize allocation under scarcity), plus World Model current-vector
resolution, governed pursuit, determinism, and production isolation.

## Known limitations

- `materialYield` and `riskExposure` have no live signal source yet → resolved
  from labeled assumptions (honest), pending a roll-layout/scrap feed and a
  risk-tier model on the event bus.
- The allocator is greedy (fast, deterministic); a true LP/ILP solver would find
  globally-optimal bundles when proposals interact.

## Next recommended organ

A **Generative Tool-Forge ↔ Goal Engine loop**: when a goal pursuit detects a
capability gap, splice an ephemeral agent (Genesis) with a forged tool aimed
specifically at closing the largest-weighted delta — closing the loop between
strategic intent and self-assembling execution.
