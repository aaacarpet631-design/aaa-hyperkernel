# AAA HyperKernel — Vision Roadmap

> The goal is not to ship features. The goal is a self-improving operating
> system that makes AAA Carpet **more profitable, efficient, intelligent,
> scalable, secure, and valuable every year it runs.** This document maps that
> vision to the code that exists today and sequences how we get the rest of the
> way — in shippable vertical slices, each proven with real data and tests.

_Status legend:_ ✅ built on `main` · 🔌 built, in PR (not yet merged) · 🟡 partial · ⬜ not started

---

## 1. Non-negotiable operating principles (already enforced in code)

These are the invariants every future phase must preserve. They are not
aspirations — they are enforced by the kernel today and verified by tests.

| Principle | How it's enforced | Where |
|---|---|---|
| **AI recommends, humans decide** | Money/customer/price/job mutations route through a gateway that *hard-blocks* `origin:'ai'` on human-only actions — a code constant, not a setting | `js/core/aaa-runtime-gateway.js` |
| **Everything is audited** | Every guarded mutation (allowed *or* denied) writes an append-only `audit_log` entry | gateway `_audit()` + `firestore.rules` |
| **Financials are owner-only** | Crew cannot read invoices/expenses/payments/rate-cards; enforced server-side | `firestore.rules` `isFinancialCollection`, verified by `test/rules` |
| **Local-first, never a single point of failure** | Writes land locally first, sync when online; offline queues drain on reconnect | `js/core/local-first-storage.js`, `sync-engine.js` |
| **Single source of truth** | One workspace-isolated data layer + a knowledge graph linking every entity | `js/core/aaa-data.js`, `knowledge-graph.js` |
| **No fabrication** | Empty/low-confidence states say so; estimators/parsers return `null` rather than guess; learning is measured against real outcomes | vision/bluetooth/receipt engines, `supervisor.js` |

**Every new slice ships with:** unit tests in the zero-dep harness, an entry in
`test/run.js`, `index.html` + `sw.js` wiring (cache bump), and — if it touches a
new financial collection — a `firestore.rules` owner-gate + a rules-test assertion.

---

## 2. Vision pillar → current code → gap

| Pillar | Today (real modules) | Status | Gap to the vision |
|---|---|---|---|
| **System of record** | `aaa-data`, `knowledge-graph`, `sync-engine`, `local-first-storage`, `aaa-rbac`, `aaa-runtime-gateway` | ✅ | Graph links entities but does not yet *predict* |
| **Sales / Quoting** | `customer-store`, `new-job-flow-ui`, vision estimating (`sidekick-vision-engine` + `netlify/functions/vision.mjs`), pricing (`pricing.test`), `measurement-to-quote` | ✅/🟡 | No quote→win driver analysis; follow-up not automated |
| **Measurement** | Bluetooth laser layer — generic BLE + `huepar-s60-adapter`, raw-frame log, parser, HUD | ✅ | Field-validate parser against real hardware frames |
| **Scheduling / Dispatch** | `schedule-store`, `schedule-ui` | ✅ | No dispatch optimization or efficiency scoring |
| **Crew / Tools** | `crew-store`, `tool-store`, `crew-ui` | ✅ | No productivity / utilization analytics |
| **Customer Experience** | `contract-store`, `portal-app`/`portal-link-store`, `review-request-engine`, voice notes (`voice-note-store`, `transcribe.mjs`) | 🟡 | No retention/LTV signals; review gen not outcome-tied |
| **Marketing** | `marketing-intel` (channel ROI) | 🟡 | No budget recommendations from ROI |
| **Accounting / Job costing** | `accounting-store` (P&L, job costing), QBO invoice export + live sync (`quickbooks-export`, `quickbooks-online`, `qbo-proxy`) | ✅ | See **Financial Excellence** gaps below |
| **Receipt → Expense intake** | Receipt Intelligence: OCR + deterministic classifier + review queue + gateway-gated posting | 🔌 **PR #23** | Merge it; then expense→QBO bill sync |
| **AI advisory team** | Agent OS + registry, Analysis Division (debate, supervisor-council, evolution, analyst-rankings), challenge/escalation, self-improvement, prompt-architect | ✅ | Not yet wired to the *financial* outcome loop |
| **Business Intelligence** | `command-center-ui`, `intelligence-dashboard-ui`, `kpi_snapshots`, `supervisor` learning metrics | 🟡 | No cash-flow/margin/forecast intelligence |
| **Security / Reliability** | gateway + RBAC + audit + rules + local-first | ✅ | Define **safe secret-handling** for 3rd-party OAuth (QBO) |

**Takeaway:** the foundation for nearly every pillar exists. The two biggest
levers left are (a) **financial optimization depth** and (b) the **compounding
intelligence network** that turns all this real data into prediction.

---

## 3. The phased plan

Each phase is independently shippable and ordered by *compounding leverage* —
earlier phases make later ones smarter.

