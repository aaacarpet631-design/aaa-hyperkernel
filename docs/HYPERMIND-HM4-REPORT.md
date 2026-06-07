# HM-4 Implementation Report — Close the Autonomy Loop

**Phase:** HM-4 of the HyperMind roadmap.
**Mission mapping:** Phase 5 — automatic learning: update scorecards, confidence
calibration, routing/prompt weights with no manual intervention.
**Autonomy mode:** Fully autonomous (owner's choice) — **for internal learning only.**
**Status:** ✅ Shipped. Full suite **1660 passed / 0 failed / 101 suites**.

## What it does
Fills HM-1's `Execute` seam with `AAA_HYPERMIND_EXECUTOR`. When the owner has full
autonomy on, each loop tick doesn't just learn — it **applies** what it learned,
with no human gate:

- **Calibration** — `propose()` from closure signals, then `autoApprove()` each
  proposal. A `simulate()` guard **skips any tuning that would reduce alignment**.
- **Prompt tunings** — `improveAll()` (LLM-driven), only when the proxy is ready.
- **Idempotent** — a proposal already encoded in the active version is left
  `unchanged` (propose() re-emits each tick; we never re-apply the same thing).

## The safety architecture (this is the whole story)
The system's integrity keystone is the gateway's hard AI-block. I did **not**
weaken it. Instead:

1. **New gateway action `AUTO_TUNE`** — internal-learning only. Human-only by
   default; AI may perform it **only when the owner has switched on
   `hypermindAutoApply`** (via a new `aiAllowedFlag` mechanism). Every other
   action that touches **money / price / customer / outbound message** declares
   no flag, so its AI block stays **absolute** — no setting can lift it. (Test:
   `FINALIZE_PRICE` stays blocked for AI even with autonomy on.)
2. **Honest audit** — every autonomous apply is recorded `origin:'ai',
   autonomous:true` in `audit_log`, plus a `hypermind_actions` ledger entry.
3. **Reversible** — `rollback(agent)` / `rollbackAll()` revert via `autoRollback`;
   `setAutoApply(false)` instantly drops the running loop to advisory.
4. **No outward path** — the executor literally has no code path to a business
   mutation. It tunes the AI's own internals; it cannot change a quote, send a
   message, or move money.
5. **Advisory fallback** — with autonomy off, `run()` still PROPOSES (leaving
   proposals pending for human review) and applies nothing.

`hypermindAutoApply` defaults **on** (the chosen "fully autonomous" mode), but is
**inert until the master switch `hypermindEnabled` turns the loop on** (off by
default). So nothing auto-applies until the owner starts HyperMind; once started,
it is fully autonomous.

## Files
- **New:** `js/intelligence/hypermind-executor.js`, `test/unit/hypermind-executor.test.js` (22).
- **Extended:** `js/core/aaa-runtime-gateway.js` (`AUTO_TUNE` + `aiAllowedFlag` +
  autonomous audit), `js/intelligence/calibration-registry.js` (`autoApprove`,
  `autoRollback`, shared `_commit`/`_rollbackMutate`), `js/intelligence/hypermind-core.js`
  (`autoApply`/`setAutoApply`, status).
- **Wired:** `index.html`, `sw.js` (`v74→v75`), `test/run.js`.

## Test coverage (22 + unchanged gateway/calibration suites)
Gateway: `AUTO_TUNE` AI-blocked when flag off, allowed + audited-autonomous when
on, `FINALIZE_PRICE` stays absolutely blocked. Executor: advisory mode proposes
only; autonomous mode auto-applies + installs tunings + versions them as
autonomous; idempotent re-runs; simulate guard skips a harmful tuning; rollback
reverts to baseline; action ledger; status surfaces autonomy + kill switch.
Regression: gateway/rbac/action-safety-gate/security/calibration suites unchanged.

## How to operate
```js
AAA_HYPERMIND.setEnabled(true);     // start the loop → fully autonomous learning
AAA_HYPERMIND.setAutoApply(false);  // drop to advisory (propose only) without stopping
AAA_HYPERMIND_EXECUTOR.rollback('pricing_optimizer'); // revert one agent
AAA_HYPERMIND_EXECUTOR.rollbackAll();                 // revert all autonomous tunings
await AAA_HYPERMIND_EXECUTOR.history();               // autonomous action ledger
```

## Next: HM-5 — make the autonomy legible
A Command Center surface for the loop: live status, tick history, the autonomous
action ledger, per-agent applied tunings + one-click rollback, and the autonomy
kill switch — so the owner can see and steer everything the loop does.
