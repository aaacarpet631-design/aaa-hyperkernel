# HM-2 Implementation Report — Connect the Memory Graph

**Phase:** HM-2 of the HyperMind roadmap.
**Mission mapping:** Phase 2 — the shared business memory graph; relationships
queryable; supports reasoning by agents.
**Status:** ✅ Shipped. Full suite **1607 passed / 0 failed / 99 suites**.

## Starting point (from the audit)
`AAA_GRAPH` (relationship graph) and `AAA_KNOWLEDGE` (queryable fabric) were both
**real but under-connected**: the graph was surfaced in `business-ui.js` and the
fabric in `knowledge-os-ui.js`, but **neither was driven by the loop**, the graph
was missing entity types the mission names, and there was no way to query an
arbitrary relationship *path*.

## What changed

### 1. New entity node types (real data sources only — no fabrication)
- **`technician`** — built from the `crew_members` collection; linked to the jobs
  they worked via `job.assigneeIds` (`technician → worked_job → job`).
- **`invoice`** — built from the `invoices` collection; linked `job → has_invoice`
  and `customer → billed_customer`.
- Existing node types (customer, job, estimate, outcome, review, source, agent,
  decision) unchanged. `business-ui`'s `byType` panel surfaces the new types
  automatically. *(supplier / product / campaign have no data source yet — they
  arrive with HM-3 ingestion, not invented here.)*

### 2. Relationships are now queryable end to end
- **`path(fromId, toId, maxDepth=6)`** — BFS over the graph returns the ordered
  relationship chain (with node types + the edge taken at each hop), so the
  mission's example traversals are real queries:
  - `path('cust:c1','rev:r1')` → Customer → Job → Review
  - `path('tech:t1','out:o1')` → Technician → Job → Outcome
  Returns `null` when no path within depth / unknown node.
- **`technicianPerformance()`** — realizes **Technician → Job → Margin**: per crew
  member, jobs worked / wins / win-rate / realized revenue / avg estimate margin,
  ranked by margin. Honest about thin data (null margin/winRate when none).
- **Lead Source → Quote → Win Rate** was already covered by `insights().bestSource`.

### 3. The graph + fabric are now driven by the loop
HM-1's **Remember** phase now refreshes all three memory layers each tick:
`AAA_GRAPH.stats()` (rebuilds the graph) + `AAA_LEARNING_FABRIC.ingest()` +
`AAA_KNOWLEDGE.index()`. So memory stays current automatically — no button.

### 4. Surfaced in the UI
`business-ui.js` Knowledge Graph panel now shows **Top crew by margin** from
`technicianPerformance()` alongside the existing stats/insights.

## Files
- **Extended:** `js/core/knowledge-graph.js` (technician+invoice nodes/edges,
  `path()`, `technicianPerformance()`, null-tolerant `listSafe`),
  `js/intelligence/hypermind-core.js` (Remember drives graph+fabric+knowledge),
  `js/ui/business-ui.js` (technician margin row).
- **New test:** `test/unit/knowledge-graph.test.js` (19 tests).
- **Updated:** `test/unit/hypermind-core.test.js` (Remember now also indexes the
  fabric — 32 tests), `test/run.js`, `sw.js` (`v72→v73`).

## Test coverage (19 new graph assertions)
New entity nodes from real collections; technician/invoice edges; `path()` for
Customer→Job→Review and Technician→Job→Outcome incl. null/unknown cases;
`technicianPerformance()` job/win/margin/revenue math + ranking; null-tolerance
when no crew/invoice collections exist.

## Deliberately deferred
- **supplier / product / campaign** nodes + the missing schema tables → **HM-3**
  (ingestion: calls, leads, refunds, invoices-as-events, ad clicks).
- A dedicated full graph-explorer UI panel (current surfacing is the business-ui
  graph section); can expand in P7 work.

## Next: HM-3 — widen the senses
Ingestion adapters + schema/migrations for the event sources with no intake today
(phone calls, missed calls, refunds, invoices-as-events, ad clicks, website
leads), so the loop observes the full business, not just jobs/quotes/outcomes.