### Phase 1 — Financial Excellence (optimization, not just compliance)
**Builds on:** `accounting-store`, Receipt Intelligence (#23), QBO modules.
1. **Merge Receipt Intelligence (#23).** 🔌 _in flight_
2. **Controller Agent** — reads real invoices/expenses/payments/receipts and
   flags margin erosion, unusual spend, duplicate/aberrant expenses, jobs going
   over cost. Recommends; never posts (gateway). _Wires AI → financial loop._
3. **Accounting Intelligence dashboard** — profitability & margin trends, cash
   position, A/R aging (outstanding), expense-by-category, job-cost variance.
4. **Cash-flow forecast** — projected inflows (scheduled jobs + outstanding
   invoices) vs. outflows (recurring + expected expenses), with a runway figure.
5. **Expense → QuickBooks bill sync** — owner-gated, approved-only, audited,
   mirroring the invoice path. _Blocked on the secret-handling flow (§5)._
6. **Audit-readiness pack** — one-click export tying every expense to its
   receipt image (Netlify Blob) + the audit trail.

**Success metric:** the owner can answer "are we making money this month, on
which jobs, and what's the cash runway?" from one screen, backed by real data.

### Phase 2 — The Intelligence Network (compounding memory)
**Builds on:** `knowledge-graph`, `supervisor`, Analysis Division.
- Outcome-learning loop: every quote/job/expense/review/payment feeds the graph;
  the supervisor scores predictions against what actually happened.
- **Pricing optimization** from win/loss + realized margin (recommend floors).
- **Opportunity & risk detection** — surfaces revenue/cost/retention signals and
  strategic risks proactively (the "predict what happens next" layer).

**Success metric:** recommendation calibration & estimate accuracy (already
tracked by `supervisor.metrics()`) trend upward month over month.

### Phase 3 — Customer Excellence & Growth
**Builds on:** `customer-store`, `review-request-engine`, `marketing-intel`, portal.
- Quote→win **conversion intelligence** (which factors drive closes).
- **Automated follow-up** sequences (recommended, human-approved sends).
- **Review generation** tied to job-closure outcomes.
- **Retention / repeat / LTV** signals; channel ROI → budget recommendations.

**Success metric:** measured lift in close rate, review volume, and repeat business.

### Phase 4 — Operational Excellence
**Builds on:** `schedule-store`, `crew-store`, `tool-store`, closure.
- Crew productivity, **callback/quality rate**, completion-time benchmarks,
  scheduling/dispatch efficiency, material & tool utilization.

**Success metric:** efficiency metrics improve every month; callbacks fall.

### Phase 5 — Strategic / Executive layer
**Builds on:** the existing CEO standup + supervisor council.
- Quarterly **strategic planning advisor** synthesizing all pillars into a
  prioritized, forecasted action list + enterprise-value tracking.

**Success metric:** leadership runs the business from HyperKernel's briefings.

### Cross-cutting (every phase) — Security & Reliability
- Offline resilience (local-first, already in place), data integrity, full
  auditability, **safe secret handling** (§5), and data export/backup. The
  software must make the business *more* resilient, never a point of failure.

---

## 4. Recommended next slice (Phase 1, ticket 2): the Controller Agent + Accounting Intelligence dashboard

The highest-leverage next build once #23 merges. It is the first place AI is
wired to the financial outcome loop, and it compounds directly on the receipt
spine just built.

- **Reads:** invoices, expenses, payments, receipts, job costing (all real).
- **Produces (recommendation-only, audited):** margin-erosion alerts, anomalous/
  duplicate-spend flags, jobs trending over cost, A/R aging, cash runway.
- **UI:** an owner-only "Financial Intelligence" screen (VIEW_FINANCIALS),
  matching the `business-ui` / command-center patterns.
- **Authority:** the agent never mutates the books — any action it suggests is
  confirmed by a human through the gateway.
- **Tests:** deterministic alert logic (e.g. "flag when realized margin < floor")
  as a zero-dep unit suite; dashboard math verified like `accounting.test.js`.

## 5. Open dependency: safe secret handling (for QBO bill sync + future integrations)
QuickBooks bill sync (and any new third-party integration) needs OAuth secrets.
Per the established rule, **credentials never get pasted into chat.** Proposed
flow to decide before Phase 1 ticket 5:
- Secrets live only in the Netlify site environment (server-side), like
  `ANTHROPIC_API_KEY` today; the browser never sees them.
- OAuth tokens stay in the server-only `integrations/**` collection (already
  fully client-denied in `firestore.rules`).
- For the sandbox round-trip, the owner sets the sandbox client id/secret +
  redirect URI directly in Netlify env (or a `qbo-proxy` config), and I verify
  against mocks here, then validate live without ever handling the raw secret.

---

## 6. In-flight / parallel threads (not part of this roadmap's build order)
- **PR #23 — Receipt Intelligence:** merge-conflict resolved, merged tree green
  (312/0); awaiting CI + owner merge approval. _Phase 1, ticket 1._
- **PR #16 — Huepar S60-G-BT adapter:** open question — a Huepar S60-family
  adapter already landed on `main` via #21, so #16 may be redundant or need
  rework. Owner decision pending; untouched.

---

_This roadmap is a living document. Each completed slice updates the status
column and refines the next-slice definition. Success is measured by the
business getting better every year — not by this list getting longer._
