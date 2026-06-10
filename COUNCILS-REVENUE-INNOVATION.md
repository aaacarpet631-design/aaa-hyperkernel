# Revenue Intelligence Council + Innovation Council

> HyperKernel no longer just *operates* AAA Carpet. It continuously discovers,
> tests, simulates, validates, and recommends new ways to grow revenue and
> margin — fully governed and auditable.

Both councils operate strictly through the existing nervous system and never
mutate production directly:

```
Event Bus → Knowledge Graph → World Model → Simulation Council
          → Council (compose engines) → Council Governance (HUMAN_APPROVAL_REQUIRED)
          → policy.change_approved → policy.change_applied → Outcome Learning
```

## Shared governance — `js/revenue/council-governance.js` (`AAA_COUNCIL_GOVERNANCE`)

One governed path for both councils (domain is a parameter). `propose(domain,
rec)` records an append-only pending recommendation and emits
`revenue.recommendation_proposed` / `innovation.recommendation_proposed`;
`approve()` requires `MANAGE_GOVERNANCE` + a ≥20-char written reason and emits
`policy.change_approved`; `apply()` emits `policy.change_applied`. Every
transition is on the hash-chained audit ledger. Nothing auto-applies.

## Revenue Intelligence Council (`js/revenue/`, `AAA_REVENUE_COUNCIL`)

Six layers, each a deterministic engine over **real data** (honest
`insufficient_data` where a source is missing — no fabricated metrics):

| Layer | Engines | Output |
|---|---|---|
| Market Intelligence | demand-pulse, neighborhood-opportunity, competitor-intelligence, market-intelligence | `{marketScore, demandIndex, opportunityIndex, confidence}` |
| Attention | search-intent (5 classes), creative-evolution, budget-physics | `{intentType, probability, expectedCloseRate, recommendedMessage}` |
| Trust | trust-gap, proof-assembly, authority-builder | `{trustScore, trustGaps, recommendedProofAssets}` |
| Estimate Intelligence | win-probability, margin-guardian, objection-forecast | `{winProbability, marginRisk, likelyObjections, recommendation}` |
| Decision Acceleration | silence-analyzer, timing, followup-intelligence | buying stage ∈ {Interested…Ghosted, Lost} + sequence |
| Review Flywheel | review-velocity, reputation, referral | `{reviewProbability, referralProbability, reputationScore}` |

Dashboard (`AAA_REVENUE_DASHBOARD`): lead quality, close probability, CAC,
margin, review velocity, referral velocity (read model only).

## Innovation Council (`js/innovation/`, `AAA_INNOVATION_COUNCIL`)

| Layer | Engines | Notes |
|---|---|---|
| Venture Discovery | adjacency-mapper, venture-discovery, opportunity-registry | adjacent lines (water mitigation, epoxy, commercial, maintenance, recurring); append-only registry |
| Business Model Simulation | business-model-simulator | **integrates the Simulation Council** — runs a counterfactual, attaches the immutable sim runId; no production mutation |
| Technology Scouting | technology-scout | ROI from explicit cost/benefit inputs |
| Automation Discovery | automation-discovery | Human Task → Automation Candidate, scored on savings/risk/complexity/ROI |
| Strategic Experiments | experiment-registry, experiment-scorecard | every experiment MUST declare a rollback plan (rejected otherwise) |

Dashboard (`AAA_INNOVATION_DASHBOARD`): opportunities discovered, experiments
running, projected ROI, validated/rejected.

## Governance guarantees

- No production mutation (tests assert production collections byte-for-byte
  unchanged through both full council flows).
- No silent path to production — every recommendation emits a proposed event
  and requires human approval with a written reason before apply.
- Append-only history (recommendations, opportunities, experiments).
- Deterministic reads for fixed data + time.
- No fabricated metrics — `insufficient_data` everywhere a real source is absent
  (CAC, weather, permits, competitor feed are honestly unpopulated until wired).

## Tests

`test/unit/revenue-council.test.js` (27) + `test/unit/innovation-council.test.js`
(23) = 50 assertions covering every required area, plus governance, simulation
integration, determinism, append-only history, and production isolation.

## Known limitations

- CAC, weather impact, permit activity, housing turnover, and competitor
  pressure have no live feed yet → reported `insufficient_data` (honest).
  Ingestion seams exist (`competitor-intelligence.observe`).
- `business-model-simulator` runs sensitivity through existing Simulation
  Council scenario kinds (price/crew/spend proxies); bespoke recurring-revenue
  scenario kinds would tighten the projection.

## Next recommended organ

A **Teleological Goal Engine** — shift from reactive recommendations to
goal-seeking: define a target system-state vector, compute the delta from
current reality, and route resource allocation + simulation toward closing it,
under hard governance boundaries. (Queued.)
