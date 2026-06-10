/*
 * AAA Bosch GLM BLE Adapter — recognizes Bosch GLM laser distance meters and
 * routes them through the shared generic adapter + measurement parser.
 *
 * STATUS: provisional (bosch-glm-v1). Bosch's GLM "Measuring Master" BLE GATT is
 * not publicly certified for third parties; this adapter fingerprints by NAME
 * ("GLM"/"Bosch") and reuses the generic connect/subscribe/reconnect machinery
 * and AAA_MEASUREMENT_PARSER (m/cm/in → ft + confidence). The raw-reading log
 * stays on for unknown frames. Lab-validate against a real GLM before trusting
 * it for money-bearing measurements.
 */
;(function (global) {
  'use strict';

  const VERSION = 'bosch-glm-v1';

  function matchBosch(info) {
    const name = String((info && info.name) || '').toLowerCase();
    const mfr = String((info && info.manufacturer) || '').toLowerCase();
    return /\bglm\b|bosch/.test(name) || /bosch/.test(mfr);
  }

  function createBoschGlmAdapter() {
    const Generic = global.AAA_GENERIC_BLE_ADAPTER;
    if (!Generic) return null;
    const a = (typeof Generic === 'function') ? new Generic() : Generic.create ? Generic.create() : Generic;
    a.deviceLabel = 'Bosch GLM';
    a.deviceFilters = [{ namePrefix: 'GLM' }, { namePrefix: 'Bosch' }];
    a.adapterVersion = VERSION;
    return a;
  }

  global.AAA_BOSCH_GLM_ADAPTER = { create: createBoschGlmAdapter, match: matchBosch, version: VERSION };

  if (global.AAA_DEVICE_ADAPTER_REGISTRY && global.AAA_GENERIC_BLE_ADAPTER) {
    global.AAA_DEVICE_ADAPTER_REGISTRY.register({
      id: 'bosch-glm', label: 'Bosch GLM', priority: 50,
      match: matchBosch, optionalServices: [], factory: function () { return createBoschGlmAdapter(); }
    });
  }
})(typeof window !== 'undefined' ? window : this);
