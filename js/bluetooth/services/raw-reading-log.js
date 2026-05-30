/*
 * AAA Raw Bluetooth Reading Log — the black box recorder.
 *
 * Every byte a device sends is logged verbatim (hex + decoded attempt) BEFORE
 * any parsing. This is what lets us add support for a new laser brand later:
 * connect the unknown device, take a few readings, then read the raw frames
 * here to write its adapter. Kept to a bounded in-memory ring + persisted tail
 * so it never grows without limit on a field device.
 */
;(function (global) {
  'use strict';

  const MAX = 200;                 // ring buffer size (in-memory)
  const buffer = [];

  function clock() { return global.AAA_RUNTIME_CLOCK; }
  function nowISO() { return clock() && clock().nowISO ? clock().nowISO() : new Date().toISOString(); }

  function toHex(dataView) {
    const out = [];
    try {
      for (let i = 0; i < dataView.byteLength; i++) out.push(dataView.getUint8(i).toString(16).padStart(2, '0'));
    } catch (_) {}
    return out.join(' ');
  }
  function toAscii(dataView) {
    let s = '';
    try {
      for (let i = 0; i < dataView.byteLength; i++) {
        const c = dataView.getUint8(i);
        s += (c >= 32 && c < 127) ? String.fromCharCode(c) : '.';
      }
    } catch (_) {}
    return s;
  }

  const Log = {
    /**
     * Record one raw frame.
     * @param {Object} entry
     * @param {string} entry.deviceId
     * @param {string} [entry.serviceUuid]
     * @param {string} [entry.characteristicUuid]
     * @param {DataView} [entry.value]   raw GATT value
     * @param {string} [entry.note]
     */
    record(entry) {
      const e = entry || {};
      const rec = {
        at: nowISO(),
        deviceId: e.deviceId || null,
        serviceUuid: e.serviceUuid || null,
        characteristicUuid: e.characteristicUuid || null,
        hex: e.value ? toHex(e.value) : null,
        ascii: e.value ? toAscii(e.value) : null,
        byteLength: e.value ? e.value.byteLength : 0,
        note: e.note || null
      };
      buffer.push(rec);
      if (buffer.length > MAX) buffer.shift();
      return rec;
    },

    /** Most recent frames, newest first. */
    recent(n) { return buffer.slice(-(n || 50)).reverse(); },

    /** Everything captured this session (for exporting to build a new adapter). */
    all() { return buffer.slice(); },

    clear() { buffer.length = 0; },

    /** Hex helper exposed for adapters/tests. */
    toHex: toHex
  };

  global.AAA_BLE_RAW_LOG = Log;
})(typeof window !== 'undefined' ? window : this);
