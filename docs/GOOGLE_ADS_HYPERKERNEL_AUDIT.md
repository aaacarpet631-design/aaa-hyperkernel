# Google Ads × HyperKernel — Systems Audit (Slice 0)

Recon map for the HyperKernel-native Google Ads Revenue Intelligence Team.
Ground rules this audit verifies against the code: **no fake automation** (no
Google Ads API calls exist anywhere; payloads are generated, never
transmitted), **business truth over vanity metrics** (won jobs / revenue /
margin, never raw leads), and **AI recommends, humans approve** (runtime
gateway `aiAllowed:false` on every money/structure/export step).

## 1. Existing systems the Ads team must plug into

| Global | File | What it is | How Ads work uses it |
|---|---|---|---|
| `AAA_MARKETING` | `js/agents/marketing-intel.js` | Real per-source rollup (customers/jobs/won/lost/closeRate by lead source) from shared memory. Explicitly documents that live Ads API integration is a future, credentialed step. | Baseline channel truth; the ads scorecard must agree with it, not replace it. |
| `AAA_LEADS` | `js/leads/lead-store.js` | Lead OS: 9-stage pipeline, validated transitions, append-only stage history, WON/LOST outcomes with revenue, ids-only events. Sources now include `google_ads`; intake accepts an `attribution` blob and delegates it to the attribution ledger; `missingAttribution()` reports paid leads with no click context. | The spine every conversion event keys to (`leadId`). |
| `AAA_QUOTES` | `js/quotes/quote-store.js` | Quote lifecycle (draft→reviewed→sent→won/lost). Committing transitions run through the gateway (`MODIFY_QUOTE`/`SEND_QUOTE`/`RESOLVE_QUOTE`, all `aiAllowed:false`); won/lost writes a lean `outcomes` training record; margin/cost never reach the customer view. **Note: the global is `AAA_QUOTES` — there is no `AAA_QUOTE_STORE`.** | Source of estimate-sent / won / final-price / job-cost truth. Quotes carry `leadSource` but not `leadId` — see Risks. |
| `AAA_AGENT_OUTCOMES` | `js/governance/agent-outcomes.js` | Agent Outcome Registry: every measurable AI decision registered with confidence, later linked to a real-world result (`ad_conversion` is already a recognized success result). | Every ads recommendation should register here so scorecards can grade the ads agents. |
| `AAA_AGENT_SCORECARDS` | `js/governance/agent-scorecards.js` | Per-agent accuracy/override/calibration/ROI scoring with governance-breach escalation. | Grades the ads agents over time; bad recommenders get escalated, not trusted. |
| `AAA_GOVERNANCE` | `js/intelligence/governance-registry.js` | Versioned governed artifacts (prompts/models/templates/policies) with approval workflow (`GOVERN_REGISTRY`, human-only). | Ads agent prompts/policies must be versioned here before agents go live (Slice ≥3). |
| `AAA_RUNTIME_GATEWAY` | `js/core/aaa-runtime-gateway.js` | THE deterministic chokepoint: action policy table (code constant), hard AI block, RBAC check, step-up security hook, audit entry for every attempt. | All ads human transitions route through it (see §4). |
| `AAA_PROVENANCE` | `js/intelligence/provenance-store.js` | Append-only "why does this recommendation exist" traces (owner-only, financial). | Ads recommendations should attach a provenance trace (evidence → recommendation); today evidence lives in the decision envelope only — see Risks. |
| `AAA_DECISION_ENVELOPE` | `js/governance/decision-envelope.js` | The one contract every agent decision ships in: gate verdict + escalation + confidence + evidence + rollback + audit-ledger chaining. Non-human approvers refused; gate-denied can never be approved; approval needs `OVERRIDE_AI_DECISION` (owner-only). | Every ads recommendation is wrapped and sealed here. |
| `AAA_EVENT_BUS` / `AAA_EVENT_TAXONOMY` | `js/core/aaa-event-bus.js`, `aaa-event-taxonomy.js` | Contract-validated event catalog (25 canonical events: `lead.captured`, `quote.accepted`, `campaign.launched`, `recommendation.created`…). | Ads modules stay consistent with the taxonomy; `campaign.launched` is the attribution anchor. |

