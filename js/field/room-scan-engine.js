/*
 * AAA Room Scan Engine — polygon/perimeter room capture, one of three inputs
 * into the same capture truth (manual entry · Bluetooth laser · room scan).
 *
 * It is a PROVIDER abstraction: a source ('manual_polygon' | 'camera_scan' |
 * 'lidar_scan' | 'roomplan_import' | 'mock_scan') supplies raw perimeter points;
 * the engine normalizes them to feet (scan-normalizer), scores trust + folds in
 * captured anomalies (scan-confidence-engine + scan-anomaly-flags), and emits a
 * room-polygon record. Real LiDAR/RoomPlan APIs do not exist in the PWA runtime,
 * so only the MOCK provider ships — no fake hardware claims; an unimplemented
 * source with no points returns `unavailable`, never a fabricated room.
 *
 * It does NOT attach to the session, run the optimizer, or touch a quote — that
 * is the adapter's and the explicit "Review Layout" step's job.
 */
;(function (global) {
  'use strict';

  function normalizer() { return global.AAA_SCAN_NORMALIZER; }
  function confidence() { return global.AAA_SCAN_CONFIDENCE_ENGINE; }
  function flags() { return global.AAA_SCAN_ANOMALY_FLAGS; }
  function ids() { return global.AAA_ID_FACTORY; }
  function clock() { return global.AAA_RUNTIME_CLOCK; }
  function nowISO() { return clock() && clock().nowISO ? clock().nowISO() : new Date().toISOString(); }
  function newId(p) { return ids() ? ids().createId(p) : p + '_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7); }

  const SUPPORTED = ['manual_polygon', 'camera_scan', 'lidar_scan', 'roomplan_import', 'mock_scan'];

  // Built-in MOCK provider: returns a rectangle (feet) from dims, or given points.
  function mockProvider(opts) {
    const o = opts || {};
    if (Array.isArray(o.points) && o.points.length >= 3) return { points: o.points, units: o.units || 'ft' };
    const L = Number(o.dims && o.dims.length) || 15, W = Number(o.dims && o.dims.width) || 12;
    return { points: [{ x: 0, y: 0 }, { x: L, y: 0 }, { x: L, y: W }, { x: 0, y: W }], units: 'ft', closed: true };
  }
  const PROVIDERS = { mock_scan: mockProvider };

  const Engine = {
    SUPPORTED_SOURCES: SUPPORTED.slice(),

    /** Register a real provider (e.g. a RoomPlan bridge) for a source. */
    registerProvider(source, fn) { if (SUPPORTED.indexOf(source) === -1 || typeof fn !== 'function') return { ok: false, error: 'INVALID_PROVIDER' }; PROVIDERS[source] = fn; return { ok: true }; },
    hasProvider(source) { return typeof PROVIDERS[source] === 'function'; },

    /**
     * Capture a room polygon. opts: { source, sessionId, roomId?, roomName?,
     * points?, units?, dims?, closed?, deviceConfidence?, anomalies? }.
     * @returns { status:'captured', polygon } | { status:'unavailable'|'insufficient_data' }.
     */
    async capture(opts) {
      const o = opts || {};
      const source = o.source || 'mock_scan';
      if (SUPPORTED.indexOf(source) === -1) return { status: 'unavailable', source: source, note: 'unknown_source' };

      // Resolve raw points: a registered provider, else caller-supplied points.
      let raw = null;
      if (PROVIDERS[source]) { try { raw = await PROVIDERS[source](o); } catch (_) { raw = null; } }
      else if (Array.isArray(o.points) && o.points.length) raw = { points: o.points, units: o.units || 'ft', closed: o.closed };
      if (!raw || !Array.isArray(raw.points)) return { status: 'unavailable', source: source, note: 'no provider for this source in the PWA runtime — supply points or register a provider' };

      const norm = normalizer().normalize(raw.points, raw.units || o.units || 'ft');
      if (norm.status !== 'normalized') return { status: 'insufficient_data', source: source, reason: norm.reason };

      const assessed = confidence().assess({ source: source, points: norm.points, closed: raw.closed !== false, deviceConfidence: o.deviceConfidence, anomalies: o.anomalies });
      const anomalies = assessed.anomalies || [];
      const sum = flags() ? flags().summary(anomalies) : { compoundLaborModifier: 1, waiverRequired: false };

      const polygon = {
        polygonId: newId('poly'), sessionId: o.sessionId || null, roomId: o.roomId || null,
        roomName: o.roomName || null, source: source, units: 'ft', points: norm.points,
        perimeterFt: norm.perimeterFt, areaSqFt: norm.areaSqFt, bbox: norm.bbox,
        confidence: assessed.confidence, risk: assessed.risk, conflicts: [], needsReview: assessed.needsReview,
        anomalies: anomalies, laborModifier: sum.compoundLaborModifier, waiverRequired: sum.waiverRequired,
        managerReview: sum.managerReview, recommendedActions: sum.recommendedActions || [], reviewReasons: assessed.reasons,
        capturedAt: nowISO(), provenanceId: newId('prov')
      };
      return { status: 'captured', polygon: polygon };
    },

    /** Field-friendly aliases. */
    startScan(opts) { return this.capture(opts); },
    saveOutline(opts) { return this.capture(opts); }
  };

  global.AAA_ROOM_SCAN_ENGINE = Engine;
})(typeof window !== 'undefined' ? window : this);
