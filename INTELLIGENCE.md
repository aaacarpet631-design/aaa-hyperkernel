# AAA Analysis Division — Autonomous Intelligence Org

The Analysis Division is no longer a set of agents that summarize and stop. It is
a multi-layer organization that **collects real data, analyzes it, challenges its
own conclusions, decides, learns from outcomes, and evolves.**

Everything below runs on the existing seams: the local-first store (shared
memory), the single Claude proxy funnel (`AAA_DATA.callAgent`), and the
Supervisor's outcome scoring. It is **honest by construction** — when the proxy
is not configured, model steps return `AI_NOT_CONFIGURED` and the system falls
back to the real, deterministic data instead of fabricating analysis.

## The six layers (`AAA_INTEL_PIPELINE`)

No analysis is accepted without passing all six:

| Layer | Name | What happens |
|------:|------|--------------|
| 1 | Data Collection | `AAA_INTEL_COLLECTORS` — deterministic rollups from real memory. No model. |
| 2 | Analysis | The team's analyst reasons **only** over Layer-1 numbers. |
| 3 | Validation | Critic + Risk analysts challenge it (`AAA_DEBATE`). |
| 4 | Supervisor Review | A supervisor arbitrates with a *calibrated* confidence and gates acceptance. |
| 5 | Executive Intelligence | Accepted findings roll up to the command center. |
| 6 | Learning & Evolution | Everything is logged so outcomes re-score it and analysts get ranked/evolved. |

`AAA_INTEL_PIPELINE.runTeam(teamId)` runs one team through all six; `runAll()`
runs every team. With no proxy, it stops at Layer 1 with `status:'collected_only'`.

## The six teams (`AAA_ANALYSIS_DIVISION.TEAMS`)

`revenue`, `pricing`, `customer`, `operations`, `marketing`, `ai` — each a domain
analyst with its own charter, the metrics it tracks, and the outputs it owns.
Each team's real numbers come from the matching collector, so analysts are
**forbidden from inventing figures**.

## Internal debate (`AAA_DEBATE`)

```
Recommendation → Critic → Risk → Supervisor verdict
```

A recommendation is accepted because it **survived challenge**, not because it
sounded good. A blocking risk caps an "accept" down to "revise". The full
transcript + verdict is stored in `debates`, and the arbitrated decision is
logged so the Supervisor scores it once the real outcome is known. The goal is
accuracy, not agreement.

## Supervisor Council (`AAA_COUNCIL`)

Five domain supervisors (Revenue, Operations, Marketing, Customer, AI) vote
approve / reject / revise on major decisions, each from their own lens. Votes,
rationale, and the tally are stored in `council_votes`; `linkOutcome()` records
the real result later so the council's own judgment becomes scorable track record.

## Meetings (`AAA_MEETINGS`)

Daily Operations Briefing · Weekly Executive Intelligence · Monthly Strategic
Planning · Quarterly Business Evolution. Each gathers the relevant real
collectors + recent analyses, reviews the last meeting's action items against the
data, and produces owned, prioritized action items into `meetings`. `due(cadence)`
reports whether enough time has elapsed — nothing fires silently.

## Analyst Rankings (`AAA_RANKINGS`)

Every analyst that has logged a decision is scored on six axes, computed **only**
from real memory: **Accuracy** (calibration), **Business Impact** (realized won
revenue), **Risk Detection** (did it doubt the deals that lost?), **Learning**
(measured calibration improvement over time), **Trust** (reliability discounted
for thin sample), and **Overall**. An axis is `null` (not zero) when data is too
thin — a new analyst is *unproven*, never falsely *bad*. `refresh()` re-scores
history via the Supervisor and stores a dated snapshot.

## Self-evolution (`AAA_EVOLUTION`)

`scan()` reads real signals of blind spots (domains stuck at low confidence,
rejected/blocked debates, ranking-coverage gaps) and proposes how to fill each: a
new analyst, workflow, metric, report, or dashboard. `createAnalyst(gap)` turns an
approved analyst gap into a real, runnable agent through the **Prompt Architect** —
so the org grows itself. Spawning is on request (or explicit `autoCreate`), never
silent.

## Executive Intelligence Dashboard (`AAA_INTEL_DASHBOARD`)

Opened from Command Center → **Executive Intelligence**. One screen over real
memory: domain health, risk level, prediction accuracy, growth opportunities,
critical threats, the analyst leaderboard, council decisions, meeting outcomes,
and evolution gaps — plus the buttons that drive the org (run a team, run all,
convene the council, hold a meeting, scan for gaps, refresh rankings).

## Tests

```
npm test   # node test/intelligence-smoke.mjs
```

Loads the intelligence modules in a sandbox with an in-memory store and a mock
proxy, seeds realistic data, and asserts the deterministic math (collectors +
rankings, hand-checked) plus end-to-end wiring of every engine — including the
"no proxy → real data only, no fabrication" path.
