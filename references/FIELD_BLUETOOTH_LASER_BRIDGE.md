# Bluetooth Laser Measurement Bridge

> Spatial measurements flow from the laser into material intelligence without
> keyboard entry: `Laser → AAA_BLUETOOTH_BRIDGE → AAA_FIELD_CAPTURE_SESSION →
> (explicit) AAA_SEAM_LAYOUT_OPTIMIZER → AAA_FIELD_BRAIN → review-gated draft`.

## What it reuses (zero duplication)
The BLE stack already exists and is reused wholesale:
- `AAA_DEVICE_ADAPTER_REGISTRY` — brand adapters register `match`/`factory`.
- `AAA_GENERIC_BLE_ADAPTER` — connect / subscribe / reconnect / timeout machinery.
- `AAA_MEASUREMENT_PARSER` — normalizes m / cm / mm / in → **feet** with a confidence score.
- `AAA_BLE_RAW_LOG` — black-box of raw frames for re-decoding unknown firmware.

This PR adds only the **device recognition** for two more brands and the **bridge**
that routes a parsed reading into the active room dimension.

## New components
- `js/bluetooth/services/leica-disto-adapter.js` (`AAA_LEICA_DISTO_ADAPTER`) — fingerprints Leica **DISTO** by name/manufacturer; registers above generic.
- `js/bluetooth/services/bosch-glm-adapter.js` (`AAA_BOSCH_GLM_ADAPTER`) — fingerprints Bosch **GLM**.
  Both are **provisional** (vendor GATT isn't publicly certified): they reuse the
  generic connect/parser path and keep the raw log on. Lab-validate before
  trusting for money-bearing measurements.
- `js/field/bluetooth-bridge.js` (`AAA_BLUETOOTH_BRIDGE`) — the bridge + state machine.
- `AAA_FIELD_CAPTURE_SESSION` gained keyboard-free capture: `beginRoom`,
  `setDimension(valueFt, 'length'|'width'|'height'|'generic')`, `activeDraft`.

## Payload + state
```
LaserMeasurementEvent : { value, rawUnit:'m'|'cm'|'in'|'ft' } OR { valueInFeet }, targetDimension, deviceId
BluetoothBridgeState  : { isDeviceConnected, activeDeviceId, signalStrength,
                          lastReceivedValue, activeSessionId, activeDimension }
```

## Flow
1. `setActiveSession(sessionId)` + `beginRoom()` + `setTarget({dimension})`.
2. `handleMeasurement(event)` → normalize to feet → `session.setDimension()`:
   - `'generic'` fills the next empty slot (length, then width);
   - when **length + width** are both present the room **auto-commits** via `addRoom` (source `'bluetooth'`) and the draft clears.
3. Emits `bluetooth.reading_captured` / `dimension_set` / `room_committed` for the UI.
4. `buildLayout()` runs the Seam & Layout Optimizer **explicitly** (review-gated) — it is **not** re-run on every laser pull.

## Field-UX decision (why the layout doesn't render per pull)
Capture stays distraction-free: the bridge emits lightweight per-reading events
(a confirmation chip + running totals), and the full layout plan is revealed only
on an explicit "Review layout" step. Rendering the optimizer mid-speech/mid-pull
is visual noise on a ladder, and a layout shown live would look "final" when it is
deliberately review-gated.

## Guardrails
- **No active session** → `NO_ACTIVE_SESSION` (honest; never invents a room).
- **Unparseable reading** → `UNPARSEABLE_READING` (never guesses a distance).
- **Graceful degrade:** a disconnect / auto-power-off flips `isDeviceConnected`
  and emits `bluetooth.degraded` but **never drops the open capture session**
  (it lives in the store); capture resumes cleanly on reconnect.
- **Review-gated + no production mutation:** `buildLayout` returns a
  `needsReview` plan; the bridge mutates no quote/job (tested).

## Tests
`test/unit/bluetooth-bridge.test.js` (19): adapters registered + name matching,
no-active-session honesty, length/width capture + metric→feet normalization +
auto-commit, generic-slot filling, unparseable rejection, shared-parser path,
graceful disconnect (session preserved) + reconnect, review-gated layout build,
no production mutation, and a wired stream source.

## Known limitations
- Leica/Bosch GATT UUIDs are provisional (name-fingerprinted, generic transport);
  add verified service/characteristic UUIDs after lab validation.
- Web Bluetooth is Chrome/Android-only; the bridge degrades to manual entry on
  unsupported browsers (the generic adapter reports `UNSUPPORTED`).

## Next organ (Tier 2)
`AAA_ROOM_SCAN_ENGINE` — LiDAR/RoomPlan perimeter capture feeding the same
capture session, so a room's full polygon (not just length×width) reaches the
layout optimizer.
