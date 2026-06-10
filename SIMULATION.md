# Simulation Council — the Counterfactual Engine

> Reality teaches HyperKernel. Simulation lets HyperKernel learn **before**
> reality. The next evolutionary jump is not more agents — it is the ability to
> reason about futures.

The kernel already learns from what happened (Event Bus → Graph → Ledger →
Reputation → ROI). The Simulation Council adds the mirror: ask *what if* —

- What happens if we raise prices 7%?
- What happens if we add a third crew?
- What happens if we stop servicing a zip code?
- What happens if fuel rises 20%?
- What happens if Google Ads spend doubles?
- What happens if a hurricane hits Houston?

— and get a bounded, governed answer **before** committing reality to it.

## Modules (`js/simulation/`)

| Module | Global | Role |
|---|---|---|
| `simulation-ledger.js` | `AAA_SIM_LEDGER` | immutable run record (assumptions, snapshot, calibration+policy version, seed, outcomes) + append-only recommendations & actuals |
| `scenario-engine.js` | `AAA_SCENARIO_ENGINE` | six scenario kinds with explicit assumptions; baseline derived from a read-only snapshot (real where derivable, labeled where assumed) |
| `outcome-estimator.js` | `AAA_OUTCOME_ESTIMATOR` | transparent elasticity models → impact on the seven metrics; pure & deterministic |
| `monte-carlo-engine.js` | `AAA_MONTE_CARLO` | seeded mulberry32; thousands of draws → best / expected / worst + p05/p50/p95 |
| `counterfactual-runner.js` | `AAA_COUNTERFACTUAL_RUNNER` | snapshot → versions → scenario → baseline → Monte Carlo → immutable record; `replay()` is exact |
| `policy-simulator.js` | `AAA_POLICY_SIMULATOR` | A/B pricing / dispatch / scheduling / marketing / approval policies vs the status-quo hold |
| `strategy-scorecard.js` | `AAA_STRATEGY_SCORECARD` | upside / risk / confidence / score; the dashboard read model |
| `simulation-governance.js` | `AAA_SIM_GOVERNANCE` | recommendation gate + the reality-grades-prediction learning loop |

## The seven estimated metrics

`revenue · margin · utilization · responseTime · callbacks · closeRate · csat`.
Every scenario's effect on these comes from a **documented elasticity model**, not
a black box — each coefficient has a named range the Monte Carlo engine explores
and a midpoint that is the expected case.

## Invariants this organ adds

1. **Scenarios are immutable.** Every run records assumptions, the input-graph
   snapshot (hash + counts + baseline), the calibration version, the policy
   version, the random seed, and the generated outcomes — append-only.
2. **No simulation mutates production.** Graph access is read-only; the only
   writes go to `sim_*` collections. The separate ledger *is* the isolation
   guarantee (a test asserts production is byte-for-byte unchanged).
3. **Deterministic.** A `{scenario, baseline, seed, n}` tuple is bit-identical
   every time; `replay(runId)` reproduces a stored run exactly.
4. **Monte Carlo is honestly bounded.** worst ≤ expected ≤ best;
   p05 ≤ p50 ≤ p95; per-metric distributions are reported.
5. **No silent path to production.** A simulation-driven recommendation emits
   `simulation.recommendation_proposed` and waits for a human with authority +
   a written reason (mirrors genesis/promotion governance).
6. **Reality closes the loop.** `recordActual(runId, actual)` compares predicted
   vs actual per metric, scores accuracy (1 − MAPE), appends it immutably,
   updates a per-scenario calibration bias, and fans the delta out to outcome
   learning and capability reputation when present — emitting
   `simulation.actual_recorded`.

## Dashboard (data, not cosmetic UI)

`AAA_STRATEGY_SCORECARD.dashboard()` returns highest-upside, highest-risk,
strongest-confidence scenarios, failed assumptions (metrics whose error exceeded
25%), and simulation accuracy over time.

## Tests

`test/unit/simulation-council.test.js` (36 assertions) covers all nine required
areas: deterministic replay, production isolation, Monte Carlo bounds,
recommendation governance, prediction-vs-actual scoring, plus scenario
assumptions, baseline derivation, outcome estimation, policy simulation, and the
dashboard. Run: `npm test` (suite `simulation-council`).
