# Ads Attribution Schema — Field-Level Contract

Canonical reference for the ad attribution record **as implemented** in
[`js/intelligence/ad-attribution.js`](../js/intelligence/ad-attribution.js)
(global `AAA_AD_ATTRIBUTION`, collection `ad_attribution`, keyed by `leadId`)
and contracted in
[`schemas/google-ads-attribution.json`](../schemas/google-ads-attribution.json)
(`$defs.AdAttribution`).

The code is the source of truth. Everything below is implemented unless
explicitly marked **planned / not implemented**.

## Purpose and separation of stores (implemented)

One lead, two records, deliberately apart:

- **Lead OS** (`js/leads/lead-store.js`, collection `leads`) holds the PII —
  name, phone, notes — plus pipeline stage. It carries only a boolean
  `attributionCaptured` about ads.
- **Ad attribution** (`ad_attribution`, keyed by the same `leadId`) holds the
  click context — click ids, UTM, campaign, consent — and **no
  name/phone/email/address, ever**.

Because the join key is `leadId`, either store can be inspected, exported, or
pointed at analytics without dragging the other along. Attribution answers
*which click produced the lead*; the conversion ladder
(`js/revenue/ads-conversion-ledger.js`, see
[`ADS_EVENT_TAXONOMY.md`](./ADS_EVENT_TAXONOMY.md)) answers *what that lead
was worth*.

## Record fields (implemented)

Built by `attach(leadId, attribution)`. All strings are length-clamped via
`str(v, max)`; numbers via `numOrNull`.

| Field | Type / max | Notes |
|---|---|---|
| `leadId` | string | Record key; join key to Lead OS. Required. |
| `workspaceId` | string | Stamped from `AAA_CONFIG.workspaceId` (default `'default'`); all reads filter by workspace. |
| `gclid` | string\|null, ≤256 | Google Click ID — the offline-conversion join key. |
| `gbraid` | string\|null, ≤256 | iOS app-campaign click id. |
| `wbraid` | string\|null, ≤256 | iOS web-campaign click id. |
| `keyword` | string\|null, ≤160 | |
| `adGroup` | string\|null, ≤160 | |
| `campaign` | string\|null, ≤160 | Aggregation key for `roas()` and the campaign scorecard. |
| `searchTerm` | string\|null, ≤200 | |
| `source` | string, ≤48 | Defaults to `'google_ads'`. |
| `landingPage` | string\|null, ≤300 | **Path only** — `fromUrl()` strips origin and query string, so identifiers in the URL never persist here. |
| `utmSource` | string\|null, ≤120 | UTM set (Slice 1 measurement foundation). |
| `utmMedium` | string\|null, ≤120 | |
| `utmCampaign` | string\|null, ≤160 | |
| `utmTerm` | string\|null, ≤160 | |
| `utmContent` | string\|null, ≤160 | |
| `channel` | string\|null, ≤32 | How the lead arrived — schema enum `form\|call\|chat\|lsa\|portal` — not *who* it is. |
| `city` | string\|null, ≤80 | Coarse geo for service-area analysis; never a street address. |
| `zip` | string\|null, ≤16 | |
| `consent` | `'granted'\|'denied'\|'unknown'` | See consent semantics below. |
| `capturedAt` | ISO date-time | First capture wins (`p.capturedAt` preserved on re-attach); falls back to `AAA_RUNTIME_CLOCK.nowISO()`. |
| `conversion` | object\|null | Legacy single-conversion record written by `recordConversion()` (`{valueUSD, kind:'revenue'\|'profit', at, sourceRef}`). The full ladder lives in `ads_conversion_events`. |

### Upsert semantics

`attach()` is an upsert by `leadId`: a provided field updates; an **omitted
field preserves the prior value** — a second attach cannot null out the
campaign or gclid.

## Click ids (implemented)

- Three click-id fields exist: `gclid` (standard), `gbraid` / `wbraid` (iOS
  app/web). Any one of them makes the lead attributable.
- **Case sensitivity**: click ids are opaque, **case-sensitive** tokens. The
  Data Manager adapter (`js/ads/google-ads-datamanager-client.js`) passes them
  through **verbatim — never lowercased, trimmed, or otherwise normalized**
  (`adIdentifiers[clicks[0]] = p[clicks[0]] // verbatim — case-sensitive
  token`). Note also that `fromUrl()` matches query-parameter **names**
  case-sensitively via `URLSearchParams`: only lowercase `gclid=`, `gbraid=`,
  `wbraid=` (and lowercase `utm_*`) are recognized; `?GCLID=...` is ignored.
- **Exactly-one-id upload rule**: attribution records and `uploadQueue()`
  payloads carry all three fields (unset ones are `null`), but the Data
  Manager adapter's `mapPayload()` requires **exactly one** non-empty click id
  per payload — zero ids rejects with `NO_CLICK_ID`, more than one rejects
  with `MULTIPLE_CLICK_IDS`. Rejected payloads land in `rejected[]` with
  reasons; they are never silently dropped.
- A conversion with no click id is never emitted: `conversions()` filters on
  `r.gclid || r.gbraid || r.wbraid`, and the ledger's `uploadQueue()` skips
  such events with reason `NO_CLICK_ID`. Nothing is fabricated.

