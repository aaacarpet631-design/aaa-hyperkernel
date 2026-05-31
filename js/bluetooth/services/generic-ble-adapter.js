/*
 * AAA Generic BLE Measurement Adapter — real Web Bluetooth, no brand hardcoded.
 *
 * Implements the adapter contract the registry expects:
 *   isSupported(), requestDevice(opts), connect(device), disconnect(),
 *   readBattery(), onReading(cb), onStatus(cb), parse(dataView)
 *
 * It connects to ANY BLE device the user picks, walks its GATT services, and
 * subscribes to every not/indicate characteristic — routing each frame through
 * the RawReadingLog and MeasurementParser. That generality is deliberate: it
 * works with unknown lasers today, and a brand-specific adapter can subclass
 * the behavior later by overriding parse() / service filters.
 *
 * Honest about platform: isSupported() is false on iOS/Safari (no Web
 * Bluetooth). Callers MUST fall back to manual entry there.
 */
;(function (global) {
  'use strict';

  const BATTERY_SERVICE = 'battery_service';            // 0x180F
  const BATTERY_LEVEL_CHAR = 'battery_level';           // 0x2A19
  const DEFAULT_CONNECT_TIMEOUT = 15000;                // ms

  function rawLog() { return global.AAA_BLE_RAW_LOG; }
  function parser() { return global.AAA_MEASUREMENT_PARSER; }

  function GenericBleMeasurementAdapter() {
    this.id = 'generic-ble';
    this.label = 'Generic Bluetooth (BLE)';
    this._device = null;       // BluetoothDevice (Web API)
    this._server = null;       // BluetoothRemoteGATTServer
    this._chars = [];          // subscribed characteristics
    this._readingCbs = [];
    this._statusCbs = [];
    this._onDisconnectBound = this._onDisconnect.bind(this);
    this._supportedServices = [];
  }

  GenericBleMeasurementAdapter.prototype = {
    /** Web Bluetooth present? (false on iOS Safari / Chrome, older browsers). */
    isSupported() {
      return !!(global.navigator && global.navigator.bluetooth && typeof global.navigator.bluetooth.requestDevice === 'function');
    },

    /** Whether the browser can tell us if Bluetooth radio is on (Chrome only). */
    async isRadioAvailable() {
      try {
        if (this.isSupported() && global.navigator.bluetooth.getAvailability) {
          return await global.navigator.bluetooth.getAvailability();
        }
      } catch (_) {}
      return this.isSupported();   // assume yes if we can't query
    },

    onReading(cb) { if (typeof cb === 'function') this._readingCbs.push(cb); },
    onStatus(cb) { if (typeof cb === 'function') this._statusCbs.push(cb); },
    _emitStatus(status, detail) { this._statusCbs.forEach((c) => { try { c(status, detail); } catch (_) {} }); },
    _emitReading(reading) { this._readingCbs.forEach((c) => { try { c(reading); } catch (_) {} }); },

    /**
     * Open the OS device picker. Web Bluetooth REQUIRES a user gesture and
     * does not allow silent background scanning, so "scan" == this picker.
     * acceptAllDevices keeps us brand-agnostic; we still request optional
     * services so we can read them post-connect.
     */
    async requestDevice() {
      if (!this.isSupported()) return { ok: false, error: 'UNSUPPORTED', message: 'This browser does not support Web Bluetooth. Use manual entry, or open the app in Chrome on Android.' };
      try {
        // Declare battery + every registered brand adapter's services up front,
        // so that when the registry resolves a brand adapter for the picked
        // device it can still reach that service (Web Bluetooth gates this).
        const optional = [BATTERY_SERVICE];
        try {
          const reg = global.AAA_DEVICE_ADAPTER_REGISTRY;
          if (reg && reg.optionalServices) reg.optionalServices().forEach((s) => { if (optional.indexOf(s) === -1) optional.push(s); });
        } catch (_) {}
        const device = await global.navigator.bluetooth.requestDevice({
          acceptAllDevices: true,
          optionalServices: optional
        });
        this._device = device;
        return { ok: true, device: { id: device.id, name: device.name || 'Unknown device' } };
      } catch (err) {
        if (err && err.name === 'NotFoundError') return { ok: false, error: 'CANCELLED', message: 'No device selected.' };
        return { ok: false, error: 'PICKER_FAILED', message: humanError(err) };
      }
    },

    /** Connect GATT, subscribe to notifyable characteristics, wire reconnect. */
    async connect(opts) {
      if (!this._device) return { ok: false, error: 'NO_DEVICE', message: 'Pick a device first.' };
      const timeout = (opts && opts.timeout) || DEFAULT_CONNECT_TIMEOUT;
      this._emitStatus('connecting');
      try {
        this._device.addEventListener('gattserverdisconnected', this._onDisconnectBound);
        this._server = await withTimeout(this._device.gatt.connect(), timeout, 'CONNECT_TIMEOUT');
        await this._subscribeAll();
        this._emitStatus('connected', { name: this._device.name });
        return {
          ok: true,
          device: {
            id: this._device.id,
            name: this._device.name || 'Unknown device',
            supportedServices: this._supportedServices.slice()
          }
        };
      } catch (err) {
        this._emitStatus('error', { message: humanError(err) });
        return { ok: false, error: (err && err.message) || 'CONNECT_FAILED', message: humanError(err) };
      }
    },

    async _subscribeAll() {
      this._chars = [];
      this._supportedServices = [];
      const services = await this._server.getPrimaryServices();
      for (const service of services) {
        this._supportedServices.push(service.uuid);
        let chars = [];
        try { chars = await service.getCharacteristics(); } catch (_) { continue; }
        for (const ch of chars) {
          if (ch.properties && (ch.properties.notify || ch.properties.indicate)) {
            try {
              await ch.startNotifications();
              ch.addEventListener('characteristicvaluechanged', (ev) => this._onValue(service.uuid, ev.target));
              this._chars.push(ch);
            } catch (_) { /* some chars refuse notifications; skip */ }
          }
        }
      }
    },

    _onValue(serviceUuid, characteristic) {
      const value = characteristic.value; // DataView
      rawLog() && rawLog().record({
        deviceId: this._device ? this._device.id : null,
        serviceUuid: serviceUuid,
        characteristicUuid: characteristic.uuid,
        value: value
      });
      const parsed = this.parse(value);
      if (parsed) this._emitReading(parsed);
    },

    /** Adapter parse hook — generic adapter delegates to the shared parser. */
    parse(dataView) { return parser() ? parser().parse(dataView) : null; },

    /** Read standard GATT battery level if the device exposes it. */
    async readBattery() {
      if (!this._server || !this._server.connected) return null;
      try {
        const svc = await this._server.getPrimaryService(BATTERY_SERVICE);
        const ch = await svc.getCharacteristic(BATTERY_LEVEL_CHAR);
        const v = await ch.readValue();
        return v.getUint8(0);
      } catch (_) { return null; }
    },

    isConnected() { return !!(this._server && this._server.connected); },

    async disconnect() {
      try {
        for (const ch of this._chars) { try { await ch.stopNotifications(); } catch (_) {} }
        if (this._device && this._device.gatt && this._device.gatt.connected) this._device.gatt.disconnect();
      } catch (_) {}
      this._chars = [];
      this._emitStatus('disconnected');
    },

    /** Try to reconnect to the SAME device object (after background/foreground). */
    async reconnect(opts) {
      if (!this._device) return { ok: false, error: 'NO_DEVICE' };
      if (this.isConnected()) return { ok: true, alreadyConnected: true };
      return this.connect(opts);
    },

    _onDisconnect() {
      this._emitStatus('disconnected', { unexpected: true });
    }
  };

  // Resolve/reject a promise after `ms`, used so a stalled connect can't hang
  // the UI on a job site with a flaky radio.
  function withTimeout(promise, ms, code) {
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(code || 'TIMEOUT')), ms);
      promise.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
    });
  }

  function humanError(err) {
    const name = err && err.name;
    const msg = (err && err.message) || String(err);
    if (name === 'SecurityError') return 'Bluetooth needs a secure (https) connection and permission. Reload over https and allow access.';
    if (name === 'NotAllowedError') return 'Bluetooth permission was denied. Enable it in your browser/site settings.';
    if (/timeout/i.test(msg)) return 'The device took too long to respond. Move closer, make sure it is on, and try again.';
    if (name === 'NetworkError') return 'Lost connection to the device. Re-select it and reconnect.';
    return msg;
  }

  // Export the class + a shared singleton instance.
  global.AAA_GENERIC_BLE_ADAPTER = GenericBleMeasurementAdapter;
})(typeof window !== 'undefined' ? window : this);
