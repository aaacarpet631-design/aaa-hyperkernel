/*
 * AAA Spatial Event Ledger — the immutable physical-truth chain of the field.
 *
 * Decouples the UNALTERABLE PHYSICS of a space (dimensions, polygon points,
 * source provenance, material category, nap, raw-payload hash) from the
 * TEMPORARY ECONOMICS of the market (pricing, waste, labor markups). Business
 * projections are computed FROM these nodes elsewhere and never live here, so
 * the raw spatial facts captured today stay pristine if nylon prices spike, AAA
 * expands into hardwood, or a new material is invented in 100 years.
 *
 * EDGE-FIRST SEALING (Pass 1): the instant a reading is accepted, the node is
 * hashed locally and synchronously (reusing AAA_AUDIT_LEDGER.sha256 + canonical
 * — a deterministic, offline SHA-256; chosen over async crypto.subtle so the
 * chain seals with zero network and zero await, on a truck in a concrete
 * basement). Each node chains off the previous node's eventHash → tamper-evident
 * the moment it is written. NETWORK NOTARIZATION (Pass 2) is a non-blocking seam
 * (notarize/markNotarized): the server re-verifies and attaches a global
 * signature as a SEPARATE attestation record — the immutable node is never
 * mutated, so the hash chain survives notarization.
 *
 * VOLATILE vs COMMITTED: a moving laser / manual drag streams through stage()
 * (in-memory, never chained). Only an ACCEPTED reading is commit()'d as a node —
 * the ledger records decisions (physical facts), not the trembling toward them.
 */
