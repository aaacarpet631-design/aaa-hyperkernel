# HyperKernel Executive Copilot

## Purpose
The human interface to HyperKernel — the owner talks to the business like
ChatGPT and gets one clear, governed answer drawn from the real councils,
ledgers, simulations, goals, and graph. It never fabricates, never bypasses
governance, and never performs a protected action.

## Architecture (`js/copilot/`)
```
owner question
  → copilot-intent-router        classify → {intent, confidence, requiredCouncils,
                                              requiredData, riskLevel, governanceRequired}
  → executive-copilot            orchestrate
       ├─ governance_action → copilot-governance-gate → HUMAN_APPROVAL_REQUIRED + approval package
       ├─ simulation_request → copilot-simulation-interface → Simulation Council
       ├─ goal_request       → copilot-goal-interface → Teleological Engine
       ├─ morning_briefing   → morning-briefing-engine
       └─ analysis intents   → council-query-engine → executive-synthesizer
  → copilot-memory-retriever     enrich with theories/beliefs
  → answer {summary, keyMetrics, threats, opportunities, bottlenecks,
            recommendedActions, confidence, missingData, governanceRequired}
copilot-ui          5 mobile screens (pure render model + DOM-guarded mount)
voice-input-adapter SpeechRecognition if present, graceful text fallback
copilot-dashboard-readmodel  Observatory read model
```

## Intent routing
Twelve intents: `business_status, revenue_analysis, operations_analysis,
customer_analysis, estimate_analysis, simulation_request, goal_request,
risk_report, opportunity_report, morning_briefing, governance_action, unknown`.
The router is deterministic (keyword) and returns the full routing contract.
Low confidence or `unknown` → the Copilot asks for clarification and executes
nothing.

## Council query flow
`council-query-engine` fans out **read-only** to the existing read models
(Revenue, Innovation, Simulation/Strategy, Teleological/World Model, Capability
Economy, Knowledge Compounding, Governance ledger, Scientific Discovery
bottlenecks). Any source with no data returns `insufficient_data` — never a
fabricated number.

## Synthesis flow
`executive-synthesizer` collapses the bundle into one owner-level answer in
plain language — key metrics, threats, opportunities, bottlenecks, recommended
actions — with confidence that drops as `missingData` grows. No raw agent dumps;
no exaggerated certainty.

## Simulation flow
"What happens if…" → `copilot-simulation-interface` parses the scenario, runs the
Counterfactual Runner (sim ledger only, never production), and returns
expected/best/worst/confidence/assumptions/recommendation with
`approvalRequired:true` (acting on a simulation is a protected change).

## Goal flow
"Add $50k/month" → `copilot-goal-interface` defines a teleological goal, computes
the current delta and capability gaps (via the Goal-Capability Bridge), and
suggests experiments. It never auto-executes; applying anything needs approval.

## Governance boundaries
Protected actions (pricing, customer messages, ad spend, schedule, dispatch,
refunds, payroll, legal, contracts, tax, bank movement, capability promotion,
production config) are **never performed**. A `governance_action` intent is
halted with `HUMAN_APPROVAL_REQUIRED` and an approval package (a pending
Council-Governance recommendation, append-only + audited).

## UI screens
1. **Talk To My Business** — chat input, suggested questions, answer cards, confidence + missing-data display.
2. **Executive Briefing** — threats, opportunities, bottlenecks, focus today.
3. **Simulate** — quick scenario prompts, result cards.
4. **Goals** — create goal, target delta, recommended experiments.
5. **Observatory** — councils, recommendations, simulations, capability gaps, governance pending.

## Example questions
"How are we doing this week?" · "Why are leads down?" · "How much money did we
make?" · "What happens if I raise prices 5%?" · "How do I add $50k per month?" ·
"What are my biggest risks?" · "What are my best opportunities?"

## Known limitations
- Operations snapshot (crew/schedule) and CAC are `insufficient_data` until live
  ops/spend telemetry is wired (honest by construction).
- Intent routing is keyword-deterministic; an LLM router (governed) would handle
  paraphrase better — the seam is the single `classify()` call.

## Next recommended organ
A **multi-turn Copilot session memory** (conversation context + follow-ups) and
an **owner notification stream** that proactively pushes the morning briefing and
approval requests — turning the Copilot from pull to push.
