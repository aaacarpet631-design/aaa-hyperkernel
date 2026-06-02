/*
 * AAA Bluetooth Connection Controller — the stateful "hook" the screens use.
 *
 * In a no-build PWA this is a singleton observable store rather than a React
 * hook, but the role is identical: own the live connection, expose state, let
 * screens subscribe to changes, and centralize the tricky lifecycle bits
 * (permission/support gating, reconnect after background/foreground, persisting
 * the device record + last-connected memory, capturing the latest reading).
 *
 * It never throws into the UI — every method resolves to a result object so the
 * field UI can show a clear message instead of a crash.
 */
;(function (global) {
  'use strict';

  function registry() { return global.AAA_DEVICE_ADAPTER_REGISTRY; }
  function store() { return global.AAA_MEASUREMENT_STORE; }
  function clock() { return global.AAA_RUNTIME_CLOCK; }
  function nowISO() { return clock() && clock().nowISO ? clock().nowISO() : new Date().toISOString(); }

  const Controller = {
    _adapter: null,
    _deviceRec: null,          // persisted BluetoothDeviceRecord
    _state: {
      status: 'disconnected',  // disconnected|connecting|connected|error|unsupported
      deviceName: null,
      deviceId: null,
      battery: null,
      lastReading: null,       // ParsedReading
      lastReadingAt: null,
      error: null,
      errorDetail: null        // { errorName, rawMessage, deviceName, discoveredServices }
    },
    _subs: [],
    _foregroundBound: null,

    // ---- subscription ---------------------------------------------------
    subscribe(cb) {
      if (typeof cb !== 'function') return () => {};
      this._subs.push(cb);
      try { cb(this.getState()); } catch (_) {}
      return () => { this._subs = this._subs.filter((s) => s !== cb); };
    },
    getState() { return Object.assign({}, this._state); },
    _set(patch) {
      this._state = Object.assign({}, this._state, patch);
      const snap = this.getState();
      this._subs.forEach((s) => { try { s(snap); } catch (_) {} });
    },

    // ---- capability -----------------------------------------------------
    isSupported() {
      const g = registry() && registry().generic();
      return !!(g && g.isSupported && g.isSupported());
    },
    async isRadioAvailable() {
      const g = registry() && registry().generic();
      return g && g.isRadioAvailable ? g.isRadioAvailable() : this.isSupported();
    },
    /** Human-readable reason BLE can't be used here, or null if it can. */
    unsupportedReason() {
      if (this.isSupported()) return null;
      const ua = (global.navigator && global.navigator.userAgent) || '';
      if (/iPhone|iPad|iPod/i.test(ua)) {
        return 'iPhone/iPad browsers do not support Web Bluetooth. Use Manual Entry here — or open the app in Chrome on an Android device to connect a laser.';
      }
      if (!global.isSecureContext) {
        return 'Bluetooth requires a secure (https) connection. Open the app over https, then try again.';
      }
      return 'This browser does not support Web Bluetooth. Use Manual Entry, or try Chrome/Edge on desktop or Android.';
    },

    // ---- discovery + connect -------------------------------------------
    /** Open the OS picker, resolve the right adapter, persist the device. */
    async scanAndPick() {
      if (!this.isSupported()) return { ok: false, error: 'UNSUPPORTED', message: this.unsupportedReason() };
      const reg = registry();
      const generic = reg.generic();
      // Open the picker ONCE, declaring every registered brand's optional
      // services up front. Without this the picked handle can only access the
      // battery service, so a brand adapter's getPrimaryService() throws
      // SecurityError on connect — the "error" users were seeing.
      const optionalServices = reg.allOptionalServices ? reg.allOptionalServices() : [];
      const picked = await generic.requestDevice({ optionalServices: optionalServices });
      if (!picked.ok) return picked;

      // Resolve a brand-specific adapter if one matches; else keep generic.
      const resolved = reg.resolve({ name: picked.device.name });
      this._adapter = resolved ? resolved.adapter : generic;
      // Hand the SAME picked BluetoothDevice handle to whichever adapter we use.
      // (Web Bluetooth ties service access to this exact handle from the picker.)
      if (this._adapter !== generic) this._adapter._device = generic._device;

      this._wireAdapter(resolved ? resolved.id : 'generic-ble');

      // Persist a device record immediately (so it shows in "paired" list).
      const rec = await this._persistDevice({
        id: picked.device.id, name: picked.device.name,
        adapterId: resolved ? resolved.id : 'generic-ble', status: 'disconnected'
      });
      this._deviceRec = rec;
      this._set({ deviceId: rec.id, deviceName: rec.nickname || rec.name, status: 'disconnected', error: null });
      return { ok: true, device: rec };
    },

    _wireAdapter(adapterId) {
      const a = this._adapter;
      if (!a) return;
      a.onStatus(async (status, detail) => {
        this._set({
          status: status,
          error: status === 'error' ? (detail && detail.message) : null,
          // Keep the full diagnostic on error so the screen can show the real
          // cause + the device's advertised services (not just "error").
          errorDetail: status === 'error' ? (detail || null) : null
        });
        if (status === 'connected') {
          const battery = a.readBattery ? await a.readBattery() : null;
          this._set({ battery: battery });
          await this._persistDevice({
            id: this._state.deviceId, name: this._state.deviceName, adapterId: adapterId,
            status: 'connected', lastConnectedAt: nowISO(), batteryLevel: battery,
            supportedServices: (detail && detail.supportedServices) || (this._deviceRec && this._deviceRec.supportedServices)
          });
        }
      });
      a.onReading((reading) => {
        this._set({ lastReading: reading, lastReadingAt: nowISO() });
      });
    },

    async connect() {
      if (!this._adapter) return { ok: false, error: 'NO_DEVICE', message: 'Scan and select a device first.' };
      const res = await this._adapter.connect({ timeout: 15000 });
      if (res.ok && res.device) {
        await this._persistDevice({
          id: res.device.id, name: res.device.name, status: 'connected',
          lastConnectedAt: nowISO(), supportedServices: res.device.supportedServices,
          adapterId: this._deviceRec ? this._deviceRec.adapterId : 'generic-ble'
        });
      }
      return res;
    },

    async disconnect() {
      if (this._adapter) await this._adapter.disconnect();
      if (this._deviceRec) await this._persistDevice({ id: this._deviceRec.id, status: 'disconnected' });
      this._set({ status: 'disconnected', battery: null });
      return { ok: true };
    },

    isConnected() { return !!(this._adapter && this._adapter.isConnected && this._adapter.isConnected()); },

    /** Reconnect to the last device (used by the reconnect button + foreground). */
    async reconnect() {
      if (this._adapter && this._adapter.reconnect) {
        this._set({ status: 'connecting' });
        return this._adapter.reconnect({ timeout: 15000 });
      }
      // No live adapter (e.g. after a reload): the user must re-pick — Web
      // Bluetooth cannot silently reconnect without a prior in-page handle.
      return { ok: false, error: 'MUST_REPICK', message: 'Tap “Scan for device” to reconnect.' };
    },

    async refreshBattery() {
      if (!this._adapter || !this._adapter.readBattery) return null;
      const b = await this._adapter.readBattery();
      this._set({ battery: b });
      return b;
    },

    /** Can the connected device be triggered from the app (vs. its own button)? */
    canMeasure() {
      return !!(this._adapter && typeof this._adapter.measure === 'function' && this.isConnected());
    },

    /**
     * Trigger a single measurement remotely (e.g. Huepar's BLE shutter). The
     * reading arrives async via onReading and lands in lastReading. Devices
     * without a remote trigger return a clear "press the button" result.
     */
    async measure() {
      if (!this._adapter) return { ok: false, error: 'NO_DEVICE', message: 'Connect a device first.' };
      if (!this.isConnected()) return { ok: false, error: 'NOT_CONNECTED', message: 'Connect the device first.' };
      if (typeof this._adapter.measure !== 'function') {
        return { ok: false, error: 'NO_REMOTE_TRIGGER', message: 'This device can’t be triggered from the app — press the measure button on the laser.' };
      }
      return this._adapter.measure();
    },

    /** Consume the latest reading exactly once (so a screen field grabs it). */
    takeReading() {
      const r = this._state.lastReading;
      return r ? Object.assign({ at: this._state.lastReadingAt }, r) : null;
    },

    // ---- background/foreground reconnect -------------------------------
    installLifecycleHandlers() {
      if (this._foregroundBound || typeof global.document === 'undefined') return;
      this._foregroundBound = () => {
        if (global.document.visibilityState === 'visible' && this._adapter && !this.isConnected() && this._deviceRec) {
          // Best-effort silent reconnect when the tech returns to the app.
          this.reconnect();
        }
      };
      global.document.addEventListener('visibilitychange', this._foregroundBound);
    },

    // ---- device persistence --------------------------------------------
    async _persistDevice(patch) {
      if (!store()) return null;
      const prior = patch.id ? await store().getDevice(patch.id) : null;
      const merged = Object.assign({}, prior || {}, patch);
      const res = await store().saveDevice(merged);
      if (res.ok) { this._deviceRec = res.device; return res.device; }
      return prior;
    },

    async setNickname(deviceId, nickname) {
      if (!store()) return { ok: false };
      const d = await store().getDevice(deviceId);
      if (!d) return { ok: false, error: 'NOT_FOUND' };
      const res = await store().saveDevice(Object.assign({}, d, { nickname: String(nickname || '') }));
      if (res.ok && this._deviceRec && this._deviceRec.id === deviceId) {
        this._deviceRec = res.device;
        this._set({ deviceName: res.device.nickname || res.device.name });
      }
      return res;
    }
  };

  global.AAA_BLUETOOTH = Controller;
})(typeof window !== 'undefined' ? window : this);
