# Bluetooth Laser Measurement — Setup & Field Guide

A modular Bluetooth measurement layer for AAA HyperKernel. Captures room
measurements in the field (via a Bluetooth laser **or** manual entry), stores
them local-first, syncs to the cloud, and feeds them into quotes — with labor
cost hidden from the customer receipt.

> **Architecture note:** This app is a **vanilla-JS PWA**, not React Native /
> Expo. Bluetooth is therefore implemented with the **Web Bluetooth API**, wired
> into the existing `AAA_DATA` / `AAA_CLOUD` / quote layer. Types are expressed
> as JSDoc `@typedef` (real IDE typechecking, no build step).

---

## Files changed / added

**New — Bluetooth core (`js/bluetooth/`)**
- `services/raw-reading-log.js` — `RawBluetoothReadingLog`: logs every raw frame (hex+ascii) for debugging and for building new brand adapters.
- `services/measurement-parser.js` — `MeasurementParser`: ASCII + binary BLE frames → normalized **feet** (handles m/cm/mm/ft/in, `10ft 6in`, `10' 6"`).
- `services/generic-ble-adapter.js` — `GenericBleMeasurementAdapter`: real Web Bluetooth connect/subscribe/battery/reconnect/timeout; brand-agnostic.
- `services/device-adapter-registry.js` — `DeviceAdapterRegistry`: pluggable per-brand adapters (Bosch/Leica/DeWalt/Mileseey later) with generic fallback.
- `hooks/use-bluetooth-connection.js` — `AAA_BLUETOOTH`: stateful connection controller (the "hook"); support/permission gating, device persistence, last-connected memory, foreground reconnect.
- `screens/measurement-hud-ui.js` — all 8 screens in one HUD.

**New — measurements (`js/measurements/`)**
- `models/measurement-models.js` — `MeasurementSession` + `BluetoothDevice` factories, validation (bad-reading / unrealistic / duplicate detection).
- `storage/measurement-store.js` — local-first persistence, retry sync, conflict reconcile (last-write-wins), workspace isolation, soft-delete.
- `measurement-ai-assistant.js` — optional Claude review (advisory only, never finalizes price); local heuristic fallback when AI is off.

**New — quote integration (`js/quotes/`)**
- `integrations/measurement-to-quote.js` — rate-card pricing for install/stretch/repair/shampoo/stairs/hallway/apartment-turn/commercial; customer **receipt** that hides labor; emits existing `job.estimates[]` entries.

**Modified**
- `js/ui/job-list-ui.js` — added **“Measure Room”** button to job detail.
- `index.html` — loads the 10 new scripts in dependency order.
- `sw.js` — cache bumped to **v17**; precaches the new files.

**Docs**
- `SETUP-BLUETOOTH-MEASUREMENT.md` (this file).

---

## Required permissions

- **Browser:** Web Bluetooth prompts the OS device picker on tap (a user
  gesture is required — there is no silent background scan). The app must be
  served over **https** (it already is on Netlify).
- **Android:** Chrome asks for Bluetooth + (on Android 12+) "Nearby devices"
  permission the first time. Location services may need to be ON for BLE scans.
- **iOS/iPadOS:** **Not supported** — Apple does not implement Web Bluetooth in
  Safari or iOS Chrome. The app detects this and routes to **Manual Entry**.

---

## Supported device assumptions

- Any **BLE (Bluetooth Low Energy)** laser measure that exposes its reading via
  a GATT notify/indicate characteristic as ASCII text or a small binary frame.
- Standard GATT **Battery Service (0x180F)** is read when present.
- No brand is hardcoded. The generic adapter connects to anything you pick; to
  add first-class support for a brand, register an adapter (see below).

---

## How to connect a device (Android / desktop Chrome)

1. Open a job → **Measure Room** → **Scan for a device**.
2. Tap **Scan (open picker)** → choose your laser in the OS dialog.
3. **Connected Device Details** → set a **nickname** → **Connect**.
4. Battery and connection status show live at the top.

## How to capture a measurement

