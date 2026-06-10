# HyperKernel Field Brain — job-optional Field Capture Session

## Purpose
The payoff of Field Mode: tap **START MEASUREMENT**, walk the house capturing
Room 1 / Room 2 / Room 3, and HyperKernel builds the quote — measurements,
material quantities, waste, stairs, labor, and a priced range — **without a
keyboard and without first creating a job**.

## What was reused (not rebuilt)
Pricing/waste/stairs/labor already live in `AAA_MEASUREMENT_QUOTE`
(`buildQuote`, rate card, hard business rules), per-room capture in
`AAA_MEASUREMENT_STORE` + `AAA_MEASUREMENT_MODELS`, guided capture in
`AAA_CAPTURE_SEQUENCER`. The gap was the **multi-room, job-optional session**
and its **aggregation** — that is all this organ adds.

## Components (`js/measurements/`)
- **`field-brain.js`** (`AAA_FIELD_BRAIN`) — pure, deterministic calculators:
  - `aggregate(rooms)` → total sqft (L×W or explicit), linear ft, stairs, room count
  - `materialPlan(sqft)` → 12-ft-wide carpet plan: sqft + waste → **running linear feet of a 12-ft roll** (carpet is sold by the running foot at a fixed width); optional whole-roll count if a roll length is configured
  - `laborHours(sqft, stairs)` → honest labor estimate (configurable productivity)
  - `serviceSelections(rooms)` → pricing inputs for `AAA_MEASUREMENT_QUOTE`, adding a stairs line when any room has stairs
  - Computes only from what was captured — empty → `insufficient_data`, never invented sizes.
- **`field-capture-session.js`** (`AAA_FIELD_CAPTURE_SESSION`) — the orchestrator:
  - `start({customerId?})` → a job-optional session (`status:'capturing'`)
  - `addRoom(id, room)` → captures a room via the measurement store (reuse)
  - `summarize(id)` → the Field Brain aggregate + material plan + labor
  - `buildQuoteDraft(id, {service})` → **one aggregated quote draft** across all
    rooms via `AAA_MEASUREMENT_QUOTE.buildQuote` (always `needsReview`)
  - `attachToJob(id, jobId)` → links the session + rooms to a job and returns
    estimate entries for the caller to persist — it does **not** mutate the job's
    business record itself

## Wiring
`AAA_FIELD_MODE_HOME.start()` now opens a Field Capture Session (job-optional)
and, when present, boots the measurement HUD bound to it. The "Field Brain"
turns the capture session into the quote.

## Honesty & safety
- No room → no quote (`insufficient_data`); no pricing engine → physical
  aggregate only, clearly labeled.
- The quote draft **always** `needsReview` — nothing finalizes a price.
- Mutates no job business record; it writes field-capture/measurement collections
  and returns estimate entries for an explicit, governed attach step (tested: no
  job mutation).

## Tests
`test/unit/field-capture-session.test.js` (17): Field Brain calculators (sqft,
12-ft material plan + waste, labor, stairs selection), session lifecycle, room
capture, aggregation, one aggregated quote draft (reusing the pricing engine,
needs-review), honest empty case, attach-to-job linkage + estimate entries, and
no job-record mutation.

## Known limitations
- The session opens the existing measurement HUD per the available capability;
  a fully unified photo+laser+voice capture surface bound to the session id is
  the next UI step.
- Material plan reports running linear feet of a 12-ft roll; multi-roll
  seam-layout optimization (nap direction, fill pieces) is a future Field Brain
  upgrade.

## Next recommended organ
**Seam & layout optimizer** — given the captured room rectangles, compute the
optimal cut layout on 12-ft rolls (nap-direction-consistent, minimal seams and
fill pieces), feeding a tighter material quantity and waste number back into the
quote draft.
