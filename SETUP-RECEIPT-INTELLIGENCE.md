# AAA Receipt Intelligence — Phase 1 (Vertical Slice)

The financial-memory intake layer: **photograph a receipt → AI extracts it →
deterministic classifier categorizes it → a person reviews and approves → it
posts to the real books and rolls up into job costing.** Built on the existing
HyperKernel stack (Claude vision, local-first storage, Runtime Gateway, RBAC,
audit log) — not a parallel system.

This document covers what is shipped in Phase 1, how to run it, and what is
deliberately deferred to later phases.

---

## What ships in Phase 1

| Piece | File | Status |
|---|---|---|
| Receipt OCR (Claude vision, structured JSON) | `netlify/functions/receipt-ocr.mjs` | ✅ real |
| Durable receipt storage (Netlify Blobs) | `netlify/functions/receipt-blob.mjs` | ✅ real |
| Capture engine (local-first, offline queue) | `js/accounting/receipt-intelligence-engine.js` | ✅ real |
| Expense Classification Agent (deterministic + learning) | `js/accounting/expense-classifier.js` | ✅ real |
| Receipt intake/review queue + posting | `js/accounting/receipt-intake-store.js` | ✅ real |
| Review & capture UI | `js/ui/receipt-intake-ui.js` | ✅ real |
| `REVIEW_RECEIPTS` human-only gateway action | `js/core/aaa-runtime-gateway.js` | ✅ real |
| Owner-only rules for `receipts` + classifier stores | `firestore.rules` | ✅ real |
| Unit tests (48 assertions) | `test/unit/expense-classifier.test.js`, `test/unit/receipt-intake.test.js` | ✅ green |

## The pipeline (one receipt's life)

```
Capture (camera / photo / PDF)
  → image stored LOCALLY first (never lost on a flaky job-site connection)
  → best-effort durable copy to Netlify Blobs
  → online: POST /api/receipt-ocr  (Claude vision → structured fields)
     offline: queue OCR_RECEIPT mutation, run on reconnect
  → AAA_RECEIPT_INTAKE.ingest(ocr):
       • classify (deterministic vendor rules + learned corrections)
       • duplicate-detect (vendor+date+total fingerprint)
       • suggest a job (date proximity + address overlap)
       • file in the review queue: needs_review | ready | duplicate
  → a PERSON reviews in the Receipts screen and approves
  → approveAndPost() → Runtime Gateway (REVIEW_RECEIPTS, human-only, audited)
       → AAA_ACCOUNTING.addExpense(...)  ← real money in the books
  → rolls up into AAA_ACCOUNTING.jobCosting(jobId) and the P&L
```

### Guarantees enforced by code (not trust)
- **Nothing posts without a human.** `REVIEW_RECEIPTS` is human-only in the
  gateway; an `origin:'ai'` call is hard-blocked and audited. AI extracts,
  classifies, and suggests — a person posts.
- **Idempotent posting.** A receipt becomes at most one expense.
- **Honest extraction.** Low-confidence/blurry/incomplete OCR lands in
  `needs_review`; the classifier returns `Uncategorized` + low confidence for
  unknown vendors instead of guessing. Uncategorized receipts cannot post.
- **Duplicates** are flagged and cannot post without an explicit override.
- **Owner-only.** `receipts`, `expense_corrections`, `expense_predictions` are
  financial collections — crew cannot read them (enforced in `firestore.rules`,
  verified by the emulator rules test).
- **Learning.** Every human re-categorization is stored per vendor and wins next
  time at high confidence; prediction accuracy is tracked.

---

## Configuration / environment

- **`ANTHROPIC_API_KEY`** — required for OCR. Already used by `/api/vision`; the
  receipt OCR function reuses the same Netlify site env var. No new key needed.
- **Netlify Blobs** — `@netlify/blobs` is already a dependency; the
  `aaa-receipts` store is created on first write. No setup needed on Netlify.
- Optional config overrides (via `AAA_CONFIG`): `receiptOcrEndpoint`
  (default `/api/receipt-ocr`), `receiptBlobEndpoint` (default
  `/api/receipt-blob`).

No config is required for the local-first capture + manual review to work; only
the AI OCR step needs the API key (and it degrades gracefully — a failed/absent
OCR still files the receipt into `needs_review` for manual entry).

## Using it

1. Open the app → **Intelligence** tab → **Receipts** (owner-only).
2. **Capture receipt** — take a photo or pick an image/PDF.
3. The receipt appears in the **Review Queue** with the extracted vendor/total,
   the suggested **category** (+ confidence + the AI's reasoning), and a
   **suggested job**.
4. Fix the **Category** or **Assign job** if needed (a category fix teaches the
   classifier), then **Approve & post**. Or **Reject** (kept for the audit trail).
5. Posted receipts flow into the P&L (Business tab) and job costing.

## Tests

```bash
npm test            # full harness incl. the 48 new receipt assertions
npm run test:rules  # firestore rules incl. owner-only `receipts` (needs Java)
```

---

## Deferred to later phases (NOT in this slice — stated honestly)

Phase 1 is the spine the rest of the division plugs into. Not yet built:

- **QuickBooks expense/bill push.** Today `qbo-proxy` pushes *invoices* only.
  The approved-expense → QBO bill push is the next step; it will be owner-gated,
  approved-only, and audited like the invoice path. **Requires QBO sandbox
  OAuth credentials to verify the live round-trip** (the owner has a sandbox).
- **The other agents** (Controller anomaly/risk scoring, Tax Strategy, Vendor
  Intelligence, dedicated Fraud detection beyond duplicate fingerprinting, AI
  Bookkeeper GL mapping) — each is a new definition on the existing agent rail.
- **Accounting Intelligence dashboards** (expense/profit trends, cash flow,
  tax forecasting, audit readiness, controller alerts).
- **Mobile "Expense Capture Center"** batch upload / drag-drop / voice notes
  (Phase 1 ships single-receipt capture; the engine already supports the queue).
- **Multi-page PDF rendering** to images for OCR (single image/page today).

These build on the Phase-1 data model and pipeline without reworking it.