## 2. Attribution (what exists after Slice 1)

`js/intelligence/ad-attribution.js` → `AAA_AD_ATTRIBUTION`, collection
`ad_attribution`, keyed by `leadId` (decoupled from the lead record on
purpose — PII and click data never share a document).

- Click ids: `gclid` / `gbraid` / `wbraid` (the offline-conversion join keys).
- Context: campaign, adGroup, keyword, searchTerm, landingPage (path only).
- **Slice 1 additions**: full UTM set (`utmSource/Medium/Campaign/Term/Content`),
  `channel` (form|call|chat|lsa|portal), coarse geo (`city`, `zip`),
  `consent` (`granted|denied|unknown` — junk values degrade to `unknown`),
  and `fromUrl()` (pure landing-URL parser, stores nothing).
- Records are built by whitelist: passing a whole intake blob cannot leak
  name/phone/email into the collection (test-proven).
- Upsert preserves prior values; a second attach can't null out a gclid.
- Lead intake (`AAA_LEADS.createLead({ …, attribution })`) attaches
  automatically and marks `attributionCaptured` on the lead;
  `missingAttribution()` makes the measurement gap visible.

## 3. Conversion events (what exists after Slice 1)

`js/revenue/ads-conversion-ledger.js` → `AAA_ADS_CONVERSIONS`, collection
`ads_conversion_events`, id = `"<leadId>:<TYPE>"` (the dedupe key — one event
per lead per type, ever; repeats return the original, so uploads can never
double-count; the Google-side `orderId` mirrors it).

Ladder (from the agent-team plan, all 10 implemented):

| Type | Tier | Primary signal | Bidding-eligible |
|---|---|---|---|
| LEAD_CREATED | volume | no | **no** — raw leads are never revenue |
| QUALIFIED_LEAD | quality | no | yes |
| ESTIMATE_SCHEDULED | quality | no | yes |
| ESTIMATE_SENT | intent | no | yes |
| JOB_WON | primary | **yes** | yes |
| JOB_COMPLETED | revenue | **yes** | yes |
| HIGH_MARGIN_JOB | premium | **yes** | yes |
| BAD_LEAD / REFUND / COMPLAINT | negative | no | no |

Upload path: `uploadQueue()` generates Google-ready payloads **only** for
bidding-eligible events whose lead has a click id **and** `consent ===
'granted'`; everything else lands in `skipped` with a reason (visible gap,
never silent). `releaseExport()` is the human step that marks a batch
released (`EXPORT_CONVERSIONS`, `aiAllowed:false`); `transmitted:false` is
stored on every batch — **no adapter exists yet and nothing calls Google**.

Legacy note: `ad-attribution.js` still carries its own single
`recordConversion()` (one value per lead). It remains for back-compat with the
existing ROAS view; the ladder is the forward path. Consolidation is a Slice 5
decision.

## 4. Gateway actions (ads-relevant policy table entries)

All in `js/core/aaa-runtime-gateway.js` `ACTIONS` (code constants — no config
override, no prompt bypass; every attempt audited to `audit_log`):

| Action | Permission | aiAllowed | Used by |
|---|---|---|---|
| `REVIEW_ADS_RECOMMENDATION` *(new)* | VIEW_FINANCIALS | **false** | `AAA_ADS_GOVERNANCE.approve()` |
| `APPLY_ADS_CHANGE` *(new)* | VIEW_FINANCIALS | **false** | `AAA_ADS_GOVERNANCE.clearForApply()` |
| `EXPORT_CONVERSIONS` *(new)* | VIEW_FINANCIALS | **false** | `AAA_ADS_CONVERSIONS.releaseExport()` |
| `SEND_QUOTE` / `MODIFY_QUOTE` / `RESOLVE_QUOTE` | APPROVE_QUOTE / CREATE_QUOTE | false | quote lifecycle (estimate truth) |
| `SEND_MESSAGE` / `APPROVE_ASSISTED_MSG` | EDIT_CUSTOMER | false | any customer-facing copy activation |
| `GOVERN_REGISTRY` | MANAGE_GOVERNANCE | false | versioning ads agent prompts/policies |

