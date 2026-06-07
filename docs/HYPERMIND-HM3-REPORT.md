# HM-3 Implementation Report — Widen the Senses (Signal Ingestion)

**Phase:** HM-3 of the HyperMind roadmap.
**Mission mapping:** Phase 3 — perceive the whole business, not just jobs/quotes;
add the missing entity types and event sources.
**Status:** ✅ Shipped. Full suite **1638 passed / 0 failed / 100 suites**.

## The gap
The loop's Observe phase only saw jobs/quotes/outcomes. Money in/out, customer
acquisition, phone calls, refunds, and ad spend were invisible — and the graph
was missing `supplier`, `product`, and `campaign` entity types.

## What changed

### 1. `AAA_SIGNAL_INGEST` — one normalized signal stream
A new ingestion layer that derives an immutable, idempotent `signals` stream from
every source, then exposes it to the loop:

| Source | Signals | Status |
|---|---|---|
| `invoices` | `invoice_issued`, `invoice_paid` | **live today** |
| `payments` | `payment_received` | **live today** |
| `expenses` | `expense_recorded` | **live today** |
| `customers` | `lead_captured` (source as segment) | **live today** |
| `calls` | `call_received`, `call_missed` | schema-ready |
| `leads` | `lead_captured` (web, campaign) | schema-ready |
| `refunds` | `refund_issued` | schema-ready |
| `ad_events` | `ad_click`, `ad_spend` | schema-ready |

- **Honest:** every adapter is null-tolerant — an empty/absent source contributes
  nothing, never a fabricated signal. The schema-ready sources light up the moment
  real records arrive (webhook / manual / future integration).
- **Idempotent:** deterministic ids (`sig_inv_iss_<id>`, …); re-ingest adds zero.
- **Wired to the bus:** mirrors `signal.<type>` when a contract exists.
- **`metrics()`** derives real KPIs with honest nulls: revenue billed/collected,
  spend (expenses + ad), invoice paid-rate, missed-call rate, refund rate/total,
  leads, and **CAC** (ad spend ÷ new customers).

### 2. Loop wiring
HM-1's **Observe** phase now runs `AAA_OUTCOME_INTELLIGENCE.ingest` **and**
`AAA_SIGNAL_INGEST.ingest` each tick — the loop senses the full business.

### 3. New graph entity types (real where data exists, null-tolerant otherwise)
- **`product`** — derived from real invoice line items (`invoice → includes_product`).
- **`expense`** — from the expenses collection (`job → has_expense`).
- **`supplier`** — from a `suppliers` collection (`supplier → supplied → expense`).
- **`campaign`** — from a `campaigns` collection (`campaign → acquired → customer`).

So new chains are queryable, e.g. `Supplier → Expense → Job` via `path()`.

## Files
- **New:** `js/intelligence/signal-ingest.js`, `test/unit/signal-ingest.test.js` (22).
- **Extended:** `js/core/knowledge-graph.js` (product/expense/supplier/campaign
  nodes + edges + `slug`), `js/intelligence/hypermind-core.js` (Observe ingests
  signals), `test/unit/knowledge-graph.test.js` (27), `test/unit/hypermind-core.test.js` (33).
- **Wired:** `index.html`, `sw.js` (`v73→v74`), `test/run.js`.

## Test coverage
Signal ingest: empty no-op + honest nulls; all real sources normalized; per-source
tallies; idempotency; typed/filterable stream; KPI math (revenue/spend/paid-rate/
leads); schema-ready sources lighting up (missed-call rate, refund total, CAC).
Graph: product/expense/supplier/campaign nodes + edges + a Supplier→Expense→Job path.

## Next: HM-4 — close the autonomy loop
Install the governed autonomous executor into HM-1's `Execute` seam: auto-generate
**and** auto-apply internal learning (calibration, routing weights, prompt tunings,
scorecards, model promotion) with full audit + rollback + kill switch. Outward
actions (pricing charged, messaging, money) remain governed — internal learning
goes fully autonomous, per the chosen mode.
