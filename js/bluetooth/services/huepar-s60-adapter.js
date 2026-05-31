/*
 * AAA Huepar S60-family BLE Adapter — first-class support for Huepar S-series
 * Bluetooth laser distance meters (S60-G-BT and siblings).
 *
 * STATUS: experimental/huepar-s60-v1.
 * Huepar's official docs confirm the S-series Bluetooth models sync to the
 * Huepar app for real-time data, but the vendor does NOT publish a public GATT
 * profile. The UUIDs, commands and frame layouts below come from PUBLIC
 * REVERSE-ENGINEERING of the LDM-S60-BT, not vendor certification. They are
 * good enough to drive an adapter, but treat them as provisional:
 *   - fingerprint the device by NAME pattern + SERVICE shape (never assume the
 *     0xAE30 service id is globally unique / future-proof),
 *   - keep the RawReadingLog black box on so unknown firmware variants can be
 *     re-decoded later,
 *   - lab-validate against a real S60-family device before trusting it for
 *     money-bearing measurements.
 *
 * The adapter subclasses the generic Web Bluetooth adapter: it reuses all of
 * its connect / subscribe / battery / reconnect / timeout machinery, and only
 * overrides what is Huepar-specific — the device filters, the write
 * characteristic capture, the measure() trigger, and the frame parser.
 *
 * Like the generic parser, distance readings are normalized to FEET (the unit
 * the quote engine uses) with the detected source unit + a confidence score.
 * Meters are kept canonically alongside. Angle/tilt frames are decoded for
 * diagnostics but are NOT emitted as room measurements (they are not lengths).
 */