- **Bluetooth:** on the Capture screen, tap **“Use laser → Length”** (or Width /
  Linear / Stairs) to arm a field, then pull the laser trigger — the reading
  drops in. Square feet auto-calculates from L×W. Add notes → **Save room**.
- **Manual:** **Enter measurements manually** from Setup (works on every device,
  including iPhone). Same form, no device needed.

## How to send a measurement to a quote

1. **Review Rooms** → confirm rooms (delete any duplicates flagged).
2. (Optional) **AI review measurements** → flags missing rooms, unrealistic
   sizes, stair/waste risk, repair-vs-replace, confidence score.
3. **Send to quote** → tick services → **Build draft quote**.
4. **Preview customer receipt** (labor hidden) and/or **Apply to job (for
   review)** — this appends `job.estimates[]` entries marked `needsReview`.
   Nothing is finalized automatically.

## Fallback workflow if Bluetooth fails

Manual entry is offered on **every** screen and never blocks a quote. If a
device won't connect: ensure it's on/in range, Bluetooth enabled, then Scan and
re-pick it (browsers can't silently reconnect). Use **Troubleshooting / Manual
Mode** for a live capability checklist. On iPhone, manual entry is the path.

---

## Rate card (owner-configurable)

Pricing defaults in `measurement-to-quote.js` are **starting points**. Override
without code by setting a `rateCard` config value, e.g. from the console or a
settings screen:

```js
AAA_CONFIG.set({ rateCard: { install_per_sqft: 0.85, material_per_sqft: 2.95, min_job: 120 } });
```

Keys: `install_per_sqft`, `material_per_sqft`, `pad_per_sqft`,
`stretch_per_sqft`, `repair_per_linear_ft`, `shampoo_per_sqft`, `stairs_each`,
`hallway_per_sqft`, `apartment_turn_flat`, `commercial_per_sqft`,
`waste_factor`, `min_job`, `range_spread`.

---

## Adding a new laser brand later

```js
AAA_DEVICE_ADAPTER_REGISTRY.register({
  id: 'mileseey',
  label: 'Mileseey',
  priority: 10,
  match: (info) => /mileseey/i.test(info.name || ''),
  factory: () => {
    const a = new AAA_GENERIC_BLE_ADAPTER();
    a.parse = (dataView) => { /* brand-specific frame → {feet,unit,confidence} */ };
    return a;
  }
});
```

Connect the device once, take readings, and read `AAA_BLE_RAW_LOG.all()` to see
the exact frames you need to parse.

---

## Testing checklist

**Logic (verified with Node — parser/models/quote/store/AI all pass):**
- [x] Parser: meters/cm/mm/ft/in, `10ft 6in`, `10' 6"`, bare number, binary float32, junk→null.
- [x] Models: auto square-feet, workspace default, unrealistic/duplicate/override warnings.
- [x] Quote: per-service pricing, min-job floor, range formatting, **receipt hides labor**, estimates carry `source:MEASUREMENT` + `needsReview`.
- [x] Store: local-first save, `syncedToCloud:false` offline, soft-delete, workspace isolation.
- [x] AI assistant: degrades to local checks when proxy off; `reviewRequired` always true.
- [x] Registry: brand match wins, generic fallback otherwise.

**Field (manual, on devices):**
- [ ] Android Chrome: scan → connect → trigger laser → value lands in armed field.
- [ ] Battery shows when device exposes 0x180F.
- [ ] Background the app, return → reconnect attempt fires.
- [ ] Connection timeout shows a clear message (turn device off mid-connect).
- [ ] iPhone: Setup shows "not available", Manual Entry works end-to-end.
- [ ] Offline: capture rooms with no signal → all save → "Sync now" pushes when back online.
- [ ] Apply to job → estimates appear in job detail, marked for review.
- [ ] Customer receipt preview shows services + totals only (no labor/material lines).

---

## Safety guarantees (by design)

- **Never blocks a quote** — manual entry is always available.
- **Never finalizes price** — every quote/estimate is `needsReview`; AI is advisory.
- **Never loses field data** — saved to local storage before any network call.
- **Never fabricates** — unparseable readings return null; thin data says so.
- **Workspace-isolated** — two businesses on one device never see each other's data.
