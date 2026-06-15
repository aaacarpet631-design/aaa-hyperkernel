/*
 * AAA Telemetry Seal — cryptographic, tamper-evident proof of field execution.
 *
 * When a job's completion photo is captured, this binds it to the record with a
 * SHA-256 hash, the geolocation, and the timestamp, then appends a
 * TelemetryCaptured event to the append-only, hash-CHAINED audit ledger. The
 * result is the defensible artifact: for every ticket, proof of WHAT was
 * captured, WHERE, and WHEN — and that the image has not been altered since.
 *
 * Honest scope — read this before extending:
 *  - This proves CAPTURE INTEGRITY, not installation QUALITY. It does NOT judge
 *    whether a seam is invisible or the pile aligns — that "edge-vision
 *    inspector" needs a trained on-device model (CoreML/TFLite) in a native
 *    React Native build; a PWA cannot run it and this module will NOT fake a
 *    pass/fail verdict. seal() records evidence; it does not gate job completion
 *    on a quality judgment it didn't make.
 *  - The hash is honest about its algorithm (alg field). Without the audit
 *    ledger's SHA-256, it refuses to seal rather than label a weak hash as
 *    SHA-256.
 *  - Local-first; no image egress. Deterministic; never throws into the UI.
 */
;(function (global) {
  'use strict';

  function audit() { return global.AAA_AUDIT_LEDGER; }
  function vm() { return global.AAA_VISUAL_MEMORY; }
  function clock() { return global.AAA_RUNTIME_CLOCK; }
  function nowISO() { return clock() && clock().nowISO ? clock().nowISO() : new Date().toISOString(); }
  function num(v) { const n = Number(v); return isFinite(n) ? n : null; }

  function sealGeo(g) {
    if (!g) return null;
    const lat = num(g.lat != null ? g.lat : g.latitude);
    const lng = num(g.lng != null ? g.lng : g.longitude);
    if (lat == null || lng == null) return null;
    return { lat: lat, lng: lng, accuracy: num(g.accuracy) };
  }

  const Seal = {
    /**
     * Seal a captured image into the tamper-evident ledger. Provide the image
     * content (imageBase64) to be hashed, or a precomputed imageHash.
     * @returns {Promise<{ok:true, seal:{imageHash,alg,geo,capturedAt,auditId,ledgerSha}} | {ok:false,error}>}
     */
    async seal(input) {
      const i = input || {};
      if (!i.jobId) return { ok: false, error: 'NO_JOB' };
      const led = audit();
      if (!led || !led.append || !led.sha256) return { ok: false, error: 'NO_AUDIT_LEDGER' };
      const imageHash = i.imageHash || (i.imageBase64 != null ? led.sha256(String(i.imageBase64)) : null);
      if (!imageHash) return { ok: false, error: 'NO_IMAGE' };

      const capturedAt = i.capturedAt || nowISO();
      const geo = sealGeo(i.geo);
      const payload = {
        jobId: String(i.jobId),
        visualMemoryId: i.visualMemoryId != null ? String(i.visualMemoryId) : null,
        imageRef: i.imageRef != null ? String(i.imageRef) : null,
        imageHash: imageHash,
        alg: 'SHA-256',
        geo: geo,
        capturedAt: capturedAt
      };
      let rec;
      try { rec = await led.append('TelemetryCaptured', payload); } catch (_) { return { ok: false, error: 'SEAL_FAILED' }; }
      return { ok: true, seal: { imageHash: imageHash, alg: 'SHA-256', geo: geo, capturedAt: capturedAt, auditId: rec.id, ledgerSha: rec.sha } };
    },

    /**
     * Recompute the hash of an image and confirm it matches a sealed hash — the
     * "mathematically enforced" tamper check. Any byte change → match:false.
     */
    verifyImage(imageBase64, expectedHash) {
      const led = audit();
      if (!led || !led.sha256) return { ok: false, error: 'NO_AUDIT_LEDGER' };
      if (imageBase64 == null || !expectedHash) return { ok: false, error: 'MISSING_INPUT' };
      const actual = led.sha256(String(imageBase64));
      return { ok: true, match: actual === expectedHash, actualHash: actual };
    },

    /** Every telemetry seal recorded for a job (from the chained ledger). */
    async forJob(jobId) {
      const led = audit();
      if (!led || !led.chain) return [];
      let chain = [];
      try { chain = (await led.chain()) || []; } catch (_) { chain = []; }
      return chain.filter(function (e) { return e.type === 'TelemetryCaptured' && e.payload && String(e.payload.jobId) === String(jobId); });
    },

    /**
     * Best-effort device geolocation (permission-gated). Honest null when the
     * platform has no geolocation, permission is denied, or it times out — never
     * a fabricated coordinate.
     */
    async currentGeo(opts) {
      const o = opts || {};
      const nav = global.navigator;
      if (!nav || !nav.geolocation || !nav.geolocation.getCurrentPosition) return null;
      return new Promise(function (resolve) {
        let done = false;
        const finish = function (v) { if (!done) { done = true; resolve(v); } };
        try {
          nav.geolocation.getCurrentPosition(
            function (pos) { finish(pos && pos.coords ? { lat: pos.coords.latitude, lng: pos.coords.longitude, accuracy: pos.coords.accuracy } : null); },
            function () { finish(null); },
            { enableHighAccuracy: o.highAccuracy !== false, timeout: o.timeout || 8000, maximumAge: 0 }
          );
        } catch (_) { finish(null); }
      });
    }
  };

  global.AAA_TELEMETRY_SEAL = Seal;
})(typeof window !== 'undefined' ? window : this);
