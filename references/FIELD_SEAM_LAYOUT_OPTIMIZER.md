# Field Seam & Layout Optimizer

> Field Brain captures reality; the Seam & Layout Optimizer turns reality into
> margin. It sits directly beneath `AAA_FIELD_BRAIN` / `AAA_FIELD_CAPTURE_SESSION`.

## Why carpet layout is not square footage
A square-foot calculator says "270 ft² → order 270 ft² + 10%." That is wrong for
carpet. Carpet ships on a **fixed 12-foot-wide roll** and is cut as drops along
the roll's length. A 15×18 room can't be a single 15×18 piece — the roll is only
12 ft wide. You order **running feet of a 12-ft roll**, and the real waste comes
from how rooms box onto that fixed width, not from a flat percentage.

## The 12-foot roll constraint
`AAA_LAYOUT_CONSTRAINT_ENGINE.ROLL_WIDTH_FT = 12` (hard-coded, not a rate-card
setting). Every room is boxed into 12-ft-wide drops:
- room width ≤ 12 ft → **one main drop**, leaving a reusable leftover strip
- room width > 12 ft → **main drop (12 ft) + a fill strip** for the remainder

## The nap direction rule
Carpet pile (nap) reflects light; a piece laid against the nap shows as a
different shade. So:
- **Nap must stay consistent** across the whole job.
- A fill piece is **never rotated** to fake a waste saving (rotating flips the
  nap). The cut list records `rotated: false` on every fill, always.
- Nap is resolved (Pass 1) from a user-selected direction, else a hallway hint,
  else **UNKNOWN** — and UNKNOWN forces `needsReview: true`.

## Fill-piece harvesting (Pass 3)
A wide room's fill is harvested from a leftover strip of a narrower room's drop —
but **only** when the nap matches (it always does; we never rotate), the
dimensions fit, and the strip is above the minimum practical width. Harvesting is
order-independent (all leftovers in the plan are candidates), so a fill is taken
from the best leftover regardless of capture order. A harvested fill consumes no
fresh roll → lower waste. An un-harvestable fill orders fresh roll **at the same
nap**.

## Seam risk scoring (Pass 4)
`AAA_LAYOUT_RISK_ANALYZER` flags: `narrow_fill_strip`, `unusual_geometry`
(extreme aspect ratio), `multi_room_nap_conflict` (UNKNOWN nap, >1 room), and —
because the capture does not yet record doorways/traffic/light lines —
`missing_threshold_data`, which means seam placement **cannot be verified from
the data** and must be confirmed on site. Risk → low/medium/high.

## The quote review gate
Pass 5 produces `totalLinearFeetOrdered`, `totalSquareYards`,
`calculatedWastePercentage`, the cut list, and a risk score — but **every
quote-impacting plan is `needsReview: true`**. The optimizer never sends a quote
or changes a price; an estimator confirms the layout first. The UI shows an
**"Estimator Review Required"** badge. Plans are append-only
(`AAA_LAYOUT_PLAN_STORE`, deep-frozen records).

## Example: a 15×18 room (nap LENGTHWISE)
```
boxRoom(15×18, LENGTHWISE)
  main drop : 12ft × 15ft        (roll length runs the 15ft room length — nap fixed)
  fill strip:  6ft × 15ft        (18 − 12 = 6ft remainder, same nap, NOT rotated)
→ order ~30 linear ft of 12-ft roll (main 15ft + fresh fill 15ft if no leftover)
→ square yards = 30 × 12 / 9 = 40 yd²
→ used 270 ft² of 360 ft² ordered → waste ≈ 25%
→ risk: missing_threshold_data (confirm seam placement) → needsReview: true
```
With a compatible narrow room in the same job, the 6-ft fill can be harvested
from its leftover instead of ordering fresh — cutting the waste and the linear
feet.

## Files
`js/field/`: `layout-constraint-engine.js`, `cut-list-generator.js`,
`layout-risk-analyzer.js`, `layout-plan-store.js`, `seam-layout-optimizer.js`,
`layout-ui.js`. Reuses the captured rooms from `AAA_FIELD_CAPTURE_SESSION`; feeds
review-gated numbers the Field Brain / quote draft can adopt after approval.

## Known limitations
- Doorway / traffic / light-line data isn't captured yet, so seam-placement
  risks are surfaced as `missing_threshold_data` (honest) rather than precisely
  located. Threshold capture is a future Field Mode field.
- Packing is a single greedy pass (largest drops first, then fill harvesting);
  a true 2-D nesting solver could squeeze a few more harvested fills.
- Rooms are treated as rectangles (length × width); L-shaped/irregular rooms need
  sub-region capture.

## Next organ
**Bluetooth Laser Measurement Bridge** — let the capture session ingest real
length/width readings directly from field laser devices, so the layout optimizer
runs on measured geometry instead of typed numbers.
