/*
 * AAA Leica DISTO BLE Adapter — recognizes Leica DISTO laser distance meters
 * and routes them through the shared generic adapter + measurement parser.
 *
 * STATUS: provisional (leica-disto-v1). Leica's DISTO BLE GATT is not publicly
 * certified for third parties; this adapter fingerprints the device by NAME
 * ("DISTO"/"Leica") and reuses the generic Web Bluetooth connect/subscribe/
 * reconnect machinery and AAA_MEASUREMENT_PARSER (which normalizes m/cm/in → ft
 * with a confidence score). The raw-reading log stays on so unknown firmware
 * frames can be re-decoded. Lab-validate against a real DISTO before trusting it
 * for money-bearing measurements.
 */
;(function (global) {
  'use strict';

  const VERSION = 'leica-disto-v1';

  function matchLeica(info) {
    const name = String((info && info.name) || '').toLowerCase();
    const mfr = String((info && info.manufacturer) || '').toLowerCase();
    return /disto|leica/.test(name) || /leica/.test(mfr);
  }

  function createLeicaDistoAdapter() {
    const Generic = global.AAA_GENERIC_BLE_ADAPTER;
    if (!Generic) return null;
    const a = (typeof Generic === 'function') ? new Generic() : Generic.create ? Generic.create() : Generic;
    a.deviceLabel = 'Leica DISTO';
    a.deviceFilters = [{ namePrefix: 'DISTO' }, { namePrefix: 'Leica' }];
    a.adapterVersion = VERSION;
    return a;
  }

  global.AAA_LEICA_DISTO_ADAPTER = { create: createLeicaDistoAdapter, match: matchLeica, version: VERSION };

  if (global.AAA_DEVICE_ADAPTER_REGISTRY && global.AAA_GENERIC_BLE_ADAPTER) {
    global.AAA_DEVICE_ADAPTER_REGISTRY.register({
      id: 'leica-disto', label: 'Leica DISTO', priority: 50,
      match: matchLeica, optionalServices: [], factory: function () { return createLeicaDistoAdapter(); }
    });
  }
})(typeof window !== 'undefined' ? window : this);
