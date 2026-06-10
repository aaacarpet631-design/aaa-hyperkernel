# HyperKernel Spatial Event Ledger (PR #80)

> Decouple the **unalterable physics of the space** from the **temporary
> economics of the market**. The raw spatial facts captured today stay pristine
> if nylon prices spike, AAA expands into hardwood, or a new material is invented
> in 100 years.

`AAA_SPATIAL_LEDGER` (`js/core/spatial-event-ledger.js`) is an append-only,
hash-chained, edge-sealed ledger of physical measurement events — separate from
all pricing/waste/labor projections (which are computed *from* these nodes
elsewhere and never stored here).

## Physical invariants vs business projections
- **Stored here (immutable):** dimensions, normalized value (feet), polygon
  points, source/provenance, material category, nap, roll width (12), epistemic
  confidence/risk, raw-payload hash. (A test asserts no `price/waste/markup/
  margin/cost` field exists on a node.)
- **NOT here (dynamic):** scrap allocation, labor markups, pricing tiers, waste
  allowances — projections that change with the market.

## Two-pass sealing (edge-first, offline-safe)
- **Pass 1 — Local Genesis Seal (edge):** the instant a reading is accepted,
  `commit()` hashes it **synchronously and locally** (reusing the audit ledger's
  deterministic SHA-256 + canonical serialization — chosen over async
  `crypto.subtle` so the chain seals with **zero network and zero await**, on a
  truck in a concrete basement). Each node chains off the previous node's
  `eventHash`. Tamper-evident the moment it's written.
- **Pass 2 — Network Notarization (cloud):** `notarize()` re-verifies the node
  and records a **separate** global-signature attestation. The immutable node is
  **never mutated** (so the hash chain survives notarization);
  `pendingNotarization()` tracks what still needs a server signature.
  Non-blocking — only runs when a connection returns.

## Volatile vs committed (answering the streaming question)
A moving laser / manual drag streams through `stage()` — **in-memory, never
chained**. Only an *accepted* reading is `commit()`'d as a node. The ledger
records **decisions (physical facts)**, not the dot trembling toward them. This
keeps the chain meaningful, the provenance honest, and sync bounded.

## UI signal (answering the lock question)
Ambient on success, loud on exception: a small high-contrast 🔒 folds into the
green confirmation ring (secured is *felt*, not read — no spinner, no clutter).
It escalates only for an **unsealed/pending** chip, an **"edited"** badge when a
laser value is manually overridden (confidence penalty; the original genesis
block is preserved), or a **broken-chain** alert.

## Honesty / governance
- Edge-first: hashing is local + synchronous; no network dependency to seal.
- Insufficient geometry (`polygon` with <3 points) or an empty measurement →
  `insufficient_data` + `needsReview`, **not committed**.
- Unknown enum values coerce to `unknown` and are recorded in `assumptions` —
  never silently dropped.
- A manually altered measurement breaks `verifyChain()` (hash mismatch) and
  fails `notarize()` (`TAMPER_DETECTED`) — an installer can't backtrack a
  short-cut roll over the original laser genesis block.

## Schema (`HyperKernelSpatialEvent`)
`eventId, eventType, capturedAt, capturedBy, captureSessionId, jobId, roomId,
provenanceId, source, measurementKind, value, unit, normalizedValue,
normalizedUnit, spaceType, surfaceTarget, axis, orientationDegrees, geometryType,
points, areaSqFt, perimeterFt, materialCategory, rollWidthFt:12, napDirection,
confidence, risk, needsReview, conflictFlags, assumptions, laborGenomeTags,
materialGenomeTags, customerGenomeTags, marketingGenomeTags, schemaVersion, seq,
rawPayloadHash, previousEventHash, eventHash, notarized`.

## Note on the TypeScript spec
The directive specified `src/core/ledger/*.ts` with `crypto.subtle` (async). This
kernel is a zero-build, browser-global JS PWA, so it is realized natively
(`AAA_SPATIAL_LEDGER`) reusing the existing audit-ledger SHA-256 — a **synchronous**
deterministic hash, which is what makes the edge chain sealable without an await
on a dead-signal job site. Same guarantees, kernel-idiomatic.

## Tests
`test/unit/spatial-event-ledger.test.js` (19): edge commit + frozen node, full
hash set, m→ft 4dp normalization, deterministic raw-payload hash, chain linkage +
verify, physical/business separation, volatile staging vs chain,
insufficient-geometry refusal, two-pass notarization (separate attestation, node
unchanged), tamper detection (verify + notarize), restore.

## Next recommended organ
**PR #81 — Installation Twin**: read the immutable spatial nodes (+ #79 anomalies)
to predict install hours, seam count, furniture moves, and crew — the first
*business projection* computed from this physical-truth ledger.
