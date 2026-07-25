# Ads Event Taxonomy — the Conversion Ladder

Canonical reference for the conversion event taxonomy **as implemented** in
[`js/revenue/ads-conversion-ledger.js`](../js/revenue/ads-conversion-ledger.js)
(global `AAA_ADS_CONVERSIONS`, collection `ads_conversion_events`). The JSON
Schema contract lives in
[`schemas/google-ads-attribution.json`](../schemas/google-ads-attribution.json)
(`$defs.AdsConversionEvent`, `$defs.OfflineConversionPayload`).

The code is the source of truth. Everything below is implemented and covered by
tests unless explicitly marked **planned / not implemented**.

## The ladder (implemented)

Ten event types, defined in the `TYPES` table of the ledger. Each event carries
its type metadata denormalized onto the record (`tier`, `direction`,
`primarySignal`) at write time.

| Type | tier | direction | primarySignal | biddingEligible |
|---|---|---|---|---|
| `LEAD_CREATED` | `volume` | `positive` | `false` | `false` |
| `QUALIFIED_LEAD` | `quality` | `positive` | `false` | `true` |
| `ESTIMATE_SCHEDULED` | `quality` | `positive` | `false` | `true` |
| `ESTIMATE_SENT` | `intent` | `positive` | `false` | `true` |
| `JOB_WON` | `primary` | `positive` | `true` | `true` |
| `JOB_COMPLETED` | `revenue` | `positive` | `true` | `true` |
| `HIGH_MARGIN_JOB` | `premium` | `positive` | `true` | `true` |
| `BAD_LEAD` | `negative` | `negative` | `false` | `false` |
| `REFUND` | `negative` | `negative` | `false` | `false` |
| `COMPLAINT` | `negative` | `negative` | `false` | `false` |

Semantics of the columns:

- **tier** — what the event measures (volume → quality → intent → primary →
  revenue → premium, plus `negative` learning signals).
- **direction** — whether the signal should push bidding up (`positive`) or
  down (`negative`).
- **primarySignal** — business truth. Only `JOB_WON` / `JOB_COMPLETED` /
  `HIGH_MARGIN_JOB` are `true`; these are the only tiers ROAS decisions may
  trust. `AAA_ADS_CONVERSIONS.isPrimarySignal(type)` exposes this check, and
  reporting (`js/revenue/ads-reporting.js`) counts revenue only from
  primary-signal events. `LEAD_CREATED` is a volume signal and must never be
  treated as revenue.
- **biddingEligible** — whether the event may ever be offered to Google as an
  optimization target. This gates `uploadQueue()` (see export policy below).

Introspection: `AAA_ADS_CONVERSIONS.TYPES` (array of type names) and
`AAA_ADS_CONVERSIONS.typeInfo(type)` (metadata for one type, `null` for
unknown types).

## Dedupe key contract (implemented)

- Event id: **`'<leadId>:<TYPE>'`** — e.g. `lead_123:JOB_WON`. One event per
  `(leadId, type)`, ever.
- `record(leadId, type, opts)` is idempotent: a repeat call is a **no-op that
  returns the ORIGINAL event** with `deduped: true`. Recording `JOB_WON` twice
  cannot double-count.
- The dedupe key is mirrored Google-side: `uploadQueue()` sets each payload's
  **`orderId` to the event id**, so Google's own transaction/order-id dedupe
  matches ours (`orderId: e.id // dedupe key Google-side too`).
- Error surface of `record()`: `NO_LEAD`, `UNKNOWN_TYPE`, `NO_STORE`,
  `WRITE_FAILED` — all as `{ok:false, error}` result objects, never throws.
- Records are constructed by **whitelist** (`id`, `workspaceId`, `leadId`,
  `type`, `tier`, `direction`, `primarySignal`, `valueUSD`, `sourceRef` (≤80),
  `note` (≤300), `at`). A caller can pass a whole intake blob in `opts`; no
  name/phone/email survives onto the event.

## HIGH_MARGIN_JOB rule (implemented)

`recordJobFinancials(leadId, { revenueUSD, costUSD, sourceRef? })` is the one
call that records a completed job's financial outcome:

1. **Validation** — both numbers required and finite
   (`REVENUE_REQUIRED` / `COST_REQUIRED`), and revenue must be positive
   (`REVENUE_MUST_BE_POSITIVE`).
