/*
 * AAA_SIDEKICK_VOICE Engine
 *
 * This module provides a hands‑free voice logging capability for the HyperKernel.
 * It leverages the Web Speech API (SpeechRecognition/ webkitSpeechRecognition) to
 * transcribe spoken notes without requiring network connectivity. Transcribed
 * notes are saved to the local job record in AAA_LOCAL_FIRST_STORAGE and a
 * mutation is queued for later synchronization. This engine respects
 * local‑first architecture and does not perform any network I/O.
 */

;(function (global) {
  'use strict';

  // Determine the appropriate SpeechRecognition constructor. Some browsers expose
  // it via webkitSpeechRecognition. If neither is available, voice logging is
  // unsupported on this device.
  const SpeechRecognition = global.SpeechRecognition || global.webkitSpeechRecognition || null;

  /**
   * Internal helper to save a note to the specified job and queue a mutation.
   * Uses the local-first storage API to fetch the specific job (not all jobs),
   * append a log entry and persist the updated job. Mutations follow the
   * prescribed schema: { mutationId, entityId, entityType, operation, payload,
   * timestamp, syncStatus }.
   *
   * @param {string} jobId
   * @param {string} text
   */
  async function saveTranscript(jobId, text) {
    const storage = global.AAA_LOCAL_FIRST_STORAGE;
    const idFactory = global.AAA_ID_FACTORY;
    const clock = global.AAA_RUNTIME_CLOCK;
    if (!storage || typeof storage.get !== 'function') {
      // If get() is unavailable, gracefully fallback to getAll() but avoid crash
      console.warn('Voice engine: storage.get not available');
      return;
    }
    try {
      // Fetch the specific job record
      let job = storage.get('jobs', jobId);
      job = typeof job?.then === 'function' ? await job : job;
      if (!job || typeof job !== 'object') {
        return;
      }
      // Build the log entry
      const logEntry = {
        logId:
          idFactory && typeof idFactory.newId === 'function'
            ? idFactory.newId()
            : Date.now().toString(),
        timestamp:
          clock && typeof clock.now === 'function' ? clock.now() : Date.now(),
        text: String(text || ''),
        type: 'VOICE_LOG'
      };
      // Produce updated job with appended log array
      const updatedJob = Object.assign({}, job, {
        logs: Array.isArray(job.logs) ? job.logs.concat(logEntry) : [logEntry]
      });
      // Persist the job locally if put() is available
      if (typeof storage.put === 'function') {
        await storage.put('jobs', jobId, updatedJob);
      }
      // Queue a structured mutation for later sync
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
          operation: 'APPEND_LOG',
          payload: logEntry,
          timestamp: timestampISO,
          syncStatus: 'PENDING'
        };
        storage.queueMutation(mutation);
      }
    } catch (e) {
      console.error('Voice engine: failed to save transcript', e);
    }
  }

  /**
   * Begin listening for a voice note. When transcription completes, the result
   * is saved to the specified job. This function returns a promise that
   * resolves with an object indicating success or failure. It does not
   * interact with the DOM directly; UI code should call this method and
   * update the interface based on the returned result.
   *
   * @param {string} jobId - The ID of the job to which the log should be saved.
   * @returns {Promise<{ ok: true, text: string } | { ok: false, error: string }>}
   */
  function startListening(jobId) {
    return new Promise((resolve) => {
      // Ensure we have a job ID
      if (!jobId) {
        resolve({ ok: false, error: 'NO_ACTIVE_JOB' });
        return;
      }
      // Verify SpeechRecognition support
      if (!SpeechRecognition) {
        resolve({ ok: false, error: 'SPEECH_RECOGNITION_UNSUPPORTED' });
        return;
      }
      // Instantiate recognition
      const recognition = new SpeechRecognition();
      recognition.lang = 'en-US';
      recognition.interimResults = false;
      recognition.continuous = false;
      let handled = false;
      // When results are available, capture the transcript and save
      recognition.onresult = async (event) => {
        if (handled) return;
        handled = true;
        try {
          const transcript = event.results[0][0].transcript.trim();
          await saveTranscript(jobId, transcript);
          resolve({ ok: true, text: transcript });
        } catch (err) {
          resolve({ ok: false, error: 'TRANSCRIPT_SAVE_ERROR' });
        }
      };
      // On error, return an error object
      recognition.onerror = (event) => {
        if (handled) return;
        handled = true;
        const err = event && event.error ? event.error : 'SPEECH_RECOGNITION_ERROR';
        resolve({ ok: false, error: err });
      };
      // If recognition ends without results, treat it as cancelled
      recognition.onend = () => {
        if (!handled) {
          handled = true;
          resolve({ ok: false, error: 'NO_SPEECH_DETECTED' });
        }
      };
      try {
        recognition.start();
      } catch (err) {
        // Some browsers may throw if start is called illegally
        resolve({ ok: false, error: 'SPEECH_RECOGNITION_START_FAILED' });
      }
    });
  }

  // Expose the voice API
  async function saveTextLog(jobId, text) {
    if (!jobId) {
      return { ok: false, error: 'NO_ACTIVE_JOB' };
    }
    const note = String(text || '').trim();
    if (!note) {
      return { ok: false, error: 'EMPTY_NOTE' };
    }
    try {
      await saveTranscript(jobId, note);
      return { ok: true };
    } catch (err) {
      console.error('Voice engine: failed to save manual note', err);
      return { ok: false, error: 'SAVE_NOTE_ERROR' };
    }
  }

  // Expose the voice API
  const voiceAPI = {
    startListening,
    saveTextLog
  };

  // Attach to the global namespace
  global.AAA_SIDEKICK_VOICE = voiceAPI;
})(typeof window !== 'undefined' ? window : this);