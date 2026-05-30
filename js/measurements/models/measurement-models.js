/*
 * AAA Measurement Models — typed factories + validation for field measurement.
 *
 * The app has no build step, so "TypeScript types" are expressed as JSDoc
 * @typedef blocks: real editor/IDE typechecking with zero tooling. Factories
 * normalize partial input into a complete, persistable record; validation runs
 * the bad-reading / unrealistic / duplicate checks the field needs so nothing
 * silently corrupts a quote. Pure functions only — no storage, no Bluetooth.
 */
;(function (global) {
  'use strict';

  function ids() { return global.AAA_ID_FACTORY; }
  function clock() { return global.AAA_RUNTIME_CLOCK; }
  function cfg() { return global.AAA_CONFIG || {}; }
  function nowMs() { return clock() ? clock().now() : Date.now(); }
  function nowISO() { return clock() && clock().nowISO ? clock().nowISO() : new Date().toISOString(); }
  function newId(prefix) { return ids() ? ids().createId(prefix) : prefix + '_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8); }

  /**
   * @typedef {'bluetooth'|'manual'|'ai'} MeasurementSource
   * @typedef {'connected'|'connecting'|'disconnected'|'error'|'unsupported'} DeviceStatus
   *
   * @typedef {Object} MeasurementSession
   * @property {string} id
   * @property {string|null} jobId
   * @property {string|null} customerId
   * @property {string|null} deviceId            BluetoothDevice.id this came from (null if manual)
   * @property {string} roomName
   * @property {number|null} length              feet
   * @property {number|null} width               feet
   * @property {number|null} squareFeet          ft^2 (auto length*width when both present, unless overridden)
   * @property {number|null} linearFeet          ft (e.g. for stretching/seams/walls)
   * @property {number} stairsCount
   * @property {Array<{id:string,note?:string,addedAt:string}>} photos  photo refs (media handled elsewhere)
   * @property {string} notes
   * @property {MeasurementSource} source
   * @property {number|null} confidenceScore     0..1 (set by capture/AI; manual entry defaults to null)
   * @property {boolean} manualOverride          true when a human typed/edited a value over a BLE reading
   * @property {string} workspaceId
   * @property {string} createdAt                ISO
   * @property {string} updatedAt                ISO
   * @property {boolean} syncedToCloud
   */

  /**
   * @typedef {Object} BluetoothDeviceRecord
   * @property {string} id                        stable id (Web Bluetooth device.id when available)
   * @property {string} name                      advertised name
   * @property {string} nickname                  owner-assigned label
   * @property {string|null} manufacturer
   * @property {string} deviceType                'laser_measure' | 'unknown' | adapter-defined
   * @property {string|null} lastConnectedAt      ISO
   * @property {number|null} batteryLevel         0..100
   * @property {DeviceStatus} status
   * @property {string[]} supportedServices       GATT service UUIDs seen on this device
   * @property {string|null} adapterId            DeviceAdapterRegistry id that handled it
   * @property {string} workspaceId
   * @property {string} createdAt                 ISO
   * @property {string} updatedAt                 ISO
   */

  const Models = {
    SOURCES: ['bluetooth', 'manual', 'ai'],

    /** Build a complete MeasurementSession from partial input. Never throws. */
    newSession(partial) {
      const p = partial || {};
      const ws = p.workspaceId || cfg().workspaceId || 'default';
      const length = numOrNull(p.length);
      const width = numOrNull(p.width);
      let sq = numOrNull(p.squareFeet);
      // Auto-derive square footage when both dims present and no explicit override.
      if (sq == null && length != null && width != null) sq = round(length * width, 2);
      return {
        id: p.id || newId('meas'),
        jobId: p.jobId != null ? String(p.jobId) : null,
        customerId: p.customerId != null ? String(p.customerId) : null,
        deviceId: p.deviceId != null ? String(p.deviceId) : null,
        roomName: String(p.roomName || 'Room'),
        length: length,
        width: width,
        squareFeet: sq,
        linearFeet: numOrNull(p.linearFeet),
        stairsCount: intOrZero(p.stairsCount),
        photos: Array.isArray(p.photos) ? p.photos : [],
        notes: String(p.notes || ''),
        source: Models.SOURCES.indexOf(p.source) !== -1 ? p.source : 'manual',
        confidenceScore: clamp01(p.confidenceScore),
        manualOverride: !!p.manualOverride,
        workspaceId: ws,
        createdAt: p.createdAt || nowISO(),
        updatedAt: nowISO(),
        syncedToCloud: !!p.syncedToCloud
      };
    },

    /** Build a complete BluetoothDeviceRecord from partial input. */
    newDevice(partial) {
      const p = partial || {};
      const ws = p.workspaceId || cfg().workspaceId || 'default';
      return {
        id: p.id || newId('bledev'),
        name: String(p.name || 'Unknown device'),
        nickname: String(p.nickname || ''),
        manufacturer: p.manufacturer != null ? String(p.manufacturer) : null,
        deviceType: String(p.deviceType || 'unknown'),
        lastConnectedAt: p.lastConnectedAt || null,
        batteryLevel: numOrNull(p.batteryLevel),
        status: p.status || 'disconnected',
        supportedServices: Array.isArray(p.supportedServices) ? p.supportedServices.slice() : [],
        adapterId: p.adapterId || null,
        workspaceId: ws,
        createdAt: p.createdAt || nowISO(),
        updatedAt: nowISO()
      };
    },

    /**
     * Validate a session for field safety. Returns { ok, errors[], warnings[] }.
     * Errors block save; warnings are surfaced but never block a quote.
     * Thresholds are conservative and tuned for residential carpet work.
     */
    validateSession(s, opts) {
      const o = opts || {};
      const errors = [];
      const warnings = [];
      if (!s || typeof s !== 'object') return { ok: false, errors: ['No measurement data.'], warnings: [] };
      if (!s.roomName || !String(s.roomName).trim()) errors.push('Room name is required.');

      const dims = ['length', 'width', 'linearFeet'];
      dims.forEach((k) => {
        if (s[k] != null && (!isFinite(s[k]) || s[k] < 0)) errors.push(prettyDim(k) + ' must be a positive number.');
      });
      if (s.squareFeet != null && (!isFinite(s.squareFeet) || s.squareFeet < 0)) errors.push('Square feet must be a positive number.');
      if (s.stairsCount != null && (!Number.isInteger(s.stairsCount) || s.stairsCount < 0)) errors.push('Stairs count must be a whole number.');

      // Need *something* measurable to be useful.
      const hasArea = s.squareFeet != null && s.squareFeet > 0;
      const hasDims = s.length != null && s.width != null;
      const hasLinear = s.linearFeet != null && s.linearFeet > 0;
      const hasStairs = s.stairsCount > 0;
      if (!hasArea && !hasDims && !hasLinear && !hasStairs) {
        errors.push('Enter at least a length × width, square feet, linear feet, or a stairs count.');
      }

      // Unrealistic-measurement warnings (don't block — tech may be on a warehouse).
      if (s.length != null && s.length > 200) warnings.push('Length over 200 ft — double-check the reading.');
      if (s.width != null && s.width > 200) warnings.push('Width over 200 ft — double-check the reading.');
      if (s.length != null && s.length > 0 && s.length < 0.5) warnings.push('Length under 6 in — likely a misfire.');
      if (s.width != null && s.width > 0 && s.width < 0.5) warnings.push('Width under 6 in — likely a misfire.');
      if (hasArea && s.squareFeet > 20000) warnings.push('Over 20,000 ft² — confirm this is a commercial space.');
      if (s.stairsCount > 60) warnings.push(s.stairsCount + ' stairs — confirm; that is unusually high.');

      // Cross-check derived vs entered square footage (catch fat-finger overrides).
      if (hasArea && hasDims) {
        const derived = s.length * s.width;
        if (derived > 0 && Math.abs(derived - s.squareFeet) / derived > 0.2) {
          warnings.push('Square feet differs >20% from length × width (' + round(derived, 1) + ' ft²). Confirm override.');
        }
      }

      // Duplicate detection against existing sessions for the same job.
      if (Array.isArray(o.existing) && o.existing.length) {
        const dup = o.existing.find((e) => e.id !== s.id && isDuplicate(e, s));
        if (dup) warnings.push('Looks like a duplicate of "' + (dup.roomName || 'an existing room') + '" — same room and near-identical size.');
      }

      return { ok: errors.length === 0, errors: errors, warnings: warnings };
    },

    /** True when two sessions look like the same physical reading. */
    isDuplicate: isDuplicate,

    /** Recompute squareFeet from dims unless it was explicitly overridden. */
    recomputeArea(s) {
      if (!s) return s;
      if (!s.manualOverride && s.length != null && s.width != null) {
        s.squareFeet = round(s.length * s.width, 2);
      }
      return s;
    }
  };

  function isDuplicate(a, b) {
    if (!a || !b) return false;
    if (String(a.roomName || '').trim().toLowerCase() !== String(b.roomName || '').trim().toLowerCase()) return false;
    const close = (x, y) => (x == null && y == null) || (x != null && y != null && Math.abs(x - y) <= Math.max(0.25, Math.abs(x) * 0.02));
    return close(a.squareFeet, b.squareFeet) && close(a.length, b.length) && close(a.width, b.width);
  }

  function numOrNull(v) { if (v == null || v === '') return null; const n = Number(v); return isFinite(n) ? n : null; }
  function intOrZero(v) { const n = parseInt(v, 10); return isFinite(n) && n > 0 ? n : 0; }
  function clamp01(v) { if (v == null) return null; const n = Number(v); return isFinite(n) ? Math.max(0, Math.min(1, n)) : null; }
  function round(n, p) { const f = Math.pow(10, p || 0); return Math.round(n * f) / f; }
  function prettyDim(k) { return ({ length: 'Length', width: 'Width', linearFeet: 'Linear feet' })[k] || k; }

  global.AAA_MEASUREMENT_MODELS = Models;
})(typeof window !== 'undefined' ? window : this);