2. **Always** records `JOB_COMPLETED` with `valueUSD = revenueUSD`.
3. Computes `marginPct = (revenue - cost) / revenue * 100`.
4. When `marginPct >= AAA_CONFIG.flag('adsHighMarginPctFloor', 55)`
   (**default floor: 55**), it **also** records `HIGH_MARGIN_JOB` with
   `valueUSD = Math.round(revenue - cost)` — the rounded margin dollars.
5. **The raw cost is never stored on any event.** Only the margin value
   survives; the cost breakdown exists solely inside the function call.
6. Both writes go through `record()`, so both dedupe per `(leadId, type)`.

Returns `{ ok, events: [...], marginPct, highMargin }`.

## Export policy (implemented)

Payload **generation** and **transmission** are separate, governed steps.
Nothing in this codebase calls the Google Ads API — there is no transport at
all (see `js/ads/google-ads-datamanager-client.js`, whose real-send path
returns `TRANSPORT_NOT_IMPLEMENTED` even with credentials configured).

**A conversion event is Google-facing only when ALL of:**

1. its type is `biddingEligible: true`, **and**
2. the lead's attribution record (`AAA_AD_ATTRIBUTION`, collection
   `ad_attribution`) carries a click id (`gclid` or `gbraid` or `wbraid`),
   **and**
3. that attribution's `consent === 'granted'`.

| Type | Google-facing (may enter `uploadQueue()`) | Why |
|---|---|---|
| `QUALIFIED_LEAD`, `ESTIMATE_SCHEDULED`, `ESTIMATE_SENT`, `JOB_WON`, `JOB_COMPLETED`, `HIGH_MARGIN_JOB` | Yes — subject to click-id + consent gates above | Bidding-eligible optimization targets |
| `LEAD_CREATED` | **No — internal only** | Pure volume signal (`primarySignal:false`, `biddingEligible:false`). Optimizing Google toward raw form fills teaches the algorithm to hunt clickers, not payers. |
| `BAD_LEAD`, `REFUND`, `COMPLAINT` | **No — internal only** | Negative learning signals (`direction:'negative'`). The offline-conversion upload has no honest way to express "this outcome was bad"; uploading them as conversions would reward the exact traffic to avoid. They feed internal reporting (`AAA_ADS_REPORTING` counts them as `badLeads`/`refunds`/`complaints` and flags "negative signal(s)" in the owner brief) and governance instead. |

Mechanics:

- **`uploadQueue(opts)`** — emits Google-ready offline-conversion payloads
  (`eventId`, `conversionAction` = event type, the three click-id fields,
  `conversionValueUSD`, `currency:'USD'`, `conversionTime`, `orderId` = event
  id) for qualifying events only. Everything that does not qualify is reported
  in `skipped[]` with an explicit reason — `NO_ATTRIBUTION`, `NO_CLICK_ID`, or
  `NO_CONSENT` — so the measurement gap is visible instead of silent.
- **`releaseExport(opts)`** — the **human** step between "payloads exist" and
  "an adapter may transmit them". Routes through
  `AAA_RUNTIME_GATEWAY.run({ action: 'EXPORT_CONVERSIONS', ... })`, which is
  registered `aiAllowed: false` in `js/core/aaa-runtime-gateway.js` — an
  AI-origin call is hard-blocked and audited. On success it writes a batch
  record to `ads_conversion_exports` with `status: 'released'` and
  **`transmitted: false`**. An empty queue returns
  `{ok:false, error:'EMPTY_QUEUE', skipped}`.
- **Downstream (shape only)** — `AAA_ADS_DATAMANAGER`
  (`js/ads/google-ads-datamanager-client.js`) consumes only `released` batches,
  maps payloads to Data-Manager-shaped requests (requiring **exactly one**
  click id per payload), and records dry-run fixtures. `batch.transmitted`
  stays `false` until a real, owner-credentialed transport exists — which this
  codebase deliberately does not contain.

## Future events under consideration (NOT implemented)

- `CALL_ANSWERED` / `CALL_MISSED` — candidate **internal-only operational
  signals** for phone-channel responsiveness (did a paid call actually get
  picked up). If adopted, they would be `biddingEligible: false`, like
  `LEAD_CREATED`: operational hygiene, not optimization targets.

These types **do not exist in the code today**. They are not in the ledger's
`TYPES` table or the JSON Schema enum, and
`AAA_ADS_CONVERSIONS.record(leadId, 'CALL_ANSWERED')` returns
`{ok:false, error:'UNKNOWN_TYPE'}`. This section is a design note, not a
contract.
