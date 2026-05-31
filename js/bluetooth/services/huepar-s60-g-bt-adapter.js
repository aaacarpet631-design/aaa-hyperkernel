/*
 * AAA Huepar S60-G-BT Adapter — first-class support for the Huepar S60-G-BT
 * Bluetooth Laser Distance Meter, layered on top of the generic BLE adapter.
 *
 * WHY A SUBCLASS, NOT A REWRITE:
 *   The generic adapter already does the hard, correct Web Bluetooth work —
 *   user-gesture picker, GATT connect with timeout, walk every primary service,
 *   subscribe to every notify/indicate characteristic, reconnect, battery,
 *   raw-frame logging. We inherit ALL of it and override only two seams:
 *     - parse(dataView): Huepar-aware parsing (still falls back to the shared
 *       parser, so we never regress).
 *     - _onValue(): adds debug capture + de-dupe + confidence/unit-source on top
 *       of the inherited raw logging and reading emit.
 *   The generic adapter is never modified by this file beyond contributing one
 *   optional service UUID to the picker (required by Web Bluetooth — see below),
 *   and that path is additive and guarded.
 *
 * HONESTY ABOUT THE FRAME FORMAT:
 *   The exact on-wire format of the S60-G-BT is not publicly documented. Huepar
 *   BT meters are commonly Mileseey-family modules that expose a Nordic UART
 *   Service (NUS) and stream the live distance as ASCII text (e.g. "1.234 m").
 *   We therefore (a) register the NUS UUID so the data service is visible,
 *   (b) try ASCII + a few binary heuristics, and (c) — most importantly — record
 *   EVERY raw frame to a debug ring and AAA_BLE_RAW_LOG so a real device can be
 *   mapped precisely. NO fabricated readings are ever emitted: parse() returns
 *   null when a frame isn't confidently a measurement, and the HUD shows the
 *   raw hex/ASCII so we can finish the mapping from real captures.
 *
 * SAFETY / FLOW (unchanged from the rest of the system):
 *   Clean readings are pushed to the HUD via onReading(); the tech reviews them,
 *   builds rooms, and only THEN drafts a quote. This adapter never finalizes a
 *   quote and never writes a room on its own. Manual entry remains available.
 */