`js/revenue/ads-governance.js` → `AAA_ADS_GOVERNANCE` (collection
`ads_recommendations`): every recommendation is wrapped + sealed in a decision
envelope (no envelope module → `NO_GOVERNANCE`, nothing recorded). Mutation
types (`BUDGET_CHANGE`, `CAMPAIGN_LAUNCH`, `CAMPAIGN_PAUSE`,
`BID_STRATEGY_CHANGE`, `NEW_SERVICE_AREA`, `CONVERSION_GOAL_CHANGE`) can
**never** auto-approve — belt-and-braces on top of the gate's conservative
default. Advisory types (negative-keyword patches, tracking alerts…) may
auto-approve, matching the plan's "guarded apply" tier. `clearForApply()`
returns a change order for a future adapter; it applies nothing.

## 5. RBAC

`js/core/aaa-rbac.js`. Roles owner/manager/crew; owner holds everything.
The chain for an ads mutation is owner-only end-to-end:

- `VIEW_FINANCIALS` (gateway permission on all three ads actions): **owner only** — managers explicitly excluded from the books.
- `OVERRIDE_AI_DECISION` (envelope approval): **owner only**.
- Envelope also refuses non-human approver identities (`agent:*`, `mission:*`, the authoring agent itself) regardless of RBAC.

## 6. Firestore rules

`firestore.rules` classifies collections; financial ⇒ owner-only, enforced
server-side. Slice 1 added `ads_conversion_events`, `ads_conversion_exports`,
`ads_recommendations` to `isFinancialCollection` (they carry realized revenue
values and spend payloads). `ad_attribution` deliberately stays
member-writable: lead intake (manager/crew devices) must attach click context,
and the record holds no money and no PII. `decision_envelopes` and `audit_log`
retain their existing handling (`audit_log` has its own append-only block).
Rules tests (`npm run test:rules`) need the Firebase emulator + Java — not run
in this environment; see Risks.

## 7. Slice 1 files

| File | Change |
|---|---|
| `js/intelligence/ad-attribution.js` | UTM set, channel, city/zip, consent, `fromUrl()` |
| `js/leads/lead-store.js` | `google_ads` source, `attribution` intake delegation, `attributionCaptured`, `missingAttribution()` |
| `js/revenue/ads-conversion-ledger.js` | **new** — the 10-event dedupe ladder + gated export release |
| `js/revenue/ads-reporting.js` | **new** — read-only join: attribution × ladder × Lead OS outcomes → campaign scorecard, diagnostics, owner brief |
| `js/revenue/ads-governance.js` | **new** — envelope-sealed recommendations, forced approval on mutations, gateway-routed approve/apply |
| `js/core/aaa-runtime-gateway.js` | 3 new ads actions, all `aiAllowed:false` |
| `firestore.rules` | 3 new financial collections |
| `schemas/google-ads-attribution.json` | **new** — JSON Schema for attribution record, conversion event, upload payload |
| `index.html`, `sw.js` | script tags + precache (cache bump v103) |
| `test/run.js` | 4 new suites registered |

## 8. Tests

`npm test` — 3,652 assertions across 185 suites, all green. New suites:

- `unit/lead-attribution.test.js` (17): attribution captured at intake; UTM/consent stored; PII never in the attribution collection, event bus, or agent logs; missing attribution visible; organic intake untouched.
- `unit/ads-conversion-ledger.test.js` (18): 10 types; (leadId,type) dedupe; PII whitelist; upload gated on click id + consent with reasoned skips; negative/volume events never uploadable.
- `unit/ads-reporting.test.js` (17): raw leads ≠ won jobs; revenue only from primary signals with no double-count; spend never invented; PII-free rows; byte-identical store after a full reporting run (read-only proof).
- `unit/ads-governance.test.js` (20): mutations always await approval (even at confidence 95); AI-origin approve/apply/export hard-blocked (`AI_NOT_PERMITTED`) and audited; nothing clears unapproved; no envelope module → no recommendation; no gateway → no approval.

## 9. Risks

