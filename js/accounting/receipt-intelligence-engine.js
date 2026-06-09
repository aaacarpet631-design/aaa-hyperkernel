/*
 * AAA Receipt Intelligence Engine — the capture front-door for the Receipt
 * Intelligence Agent (agent #1 in the division spec).
 *
 * Local-first, exactly like the vision estimating engine:
 *   1. The image/PDF is converted to base64 and stored LOCALLY first (so a
 *      receipt is never lost on a flaky job-site connection).
 *   2. Best-effort: upload a durable copy to the receipt blob store.
 *   3. Online → call /api/receipt-ocr (Claude), then hand the structured OCR to
 *      AAA_RECEIPT_INTAKE.ingest() which classifies + files it for review.
 *      Offline → queue an OCR_RECEIPT mutation to run on reconnect.
 *
 * It never posts an expense; it only gets a receipt INTO the review queue.
 * Returns a result object (never throws into the UI).
 */
;(function (global) {
  'use strict';

  function ocrEndpoint() { return (global.AAA_CONFIG && global.AAA_CONFIG.receiptOcrEndpoint) || '/api/receipt-ocr'; }
  function blobEndpoint() { return (global.AAA_CONFIG && global.AAA_CONFIG.receiptBlobEndpoint) || '/api/receipt-blob'; }
  function storage() { return global.AAA_LOCAL_FIRST_STORAGE; }
  function intake() { return global.AAA_RECEIPT_INTAKE; }
  function idFactory() { return global.AAA_ID_FACTORY; }
  function clock() { return global.AAA_RUNTIME_CLOCK; }

  function fileToBase64(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onloadend = () => {
        const result = reader.result;
        if (typeof result === 'string') resolve(result.split(',')[1] || '');
        else reject(new Error('Failed to convert file to base64'));
      };
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(file);
    });
  }

  function newId(prefix) {
    const f = idFactory();
    if (f && typeof f.createId === 'function') return f.createId(prefix, []);
    if (f && typeof f.newId === 'function') return f.newId();
    return prefix + '_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);
  }
  function nowISO() { return clock() && clock().nowISO ? clock().nowISO() : new Date().toISOString(); }
  function online() { return typeof navigator === 'undefined' || navigator.onLine; }

  /** Run Claude OCR on a base64 receipt. Returns the structured OCR or null. */
  async function runOcr(base64, mediaType) {
    try {
      const res = await fetch(ocrEndpoint(), {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ image: base64, mediaType: mediaType || 'image/jpeg' })
      });
      if (res.ok) {
        const data = await res.json();
        if (data && data.ok && data.ocr) return data.ocr;
      }
      console.warn('Receipt OCR returned an error status', res.status);
    } catch (err) {
      console.warn('Receipt OCR unreachable', err);
    }
    return null;
  }

  /** Best-effort durable upload. Failure is non-fatal (we still have it local). */
  async function uploadBlob(mediaId, base64, mediaType) {
    try {
      const res = await fetch(blobEndpoint(), {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ key: mediaId, data: base64, mediaType: mediaType || 'image/jpeg' })
      });
      if (res.ok) { const j = await res.json(); if (j && j.ok) return j.key || mediaId; }
    } catch (_) {}
    return null;
  }

  const Engine = {
    /**
     * Capture a receipt file and get it into the review queue.
     * @param {File|Blob} file
     * @returns {Promise<{ok:true, receipt} | {ok:true, status:'QUEUED_FOR_NETWORK', mediaId} | {ok:false, error}>}
     */
    async captureReceipt(file) {
      if (!file) return { ok: false, error: 'INVALID_INPUT' };
      if (!storage() || typeof storage().put !== 'function') return { ok: false, error: 'STORAGE_UNAVAILABLE' };
      if (!intake()) return { ok: false, error: 'INTAKE_UNAVAILABLE' };
      try {
        const base64 = await fileToBase64(file);
        const mediaId = newId('rmedia');
        const mediaType = file.type || 'image/jpeg';
        await storage().put('receiptMedia', mediaId, { mediaId: mediaId, data: base64, mediaType: mediaType, createdAt: nowISO() });

        if (!online()) {
          // Defer OCR until we have a connection.
          if (typeof storage().queueMutation === 'function') {
            await storage().queueMutation({
              mutationId: newId('mut'), entityType: 'receipt', operation: 'OCR_RECEIPT',
              payload: { mediaId: mediaId, mediaType: mediaType }, timestamp: nowISO(), syncStatus: 'PENDING'
            });
          }
          return { ok: false, status: 'QUEUED_FOR_NETWORK', mediaId: mediaId };
        }

        const blobKey = await uploadBlob(mediaId, base64, mediaType);
        const ocr = await runOcr(base64, mediaType);
        if (!ocr) {
          // Online but OCR failed — still file a blank record so the receipt
          // isn't lost; it lands in needs_review for manual entry.
          const rec = await intake().ingest({ mediaId: mediaId, blobKey: blobKey, ocr: { vendor: '', total: null, confidence: 0, quality: 'partial' } });
          return { ok: true, receipt: rec, ocrFailed: true };
        }
        const rec = await intake().ingest({ mediaId: mediaId, blobKey: blobKey, ocr: ocr });
        return { ok: true, receipt: rec };
      } catch (err) {
        console.error('Receipt capture error', err);
        return { ok: false, error: 'CAPTURE_ERROR', message: String((err && err.message) || err) };
      }
    },

    /** Drain queued OCR mutations after reconnect (called by the sync engine). */
    async processQueued() {
      const s = storage();
      if (!s || typeof s.getMutations !== 'function' || !online()) return { ok: false, processed: 0 };
      const muts = (await s.getMutations()) || [];
      let processed = 0;
      const remaining = [];
      for (const m of muts) {
        if (m && m.operation === 'OCR_RECEIPT' && m.syncStatus === 'PENDING') {
          const media = await s.get('receiptMedia', m.payload.mediaId);
          if (media && media.data) {
            const blobKey = await uploadBlob(media.mediaId, media.data, media.mediaType);
            const ocr = await runOcr(media.data, media.mediaType);
            await intake().ingest({ mediaId: media.mediaId, blobKey: blobKey, ocr: ocr || { vendor: '', total: null, confidence: 0, quality: 'partial' } });
            processed++;
            continue; // drop the mutation (handled)
          }
        }
        remaining.push(m);
      }
      if (typeof s.setMutations === 'function') await s.setMutations(remaining);
      return { ok: true, processed: processed };
    }
  };

  global.AAA_RECEIPT_INTELLIGENCE = Engine;
})(typeof window !== 'undefined' ? window : this);
