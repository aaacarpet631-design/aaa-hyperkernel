# HyperMind Roadmap — Complete (HM-1 → HM-6)

The HyperMind continuous-cognition loop is built, wired, tested, and observable.
The intelligence org no longer waits for a button — it runs itself.

## Decisions honored
- **Autonomy:** Fully autonomous **for internal learning** (calibration, prompt
  tunings, scorecards). Outward actions (price charged, messages, money) remain
  human-gated — by an absolute, unliftable gateway block.
- **Sequence:** Full roadmap HM-1 → HM-6, in order.
- **Model:** Nemotron only (no Gemma added).

## Phases
| Phase | What shipped | Tests | Report |
|---|---|---|---|
| HM-1 | `AAA_HYPERMIND` heartbeat — 9-phase loop driver, off by default, kill switch, audited ticks | 33 | HM1-REPORT |
| HM-2 | Memory graph connected — technician/invoice nodes, queryable `path()`, Technician→Job→Margin, loop-driven | +19 | HM2-REPORT |
| HM-3 | `AAA_SIGNAL_INGEST` — wider senses (invoices/payments/expenses/customers live; calls/leads/refunds/ads schema-ready) + supplier/product/campaign nodes | +22 | HM3-REPORT |
| HM-4 | `AAA_HYPERMIND_EXECUTOR` — governed autonomous apply via new `AUTO_TUNE` gateway action, simulate guard, rollback | +22 | HM4-REPORT |
| HM-5 | `AAA_HYPERMIND_UI` — owner console: status, controls, autonomy ledger, tunings + rollback, loop log | +14 | HM5-REPORT |
| HM-6 | End-to-end capstone test — real modules composed, full chain + kill switch + rollback | +17 | HM6-REPORT |

Full suite at completion: **1691 passed / 0 failed / 103 suites.**

## How to run it
```js
AAA_HYPERMIND.setEnabled(true);     // start the heartbeat → fully autonomous learning
AAA_HYPERMIND.status();             // { enabled, running, autoApply, intervalMs, tickCount, ... }
// Owner console: Command Center → 🧠 HyperMind
AAA_HYPERMIND.setAutoApply(false);  // kill autonomy (advisory only), loop keeps running
AAA_HYPERMIND.setEnabled(false);    // stop the loop entirely
AAA_HYPERMIND_EXECUTOR.rollbackAll();// revert every autonomous tuning
```

## Safety invariants (enforced by code + tests)
- Loop is **off by default**; `boot()` is a no-op until the owner enables it.
- Autonomy applies **internal learning only**; the executor has no code path to a
  business mutation.
- The gateway hard-blocks AI on money/price/customer/message actions **absolutely**
  — `hypermindAutoApply` only unlocks `AUTO_TUNE`, nothing else.
- Every autonomous apply is **audited** (`origin:'ai', autonomous:true`) and
  **reversible** (`rollback`/`rollbackAll`).
- Every phase is **null-tolerant** — a missing module or a thrown error is
  recorded and contained; the loop never crashes and never fabricates.

## Future (not in scope; noted for later)
- Light up the schema-ready sources with real adapters (telephony, web-lead
  webhook, ads API, refunds).
- Autonomous **routing-weight** + **model-promotion** apply through the same
  `AUTO_TUNE` seam (calibration + prompt tunings are done today).
- A dedicated graph-explorer UI panel.
