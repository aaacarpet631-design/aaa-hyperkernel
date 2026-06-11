/*
 * Bluetooth connect flow — regression test for the "keeps saying error" bug.
 *
 * The real Web Bluetooth rule: getPrimaryService(uuid) is only permitted if that
 * uuid was declared (via optionalServices or a filter) at requestDevice() time.
 * The old scanAndPick opened the picker with the GENERIC adapter (battery only),
 * then handed the device to the Huepar adapter, whose getPrimaryService(0xae30)
 * was therefore blocked → SecurityError → status 'error'.
 *
 * This fakes navigator.bluetooth enforcing that rule, and asserts:
 *   - a Huepar pick now connects (its service was declared up front), and
 *   - reproduces the OLD failure when the union isn't declared (guard the fix).
 */
'use strict';
const path = require('path');
const { makeRunner, ROOT } = require('../helpers/harness');

// ---- shared GATT fakes (used by the picker fake AND the getDevices fake) ----
function makeChar(uuid, props) {
  return {
    uuid, properties: Object.assign({ notify: true, indicate: false, write: false, writeWithoutResponse: false }, props || {}),
    async startNotifications() { return this; },
    addEventListener() {},
    async writeValue() {},
    async readValue() { return new DataView(new Uint8Array([90]).buffer); }
  };
}
function makeService(uuid) {
  // Each service exposes a notify char AND a write char so the brand adapter
  // can locate a measurement-trigger characteristic by capability.
  return {
    uuid,
    async getCharacteristics() { return [makeChar(uuid + '-notify', { notify: true }), makeChar(uuid + '-write', { notify: false, write: true })]; },
    async getCharacteristic() { return makeChar(uuid + '-w', { write: true }); }
  };
}

// ---- a fake Web Bluetooth that enforces the optionalServices security rule ---
function makeFakeBluetooth(deviceName, presentServices) {
  // presentServices: uuids the device actually exposes over GATT.
  return {
    _allowed: null,
    async requestDevice(opts) {
      // Record which services the caller declared (filters + optionalServices).
      const declared = [].concat(opts.optionalServices || []);
      (opts.filters || []).forEach((f) => (f.services || []).forEach((s) => declared.push(s)));
      this._allowed = declared.map((s) => String(s).toLowerCase());
      const allowed = this._allowed;
      const device = {
        id: 'dev-1', name: deviceName,
        addEventListener() {}, removeEventListener() {},
        gatt: {
          connected: false,
          async connect() {
            this.connected = true;
            const self = this;
            const present = presentServices.map((s) => s.toLowerCase());
            return {
              connected: true,
              // Real Web Bluetooth: getPrimaryServices() returns only services
              // that are BOTH present on the device AND were declared at
              // requestDevice() time; if none qualify it throws NotFoundError.
              async getPrimaryServices() {
                const visible = present.filter((s) => allowed.indexOf(s) !== -1);
                if (!visible.length) { const e = new Error('No Services found in device.'); e.name = 'NotFoundError'; throw e; }
                return visible.map(makeService);
              },
              async getPrimaryService(uuid) {
                const u = String(uuid).toLowerCase();
                if (allowed.indexOf(u) === -1) {
                  const e = new Error('Origin is not allowed to access the service. Tip: add it to optionalServices.');
                  e.name = 'SecurityError'; throw e;
                }
                if (present.indexOf(u) === -1) { const e = new Error('No Services matching UUID.'); e.name = 'NotFoundError'; throw e; }
                return makeService(uuid);
              }
            };
          },
          disconnect() { this.connected = false; }
        }
      };
      return device;
    },
    async getAvailability() { return true; }
  };
}