;(function (global) {
  'use strict';

  function Base() { return global.AAA_GENERIC_BLE_ADAPTER; }
  function parser() { return global.AAA_MEASUREMENT_PARSER; }
  function rawLog() { return global.AAA_BLE_RAW_LOG; }
  function clock() { return global.AAA_RUNTIME_CLOCK; }
  function nowMs() { return clock() && clock().now ? clock().now() : Date.now(); }

  // --- Known/likely UUIDs for Huepar (Mileseey-family) BT meters -------------
  // Nordic UART Service is the common transport for these modules. Registering
  // it makes the data service visible after connect (Web Bluetooth only exposes
  // services declared at pick time). If a given unit uses a different service,
  // the generic service-walk + debug log still capture it for mapping.
  const NUS_SERVICE = '6e400001-b5a3-f393-e0a9-e50e24dcca9e';
  const NUS_TX_NOTIFY = '6e400003-b5a3-f393-e0a9-e50e24dcca9e'; // device → app
  const HUEPAR_OPTIONAL_SERVICES = [NUS_SERVICE];

  // Name fragments that identify (or plausibly identify) the device in the
  // OS picker. Matching is case-insensitive and substring-based.
  const NAME_HINTS = ['huepar', 's60-g-bt', 's60-g', 's60', 'mileseey', 'laser', 'ldm', 'distance'];

  const DEDUPE_MS = 600;          // ignore identical readings within this window
  const DEDUPE_EPS_FT = 0.003;    // ~1 mm — treat as the "same" reading
  const DEBUG_RING = 60;          // debug frames kept in memory

  function HueparS60Adapter() {
    Base().call(this);            // run the generic constructor (sets up state)
    this.id = 'huepar-s60-g-bt';
    this.label = 'Huepar S60-G-BT Laser';
    this._lastReading = null;     // { feet, at } for de-dupe
    this._debug = [];             // ring of { at, deviceName, serviceUuid, characteristicUuid, hex, ascii, feet, unit, confidence, via }
    this._debugEnabled = false;
  }

  // Inherit the generic adapter's prototype, then override the two seams.
  HueparS60Adapter.prototype = Object.create(Base().prototype);
  HueparS60Adapter.prototype.constructor = HueparS60Adapter;

  /** Static: does this device (by name) look like a Huepar/compatible meter? */
  HueparS60Adapter.matchesName = function (name) {
    if (!name) return false;
    const n = String(name).toLowerCase();
    return NAME_HINTS.some((h) => n.indexOf(h) !== -1);
  };

  // ---- field-debug mode -----------------------------------------------------
  HueparS60Adapter.prototype.setDebug = function (on) { this._debugEnabled = !!on; };
  HueparS60Adapter.prototype.isDebug = function () { return this._debugEnabled; };
  HueparS60Adapter.prototype.debugFrames = function (n) { return this._debug.slice(-(n || DEBUG_RING)).reverse(); };
  HueparS60Adapter.prototype.clearDebug = function () { this._debug = []; };

  /**
   * Override of the generic _onValue: keep the inherited behavior (raw logging
   * + emit), but also (a) capture a rich debug frame and (b) de-dupe rapid
   * repeats so the HUD field doesn't flicker while the trigger is held.
   */
  HueparS60Adapter.prototype._onValue = function (serviceUuid, characteristic) {
    const value = characteristic.value; // DataView

    // 1) Always log the raw frame first (black-box recorder) — verbatim.
    if (rawLog()) {
      rawLog().record({
        deviceId: this._device ? this._device.id : null,
        serviceUuid: serviceUuid,
        characteristicUuid: characteristic.uuid,
        value: value,
        note: 'huepar'
      });
    }

    // 2) Parse (Huepar-aware, falls back to shared parser).
    const parsed = this.parse(value);

    // 3) Debug frame — captured whether or not parsing succeeded, so unknown
    //    frames are visible for mapping. Never fabricated.
    const dbg = {
      at: nowMs(),
      deviceName: this._device ? (this._device.name || 'Unknown') : null,
      serviceUuid: serviceUuid,
      characteristicUuid: characteristic.uuid,
      hex: rawLog() ? rawLog().toHex(value) : null,
      ascii: readAsciiPrintable(value),
      feet: parsed ? parsed.feet : null,
      unit: parsed ? parsed.unit : null,
      unitSource: parsed ? parsed.unitSource : null,
      confidence: parsed ? parsed.confidence : 0,
      via: parsed ? parsed.via : null
    };
    this._debug.push(dbg);
    if (this._debug.length > DEBUG_RING) this._debug.shift();

    if (!parsed) return;          // unknown frame: logged, but nothing emitted

    // 4) De-dupe: drop identical readings inside a short window.
    const last = this._lastReading;
    if (last && Math.abs(last.feet - parsed.feet) <= DEDUPE_EPS_FT && (dbg.at - last.at) < DEDUPE_MS) {
      return;
    }
    this._lastReading = { feet: parsed.feet, at: dbg.at };

    // 5) Emit a clean reading to the HUD (review-before-use; never auto-quote).
    this._emitReading(parsed);
  };

  /**
   * Huepar-aware parse. Strategy, highest confidence first:
   *   1. ASCII text with an explicit unit ("1.234 m", "10ft 6in", '40 1/2"').
   *   2. Shared parser's binary heuristics (float32 m / uint mm), re-tagged.
   *   3. null — never guess a bare number into a measurement here.
   * Returns the standard ParsedReading shape + { unitSource } so the HUD can
   * show where the unit came from (device text vs. inferred binary).
   * @param {DataView} dataView
   */
  HueparS60Adapter.prototype.parse = function (dataView) {
    if (!dataView || !dataView.byteLength) return null;

    // --- 1. ASCII path (the most likely + most trustworthy for these meters) ---
    const ascii = readAsciiPrintable(dataView);
    if (ascii && /[0-9]/.test(ascii)) {
      // Reassemble fragmented ASCII: meters can split "1.234 m" across frames.
      const buffered = this._bufferAscii(ascii);
      const fromText = parser() ? parser().parseText(buffered) : null;
      if (fromText && hasExplicitUnit(buffered)) {
        this._asciiBuf = '';      // consumed a complete reading
        return decorate(fromText, 'ascii', 'device-text');
      }
      // Also try the raw fragment alone (single-frame complete readings).
      const single = parser() ? parser().parseText(ascii) : null;
      if (single && hasExplicitUnit(ascii)) {
        this._asciiBuf = '';
        return decorate(single, 'ascii', 'device-text');
      }
      // Incomplete ASCII so far — keep buffering, emit nothing yet.
      return null;
    }

    // --- 2. Binary fallback (delegate to the shared heuristic parser) ---
    const fromBin = parser() ? parser()._parseBinary(dataView) : null;
    if (fromBin) {
      // Binary unit is inferred, not stated by the device → mark the source and
      // cap confidence so review treats it cautiously.
      const out = decorate(fromBin, 'binary', 'inferred-binary');
      out.confidence = Math.min(out.confidence != null ? out.confidence : 0.4, 0.6);
      return out;
    }
    return null;
  };

  // Append a fragment to a short-lived ASCII buffer (cleared on a complete read
  // or when it grows unreasonable). Lets us stitch split frames without leaking
  // state across unrelated readings.
  HueparS60Adapter.prototype._bufferAscii = function (fragment) {
    const f = String(fragment || '').replace(/[^0-9a-zA-Z.,'"/ \-]/g, '');
    this._asciiBuf = ((this._asciiBuf || '') + f).slice(-48);
    return this._asciiBuf;
  };

  /**
   * Override requestDevice so a direct Huepar pick can use a name prefilter when
   * available, while still allowing acceptAllDevices (some units advertise no
   * recognizable name until selected). Falls back to the generic picker exactly.
   * In practice the HUD picks via the generic adapter and the registry routes to
   * us; this override is here for completeness + direct use.
   */
  HueparS60Adapter.prototype.requestDevice = async function () {
    if (!this.isSupported()) {
      return { ok: false, error: 'UNSUPPORTED', message: 'This browser does not support Web Bluetooth. Use manual entry, or open the app in Chrome on Android.' };
    }
    try {
      const device = await global.navigator.bluetooth.requestDevice({
        // Name prefilters narrow the picker to likely lasers, but we also accept
        // all so an unlabeled unit can still be chosen by the user.
        filters: NAME_HINTS.map((h) => ({ namePrefix: capitalizeFirst(h) }))
          .concat([{ services: [NUS_SERVICE] }]),
        acceptAllDevices: false,
        optionalServices: Base().optionalServices ? Base().optionalServices() : HUEPAR_OPTIONAL_SERVICES.concat(['battery_service'])
      });
      this._device = device;
      return { ok: true, device: { id: device.id, name: device.name || 'Unknown device' } };
    } catch (err) {
      // If the filtered picker found nothing, retry brand-agnostic so the user
      // is never stuck (e.g. a unit that advertises an unexpected name).
      if (err && err.name === 'NotFoundError') {
        try {
          const device = await global.navigator.bluetooth.requestDevice({
            acceptAllDevices: true,
            optionalServices: Base().optionalServices ? Base().optionalServices() : HUEPAR_OPTIONAL_SERVICES.concat(['battery_service'])
          });
          this._device = device;
          return { ok: true, device: { id: device.id, name: device.name || 'Unknown device' } };
        } catch (err2) {
          if (err2 && err2.name === 'NotFoundError') return { ok: false, error: 'CANCELLED', message: 'No device selected.' };
          return { ok: false, error: 'PICKER_FAILED', message: (err2 && err2.message) || String(err2) };
        }
      }
      return { ok: false, error: 'PICKER_FAILED', message: (err && err.message) || String(err) };
    }
  };

  // ---- helpers --------------------------------------------------------------
  function decorate(reading, via, unitSource) {
    // reading: { feet, raw, unit, confidence } from the shared parser.
    return {
      feet: reading.feet,
      raw: reading.raw,
      unit: reading.unit,                 // detected source unit (m|cm|mm|ft|in|unknown)
      unitSource: unitSource,             // where the unit came from
      confidence: reading.confidence,     // 0..1
      via: via,                           // 'ascii' | 'binary'
      brand: 'huepar-s60-g-bt'
    };
  }

  function hasExplicitUnit(text) {
    if (!text) return false;
    return /(mm|cm|\bm\b|ft|feet|'|in|inch|inches|")/i.test(String(text));
  }

  function readAsciiPrintable(dv) {
    let s = '';
    try {
      for (let i = 0; i < dv.byteLength; i++) {
        const c = dv.getUint8(i);
        if (c >= 32 && c < 127) s += String.fromCharCode(c);
      }
    } catch (_) {}
    return s.trim();
  }

  function capitalizeFirst(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : s; }

  // ---- registration ---------------------------------------------------------
  // Only register if the base adapter is present (load-order safety).
  if (Base()) {
    // 1) Make the Huepar/NUS service visible to the picker (additive).
    if (Base().registerOptionalServices) Base().registerOptionalServices(HUEPAR_OPTIONAL_SERVICES);

    // 2) Register with the device adapter registry so the controller routes
    //    matching devices to us automatically (priority above generic).
    if (global.AAA_DEVICE_ADAPTER_REGISTRY) {
      global.AAA_DEVICE_ADAPTER_REGISTRY.register({
        id: 'huepar-s60-g-bt',
        label: 'Huepar S60-G-BT Laser',
        priority: 50,
        match: function (info) {
          if (!info) return false;
          if (HueparS60Adapter.matchesName(info.name)) return true;
          // Match by advertised/known service if the picker surfaced it.
          const svcs = (info.services || []).map((s) => String(s).toLowerCase());
          return svcs.indexOf(NUS_SERVICE) !== -1;
        },
        factory: function () { return new HueparS60Adapter(); }
      });
    }
  }

  HueparS60Adapter.NUS_SERVICE = NUS_SERVICE;
  HueparS60Adapter.NUS_TX_NOTIFY = NUS_TX_NOTIFY;
  HueparS60Adapter.NAME_HINTS = NAME_HINTS.slice();
  global.AAA_HUEPAR_S60_ADAPTER = HueparS60Adapter;
})(typeof window !== 'undefined' ? window : this);
