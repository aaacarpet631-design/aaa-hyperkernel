# Field Room Scan Engine (PR #79)

> Manual entry, Bluetooth laser, and room scan are **three inputs into the same
> capture truth ledger** — not a separate estimating path.

The Room Scan Engine adds polygon/perimeter capture to the existing
`AAA_FIELD_CAPTURE_SESSION` and feeds the **same** Seam & Layout Optimizer richer
geometry when available — without replacing laser or manual entry.

## Modules (`js/field/`)
- `scan-normalizer.js` (`AAA_SCAN_NORMALIZER`) — points (m/cm/mm/in/ft) → feet; shoelace area; perimeter; bounding box (length = longer side). `<3 points → insufficient_data`.
- `scan-anomaly-flags.js` (`AAA_SCAN_ANOMALY_FLAGS`) — the field-veteran anomaly catalog, **moisture first**, with deterministic labor modifiers + waiver/manager flags (see below).
- `scan-confidence-engine.js` (`AAA_SCAN_CONFIDENCE_ENGINE`) — trust from source + vertex count + closure + device confidence; folds anomaly severity into risk + `needsReview`.
- `room-polygon-store.js` (`AAA_ROOM_POLYGON_STORE`) — append-only, deep-frozen polygon overlay.
- `room-scan-engine.js` (`AAA_ROOM_SCAN_ENGINE`) — **provider abstraction** + mock provider; `capture()` → normalized polygon. Real LiDAR/RoomPlan don't exist in the PWA runtime → only the mock ships; an unimplemented source with no points returns `unavailable` (no fake hardware).
- `scan-to-capture-adapter.js` (`AAA_SCAN_TO_CAPTURE_ADAPTER`) — create a room from the polygon bbox, or attach to an existing manual/laser room **conflict-checked and non-destructively**.
- `room-scan-ui.js` (`AAA_ROOM_SCAN_UI`) — scan panel (start/save outline, area/perimeter, confidence, conflict + moisture warnings, needs-review badge, **explicit Review Layout** button).

## Polygon schema
`{ polygonId, sessionId, roomId, source, units, points, perimeterFt, areaSqFt,
bbox, confidence, risk, conflicts, needsReview, anomalies, laborModifier,
waiverRequired, managerReview, recommendedActions, capturedAt, provenanceId }`.
Sources: `manual_polygon · camera_scan · lidar_scan · roomplan_import · mock_scan`.

## Three inputs, one truth — and conflict safety
- **Create** a room from a scan (bbox → `addRoom`, source tagged scan via the polygon overlay).
- **Attach** to an existing room: the scan bbox is compared to the room's
  laser/manual dimensions. If they disagree beyond tolerance, a **conflict** is
  recorded, **both are preserved** (laser/manual dimensions are never
  overwritten), and the polygon is `needsReview`. The full polygon is always
  stored as an overlay — geometry the optimizer can consult later (PR #80).

## Anomaly capture (moisture-first)
Anomalies are **captured/tapped inputs** (a tech today; vision/thermal later) —
never fabricated here. The catalog, in priority order: `moisture_intrusion`,
`furniture_complexity`, `stair_complexity`, `pattern_seam_risk`,
`subfloor_integrity`, `pet_urine_saturation`, `transition_complexity`,
`door_clearance_risk`, `baseboard_damage_risk`, `appliance_move_risk`.

Each carries a deterministic labor modifier by severity and whether it requires
a waiver / manager review. **Moisture (and subfloor/pet) HIGH forces
`needsReview` + `waiverRequired`** and records a `laborModifier` for the
Installation Twin (PR #81) to consume **after review** — PR #79 does **not** apply
labor to a price, generate the waiver, or mutate a quote.

## Governance guarantees
- No separate estimating path — everything lands in the capture session.
- Scan never silently overwrites laser/manual; conflicts preserve both.
- Low confidence / high-severity anomaly → `needsReview`.
- The optimizer runs **only** on an explicit "Review Layout" tap, never on
  capture. No production quote mutation (tested). Append-only polygon history.
- Honest: insufficient geometry → `insufficient_data`; real hardware sources →
  `unavailable` until a provider is registered.

## Tests
`test/unit/room-scan-engine.test.js` (23): normalization, area, perimeter,
mock provider + honest hardware unavailability, attach to the shared session,
scan/laser **conflict detection with both preserved**, low-confidence →
needsReview, **moisture → waiver + needsReview + labor modifier**, explicit
review-layout only, no production quote mutation, UI render model.

## Known limitations
- Anomalies are captured inputs; automatic detection (thermal/vision) is PR #82/#87.
- The optimizer still consumes the bbox rectangle; full-polygon (non-rectangular)
  layout is a follow-up once the Spatial Intelligence mesh (PR #80) lands.
- LiDAR/RoomPlan providers are seams only — register a real bridge when the
  native runtime exposes the API.

## Next recommended organ
**PR #80 — Spatial Intelligence Engine** (`AAA_SPATIAL_INTEL`): turn the polygon +
anomalies into an environment mesh (objects, transitions, hazards), where
fixed objects carry **both** a `subtraction_sqft` and a `labor_penalty`
(tracked separately, never a flat %).