1. **Quotes don't carry `leadId`.** Quote records key on `customerId`/`jobId` with only a `leadSource` string, so estimate-truth (final price, job cost, margin) joins to campaigns only via the conversion events sales staff record. A first-class `leadId` on quotes (Slice 2) closes the strongest loop: click → quote margin.
2. **Two conversion representations.** The legacy single `conversion` on `ad_attribution` and the new ladder coexist. Harmless today (different consumers), but Slice 5's upload pipeline must pick one source of truth (the ladder) and migrate the ROAS view.
3. **Rules tests not executed here.** The `firestore.rules` change is additive and pattern-identical to 30+ existing entries, but `npm run test:rules` needs the Firebase emulator (Java); run it before deploying rules.
4. **No provenance traces yet.** Evidence lives in the sealed envelope; `AAA_PROVENANCE` traces (source data → outcomes → comparable cases) should be attached per recommendation when the first real agent lands (Slice 3).
5. **Consent capture is schema-only.** The field exists and gates uploads, but no UI/intake flow sets it yet — until then every upload is (correctly) blocked with `NO_CONSENT`, which is honest but means zero uploadable conversions.
6. **`HIGH_MARGIN_JOB` threshold is undefined.** The event exists; the rule that emits it (margin % floor, from quote cost data) belongs to the margin-guardian integration in Slice 2.
7. **Owner-only conversion recording.** `ads_conversion_events` is financial (owner-only in Firestore); if managers should record QUALIFIED_LEAD from the field, the recording flow must run owner-side or the classification needs revisiting.

## 10. Non-goals (explicitly not built, by design)

- **No Google Ads API client, real or fake.** No OAuth, no developer token, no mock that pretends to mutate campaigns. When credentials exist, an adapter consumes approved change orders and released export batches — both already audited artifacts.
- **No autonomous spend changes** — mutations cannot auto-approve, period.
- **No PII to Google** — no enhanced-conversion hashing yet; that is Slice 5, behind consent + a governed export.
- **No CPL/CTR optimization** — the scorecard's unit economics are cost per **won job** and revenue per ad dollar; margin-adjusted CPA arrives when quotes join by `leadId`.
- **No LSA/PMax integration** — Phase 2/3 per the plan, after Search + measurement truth are proven.

## 11. PROJECT TITAN alignment

TITAN's six layers largely map onto systems that already exist here; the Ads
team is one node of that ecosystem, not a separate platform:

| TITAN layer | Existing HyperKernel counterpart |
|---|---|
| 1 Business Digital Twin | `twin_scenarios`, `js/core/knowledge-graph.js`, world-model + signal registry (`js/intelligence/`) |
| 2 Enterprise Memory | event bus + taxonomy, spatial event ledger, outcome spine, visual memory, `job_memory`, knowledge OS |
| 3 Autonomous Intelligence Org | Executive/Revenue/Innovation councils, workforce registry/queue/scheduler, agent OS, supervisor |
| 4 Continuous Experimentation | creative-evolution engine, eval-golden store, calibration registry — an Experiment Agent (plan §9) is the gap |
| 5 Predictive Intelligence | win-probability, demand-pulse, prediction-actual comparator, prediction closures |
| 6 Autonomous Optimization | budget-physics engine, pricing optimizer, margin guardian — all advisory, gateway-gated |

The Evidence Engine contract (why / certainty / evidence / rollback) is
exactly the Decision Envelope schema; TITAN's governance list (reversible,
versioned, logged, attributable, reproducible, explainable) is the envelope +
audit ledger + governance registry + replay sandbox. The practical TITAN path
is: keep every new division shipping through the envelope/gateway spine, and
grow the ads slices (2→7) into the Marketing Division of the org chart rather
than building a parallel system.

## 12. Slice 2–3 addendum (2026-07-09)

Built by a coordinated agent team after the Slice 1 audit above; see
`docs/ADS_EVENT_TAXONOMY.md` and `docs/ADS_ATTRIBUTION_SCHEMA.md` for the
canonical contracts.

- **Click → margin loop closed (Slice 2)**: quotes now carry `leadId`
  (`AAA_QUOTES.createDraft` and the estimator's `draftQuote` forward it; the
  outcomes training record includes it; `customerView()` still hides it). The
  campaign scorecard joins WON-quote margin via that key: `grossMarginUSD`,
  `marginKnownWon` (coverage visibility), and with real spend
  `marginPerAdDollar` + `costPerMarginDollar` — the margin-adjusted north-star
  cells. Unknown stays null, never invented.
