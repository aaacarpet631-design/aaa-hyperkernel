/*
 * AAA_SIDEKICK_VISION Engine
 *
 * This module provides vision-assisted estimating for the HyperKernel. It
 * captures images, stores them locally, and decides whether to run an
 * immediate analysis or defer processing until network connectivity is
 * available. The engine adheres to local-first principles: images are
 * always stored locally first, and no network call is attempted when
 * offline.
 */

;(function (global) {
  'use strict';

  /**
   * Convert a File/Blob into a Base64-encoded string.
   * @param {Blob} file
   * @returns {Promise<string>}
   */
  function fileToBase64(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onloadend = () => {
        // reader.result is a Data URL (e.g. data:image/png;base64,...)
        const result = reader.result;
        if (typeof result === 'string') {
          // Extract Base64 portion after comma
          const base64 = result.split(',')[1] || '';
          resolve(base64);
        } else {
          reject(new Error('Failed to convert file to base64'));
        }
      };
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(file);
    });
  }

  // Endpoint of the Claude-backed vision function (overridable via AAA_CONFIG).
  function visionEndpoint() {
    return (global.AAA_CONFIG && global.AAA_CONFIG.visionEndpoint) || '/api/vision';
  }

  /**
   * Send the image to the serverless vision function, which runs Claude vision
   * and returns a structured estimate. Falls back to a conservative local
   * estimate if the backend is unreachable or errors, so the tech is never
   * left without something to act on.
   * @param {string} base64Image
   * @param {string} mediaType - e.g. "image/jpeg"
   * @returns {Promise<Object>} { type, severity?, estimatedTimeMins, materials, summary? }
   */
  async function analyzeCarpetDamage(base64Image, mediaType) {
    try {
      const res = await fetch(visionEndpoint(), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ image: base64Image, mediaType: mediaType || 'image/jpeg' })
      });
      if (res.ok) {
        const data = await res.json();
        if (data && data.ok && data.analysis) {
          return data.analysis;
        }
      }
      console.warn('Vision endpoint returned an error status', res.status);
    } catch (err) {
      console.warn('Vision endpoint unreachable, using local fallback', err);
    }
    // Fallback estimate (offline or backend unavailable).
    return {
      type: 'GENERAL_INSPECTION',
      severity: 'MEDIUM',
      confidence: null,
      estimatedTimeMins: 45,
      estimatedQuoteRange: null,
      materials: ['Seam Tape'],
      recommendedNextStep: 'Confirm details on site, then enter the estimate manually.',
      summary: 'Backend unavailable — enter details manually or retry on a connection.'
    };
  }

  /**
   * Capture an image file and perform an AI analysis when online. The image
   * is always saved locally first. When offline, a mutation is queued to
   * request analysis later.
   *
   * @param {string} jobId - The ID of the job context.
   * @param {File|Blob} imageFile - The captured image.
   * @returns {Promise<{ ok: true, analysis: Object, mediaId: string } | { ok: false, status: string, mediaId: string }>}
   */
  async function captureAndAnalyze(jobId, imageFile) {
    const storage = global.AAA_LOCAL_FIRST_STORAGE;
    const idFactory = global.AAA_ID_FACTORY;
    const clock = global.AAA_RUNTIME_CLOCK;
    if (!jobId || !imageFile) {
      return { ok: false, error: 'INVALID_INPUT' };
    }
    if (!storage || typeof storage.put !== 'function') {
      return { ok: false, error: 'STORAGE_UNAVAILABLE' };
    }
    try {
      // Convert image to Base64
      const base64 = await fileToBase64(imageFile);
      // Generate a media ID
      const mediaId =
        idFactory && typeof idFactory.createId === 'function'
          ? idFactory.createId('media', [])
          : idFactory && typeof idFactory.newId === 'function'
          ? idFactory.newId()
          : Date.now().toString();
      // Prepare media record
      const createdAt =
        clock && typeof clock.now === 'function' ? clock.now() : Date.now();
      const mediaRecord = {
        mediaId: mediaId,
        jobId: jobId,
        data: base64,
        createdAt: createdAt
      };
      // Save to mediaCache in local storage
      await storage.put('mediaCache', mediaId, mediaRecord);
      // Check connectivity
      if (typeof navigator !== 'undefined' && navigator.onLine) {
        // Online: perform analysis immediately
        const analysis = await analyzeCarpetDamage(base64, imageFile.type);
        // Record this capture as structured visual evidence (moat layer). Maps
        // ONLY real analysis fields — never invents — and is fully guarded so a
        // missing/erroring memory store can't break capture. Local-first; no
        // image egress happens here.
        if (global.AAA_VISUAL_MEMORY && global.AAA_VISUAL_MEMORY.record) {
          try {
            const qr = analysis && analysis.estimatedQuoteRange;
            const lo = Array.isArray(qr) ? qr[0] : (qr && qr.low != null ? qr.low : null);
            const hi = Array.isArray(qr) ? qr[1] : (qr && qr.high != null ? qr.high : null);
            await global.AAA_VISUAL_MEMORY.record({
              jobId: jobId, imageRef: mediaId, source: 'vision',
              analysis: {
                category: analysis && analysis.type != null ? analysis.type : null,
                recommendation: analysis && (analysis.recommendedNextStep || analysis.summary) || null,
                confidenceScore: analysis && analysis.confidence != null ? analysis.confidence : null,
                estimateLowUSD: lo, estimateHighUSD: hi
              },
              tags: analysis && Array.isArray(analysis.materials) ? analysis.materials : []
            });
          } catch (_) { /* visual memory is best-effort; capture must not fail on it */ }
        }
        return { ok: true, analysis: analysis, mediaId: mediaId };
      } else {
        // Offline: queue mutation for later analysis
        if (
          typeof storage.queueMutation === 'function' &&
          idFactory &&
          ((typeof idFactory.createId === 'function') || (typeof idFactory.newId === 'function'))
        ) {
          const mutationId =
            idFactory && typeof idFactory.createId === 'function'
              ? idFactory.createId('mut', [])
              : idFactory.newId();
          const timestampISO =
            clock && typeof clock.nowISO === 'function'
              ? clock.nowISO()
              : new Date().toISOString();
          const mutation = {
            mutationId: mutationId,
            entityId: jobId,
            entityType: 'job',
            operation: 'ANALYZE_MEDIA',
            payload: { mediaId: mediaId },
            timestamp: timestampISO,
            syncStatus: 'PENDING'
          };
          storage.queueMutation(mutation);
        }
        return { ok: false, status: 'QUEUED_FOR_NETWORK', mediaId: mediaId };
      }
    } catch (err) {
      console.error('Vision engine: error in capture and analyze', err);
      return { ok: false, error: 'CAPTURE_ANALYZE_ERROR' };
    }
  }

  // Expose the vision API
  const visionAPI = {
    captureAndAnalyze
  };

  // Attach to global namespace
  global.AAA_SIDEKICK_VISION = visionAPI;
})(typeof window !== 'undefined' ? window : this);