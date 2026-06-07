# HM-1 Implementation Report — The Heartbeat (`AAA_HYPERMIND`)

**Phase:** HM-1 of the HyperMind roadmap (see `HYPERMIND-AUDIT.md`).
**Mission mapping:** Phase 1 — the continuous Observe→…→Repeat loop that runs
without a button click.
**Status:** ✅ Shipped. Full suite **1587 passed / 0 failed / 98 suites**.

## What it does
Adds a governed **heartbeat** that drives the *existing* intelligence modules
through the nine canonical phases on a clock:

```
Observe → Remember → Predict → Plan → Execute → Measure → Learn → Update → Repeat
```

| Phase | Existing module it drives (null-tolerant) |
|---|---|
| Observe | `AAA_OUTCOME_INTELLIGENCE.ingest` (new outcome events) |
| Remember | `AAA_GRAPH.build` + `AAA_LEARNING_FABRIC.ingest` |
| Predict | `AAA_PREDICTION_CLOSURE.evaluate` |
| Plan | `AAA_PRICING_OPTIMIZER.analyze` (+ `AAA_INTEL_PIPELINE.runAll` on `deep` ticks) |
| Execute | **delegates to `AAA_HYPERMIND_EXECUTOR` if installed** — HM-1 ships none → advisory-only |
| Measure | `AAA_OUTCOME_INTELLIGENCE.scoreAgents` + `AAA_PREDICTION_CLOSURE.close` |
| Learn | `AAA_OUTCOME_INTELLIGENCE.extractPatterns` + `AAA_LEARNING_FABRIC.refresh` |
| Update | `AAA_RELIABILITY.snapshot` + `AAA_RANKINGS.refresh` |
| Repeat | interval scheduling metadata |

It **adds no new cognition** — it makes what already exists run itself.

## Design guarantees (consistent with the kernel's ethos)
- **OFF by default.** Gated on owner flag `hypermindEnabled`. `boot()` is a no-op
  until the owner enables it, so existing behaviour is unchanged. Verified by test.
- **Honest + null-tolerant.** Every phase is wrapped: a missing module → `skipped`;
  a thrown error → `error` on that phase; the loop continues. A throwing module
  was verified to degrade (not crash) the tick. No fabricated results.
- **Auditable.** Every tick is persisted to the append-only `hypermind_ticks`
  ledger and logged to `agent_logs`. `status()` / `history()` / `metrics()` expose
  per-phase reliability for the Command Center (P7 panel lands later).
- **Advisory-only in HM-1.** The `Execute` phase is a clean seam: it runs an
  installed governed executor or defers. **HM-4 installs the autonomous executor
  here** — no rewrite needed.
- **Kill switch + floor.** `stop()` clears the interval immediately;
  `setEnabled(false)` is the owner kill switch; interval is floored at 15s so a bad
  config can't busy-loop. Timer is `unref()`'d so it never holds a Node process open.

## Files
- **New:** `js/intelligence/hypermind-core.js` (driver), `test/unit/hypermind-core.test.js` (31 tests).
- **Wired:** `index.html` (script tag + `AAA_HYPERMIND.boot()` next to `AAA_AUTOMATION.init()`),
  `sw.js` (precache + `v71→v72`), `test/run.js` (suite registered).

## How to turn it on
```js
AAA_HYPERMIND.setEnabled(true);                 // start the heartbeat (persisted)
AAA_CONFIG.set({ hypermindIntervalMs: 600000 });// optional: 10-min cadence
AAA_HYPERMIND.status();                          // { enabled, running, intervalMs, tickCount, ... }
await AAA_HYPERMIND.tick({ deep: true });        // run one cycle now (deep = also run the proxy pipeline)
AAA_HYPERMIND.setEnabled(false);                 // kill switch
```

## Test coverage (31 assertions)
Default-off boot no-op; all 9 phases run in canonical order; clean skips when
modules absent; real module calls when present; thrown phase contained as `error`
with loop survival; `Execute` delegates to an installed executor with context;
enable/disable persistence + kill switch; interval floor; history newest-first;
metrics per-phase aggregation.

## What HM-1 deliberately does NOT do (by design / deferred)
- **No outward action.** It does not change prices, send messages, or move money.
  Autonomous *internal* apply (calibration/routing/prompt/scorecards) arrives in
  **HM-4** via the `Execute` seam; outward-facing actions remain governed.
- **Graph/Fabric** are driven if present but not yet surfaced in a UI — that is **HM-2**.
- **New event ingestion** (calls/leads/refunds/invoices/ads) is **HM-3**.

## Next: HM-2 — connect the already-built memory graph (`AAA_GRAPH` / `AAA_KNOWLEDGE`)
into a UI + the loop, and add the missing entity node types.