- **Ads agents are now measurable**: `AAA_ADS_GOVERNANCE.recommend()` registers
  every recommendation in `AAA_AGENT_OUTCOMES` (`outcomeDecisionId`; reject →
  `overridden` + training queue) and appends an `AAA_PROVENANCE` trace
  (`provenanceId`: evidence + envelope citation). Both advisory — a missing
  registry never blocks governance, the record then honestly carries null.
- **HIGH_MARGIN_JOB rule defined**: `recordJobFinancials(leadId, {revenueUSD,
  costUSD})` always records JOB_COMPLETED and adds HIGH_MARGIN_JOB when margin
  % ≥ `adsHighMarginPctFloor` (default 55). Raw cost is never stored — only the
  margin value survives.
- **Data Manager–first adapter layer** (`js/ads/`): `AAA_ADS_DATAMANAGER`
  consumes only human-released export batches, validates the
  exactly-one-click-id rule (GBRAID/WBRAID case preserved verbatim), maps to
  Data-Manager-shaped requests, and `dryRun()` writes honestly-labeled
  `mode:'fixture'` records to `ads_transmission_fixtures` (owner-only in
  firestore.rules). There is deliberately NO transport: `send()` returns
  `NO_CREDENTIALS` or `TRANSPORT_NOT_IMPLEMENTED` — success is never faked and
  `batch.transmitted` never flips. `AAA_ADS_MOCK_CLIENT` is a deterministic
  test-only fake, not loaded by index.html.
- **Diagnostics**: `AAA_ADS_DIAGNOSTICS.healthReport()` — 8 read-only checks
  (click-id/consent coverage, upload blockers, dedupe integrity, orphan
  events, missing attribution, value sanity, unreleased backlog).
- Tests: 3,786 assertions across 190 suites, all green (9 ads-specific suites).

**Review status (final, 2026-07-09)**: the 4-lens adversarial review workflow
completed — 15 raw findings across correctness / governance-security /
PII-honesty / test-gaps lenses, deduped to 12, each judged by two independent
skeptics. **5 confirmed, all fixed with regression tests in the same commit**:

1. *(critical)* `campaignScorecard` summed HIGH_MARGIN_JOB's derived-margin
   valueUSD into `revenueUSD` alongside JOB_COMPLETED revenue — a $10,000 job
   at 60% margin reported as $16,000. Fixed: HIGH_MARGIN_JOB is margin, never
   revenue (excluded from the revenue sum and the valued-leads dedupe map).
2. *(major)* `recordJobFinancials` ignored `completed.deduped`: a repeat call
   with different numbers could fabricate a HIGH_MARGIN_JOB the recorded job
   never earned. Fixed: first write wins; on dedupe the repeat's numbers are
   ignored and marginPct returns null (the original cost is never stored).
3. *(major)* negative `costUSD` was accepted, fabricating margin beyond the
   job's revenue (sign/data-entry errors). Fixed: `COST_MUST_BE_NON_NEGATIVE`.
4. *(major test-gap)* the revenueUSD × grossMarginUSD interplay on a single
   lead was unasserted. Fixed: interplay + margin-not-revenue regressions.
5. *(minor)* `fromUrl()` kept URL fragments: `#email=…` persisted into the
   landing page and a fragment after `?gclid=` fused into the stored click
   id. Fixed: fragments are stripped before parsing (doc claim now true).

7 findings were refuted by both skeptics (pre-existing behavior, intentional
and documented, or immaterial); 1 test-coverage finding (diagnostics'
workspace filters) went unverified when its two verifier agents hit a session
limit — it alleges a coverage gap, not a defect, and is carried as a known
minor gap rather than silently dropped.

## Recommended next slice

**Slice 2 — Reporting Brain**: add `leadId` to quote drafts, join quote
margin into the campaign scorecard (margin-adjusted cost per won job — the
north star), wire `AAA_ADS_GOVERNANCE.recommend()` to register in
`AAA_AGENT_OUTCOMES`, and emit the owner brief on a schedule.
