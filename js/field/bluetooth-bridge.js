/*
 * AAA Bluetooth Laser Measurement Bridge — readings flow from the laser into the
 * active capture session without a keyboard.
 *
 * It reuses the existing BLE stack entirely (AAA_DEVICE_ADAPTER_REGISTRY +
 * adapters + AAA_MEASUREMENT_PARSER, which already normalizes m/cm/in → feet
 * with a confidence score). This module is only the BRIDGE: it routes a parsed
 * reading to the active room's focused dimension in AAA_FIELD_CAPTURE_SESSION,
 * tracks connection state, and emits events the UI listens to. Per the field-UX
 * decision it does NOT re-render the layout on every pull — it emits events and
 * exposes buildLayout() as an explicit, review-gated step.
 *
 * Graceful degrade: a disconnect / auto-power-off flips a flag and emits
 * 'bluetooth.degraded' but never drops the open capture session (that lives in
 * the store). Deterministic + headless-testable: handleMeasurement() is the pure
 * path, and wire(source) attaches a real adapter's subscribe() in the app.
 */
;(function (global) {
  'use strict';

  function session() { return global.AAA_FIELD_CAPTURE_SESSION; }
  function parser() { return global.AAA_MEASUREMENT_PARSER; }
  function events() { return global.AAA_EVENTS; }
  function optimizer() { return global.AAA_SEAM_LAYOUT_OPTIMIZER; }

  const M_TO_FT = 3.28084, CM_TO_FT = 0.0328084, MM_TO_FT = 0.00328084, IN_TO_FT = 1 / 12;

  function toFeet(value, unit) {
    const v = Number(value); if (!isFinite(v)) return null;
    switch (String(unit || '').toLowerCase()) {
      case 'ft': case 'feet': case "'": return v;
      case 'm': return v * M_TO_FT;
      case 'cm': return v * CM_TO_FT;
      case 'mm': return v * MM_TO_FT;
      case 'in': case 'inch': case '"': return v * IN_TO_FT;
      default: return null;
    }
  }
  function emit(type, payload) { try { if (events()) events().emit(type, payload); } catch (_) {} }

  // Mutable bridge state (one active device per phone in the field).
  const state = { isDeviceConnected: false, activeDeviceId: null, signalStrength: 0, lastReceivedValue: null, activeSessionId: null, activeDimension: 'generic', activeRoomLabel: null };
  let _detach = null;

  const Bridge = {
    state: state,

    /** Bind the bridge to the capture session it should fill. */
    setActiveSession(sessionId) { state.activeSessionId = sessionId || null; return state; },
    /** Focus the next reading onto a dimension ('length'|'width'|'height'|'generic'). */
    setTarget(opts) { const o = opts || {}; if (o.dimension) state.activeDimension = o.dimension; if (o.roomLabel !== undefined) state.activeRoomLabel = o.roomLabel; return state; },

    /**
     * Core path: ingest a laser reading and route it to the active room
     * dimension. Accepts either { valueInFeet } or { value, rawUnit }.
     * @returns the capture-session result, or an honest error.
     */
    async handleMeasurement(event) {
      const e = event || {};
      if (!state.activeSessionId) return { ok: false, error: 'NO_ACTIVE_SESSION', note: 'Start a field capture session before measuring.' };
      let ft = (e.valueInFeet != null) ? Number(e.valueInFeet) : toFeet(e.value, e.rawUnit);
      if (ft == null || !isFinite(ft) || ft <= 0) { emit('bluetooth.bad_reading', { event: e }); return { ok: false, error: 'UNPARSEABLE_READING' }; }
      ft = Math.round(ft * 100) / 100;
      state.lastReceivedValue = ft;
      if (e.deviceId) state.activeDeviceId = e.deviceId;
      const dimension = e.targetDimension || state.activeDimension || 'generic';

      const res = await session().setDimension(state.activeSessionId, ft, dimension);
      if (!res.ok) { emit('bluetooth.reading_rejected', { error: res.error, value: ft }); return res; }
      emit('bluetooth.reading_captured', { sessionId: state.activeSessionId, dimension: res.dimension, valueFt: ft });
      if (res.committed) emit('bluetooth.room_committed', { sessionId: state.activeSessionId, room: res.room });
      else emit('bluetooth.dimension_set', { sessionId: state.activeSessionId, draft: res.draft });
      return res;
    },

    /**
     * Wire a real adapter/controller's reading stream into the bridge. The
     * source exposes subscribe(cb) where cb receives a normalized reading
     * (valueInFeet or value+unit). Returns an unwire function.
     */
    wire(source) {
      if (_detach) { try { _detach(); } catch (_) {} _detach = null; }
      if (!source || typeof source.subscribe !== 'function') return function () {};
      const self = this;
      const off = source.subscribe(function (reading) {
        if (reading && (reading.connected != null || reading.signalStrength != null)) { state.isDeviceConnected = !!reading.connected; if (reading.signalStrength != null) state.signalStrength = reading.signalStrength; }
        if (reading && (reading.valueInFeet != null || reading.value != null)) return self.handleMeasurement(reading);
      });
      _detach = typeof off === 'function' ? off : function () {};
      return _detach;
    },

    /** Connection lifecycle (graceful — never drops session data). */
    onConnect(deviceId, signal) { state.isDeviceConnected = true; state.activeDeviceId = deviceId || state.activeDeviceId; if (signal != null) state.signalStrength = signal; emit('bluetooth.connected', { deviceId: state.activeDeviceId }); return state; },
    onDisconnect(reason) { state.isDeviceConnected = false; state.signalStrength = 0; emit('bluetooth.degraded', { reason: reason || 'disconnected', sessionPreserved: !!state.activeSessionId }); return state; },

    /** Explicit, review-gated layout build (NOT fired per reading). */
    async buildLayout(opts) {
      const o = opts || {};
      if (!state.activeSessionId) return { ok: false, error: 'NO_ACTIVE_SESSION' };
      if (!optimizer()) return { ok: false, error: 'OPTIMIZER_UNAVAILABLE' };
      const plan = await optimizer().optimize({ sessionId: state.activeSessionId, napDirection: o.napDirection });
      emit('bluetooth.layout_ready', { sessionId: state.activeSessionId, layoutPlanId: plan && plan.layoutPlanId, needsReview: plan && plan.needsReview });
      return { ok: true, plan: plan };
    },

    /** Parse a raw BLE DataView via the shared parser → a bridge reading. */
    fromDataView(dataView, deviceId) {
      if (!parser() || !parser().parse) return null;
      const r = parser().parse(dataView);
      if (!r || r.feet == null) return null;
      return { valueInFeet: r.feet, rawUnit: r.unit || 'ft', deviceId: deviceId || state.activeDeviceId, confidence: r.confidence };
    }
  };

  global.AAA_BLUETOOTH_BRIDGE = Bridge;
})(typeof window !== 'undefined' ? window : this);