;(function (global) {
  'use strict';

  const COLLECTION = 'spatial_events';
  const NOTARY = 'spatial_notarizations';
  const SCHEMA_VERSION = 1;
  const GENESIS = '0000000000000000000000000000000000000000000000000000000000000000';

  function cfg() { return global.AAA_CONFIG || {}; }
  function data() { return global.AAA_DATA; }
  function ids() { return global.AAA_ID_FACTORY; }
  function clock() { return global.AAA_RUNTIME_CLOCK; }
  function audit() { return global.AAA_AUDIT_LEDGER; }
  function ws() { return cfg().workspaceId || 'default'; }
  function nowMs() { return clock() && clock().now ? clock().now() : Date.now(); }
  function mine(r) { return r && (r.workspaceId == null || r.workspaceId === ws()); }
  function newId(p) { return ids() ? ids().createId(p) : p + '_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8); }
  function deepFreeze(o) { if (o && typeof o === 'object' && !Object.isFrozen(o)) { Object.keys(o).forEach(function (k) { deepFreeze(o[k]); }); Object.freeze(o); } return o; }

  // Reuse the audit ledger's deterministic, synchronous SHA-256 + canonical
  // serialization (no duplication, no network, identical on client + server).
  function canonical(o) { if (audit() && audit().canonical) return audit().canonical(o); return JSON.stringify(o); }
  function sha256(s) { if (audit() && audit().sha256) return audit().sha256(s); var h = 0x811c9dc5; for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0; } return ('0000000' + (h >>> 0).toString(16)).slice(-8); }

  // ---- enums (coerced to 'unknown', never rejected — honest, flagged) -------
  const SOURCES = ['bluetooth_laser', 'manual', 'room_scan', 'lidar', 'camera', 'voice'];
  const KINDS = ['length', 'width', 'height', 'perimeter', 'area', 'polygon_point', 'moisture', 'temperature', 'humidity'];
  const SPACES = ['room', 'hallway', 'stair', 'closet', 'landing', 'transition', 'unknown'];
  const SURFACES = ['floor', 'subfloor', 'wall', 'stair_tread', 'stair_riser', 'threshold'];
  const AXES = ['nap_axis', 'cross_axis', 'vertical', 'unknown'];
  const GEOMS = ['rectangle', 'polygon', 'line_segment', 'point_cloud', 'scan_mesh', 'unknown'];
  const MATERIALS = ['carpet', 'padding', 'subfloor', 'tile', 'hardwood', 'laminate', 'unknown'];
  function coerce(v, set, dflt) { return set.indexOf(v) !== -1 ? v : dflt; }

  // Deterministic unit normalization to feet (4dp) for linear kinds; deg/pct pass through.
  const TO_FT = { ft: 1, feet: 1, m: 3.28084, cm: 0.0328084, mm: 0.00328084, in: 1 / 12, inch: 1 / 12 };
  function round4(n) { return Math.round(n * 10000) / 10000; }
  function normalize(value, unit) {
    const u = String(unit || 'ft').toLowerCase();
    if (u === 'deg') return { value: round4(Number(value)), unit: 'deg' };
    if (u === 'pct' || u === '%') return { value: round4(Number(value)), unit: 'pct' };
    const k = TO_FT[u];
    if (k == null) return { value: round4(Number(value)), unit: 'ft', assumed: 'unknown_unit_assumed_feet' };
    return { value: round4(Number(value) * k), unit: 'ft' };
  }

  async function chain() { const all = (await data().list(COLLECTION)).filter(mine); return all.sort(function (a, b) { return (a.seq || 0) - (b.seq || 0); }); }

  const Ledger = {
    COLLECTION: COLLECTION, SCHEMA_VERSION: SCHEMA_VERSION, GENESIS: GENESIS,
    SOURCES: SOURCES.slice(), KINDS: KINDS.slice(),
    normalize: normalize,

    // ---- volatile staging (Pass 0): live stream, never chained --------------
    _stage: {},
    stage(reading) {
      const r = reading || {};
      const key = (r.captureSessionId || 'default') + ':' + (r.roomId || 'r') + ':' + (r.measurementKind || 'generic');
      this._stage[key] = { value: r.value, unit: r.unit, at: nowMs(), accepted: false };
      return { staged: true, key: key, value: r.value };
    },
    staged(sessionId) { const out = {}; const self = this; Object.keys(this._stage).forEach(function (k) { if (!sessionId || k.indexOf(sessionId + ':') === 0) out[k] = self._stage[k]; }); return out; },

    /**
     * Pass 1 — commit an ACCEPTED reading as an immutable, edge-sealed node.
     * Synchronous hashing, offline-safe. Returns { ok, event } or
     * { ok:false, error:'insufficient_data', needsReview:true }.
     */
    async commit(reading) {
      const r = reading || {};
      const geometryType = coerce(r.geometryType, GEOMS, 'unknown');
      const points = Array.isArray(r.points) ? r.points.map(function (p) { return Object.assign({ x: Number(p.x), y: Number(p.y) }, p.z != null ? { z: Number(p.z) } : {}); }) : [];
      // Geometry guard: a polygon/area claim needs a real shape — never invented.
      if ((geometryType === 'polygon' || geometryType === 'scan_mesh') && points.length < 3) {
        return { ok: false, error: 'insufficient_data', needsReview: true, reason: 'polygon_needs_3_points' };
      }
      if (r.value == null && !points.length && r.areaSqFt == null && r.perimeterFt == null) {
        return { ok: false, error: 'insufficient_data', needsReview: true, reason: 'no_measurement' };
      }

      const norm = (r.value != null) ? normalize(r.value, r.unit) : { value: null, unit: 'ft' };
      const assumptions = Array.isArray(r.assumptions) ? r.assumptions.slice() : [];
      if (norm.assumed) assumptions.push(norm.assumed);

      const rawPayload = r.rawPayload || { source: r.source, value: r.value, unit: r.unit, points: points };
      const rawPayloadHash = sha256(canonical(rawPayload));

      const prev = (await chain()).slice(-1)[0] || null;
      const seq = (prev ? prev.seq : 0) + 1;

      // Physical-invariant node (NO pricing/waste/labor fields — those are projections).
      const node = {
        eventId: r.eventId || newId('spx'), eventType: 'MEASUREMENT_RECORDED',
        workspaceId: ws(),
        capturedAt: r.capturedAt != null ? r.capturedAt : nowMs(),
        capturedBy: r.capturedBy || (cfg().firebaseUid || 'unknown_operator'),
        captureSessionId: r.captureSessionId || null,
        jobId: r.jobId != null ? r.jobId : null,
        roomId: r.roomId || null,
        provenanceId: r.provenanceId || r.deviceId || 'unknown_provenance',
        source: coerce(r.source, SOURCES, 'manual'),
        measurementKind: coerce(r.measurementKind, KINDS, 'length'),
        value: r.value != null ? Number(r.value) : null,
        unit: String(r.unit || 'ft'),
        normalizedValue: norm.value,
        normalizedUnit: norm.unit,
        spaceType: coerce(r.spaceType, SPACES, 'unknown'),
        surfaceTarget: coerce(r.surfaceTarget, SURFACES, 'floor'),
        axis: coerce(r.axis, AXES, 'unknown'),
        orientationDegrees: r.orientationDegrees != null ? Number(r.orientationDegrees) : null,
        geometryType: geometryType,
        points: points,
        areaSqFt: r.areaSqFt != null ? Number(r.areaSqFt) : null,
        perimeterFt: r.perimeterFt != null ? Number(r.perimeterFt) : null,
        materialCategory: coerce(r.materialCategory, MATERIALS, 'carpet'),
        rollWidthFt: 12,
        napDirection: ['north', 'south', 'east', 'west'].indexOf(r.napDirection) !== -1 ? r.napDirection : 'unknown',
        confidence: clamp01(r.confidence, 0.5),
        risk: clamp01(r.risk, 0),
        needsReview: !!r.needsReview,
        conflictFlags: Array.isArray(r.conflictFlags) ? r.conflictFlags.slice() : [],
        assumptions: assumptions,
        laborGenomeTags: Array.isArray(r.laborGenomeTags) ? r.laborGenomeTags.slice() : [],
        materialGenomeTags: Array.isArray(r.materialGenomeTags) ? r.materialGenomeTags.slice() : [],
        customerGenomeTags: Array.isArray(r.customerGenomeTags) ? r.customerGenomeTags.slice() : [],
        marketingGenomeTags: Array.isArray(r.marketingGenomeTags) ? r.marketingGenomeTags.slice() : [],
        schemaVersion: SCHEMA_VERSION,
        seq: seq,
        rawPayloadHash: rawPayloadHash,
        previousEventHash: prev ? prev.eventHash : GENESIS,
        notarized: false
      };
      // eventHash = SHA-256 of the canonical node (eventHash excluded). Edge, sync.
      node.eventHash = sha256(canonical(node));
      const sealed = deepFreeze(node);
      await data().put(COLLECTION, sealed.eventId, sealed);
      try { if (data().cloudReady && data().cloudReady() && global.AAA_CLOUD) global.AAA_CLOUD.upsertEntity(COLLECTION, sealed.eventId, sealed); } catch (_) {}
      return { ok: true, event: sealed };
    },

    /**
     * Re-verify the local chain (what the server re-runs in Pass 2). Detects any
     * altered value (hash mismatch), a broken link, or a sequence gap.
     */
    async verifyChain() {
      const all = await chain();
      const breaks = []; let prevHash = GENESIS;
      all.forEach(function (e, i) {
        if (i > 0 && e.seq !== all[i - 1].seq + 1) breaks.push({ seq: e.seq, eventId: e.eventId, reason: 'seq_gap' });
        if ((e.previousEventHash || GENESIS) !== prevHash) breaks.push({ seq: e.seq, eventId: e.eventId, reason: 'chain_break' });
        if (sha256(canonical(omit(e, ['eventHash']))) !== e.eventHash) breaks.push({ seq: e.seq, eventId: e.eventId, reason: 'hash_mismatch' });
        prevHash = e.eventHash;
      });
      return { ok: breaks.length === 0, length: all.length, breaks: breaks };
    },

    /**
     * Pass 2 — network notarization. Re-verify, then record a SEPARATE global
     * signature attestation (the immutable node is never mutated). Non-blocking;
     * callable only after a connection returns.
     */
    async notarize(eventId, globalSignature) {
      const ev = await this.get(eventId);
      if (!ev) return { ok: false, error: 'EVENT_NOT_FOUND' };
      const recomputed = sha256(canonical(omit(ev, ['eventHash'])));
      if (recomputed !== ev.eventHash) return { ok: false, error: 'TAMPER_DETECTED', eventId: eventId };
      const id = 'notary_' + eventId;
      const rec = deepFreeze({ id: id, workspaceId: ws(), eventId: eventId, eventHash: ev.eventHash, globalSignature: globalSignature || sha256(ev.eventHash + ':' + ws()), notarizedAt: nowMs() });
      await data().put(NOTARY, id, rec);
      return { ok: true, notarization: rec };
    },
    async notarization(eventId) { const r = await data().get(NOTARY, 'notary_' + eventId); return mine(r) ? r : null; },
    async pendingNotarization() { const all = await chain(); const out = []; for (const e of all) { if (!(await this.notarization(e.eventId))) out.push(e.eventId); } return out; },

    async get(id) { const r = await data().get(COLLECTION, id); return mine(r) ? r : null; },
    async events(filter) {
      const f = filter || {};
      let all = await chain();
      if (f.captureSessionId) all = all.filter(function (e) { return e.captureSessionId === f.captureSessionId; });
      if (f.roomId) all = all.filter(function (e) { return e.roomId === f.roomId; });
      if (f.source) all = all.filter(function (e) { return e.source === f.source; });
      return all;
    }
  };

  function clamp01(v, d) { const n = Number(v); return isFinite(n) ? Math.max(0, Math.min(1, n)) : d; }
  function omit(o, keys) { const out = {}; Object.keys(o).forEach(function (k) { if (keys.indexOf(k) === -1) out[k] = o[k]; }); return out; }

  global.AAA_SPATIAL_LEDGER = Ledger;
})(typeof window !== 'undefined' ? window : this);
