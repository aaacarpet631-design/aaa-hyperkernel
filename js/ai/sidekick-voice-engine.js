/*
 * AAA_SIDEKICK_VOICE Engine — three-layer voice capture for field job notes.
 *
 *   Layer 1  Live voice recognition  (Web Speech API)        → startListening()
 *   Layer 2  Audio recording + transcription (MediaRecorder) → recorder()/transcribeAudio()
 *   Layer 3  Manual note                                     → saveTextLog()  (UI owns the textarea)
 *
 * Every layer saves through AAA_VOICE_NOTES with the full note schema (source,
 * status, confidence, errorReason, rawAudioUrl…) and attaches to the active job.
 * Every failure is classified by AAA_VOICE_DIAGNOSTICS into a real reason (denied
 * permission, insecure context, unsupported browser, offline, no-speech, timeout)
 * and logged — never silently collapsed into "no signal".
 *
 * Safety: this engine captures and saves notes only. AI extraction (review-only
 * suggestions) is handled by AAA_JOB_NOTES_AGENT and never auto-applied.
 */
;(function (global) {
  'use strict';

  function diag() { return global.AAA_VOICE_DIAGNOSTICS; }
  function notes() { return global.AAA_VOICE_NOTES; }
  function cfg() { return global.AAA_CONFIG || {}; }

  // Read the constructor live (never snapshot at load) so detection reflects the
  // current environment — and stays in lockstep with the diagnostics module.
  function getSpeechRecognition() {
    if (diag() && diag().getSpeechRecognition) return diag().getSpeechRecognition();
    return global.SpeechRecognition || global.webkitSpeechRecognition || null;
  }
  // No-speech safety valve so the mic never hangs open forever in the field.
  const LISTEN_TIMEOUT_MS = 12000;

  async function logErr(code, jobId, source, detail) {
    try { if (diag()) await diag().log(code, { jobId: jobId, source: source, detail: detail }); } catch (_) {}
  }

  // ---- Layer 1: live speech recognition ----------------------------------
  async function startListening(jobId, opts) {
    opts = opts || {};
    const D = diag();
    // Gate on the real reasons BEFORE touching the mic, so we report accurately
    // (each is logged with its true cause — never collapsed into "no signal").
    if (!jobId) { await logErr('NO_ACTIVE_JOB', null, 'live_speech'); return { ok: false, code: 'NO_ACTIVE_JOB', error: 'NO_ACTIVE_JOB' }; }
    if (D && !D.isSecureContext()) { await logErr('INSECURE_CONTEXT', jobId, 'live_speech'); return { ok: false, code: 'INSECURE_CONTEXT', error: 'INSECURE_CONTEXT' }; }
    if (D) {
      const perm = await D.permissionState();
      if (perm === 'denied') { await logErr('PERMISSION_DENIED', jobId, 'live_speech'); return { ok: false, code: 'PERMISSION_DENIED', error: 'PERMISSION_DENIED' }; }
    }
    return new Promise(function (resolve) {
      const SR = getSpeechRecognition();
      if (!SR) { logErr('UNSUPPORTED_BROWSER', jobId, 'live_speech'); resolve({ ok: false, code: 'UNSUPPORTED_BROWSER', error: 'UNSUPPORTED_BROWSER' }); return; }

      let recognition;
      try { recognition = new SR(); }
      catch (e) { logErr('UNSUPPORTED_BROWSER', jobId, 'live_speech', e && e.message); resolve({ ok: false, code: 'UNSUPPORTED_BROWSER', error: 'UNSUPPORTED_BROWSER' }); return; }

      recognition.lang = opts.lang || 'en-US';
      recognition.interimResults = false;
      recognition.continuous = false;
      recognition.maxAlternatives = 1;

      let handled = false;
      let timer = null;
      function finish(result) {
        if (handled) return; handled = true;
        if (timer) { clearTimeout(timer); timer = null; }
        try { recognition.stop(); } catch (_) {}
        resolve(result);
      }

      recognition.onresult = function (event) {
        if (handled) return;
        // Claim the result synchronously so a trailing onend can't pre-empt us,
        // then do the async save. We resolve only after the note is persisted.
        handled = true;
        if (timer) { clearTimeout(timer); timer = null; }
        try { recognition.stop(); } catch (_) {}
        (async function () {
          try {
            const res = event.results[0][0];
            const transcript = String(res.transcript || '').trim();
            const confidence = typeof res.confidence === 'number' ? Math.round(res.confidence * 100) : 0;
            if (!transcript) { await logErr('EMPTY_TRANSCRIPT', jobId, 'live_speech'); resolve({ ok: false, code: 'EMPTY_TRANSCRIPT', error: 'EMPTY_TRANSCRIPT' }); return; }
            const saved = notes() ? await notes().create({ jobId: jobId, source: 'live_speech', transcript: transcript, status: 'transcribed', confidence: confidence }) : { ok: true };
            resolve({ ok: true, text: transcript, transcript: transcript, confidence: confidence, noteId: saved.note && saved.note.id, source: 'live_speech' });
          } catch (err) {
            await logErr('TRANSCRIPTION_FAILED', jobId, 'live_speech', err && err.message);
            resolve({ ok: false, code: 'TRANSCRIPTION_FAILED', error: 'TRANSCRIPTION_FAILED' });
          }
        })();
      };
      // onerror must claim the result SYNCHRONOUSLY (before any await) so the
      // real error reason wins the race against the onend that follows it —
      // otherwise a 'network'/'not-allowed' error would be masked by the
      // generic "ended with no result" path. Logging is fire-and-forget.
      recognition.onerror = function (event) {
        if (handled) return;
        const raw = event && event.error;
        let code = D ? D.mapSpeechError(raw) : 'TRANSCRIPTION_FAILED';
        // Browser says "network" but we're actually online → it's a recognition-
        // service issue, not connectivity. Only call it offline when we truly are.
        if (code === 'NETWORK_OFFLINE' && D && D.isOnline()) code = 'TRANSCRIPTION_FAILED';
        logErr(code, jobId, 'live_speech', 'speech error: ' + raw);
        finish({ ok: false, code: code, error: code });
      };
      recognition.onend = function () {
        if (!handled) { logErr('EMPTY_TRANSCRIPT', jobId, 'live_speech', 'ended with no result'); finish({ ok: false, code: 'EMPTY_TRANSCRIPT', error: 'EMPTY_TRANSCRIPT' }); }
      };

      try {
        recognition.start();
        timer = setTimeout(function () {
          if (!handled) { logErr('TIMEOUT', jobId, 'live_speech'); finish({ ok: false, code: 'TIMEOUT', error: 'TIMEOUT' }); }
        }, opts.timeoutMs || LISTEN_TIMEOUT_MS);
      } catch (err) {
        logErr('RECORDING_FAILED', jobId, 'live_speech', err && err.message);
        finish({ ok: false, code: 'RECORDING_FAILED', error: 'RECORDING_FAILED' });
      }
    });
  }

  // ---- Layer 2: audio recording (MediaRecorder) --------------------------
  /**
   * Returns a controller for a single recording session:
   *   { ok, start(), stop()->Promise<{blob,mime,durationMs}>, cancel() }
   * or { ok:false, code } if recording can't start (logged).
   */
  async function recorder(jobId) {
    const D = diag();
    if (!jobId) { await logErr('NO_ACTIVE_JOB', null, 'audio_recording'); return { ok: false, code: 'NO_ACTIVE_JOB' }; }
    if (D && !D.isSecureContext()) { await logErr('INSECURE_CONTEXT', jobId, 'audio_recording'); return { ok: false, code: 'INSECURE_CONTEXT' }; }
    if (!D || !D.mediaRecorderSupported()) { await logErr('UNSUPPORTED_BROWSER', jobId, 'audio_recording'); return { ok: false, code: 'UNSUPPORTED_BROWSER' }; }

    let stream;
    try {
      stream = await global.navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (err) {
      const name = err && err.name;
      const code = (name === 'NotAllowedError' || name === 'SecurityError') ? 'PERMISSION_DENIED'
        : (name === 'NotFoundError' || name === 'DevicesNotFoundError') ? 'NO_MICROPHONE'
        : 'RECORDING_FAILED';
      await logErr(code, jobId, 'audio_recording', name || (err && err.message));
      return { ok: false, code: code };
    }

    let mr, chunks = [], startedAt = 0;
    const mime = (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported &&
      MediaRecorder.isTypeSupported('audio/webm')) ? 'audio/webm' : '';
    try { mr = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream); }
    catch (err) {
      stream.getTracks().forEach(function (t) { t.stop(); });
      await logErr('RECORDING_FAILED', jobId, 'audio_recording', err && err.message);
      return { ok: false, code: 'RECORDING_FAILED' };
    }
    mr.ondataavailable = function (e) { if (e.data && e.data.size) chunks.push(e.data); };
    function cleanup() { try { stream.getTracks().forEach(function (t) { t.stop(); }); } catch (_) {} }

    return {
      ok: true,
      start: function () { chunks = []; startedAt = Date.now(); mr.start(); },
      stop: function () {
        return new Promise(function (resolve) {
          mr.onstop = function () {
            cleanup();
            const blob = new Blob(chunks, { type: mr.mimeType || mime || 'audio/webm' });
            resolve({ blob: blob, mime: blob.type, durationMs: Date.now() - startedAt });
          };
          try { mr.stop(); } catch (e) { cleanup(); resolve({ blob: new Blob(chunks), mime: mime, durationMs: Date.now() - startedAt }); }
        });
      },
      cancel: function () { try { mr.stop(); } catch (_) {} cleanup(); }
    };
  }

  /**
   * Persist a recorded audio blob as a note, then attempt transcription via the
   * configured endpoint (cfg.transcriptionEndpoint, e.g. a Whisper proxy). Audio
   * is always saved first so nothing is lost even if transcription fails.
   * @returns saved/updated note result
   */
  async function saveRecording(jobId, blob, meta) {
    meta = meta || {};
    if (!jobId) { await logErr('NO_ACTIVE_JOB', null, 'audio_recording'); return { ok: false, code: 'NO_ACTIVE_JOB' }; }
    let rawAudioUrl = '';
    try { if (global.URL && global.URL.createObjectURL && blob) rawAudioUrl = global.URL.createObjectURL(blob); } catch (_) {}

    // Save the audio note as a draft first (durable even if transcription fails).
    const created = notes() ? await notes().create({
      jobId: jobId, source: 'audio_recording', rawAudioUrl: rawAudioUrl, status: 'draft'
    }) : { ok: true, note: { id: null } };
    const noteId = created.note && created.note.id;

    const t = await transcribeAudio(blob, jobId);
    if (!t.ok) {
      if (noteId && notes()) await notes().update(noteId, { status: 'failed', errorReason: t.code || 'TRANSCRIPTION_FAILED' });
      return { ok: false, code: t.code || 'TRANSCRIPTION_FAILED', noteId: noteId, rawAudioUrl: rawAudioUrl };
    }
    if (noteId && notes()) {
      const upd = await notes().update(noteId, { transcript: t.transcript, status: 'transcribed', confidence: t.confidence || 0 });
      return { ok: true, noteId: noteId, transcript: t.transcript, confidence: t.confidence || 0, rawAudioUrl: rawAudioUrl, note: upd.note };
    }
    return { ok: true, transcript: t.transcript, confidence: t.confidence || 0, rawAudioUrl: rawAudioUrl };
  }

  /**
   * Transcribe an audio blob via a server endpoint (future Whisper/other).
   * Endpoint is read from cfg.transcriptionEndpoint; absent → honest, logged error.
   * The recording is never lost — callers save audio before calling this.
   */
  async function transcribeAudio(blob, jobId) {
    const endpoint = cfg().transcriptionEndpoint || (cfg().flag ? cfg().flag('transcriptionEndpoint', null) : null);
    if (!endpoint) { await logErr('TRANSCRIPTION_FAILED', jobId, 'audio_recording', 'no transcriptionEndpoint configured'); return { ok: false, code: 'TRANSCRIPTION_FAILED', error: 'TRANSCRIPTION_NOT_CONFIGURED' }; }
    if (diag() && !diag().isOnline()) { await logErr('NETWORK_OFFLINE', jobId, 'audio_recording'); return { ok: false, code: 'NETWORK_OFFLINE' }; }
    try {
      const form = new FormData();
      form.append('audio', blob, 'note.webm');
      if (jobId) form.append('jobId', jobId);
      const res = await global.fetch(endpoint, { method: 'POST', body: form });
      if (!res || !res.ok) { await logErr('TRANSCRIPTION_FAILED', jobId, 'audio_recording', 'http ' + (res && res.status)); return { ok: false, code: 'TRANSCRIPTION_FAILED' }; }
      const json = await res.json();
      const transcript = String((json && (json.transcript || json.text)) || '').trim();
      if (!transcript) { await logErr('EMPTY_TRANSCRIPT', jobId, 'audio_recording'); return { ok: false, code: 'EMPTY_TRANSCRIPT' }; }
      return { ok: true, transcript: transcript, confidence: typeof json.confidence === 'number' ? json.confidence : 0 };
    } catch (err) {
      await logErr('TRANSCRIPTION_FAILED', jobId, 'audio_recording', err && err.message);
      return { ok: false, code: 'TRANSCRIPTION_FAILED' };
    }
  }

  // ---- Layer 3: manual note ----------------------------------------------
  async function saveTextLog(jobId, text) {
    if (!jobId) { await logErr('NO_ACTIVE_JOB', null, 'manual'); return { ok: false, code: 'NO_ACTIVE_JOB', error: 'NO_ACTIVE_JOB' }; }
    const note = String(text || '').trim();
    if (!note) return { ok: false, code: 'EMPTY_TRANSCRIPT', error: 'EMPTY_NOTE' };
    try {
      const saved = notes() ? await notes().create({ jobId: jobId, source: 'manual', transcript: note, status: 'transcribed', confidence: 100 }) : { ok: true };
      return { ok: true, noteId: saved.note && saved.note.id, transcript: note, source: 'manual' };
    } catch (err) {
      await logErr('RECORDING_FAILED', jobId, 'manual', err && err.message);
      return { ok: false, code: 'SAVE_NOTE_ERROR', error: 'SAVE_NOTE_ERROR' };
    }
  }

  global.AAA_SIDEKICK_VOICE = {
    startListening: startListening,   // Layer 1
    recorder: recorder,               // Layer 2 (controller)
    saveRecording: saveRecording,     // Layer 2 (persist + transcribe)
    transcribeAudio: transcribeAudio, // Layer 2 (transcription only)
    saveTextLog: saveTextLog          // Layer 3
  };
})(typeof window !== 'undefined' ? window : this);