module.exports = async function run() {
  const t = makeRunner('bluetooth');
  const G = global; G.window = G;
  G.isSecureContext = true;

  // In Node, global.navigator is a read-only getter — define it writably.
  // The adapter reads navigator.bluetooth.*, so wrap the fake under .bluetooth.
  function setNavigator(btFake) {
    const nav = { userAgent: 'Chrome', bluetooth: btFake };
    try { G.navigator = nav; } catch (_) { Object.defineProperty(G, 'navigator', { value: nav, configurable: true, writable: true }); }
  }
  function bt() { return G.navigator.bluetooth; }

  const HUEPAR_SERVICE = '0000ae30-0000-1000-8000-00805f9b34fb';

  function loadStack() {
    ['js/bluetooth/services/raw-reading-log.js',
     'js/bluetooth/services/measurement-parser.js',
     'js/bluetooth/services/generic-ble-adapter.js',
     'js/bluetooth/services/device-adapter-registry.js',
     'js/bluetooth/services/huepar-s60-adapter.js',
     'js/bluetooth/hooks/use-bluetooth-connection.js'].forEach((rel) => {
      delete require.cache[require.resolve(path.join(ROOT, rel))];
      require(path.join(ROOT, rel));
    });
  }

  // Minimal measurement store so _persistDevice doesn't no-op the flow.
  // Accepts seed records so the auto-reconnect tests can pre-save a device,
  // and mirrors the real store's lastConnectedDevice() (most recent first).
  function fakeStore(seed) {
    const devices = {};
    (seed || []).forEach((d) => { devices[d.id] = d; });
    G.AAA_MEASUREMENT_STORE = {
      async getDevice(id) { return devices[id] || null; },
      async saveDevice(d) { const rec = Object.assign({ id: d.id || 'dev-1' }, devices[d.id] || {}, d); devices[rec.id] = rec; return { ok: true, device: rec }; },
      async listDevices() { return Object.values(devices); },
      async lastConnectedDevice() {
        const known = Object.values(devices).filter((d) => d.lastConnectedAt)
          .sort((a, b) => String(b.lastConnectedAt).localeCompare(String(a.lastConnectedAt)));
        return known[0] || null;
      }
    };
    return devices;
  }

  // ---- registry declares the union of optional services --------------------
  fakeStore();
  loadStack();
  const Reg = G.AAA_DEVICE_ADAPTER_REGISTRY;
  const union = Reg.allOptionalServices().map((s) => String(s).toLowerCase());
  t.ok('registry exposes allOptionalServices()', typeof Reg.allOptionalServices === 'function');
  t.ok('union includes the Huepar service', union.indexOf(HUEPAR_SERVICE) !== -1);
  t.ok('union includes battery service', union.indexOf('battery_service') !== -1);

  // ---- FIXED flow: Huepar device connects (service was declared) -----------
  setNavigator(makeFakeBluetooth('LDM-S60-BT', [HUEPAR_SERVICE]));
  const BLE = G.AAA_BLUETOOTH;
  const pick = await BLE.scanAndPick();
  t.ok('scanAndPick ok for Huepar device', pick.ok === true);
  t.ok('resolved the Huepar adapter', BLE._adapter && BLE._adapter.id === 'huepar-s60');
  t.ok('picker declared the Huepar service up front', bt()._allowed.indexOf(HUEPAR_SERVICE) !== -1);

  const conn = await BLE.connect();
  t.ok('connect ok (no SecurityError)', conn.ok === true);
  t.eq('status is connected, not error', BLE.getState().status, 'connected');
  t.ok('huepar service was reachable post-connect', (conn.device.supportedServices || []).map((s) => s.toLowerCase()).indexOf(HUEPAR_SERVICE) !== -1);

  // ---- REGRESSION GUARD: prove the OLD path would have failed ---------------
  // Re-pick but with ONLY the battery service declared (the old behavior), then
  // force the Huepar adapter and connect → must surface the SecurityError.
  setNavigator(makeFakeBluetooth('LDM-S60-BT', [HUEPAR_SERVICE]));
  loadStack();
  const BLE2 = G.AAA_BLUETOOTH;
  const generic = Reg.generic();
  // Simulate the OLD scanAndPick: generic picker with battery-only.
  await generic.requestDevice({ optionalServices: [] });
  t.ok('old-style picker did NOT declare Huepar service', bt()._allowed.indexOf(HUEPAR_SERVICE) === -1);
  const huepar = Reg.resolve({ name: 'LDM-S60-BT' }).adapter;
  huepar._device = generic._device;
  const bad = await huepar.connect({ timeout: 1000 });
  t.ok('old path fails to connect (reproduces the bug)', bad.ok === false);
  t.ok('old failure message is human, not blank', !!(bad.message && /secure|https|connection|service|allow/i.test(bad.message)) );
  // Self-diagnosing detail is captured so the UI can show the real cause.
  t.ok('failure carries a structured detail', !!(bad.detail && typeof bad.detail === 'object'));
  t.ok('detail names the error type', !!(bad.detail.errorName));
  t.ok('detail includes the device name', bad.detail.deviceName === 'LDM-S60-BT');

  // ---- a generic (non-brand) device still connects fine --------------------
  setNavigator(makeFakeBluetooth('Some Random Laser', ['battery_service']));
  loadStack();
  const BLE3 = G.AAA_BLUETOOTH;
  const p3 = await BLE3.scanAndPick();
  t.ok('generic device picks generic adapter', p3.ok && BLE3._adapter.id === 'generic-ble');
  const c3 = await BLE3.connect();
  t.ok('generic device connects', c3.ok === true);
  t.eq('generic device status connected', BLE3.getState().status, 'connected');

  // ---- robustness: a Huepar that uses a DIFFERENT service still works -------
  // S60 firmware variant exposing the FFF0 UART-like service instead of 0xae30.
  const FFF0 = '0000fff0-0000-1000-8000-00805f9b34fb';
  // The candidate family must be declared so this service is even visible.
  t.ok('candidate union covers FFF0 family', Reg.allOptionalServices().map((s) => String(s).toLowerCase()).indexOf(FFF0) !== -1);
  setNavigator(makeFakeBluetooth('S60-G-BT', [FFF0]));
  loadStack();
  const BLE4 = G.AAA_BLUETOOTH;
  const p4 = await BLE4.scanAndPick();
  t.ok('S60 on FFF0 resolves Huepar adapter', p4.ok && BLE4._adapter.id === 'huepar-s60');
  t.ok('picker declared FFF0 up front', bt()._allowed.indexOf(FFF0) !== -1);
  const c4 = await BLE4.connect();
  t.ok('S60 on a different service still connects', c4.ok === true);
  t.eq('S60-variant status connected', BLE4.getState().status, 'connected');
  // The brand adapter found a writable characteristic by capability (not UUID),
  // so the remote measure() trigger is available even off the known service.
  t.ok('write char located by capability', !!BLE4._adapter._writeChar);
  const meas = await BLE4._adapter.measure();
  t.ok('measure() can trigger via discovered write char', meas.ok === true);

  // ==========================================================================
  // AUTO-RECONNECT — re-acquire a remembered laser without the picker.
  // ==========================================================================

  // A previously-permitted BluetoothDevice handle, as getDevices() returns it.
  // Permission persisted, so all present services are reachable post-connect.
  function makePermittedDevice(id, name, presentServices, opts) {
    const o = opts || {};
    const present = presentServices.map((s) => s.toLowerCase());
    const listeners = {};
    const device = {
      id: id, name: name,
      _connectCalls: 0,
      _watchCalls: 0,
      _listenerCount(type) { return (listeners[type] || []).length; },
      _emit(type, ev) { (listeners[type] || []).slice().forEach((f) => f(ev || {})); },
      addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
      removeEventListener(type, fn) { listeners[type] = (listeners[type] || []).filter((f) => f !== fn); },
      gatt: {
        connected: false,
        async connect() {
          device._connectCalls++;
          this.connected = true;
          return {
            connected: true,
            async getPrimaryServices() { return present.map(makeService); },
            async getPrimaryService(uuid) {
              const u = String(uuid).toLowerCase();
              if (present.indexOf(u) === -1) { const e = new Error('No Services matching UUID.'); e.name = 'NotFoundError'; throw e; }
              return makeService(uuid);
            }
          };
        },
        disconnect() { this.connected = false; }
      }
    };
    if (o.watchable !== false) {
      device.watchAdvertisements = async function () { device._watchCalls++; };
    }
    return device;
  }

  // navigator.bluetooth for the auto path: getDevices() works, but the picker
  // is SPIED and must never be invoked.
  function makeAutoBluetooth(permittedDevices) {
    return {
      _requestDeviceCalls: 0,
      async requestDevice() { this._requestDeviceCalls++; throw new Error('picker must not open on the auto path'); },
      async getDevices() { return (permittedDevices || []).slice(); },
      async getAvailability() { return true; }
    };
  }
  function settle(ms) { return new Promise((r) => setTimeout(r, ms || 15)); }
  const SAVED_HUEPAR = { id: 'dev-9', name: 'LDM-S60-BT', adapterId: 'huepar-s60', lastConnectedAt: '2026-06-01T10:00:00.000Z', status: 'disconnected' };

  // NOTE: the root package.json is "type":"module", so under Node's require(esm)
  // the js/ modules are cached in the ESM registry — deleting require.cache does
  // NOT reload them. loadStack() therefore can't mint a fresh controller; reset
  // the singleton's state explicitly between scenarios instead.
  function resetBle() {
    const c = G.AAA_BLUETOOTH;
    c._adapter = null; c._deviceRec = null; c._watchingDeviceId = null; c._subs = [];
    c._state = { status: 'disconnected', deviceName: null, deviceId: null, battery: null, lastReading: null, lastReadingAt: null, error: null, errorDetail: null };
    return c;
  }

  // ---- 1. already connected → {already:true} -------------------------------
  fakeStore([Object.assign({}, SAVED_HUEPAR)]);
  setNavigator(makeAutoBluetooth([]));
  const A1 = resetBle();
  A1._adapter = { isConnected: () => true };
  const r1 = await A1.autoReconnect();
  t.ok('autoReconnect when already connected → ok+already', r1.ok === true && r1.already === true);

  // ---- 2. in-session: live adapter + deviceRec → delegates to reconnect ----
  const A2 = resetBle();
  let reconnectCalls = 0;
  A2._adapter = { isConnected: () => false, reconnect: async () => { reconnectCalls++; return { ok: true, via: 'reconnect' }; } };
  A2._deviceRec = { id: 'dev-9' };
  const r2 = await A2.autoReconnect();
  t.ok('in-session autoReconnect delegates to reconnect()', r2.ok === true && r2.via === 'reconnect' && reconnectCalls === 1);
  t.eq('in-session path set status connecting', A2.getState().status, 'connecting');

  // ---- 3. cold path: getDevices has the saved Huepar → adopt + connect -----
  fakeStore([Object.assign({}, SAVED_HUEPAR)]);
  const coldDev = makePermittedDevice('dev-9', 'LDM-S60-BT', [HUEPAR_SERVICE]);
  setNavigator(makeAutoBluetooth([coldDev]));
  const A3 = resetBle();
  t.eq('lastKnownDeviceId finds the saved Huepar', await A3.lastKnownDeviceId(), 'dev-9');
  const r3 = await A3.autoReconnect();
  t.ok('cold autoReconnect connects without a picker', r3.ok === true);
  t.eq('picker (requestDevice) NEVER called on auto path', bt()._requestDeviceCalls, 0);
  t.ok('resolved the Huepar brand adapter from the handle name', A3._adapter && A3._adapter.id === 'huepar-s60');
  t.ok('adapter adopted the permitted handle', A3._adapter._device === coldDev);
  t.eq('status is connected after cold auto-reconnect', A3.getState().status, 'connected');
  t.eq('state carries the saved device id', A3.getState().deviceId, 'dev-9');
  t.ok('connect went through the adopted handle', coldDev._connectCalls === 1);

  // ---- 4. getDevices returns no matching handle → honest MUST_REPICK -------
  fakeStore([Object.assign({}, SAVED_HUEPAR)]);
  setNavigator(makeAutoBluetooth([]));
  const A4 = resetBle();
  const r4 = await A4.autoReconnect();
  t.ok('empty getDevices → MUST_REPICK', r4.ok === false && r4.error === 'MUST_REPICK');
  t.ok('MUST_REPICK message tells the tech to scan', /scan/i.test(r4.message || ''));
  t.eq('no picker on the empty-getDevices path', bt()._requestDeviceCalls, 0);

  // ---- 5. getDevices API absent entirely → honest MUST_REPICK --------------
  fakeStore([Object.assign({}, SAVED_HUEPAR)]);
  setNavigator({ async requestDevice() { throw new Error('no'); }, async getAvailability() { return true; } });
  const A5 = resetBle();
  const g5 = G.AAA_DEVICE_ADAPTER_REGISTRY.generic();
  t.ok('getPermittedDevices → [] when getDevices is absent', (await g5.getPermittedDevices()).length === 0);
  const r5 = await A5.autoReconnect();
  t.ok('no getDevices API → MUST_REPICK', r5.ok === false && r5.error === 'MUST_REPICK');

  // getDevices that THROWS must also degrade to [] (never throws).
  setNavigator({ async requestDevice() {}, async getDevices() { throw new Error('boom'); } });
  const g5b = G.AAA_DEVICE_ADAPTER_REGISTRY.generic();
  t.ok('getPermittedDevices swallows getDevices errors → []', (await g5b.getPermittedDevices()).length === 0);

  // ---- 6. no saved device → MUST_REPICK -------------------------------------
  fakeStore([]);
  setNavigator(makeAutoBluetooth([makePermittedDevice('dev-9', 'LDM-S60-BT', [HUEPAR_SERVICE])]));
  const A6 = resetBle();
  t.ok('lastKnownDeviceId null with empty store', (await A6.lastKnownDeviceId()) === null);
  const r6 = await A6.autoReconnect();
  t.ok('no saved device → MUST_REPICK', r6.ok === false && r6.error === 'MUST_REPICK');

  // ---- 7. watchForDevice: advertisement triggers a one-shot connect --------
  fakeStore([Object.assign({}, SAVED_HUEPAR)]);
  const watchDev = makePermittedDevice('dev-9', 'LDM-S60-BT', [HUEPAR_SERVICE]);
  setNavigator(makeAutoBluetooth([watchDev]));
  const A7 = resetBle();
  const w7 = await A7.watchForDevice();
  t.ok('watchForDevice → watching when API present', w7.ok === true && w7.watching === true);
  t.ok('watchAdvertisements was actually called', watchDev._watchCalls === 1);
  t.ok('advertisement listener registered', watchDev._listenerCount('advertisementreceived') === 1);
  t.ok('not connected before the laser powers on', !A7.isConnected());
  watchDev._emit('advertisementreceived');           // tech powers the laser on
  await settle();
  t.eq('advertisement triggered the auto-connect', A7.getState().status, 'connected');
  t.eq('still no picker after advertisement connect', bt()._requestDeviceCalls, 0);
  t.ok('one-shot: listener removed after firing', watchDev._listenerCount('advertisementreceived') === 0);
  watchDev._emit('advertisementreceived');           // a second adv must be inert
  await settle();
  t.ok('second advertisement does not reconnect again', watchDev._connectCalls === 1);

  // ---- 8. watchForDevice honest no-ops ---------------------------------------
  fakeStore([Object.assign({}, SAVED_HUEPAR)]);
  setNavigator(makeAutoBluetooth([makePermittedDevice('dev-9', 'LDM-S60-BT', [HUEPAR_SERVICE], { watchable: false })]));
  resetBle();
  const w8 = await G.AAA_BLUETOOTH.watchForDevice();
  t.ok('no watchAdvertisements API → honest no-op', w8.ok === false && w8.reason === 'WATCH_UNSUPPORTED');

  fakeStore([]);
  setNavigator(makeAutoBluetooth([]));
  resetBle();
  const w8b = await G.AAA_BLUETOOTH.watchForDevice();
  t.ok('no saved device → watch declines with a reason', w8b.ok === false && !!w8b.reason);

  // ---- 9. unsupported platform: nothing throws, everything honest ----------
  fakeStore([Object.assign({}, SAVED_HUEPAR)]);
  setNavigator(undefined);   // navigator.bluetooth missing (e.g. iOS Safari)
  const A9 = resetBle();
  let threw = false;
  let r9 = null, w9 = null;
  try { r9 = await A9.autoReconnect(); w9 = await A9.watchForDevice(); } catch (_) { threw = true; }
  t.ok('unsupported platform never throws', threw === false);
  t.ok('unsupported autoReconnect → MUST_REPICK', r9 && r9.ok === false && r9.error === 'MUST_REPICK');
  t.ok('unsupported watchForDevice → honest decline', w9 && w9.ok === false && w9.reason === 'UNSUPPORTED');

  return t.report();
};
