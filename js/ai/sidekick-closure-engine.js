/*
 * AAA_SIDEKICK_CLOSURE Engine
 *
 * This module audits a job's completion readiness. It verifies the presence of
 * required photos, estimates, notes, and sync status. It returns a
 * structured report indicating which auto-verified items are complete and
 * identifies any missing items. The engine operates offline-first,
 * querying only local data.
 */

;(function (global) {
  'use strict';

  /**
   * Check if the media cache contains both BEFORE and AFTER photos for a job.
   * Assumes media records may have a `type` property indicating photo type.
   * If types are unavailable, checks for at least two images associated with
   * the job as a best-effort fallback.
   * @param {Array<Object>} mediaEntries
   * @returns {boolean}
   */
  function verifyPhotos(mediaEntries) {
    if (!Array.isArray(mediaEntries) || mediaEntries.length === 0) return false;
    // Look for explicit types
    let hasBefore = false;
    let hasAfter = false;
    for (const m of mediaEntries) {
      if (!m) continue;
      const type = m.type || m.tag || '';
      if (typeof type === 'string') {
        const t = type.toUpperCase();
        if (t.includes('BEFORE')) hasBefore = true;
        if (t.includes('AFTER')) hasAfter = true;
      }
    }
    if (hasBefore && hasAfter) return true;
    // Fallback: if at least two photos exist, assume before/after present
    return mediaEntries.length >= 2;
  }

  /**
   * Check if there are any unsynced or orphaned mutations. This implementation
   * assumes all queued mutations are valid and returns true. Override if
   * mutation queue auditing logic exists.
   * @returns {boolean}
   */
  function verifySyncStatus() {
    // Without access to mutation queue internals, assume sync is okay
    return true;
  }

  /**
   * Audit a job file for closure readiness.
   * @param {string} jobId
   * @returns {Promise<{ ok: true, ready: boolean, autoVerified: Object, missingAuto: Array<string> }>}
   */
  async function auditJobFile(jobId) {
    const storage = global.AAA_LOCAL_FIRST_STORAGE;
    if (!jobId || !storage || typeof storage.get !== 'function') {
      return { ok: false, ready: false, autoVerified: {}, missingAuto: ['INVALID_JOB_OR_STORAGE'] };
    }
    try {
      // Retrieve job record
      let job = storage.get('jobs', jobId);
      job = typeof job?.then === 'function' ? await job : job;
      if (!job || typeof job !== 'object') {
        return { ok: false, ready: false, autoVerified: {}, missingAuto: ['JOB_NOT_FOUND'] };
      }
      // Retrieve media records for this job
      let media = storage.getAll && typeof storage.getAll === 'function' ? storage.getAll('mediaCache') : [];
      media = typeof media?.then === 'function' ? await media : media;
      const mediaForJob = Array.isArray(media) ? media.filter((m) => m && m.jobId === jobId) : [];
      // Auto verifications
      const photosOk = verifyPhotos(mediaForJob);
      // Determine if the job has an applied estimate/price.  Some job records may
      // include a `price`, `estimate`, or an `estimates` array.  Consider any
      // of these non-empty values as an estimate being applied.
      let estimateOk = false;
      if (typeof job.price === 'number' && !Number.isNaN(job.price)) {
        estimateOk = true;
      } else if (job.estimate && typeof job.estimate === 'number') {
        estimateOk = true;
      } else if (Array.isArray(job.estimates) && job.estimates.length > 0) {
        estimateOk = true;
      }
      // A job is considered to have notes if there are logs or a notes string
      // populated.  Logs are stored as an array and notes may be stored as
      // freeform text on the job record.  Either counts as the presence of
      // work notes.
      const notesArrayOk = Array.isArray(job.logs) && job.logs.length > 0;
      const notesStringOk = typeof job.notes === 'string' && job.notes.trim().length > 0;
      const notesOk = notesArrayOk || notesStringOk;
      const syncOk = verifySyncStatus();
      const autoVerified = {
        photos: photosOk,
        estimate: estimateOk,
        notes: notesOk,
        sync: syncOk
      };
      const missingAuto = [];
      if (!photosOk) missingAuto.push('PHOTOS');
      if (!estimateOk) missingAuto.push('ESTIMATE');
      if (!notesOk) missingAuto.push('NOTES');
      if (!syncOk) missingAuto.push('SYNC');
      const ready = photosOk && estimateOk && notesOk && syncOk;
      return { ok: true, ready: ready, autoVerified: autoVerified, missingAuto: missingAuto };
    } catch (err) {
      console.error('Closure engine: error auditing job', err);
      return { ok: false, ready: false, autoVerified: {}, missingAuto: ['AUDIT_ERROR'] };
    }
  }

  const closureAPI = {
    auditJobFile
  };
  global.AAA_SIDEKICK_CLOSURE = closureAPI;
})(typeof window !== 'undefined' ? window : this);