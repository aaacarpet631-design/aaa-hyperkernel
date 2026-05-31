/*
 * AAA Device Adapter Registry — pluggable laser-brand support.
 *
 * The generic BLE adapter handles any device. To add Bosch / Leica / DeWalt /
 * Mileseey support later, register an adapter with a match(deviceInfo) test and
 * (optionally) its own parse(); the registry hands the connection to the most
 * specific matching adapter, falling back to generic. This is the single seam
 * where brand support grows — no other file needs to change.
 */
;(function (global) {
  'use strict';

  const adapters = [];   // { id, label, match(info)->bool, factory()->adapter, priority }

  const Registry = {
    /**
     * @param {Object} def
     * @param {string} def.id
     * @param {string} def.label
     * @param {(info:{name?:string,manufacturer?:string,services?:string[]})=>boolean} [def.match]
     * @param {()=>Object} def.factory   returns an adapter instance (adapter contract)
     * @param {number} [def.priority]    higher = preferred when multiple match
     */
    register(def) {
      if (!def || !def.id || typeof def.factory !== 'function') return false;
      const existing = adapters.findIndex((a) => a.id === def.id);
      const entry = {
        id: def.id, label: def.label || def.id,
        match: typeof def.match === 'function' ? def.match : () => false,
        factory: def.factory, priority: def.priority || 0,
        // Brand service UUIDs this adapter needs reachable post-connect. They
        // MUST be declared to the OS picker up front (Web Bluetooth blocks
        // getPrimaryService for services not requested), so the generic picker
        // folds these in — registering a brand adapter is all it takes.
        optionalServices: Array.isArray(def.optionalServices) ? def.optionalServices.slice() : []
      };
      if (existing !== -1) adapters[existing] = entry; else adapters.push(entry);
      return true;
    },

    list() { return adapters.map((a) => ({ id: a.id, label: a.label, priority: a.priority })); },

    /** Union of every registered adapter's optional service UUIDs, deduped. */
    optionalServices() {
      const out = [];
      adapters.forEach((a) => (a.optionalServices || []).forEach((s) => { if (s && out.indexOf(s) === -1) out.push(s); }));
      return out;
    },

    /** Pick the best adapter for a device, or the generic fallback. */
    resolve(deviceInfo) {
      const info = deviceInfo || {};
      const matched = adapters
        .filter((a) => a.id !== 'generic-ble')
        .filter((a) => { try { return a.match(info); } catch (_) { return false; } })
        .sort((a, b) => b.priority - a.priority);
      const chosen = matched[0] || adapters.find((a) => a.id === 'generic-ble');
      return chosen ? { id: chosen.id, label: chosen.label, adapter: chosen.factory() } : null;
    },

    /** A fresh generic adapter (used for discovery before we know the device). */
    generic() {
      const g = adapters.find((a) => a.id === 'generic-ble');
      return g ? g.factory() : null;
    }
  };

  // Register the built-in generic adapter if its class is loaded.
  if (global.AAA_GENERIC_BLE_ADAPTER) {
    Registry.register({
      id: 'generic-ble',
      label: 'Generic Bluetooth (BLE)',
      priority: -100,                 // always lowest — pure fallback
      match: () => true,
      factory: () => new global.AAA_GENERIC_BLE_ADAPTER()
    });
  }

  global.AAA_DEVICE_ADAPTER_REGISTRY = Registry;
})(typeof window !== 'undefined' ? window : this);
