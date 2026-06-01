/*
 * AAA Voice Note Store — persistence for voice/audio/manual job notes.
 *
 * Every note (however captured) is saved as a first-class `voice_notes` record
 * with the required schema, AND mirrored as a VOICE_LOG entry on the job's own
 * `logs` array so existing job views keep showing notes (backward compatible).
 * Local-first is the source of truth; the cloud mirror is best-effort.
 *
 * Schema (per spec):
 *   { id, jobId, source, transcript, rawAudioUrl, status, errorReason,
 *     createdAt, createdBy, confidence, intelligence }
 *   source: 'live_speech' | 'audio_recording' | 'manual'
 *   status: 'draft' | 'transcribed' | 'failed' | 'approved'
 *
 * Safety: this layer only writes notes. It NEVER changes job status, quotes,
 * invoices, or accounting — those remain human-approved actions elsewhere.
 */
;(function (global) {
  'use strict';

  function storage() { return global.AAA_LOCAL_FIRST_STORAGE; }
  function data() { return global.AAA_DATA; }
  function ids() { return global.AAA_ID_FACTORY; }
  function clock() { return global.AAA_RUNTIME_CLOCK; }
  function cfg() { return global.AAA_CONFIG || {}; }

  const SOURCES = ['live_speech', 'audio_recording', 'manual'];
  const STATUSES = ['draft', 'transcribed', 'failed', 'approved'];

  function newId(p) { return ids() ? ids().createId(p) : (p + '_' + Date.now()); }
  function now() { return clock() ? clock().now() : Date.now(); }
  function nowISO() { return clock() && clock().nowISO ? clock().nowISO() : new Date().toISOString(); }

  function currentUser() {
    try {
      if (global.AAA_CLOUD && global.AAA_CLOUD.currentUser) {
        const u = global.AAA_CLOUD.currentUser();
        if (u && (u.email || u.uid)) return u.email || u.uid;
      }
    } catch (_) {}
    return cfg().deviceRole ? ('device:' + cfg().deviceRole) : 'field';
  }

  // Append a VOICE_LOG to the job so existing job views render the note, and
  // queue a sync mutation in the established shape. Best-effort, never throws.
  async function appendJobLog(jobId, note) {
    const s = storage();
    if (!s || typeof s.get !== 'function' || typeof s.put !== 'function') return;
    try {
      let job = s.get('jobs', jobId);
      job = (job && typeof job.then === 'function') ? await job : job;
      if (!job || typeof job !== 'object') return;
      const logEntry = {
        logId: newId('log'),
        timestamp: now(),
        text: String(note.transcript || ''),
        type: 'VOICE_LOG',
        source: note.source,
        voiceNoteId: note.id
      };
      const updated = Object.assign({}, job, {
        logs: Array.isArray(job.logs) ? job.logs.concat(logEntry) : [logEntry]
      });
      await s.put('jobs', jobId, updated);
      if (typeof s.queueMutation === 'function') {
        s.queueMutation({
          mutationId: newId('mut'), entityId: jobId, entityType: 'job',
          operation: 'APPEND_LOG', payload: logEntry, timestamp: nowISO(), syncStatus: 'PENDING'
        });
      }
    } catch (e) {
      try { console.error('voice-note-store: appendJobLog failed', e); } catch (_) {}
    }
  }

  const Store = {
    SOURCES: SOURCES,
    STATUSES: STATUSES,

    /**
     * Create and persist a voice note. Returns the stored record.
     * @param {object} input { jobId, source, transcript?, rawAudioUrl?, status?,
     *                          errorReason?, confidence? }
     */
    async create(input) {
      input = input || {};
      if (!input.jobId) return { ok: false, error: 'NO_ACTIVE_JOB' };
      const source = SOURCES.indexOf(input.source) !== -1 ? input.source : 'manual';
      const status = STATUSES.indexOf(input.status) !== -1 ? input.status
        : (input.errorReason ? 'failed' : (input.transcript ? 'transcribed' : 'draft'));

      const note = {
        id: newId('vnote'),
        jobId: input.jobId,
        source: source,
        transcript: String(input.transcript || ''),
        rawAudioUrl: input.rawAudioUrl || '',
        status: status,
        errorReason: input.errorReason || '',
        createdAt: nowISO(),
        createdBy: input.createdBy || currentUser(),
        confidence: typeof input.confidence === 'number' ? input.confidence : 0,
        intelligence: null // filled by the Job Notes Agent (review-only suggestions)
      };

      try { if (data() && data().put) await data().put('voice_notes', note.id, note); } catch (_) {}
      try {
        if (data() && data().cloudReady && data().cloudReady() && global.AAA_CLOUD) {
          await global.AAA_CLOUD.upsertEntity('voice_notes', note.id, note);
        }
      } catch (_) {}

      // Mirror into the job log only when there's actual text to show.
      if (note.transcript) await appendJobLog(note.jobId, note);

      return { ok: true, note: note };
    },

    /** Patch an existing note (e.g. attach a transcript or intelligence). */
    async update(id, patch) {
      if (!data() || !data().get) return { ok: false, error: 'NO_DATA_LAYER' };
      const existing = await data().get('voice_notes', id);
      if (!existing) return { ok: false, error: 'NOT_FOUND' };
      const merged = Object.assign({}, existing, patch || {});
      try { await data().put('voice_notes', id, merged); } catch (_) {}
      try {
        if (data().cloudReady && data().cloudReady() && global.AAA_CLOUD) {
          await global.AAA_CLOUD.upsertEntity('voice_notes', id, merged);
        }
      } catch (_) {}
      // If a transcript was just added and wasn't logged before, mirror it now.
      if (patch && patch.transcript && !existing.transcript) await appendJobLog(merged.jobId, merged);
      return { ok: true, note: merged };
    },

    async get(id) { return data() && data().get ? data().get('voice_notes', id) : null; },

    /** All notes for a job, newest first. */
    async listForJob(jobId) {
      if (!data() || !data().list) return [];
      const all = await data().list('voice_notes');
      return all
        .filter(function (n) { return n.jobId === jobId; })
        .sort(function (a, b) { return (b.createdAt || '').localeCompare(a.createdAt || ''); });
    }
  };

  global.AAA_VOICE_NOTES = Store;
})(typeof window !== 'undefined' ? window : this);
