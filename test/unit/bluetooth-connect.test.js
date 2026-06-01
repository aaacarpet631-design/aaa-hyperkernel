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

// ---- a fake Web Bluetooth that enforces the optionalServices security rule ---
function makeFakeBluetooth(deviceName, presentServices) {
  // presentServices: uuids the device actually exposes over GATT.
  function makeChar(uuid) {
    return {
      uuid, properties: { notify: true, indicate: false },
      async startNotifications() { return this; },
      addEventListener() {},
      async writeValue() {},
      async readValue() { return new DataView(new Uint8Array([90]).buffer); }
    };
  }
  function makeService(uuid) {
    return { uuid, async getCharacteristics() { return [makeChar(uuid + '-char')]; }, async getCharacteristic() { return makeChar(uuid + '-w'); } };
  }
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
  function fakeStore() {
    const devices = {};
    G.AAA_MEASUREMENT_STORE = {
      async getDevice(id) { return devices[id] || null; },
      async saveDevice(d) { const rec = Object.assign({ id: d.id || 'dev-1' }, d); devices[rec.id] = rec; return { ok: true, device: rec }; },
      async listDevices() { return Object.values(devices); }
    };
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

  // ---- a generic (non-brand) device still connects fine --------------------
  setNavigator(makeFakeBluetooth('Some Random Laser', ['battery_service']));
  loadStack();
  const BLE3 = G.AAA_BLUETOOTH;
  const p3 = await BLE3.scanAndPick();
  t.ok('generic device picks generic adapter', p3.ok && BLE3._adapter.id === 'generic-ble');
  const c3 = await BLE3.connect();
  t.ok('generic device connects', c3.ok === true);
  t.eq('generic device status connected', BLE3.getState().status, 'connected');

  return t.report();
};