## Consent semantics (implemented)

`consent` is `'granted' | 'denied' | 'unknown'`:

- `attach()` accepts only those three values. **Junk degrades to unknown**: an
  invalid consent value is treated as not-provided, so the record keeps the
  prior consent or defaults to `'unknown'`
  (`consent: consent || p.consent || 'unknown'`).
- `'unknown'` is the honest default until consent is explicitly captured.
- **Only `'granted'` is uploadable**: `AAA_ADS_CONVERSIONS.uploadQueue()` skips
  any event whose attribution has `consent !== 'granted'` with reason
  `NO_CONSENT`. `'denied'` and `'unknown'` are equally non-uploadable; the
  distinction matters only for diagnostics (an `'unknown'` is a capture gap to
  fix, a `'denied'` is a final answer).

## Whitelist construction — why PII cannot enter (implemented)

`attach()` never spreads or copies its input object. The stored record is
constructed **field by field from a fixed whitelist** (the table above), each
value passed through `str()` with a length cap. A caller can hand `attach()` a
whole intake blob — name, phone, email, street address included — and none of
those keys exist in the constructed record, so nothing outside the whitelist
can ever land in the `ad_attribution` collection. The same pattern protects
`recordConversion()` (fixed `conversion` shape) and the `roas()` aggregates,
which are keyed by campaign/adGroup/keyword/source — never names or phones.

## `fromUrl(url)` (implemented)

Pure helper that extracts click ids + UTM parameters from a landing-page URL
(or bare query string) into an `attach()`-ready partial:

- Accepts a full URL (`https://site.com/carpet?gclid=X`), a query string, or a
  bare `a=b&c=d` string.
- Recognizes exactly: `gclid`, `gbraid`, `wbraid`, `utm_source`, `utm_medium`,
  `utm_campaign`, `utm_term`, `utm_content` (mapped to the camelCase fields).
  **Unknown params are ignored, nothing is stored** — the whitelist starts at
  parse time.
- Sets `landingPage` to the **path only** (origin and query string stripped),
  so identifiers embedded in the URL never persist.
- **Never throws** — a bad/empty URL yields `{}`.

## Lead-intake delegation (implemented in `js/leads/lead-store.js`)

- `AAA_LEADS.createLead(input)` accepts optional `input.attribution`
  (gclid/gbraid/wbraid, utm\*, campaign, adGroup, keyword, searchTerm,
  landingPage, channel, city, zip, consent) and hands it to
  `AAA_AD_ATTRIBUTION.attach(leadId, input.attribution)` — it is **never
  merged into the lead record**.
- The lead itself carries only **`attributionCaptured: true|false`** —
  `true` only when the attach succeeded; an attach failure or absent
  attribution leaves it `false` (attach errors never fail lead creation).
- `AAA_LEADS.missingAttribution()` is the measurement-gap report: every lead
  whose `source` is a paid channel (`PAID_SOURCES = ['google_ads', 'lsa']`)
  but has **no** `ad_attribution` record. Output rows are
  `{leadId, source, createdAt}` — **ids only, no PII**. Non-paid leads never
  appear in the gap report.

## Measurement-gap diagnostics surface (implemented)

`AAA_ADS_REPORTING.diagnostics()` (`js/revenue/ads-reporting.js`, read-only by
construction — owns no collection, never calls `put()`) answers "is the
measurement foundation trustworthy yet?":

| Field | Meaning |
|---|---|
| `attributedLeads` | Count of `ad_attribution` records in this workspace. |
| `missingAttribution` | Rows from `AAA_LEADS.missingAttribution()` — paid leads with no attribution record (ids only). |
| `consentUnknownLeadIds` | Lead ids whose attribution consent is neither `'granted'` nor `'denied'` — the consent-capture gap. |
| `uploadable` | `uploadQueue().payloads.length` — events that would qualify for upload right now. |
| `blockedUploads` | `uploadQueue().skipped` — each blocked event with its reason (`NO_ATTRIBUTION` / `NO_CLICK_ID` / `NO_CONSENT`). |

`AAA_ADS_REPORTING.ownerBrief()` surfaces the same gap in plain language,
appending `MEASUREMENT GAP: N paid lead(s) with no attribution record.` when
the gap is non-empty. A broader scheduled health surface
(`js/ads/google-ads-diagnostics.js`, `AAA_ADS_DIAGNOSTICS`) also runs a
click-id-coverage check over attribution records and a missing-attribution
check delegating to `AAA_LEADS.missingAttribution()`.

## Boundaries (implemented — by absence)

- **Nothing in this codebase calls the Google Ads API.** Attribution and the
  ledger *generate* upload payloads; transmission requires a human-released
  export batch (gateway action `EXPORT_CONVERSIONS`, `aiAllowed:false`) and a
  real credentialed transport that deliberately does not exist
  (`send()` returns `TRANSPORT_NOT_IMPLEMENTED`).
- All methods are null-tolerant and deterministic: missing stores yield
  `{ok:false, error:'NO_STORE'}` or honest empties, never throws, no network.