;(function (global) {
  'use strict';

  // --- provisional GATT contract (reverse-engineered, not vendor-certified) ---
  const HUEPAR_SERVICE = '0000ae30-0000-1000-8000-00805f9b34fb';
  const HUEPAR_WRITE   = '0000ae01-0000-1000-8000-00805f9b34fb'; // app -> device
  const HUEPAR_NOTIFY  = '0000ae02-0000-1000-8000-00805f9b34fb'; // device -> app
  const BATTERY_SERVICE = 'battery_service';                     // 0x180F

  // Commands the app writes to HUEPAR_WRITE (hex strings). Unit-change commands
  // exist upstream (f101030105, ...0206, ...0307) but are display-only and
  // unverified, so we deliberately don't ship them — meters stay canonical.
  const CMD = {
    MEASURE: 'f104010106', // trigger a single distance measurement
    CLEAR:   'f104000105'  // clear the last measurement
  };

  const M_TO_FT = 3.28083989501;
  const VERSION = 'experimental/huepar-s60-v1';

  // Plausible room/measurement window in meters. Frames decoding outside this
  // are rejected rather than guessed (S60 family ranges to ~80 m).
  const MIN_M = 0.03;
  const MAX_M = 150;

  // --------------------------------------------------------------------------
  // Parser — pure, deterministic, fully unit-testable without Web Bluetooth.
  // --------------------------------------------------------------------------
  const Parser = {
    version: VERSION,
    SERVICE: HUEPAR_SERVICE,
    WRITE: HUEPAR_WRITE,
    NOTIFY: HUEPAR_NOTIFY,
    CMD: CMD,

    bytesFromHex(hex) {
      const clean = String(hex || '').replace(/[^0-9a-f]/gi, '');
      if (!clean.length || clean.length % 2) return null;
      const out = new Uint8Array(clean.length / 2);
      for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.substr(i * 2, 2), 16);
      return out;
    },

    _toBytes(input) {
      if (input == null) return null;
      if (typeof input === 'string') return this.bytesFromHex(input);
      // DataView
      if (typeof input.getUint8 === 'function' && typeof input.byteLength === 'number') {
        const out = new Uint8Array(input.byteLength);
        for (let i = 0; i < input.byteLength; i++) out[i] = input.getUint8(i);
        return out;
      }
      // ArrayBuffer / typed array
      if (input.buffer || input.length != null) {
        try { return Uint8Array.from(input.length != null ? input : new Uint8Array(input)); } catch (_) { return null; }
      }
      return null;
    },

    toHex(input) {
      const b = this._toBytes(input);
      if (!b) return '';
      let s = '';
      for (let i = 0; i < b.length; i++) s += b[i].toString(16).padStart(2, '0');
      return s;
    },

    /**
     * Full-fidelity frame decode for diagnostics + tests.
     * @returns {Object|null} { kind:'distance'|'angles'|'error', ... } or null.
     */
    parseFrame(input) {
      const b = this._toBytes(input);
      if (!b || b.length < 5) return null;
      if (b[0] !== 0xf1) return null;

      // Distance family: f1 04 01 00 07 <unit> 01 31 50 <d2 d1 d0> <quality> <cs>
      if (b[1] === 0x04 && b[2] === 0x01 && b[3] === 0x00 && b[4] === 0x07 && b.length >= 13) {
        return this._distance(b);
      }
      // Angle/tilt family: f1 02 01 00 04 <Xhi Xlo> <Yhi Ylo> <Zhi Zlo> <cs>
      if (b[1] === 0x02 && b[2] === 0x01 && b[3] === 0x00 && b[4] === 0x04 && b.length >= 11) {
        return this._angles(b);
      }
      // Known error frames (semantics need lab validation).
      if (b[1] === 0x05) {
        return { kind: 'error', code: this.toHex(b), checksumOk: null };
      }
      return null;
    },

    _distance(b) {
      const unitMode = b[5];
      // 3-byte big-endian magnitude in 1e-5 m (10 micrometres per count).
      const raw = (b[9] << 16) | (b[10] << 8) | b[11];
      const meters = raw / 100000;
      const qualityFlag = b[12];
      // Checksum algorithm is unverified upstream; record but DO NOT gate on it.
      const checksumOk = null;
      const displayedUnit =
        unitMode === 1 ? 'm' :
        unitMode === 2 ? 'ft' :
        unitMode === 3 ? 'in_decimal' :
        unitMode === 4 ? 'in_frac' :
        unitMode === 5 ? 'ft_in_frac' : 'unknown';
      const out = {
        kind: 'distance',
        unitMode: unitMode,
        displayedUnit: displayedUnit,
        meters: round(meters, 5),
        feet: round(meters * M_TO_FT, 3),
        qualityFlag: qualityFlag,
        checksumOk: checksumOk
      };
      // Reject implausible decodes rather than emit a bad room dimension.
      if (!isFinite(meters) || meters < MIN_M || meters > MAX_M) {
        out.plausible = false;
        return out;
      }
      out.plausible = true;
      return out;
    },

    _angles(b) {
      return {
        kind: 'angles',
        xDeg: signedTenths((b[5] << 8) | b[6]),
        yDeg: signedTenths((b[7] << 8) | b[8]),
        zDeg: signedTenths((b[9] << 8) | b[10]),
        checksumOk: null
      };
    },

    /**
     * Adapter parse hook — returns a normalized READING ({feet,raw,unit,...})
     * ONLY for plausible distance frames; null for angles/errors/unknown so the
     * adapter can fall back to the generic ASCII/binary parser.
     * @returns {Object|null}
     */
    parse(input) {
      const f = this.parseFrame(input);
      if (!f || f.kind !== 'distance' || !f.plausible) return null;
      // Confidence: recognized distance family is high; an in-band quality flag
      // nudges it down so low-trust reads land in review, not the quote total.
      const confidence = f.qualityFlag ? 0.8 : 0.9;
      return {
        feet: f.feet,
        meters: f.meters,
        raw: f.meters,
        unit: 'm',
        displayedUnit: f.displayedUnit,
        confidence: confidence,
        via: 'huepar-frame',
        adapter: VERSION
      };
    }
  };

  function signedTenths(word) {
    const signNibble = (word & 0xf000) >>> 12;
    const magnitude = word & 0x0fff;
    const sign = signNibble === 0x1 ? 1 : -1;
    return sign * (magnitude / 10);
  }
  function round(n, p) { const f = Math.pow(10, p || 0); return Math.round(n * f) / f; }

  // --------------------------------------------------------------------------
  // Adapter factory — subclass the generic adapter instance.
  // --------------------------------------------------------------------------
  function createHueparS60Adapter() {
    const Generic = global.AAA_GENERIC_BLE_ADAPTER;
    if (!Generic) return null;
    const a = new Generic();
    a.id = 'huepar-s60';
    a.label = 'Huepar S-series (BT)';
    a._writeChar = null;

    // Huepar-specific frame parser, with generic fallback for anything it does
    // not recognize (e.g. firmware that also speaks ASCII).
    const genericParse = a.parse.bind(a);
    a.parse = function (dataView) {
      const fromHuepar = Parser.parse(dataView);
      if (fromHuepar) return fromHuepar;
      return genericParse(dataView);
    };

    // Targeted picker: name pattern OR the Huepar service shape, and crucially
    // list the Huepar service as optional so getPrimaryService() is allowed
    // post-connect (Web Bluetooth blocks services not declared up front).
    a.requestDevice = async function () {
      if (!this.isSupported()) {
        return { ok: false, error: 'UNSUPPORTED', message: 'This browser does not support Web Bluetooth. Use manual entry, or open the app in Chrome on Android.' };
      }
      try {
        const device = await global.navigator.bluetooth.requestDevice({
          filters: [
            { namePrefix: 'LDM' },
            { namePrefix: 'Huepar' },
            { namePrefix: 'HUEPAR' },
            { services: [HUEPAR_SERVICE] }
          ],
          optionalServices: [HUEPAR_SERVICE, BATTERY_SERVICE]
        });
        this._device = device;
        return { ok: true, device: { id: device.id, name: device.name || 'Huepar device' } };
      } catch (err) {
        if (err && err.name === 'NotFoundError') return { ok: false, error: 'CANCELLED', message: 'No device selected.' };
        return { ok: false, error: 'PICKER_FAILED', message: (err && err.message) || String(err) };
      }
    };

    // After the generic subscribe wires up notifications, grab the write
    // characteristic so we can trigger measurements.
    const baseSubscribe = a._subscribeAll.bind(a);
    a._subscribeAll = async function () {
      await baseSubscribe();
      this._writeChar = null;
      try {
        const svc = await this._server.getPrimaryService(HUEPAR_SERVICE);
        this._writeChar = await svc.getCharacteristic(HUEPAR_WRITE);
      } catch (_) { /* device may not expose it under this id; measure() will report */ }
    };

    // Trigger a single measurement (remote shutter). The reading arrives async
    // via the notify characteristic and flows through parse()/onReading().
    a.measure = async function () {
      if (!this._writeChar) return { ok: false, error: 'NO_WRITE_CHAR', message: 'Huepar control characteristic not available; press the button on the meter instead.' };
      try {
        await this._writeChar.writeValue(Parser.bytesFromHex(CMD.MEASURE));
        return { ok: true };
      } catch (err) {
        return { ok: false, error: 'WRITE_FAILED', message: (err && err.message) || String(err) };
      }
    };

    a.clearLast = async function () {
      if (!this._writeChar) return { ok: false, error: 'NO_WRITE_CHAR' };
      try { await this._writeChar.writeValue(Parser.bytesFromHex(CMD.CLEAR)); return { ok: true }; }
      catch (err) { return { ok: false, error: 'WRITE_FAILED', message: (err && err.message) || String(err) }; }
    };

    return a;
  }

  // Fingerprint a device as Huepar by NAME pattern or advertised SERVICE shape.
  function matchHuepar(info) {
    const name = (info && info.name) || '';
    if (/huepar|ldm-?s\d|s60.?g?.?bt/i.test(name)) return true;
    const services = (info && info.services) || [];
    return services.some((s) => String(s).toLowerCase() === HUEPAR_SERVICE);
  }

  // Export parser + factory + match for tests and the registry.
  global.AAA_HUEPAR_S60_PARSER = Parser;
  global.AAA_HUEPAR_S60_ADAPTER = { create: createHueparS60Adapter, match: matchHuepar, version: VERSION };

  // Self-register as a first-class adapter when the registry + generic base are
  // present (priority above generic; generic stays the fallback).
  if (global.AAA_DEVICE_ADAPTER_REGISTRY && global.AAA_GENERIC_BLE_ADAPTER) {
    global.AAA_DEVICE_ADAPTER_REGISTRY.register({
      id: 'huepar-s60',
      label: 'Huepar S-series (BT)',
      priority: 50,
      match: matchHuepar,
      optionalServices: [HUEPAR_SERVICE],
      factory: () => createHueparS60Adapter()
    });
  }
})(typeof window !== 'undefined' ? window : this);
