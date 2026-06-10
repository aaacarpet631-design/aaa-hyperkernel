# World Model + Signal Intelligence Layer

> Simulation is only as smart as the signals feeding it. The World Model turns
> graph facts, events, and business metrics into fresh, governed strategic
> signals — and refuses to let stale or fabricated state drive the future.

## The unified intelligence stack

```
Reality
  → Event Bus            (typed, hash-chained facts)
  → Knowledge Graph      (current state + provenance)
  → World Model          (signals: derived, append-only, freshness-protected)  ◄── this organ
  → Simulation Council   (counterfactual futures over a safe snapshot)
  → Strategic Recommendation
  → Governance           (human approval before production)
  → Actual Outcome
  → Calibration          (prediction vs actual → reputation + sim calibration)
        ↑__________________________________________________________________|
```

The World Model sits between the graph and the Simulation Council: it converts
raw reality into the signals strategy reasons over, and it is the thing that
guarantees a simulation is never silently driven by stale state.

## Modules (`js/intelligence/`)

| Module | Global | Role |
|---|---|---|
| `signal-registry.js` | `AAA_SIGNAL_REGISTRY` | the 11 recognized signal types + units, policies, TTLs |
| `world-state-ledger.js` | `AAA_WORLD_STATE_LEDGER` | append-only, deep-frozen signal timeline; current state is a derived read model |
| `signal-freshness-sentinel.js` | `AAA_SIGNAL_FRESHNESS_SENTINEL` | entropy decay (confidence × e^−volatility·hoursStale); block / degrade / require-override / insufficient |
| `signal-derivation-engine.js` | `AAA_SIGNAL_DERIVATION_ENGINE` | derives signals from real graph/events; null + insufficient_data when data is missing |
| `world-model.js` | `AAA_WORLD_MODEL` | facade: refresh / observe / readModel / **snapshot** (usable vs withheld) |
| `signal-quality-scorecard.js` | `AAA_SIGNAL_QUALITY_SCORECARD` | coverage / freshness / confidence of the live signal set |
| `causal-hypothesis-store.js` | `AAA_CAUSAL_HYPOTHESIS_STORE` | governed causal layer; append-only evidence; status projected from it |
| `causal-learning-engine.js` | `AAA_CAUSAL_LEARNING_ENGINE` | pure inference rule + correlation (which can never alone imply causation) |
| `prediction-actual-comparator.js` | `AAA_PREDICTION_COMPARATOR` | append-only predicted-vs-actual deltas; feeds calibration/reputation |
| `intelligence-scorecard.js` | `AAA_INTELLIGENCE_SCORECARD` | 8-dimension self-assessment with honest insufficient_data |

## The signal schema

Every signal carries: `signalId, signalType, value, unit, source, confidence,
volatility, observedAt, expiresAt, stalePolicy, derivationMethod,
relatedEntities, provenanceId`. The 11 types: `lead_volume, close_rate,
quote_accuracy, callback_rate, crew_utilization, response_time, gross_margin,
job_profitability, review_velocity, marketing_cac, schedule_capacity`.

## Invariants this organ adds

1. **Signals are append-only.** History is never rewritten; current state is a
   read model projected from the latest record per type. Records are deep-frozen.
2. **Stale signals cannot silently drive simulations.** The Freshness Sentinel
   blocks, degrades (entropy decay), or requires override; the World Model
   `snapshot()` splits signals into `usable` and `withheld`, and the Simulation
   Council only ever overlays `usable` ones — a withheld stale signal is never
   applied to a baseline.
3. **No fake values.** Missing data → `null` / `insufficient_data`, never a
   fabricated number. (The reference design's `|| 0.85` fallbacks were
   deliberately rejected.)
4. **Correlation is not causation.** A hypothesis only reaches `supported` after
   enough low-counter-evidence observations; correlation can *propose*, never
   *promote*.
5. **No production mutation.** The layer reads production collections and writes
   only `world_signals`, `causal_*`, `prediction_deltas` (a test asserts
   production is byte-for-byte unchanged through derive + snapshot + consume).
6. **No flattering defaults in the scorecard.** Each of the eight dimensions is
   `insufficient_data` when it has no real basis; the composite is computed only
   over available dimensions, and is itself `insufficient_data` when too few
   exist.

## Tests

`test/unit/world-model.test.js` (36 assertions) covers every required area:
signal creation, append-only ledger, current-state read model, stale
blocking/degrading, insufficient-data behavior, derived lead volume / close rate
/ gross margin, causal hypothesis creation + evidence append + supported/rejected
transitions, prediction-vs-actual scoring, scorecard insufficient-data, no
production mutation, and safe integration with the Simulation Council snapshot.

## Known limitations

- `crew_utilization`, `response_time`, `callback_rate`, `marketing_cac`, and
  `schedule_capacity` currently derive to `insufficient_data` — they need live
  ops/fleet/marketing telemetry wired into the event bus to produce real values.
  This is honest by construction (no fabricated ops metrics), not a bug.
- `businessImpact` and `graphCompleteness` in the intelligence scorecard report
  `insufficient_data` unless the graph/governance engines expose the needed
  rollups in the running workspace.

## Next organ

A **Macroeconomic & Competitor Signal Bridge**: ingest external signals (fuel
indices, local housing turnover, competitor pricing) under the same governed
signal schema, so the World Model — and therefore the Simulation Council — can
reason about forces originating outside the company's own ledger.
