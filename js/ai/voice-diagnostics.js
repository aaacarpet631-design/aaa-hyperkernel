/*
 * AAA Voice Diagnostics — the single source of truth for WHY voice is or isn't
 * available, plus structured error logging.
 *
 * The old pipeline collapsed every failure (permission denied, insecure HTTP,
 * unsupported browser, no-speech timeout) into one misleading message:
 * "No signal. Enter note:". This module replaces that guesswork with real
 * feature detection so the UI can show the ACTUAL reason and the right recovery
 * action, and so every failure is logged with enough detail to debug in the field.
 *
 * Pure detection — no DOM, no recording. The engine and the HUD consume it.
 */
;(function (global) {
  'use strict';

  function data() { return global.AAA_DATA; }
  function ids() { return global.AAA_ID_FACTORY; }
  function clock() { return global.AAA_RUNTIME_CLOCK; }

  // Live feature detection (read at call time, not snapshotted at load) so the
  // result is always current — important on mobile where capabilities and
  // permissions can change during a session.
  function getSpeechRecognition() { return global.SpeechRecognition || global.webkitSpeechRecognition || null; }

  // Canonical error codes (the full set the spec requires us to log) → the
  // calm, professional message a field tech should see.
  const MESSAGES = {
    PERMISSION_DENIED: 'Microphone access is blocked. Allow the mic for this site in your browser settings, then retry.',
    UNSUPPORTED_BROWSER: 'This browser can’t do live voice recognition. You can record audio or type the note instead.',
    INSECURE_CONTEXT: 'Voice needs a secure (https) connection. Open the app over https, then retry.',
    NO_MICROPHONE: 'No microphone was found on this device. Plug one in or type the note instead.',
    RECORDING_FAILED: 'Audio recording could not start. Check the mic, then retry or type the note.',
    TRANSCRIPTION_FAILED: 'Couldn’t transcribe the audio. The recording is saved — you can retry transcription later.',
    NETWORK_OFFLINE: 'You’re offline. Live recognition needs a connection; record audio or type the note for now.',
    EMPTY_TRANSCRIPT: 'No speech was detected. Move somewhere quieter and retry, or type the note.',
    TIMEOUT: 'Voice timed out before any speech was detected. Retry, or type the note.',
    NO_ACTIVE_JOB: 'Open a job first — voice notes attach to the job you’re viewing.',
    OK: 'Ready.'
  };

  // Map a Web Speech API error string to our canonical code.
  function mapSpeechError(err) {
    switch (String(err || '')) {
      case 'not-allowed':
      case 'service-not-allowed': return 'PERMISSION_DENIED';
      case 'audio-capture': return 'NO_MICROPHONE';
      case 'network': return 'NETWORK_OFFLINE';
      case 'no-speech': return 'EMPTY_TRANSCRIPT';
      case 'aborted': return 'TIMEOUT';
      default: return 'TRANSCRIPTION_FAILED';
    }
  }

  function isSecure() {
    if (typeof global.isSecureContext === 'boolean') return global.isSecureContext;
    const loc = global.location || {};
    return loc.protocol === 'https:' || loc.hostname === 'localhost' || loc.hostname === '127.0.0.1';
  }

  function speechSupported() { return !!getSpeechRecognition(); }

  function mediaRecorderSupported() {
    return !!(global.navigator && global.navigator.mediaDevices &&
      typeof global.navigator.mediaDevices.getUserMedia === 'function' &&
      typeof global.MediaRecorder !== 'undefined');
  }

  function isOnline() {
    const n = global.navigator;
    return !n || typeof n.onLine !== 'boolean' ? true : n.onLine;
  }

  const Diag = {
    getSpeechRecognition: getSpeechRecognition,
    MESSAGES: MESSAGES,
    mapSpeechError: mapSpeechError,
    message: function (code) { return MESSAGES[code] || ('Voice error (' + code + ').'); },

    isSecureContext: isSecure,
    speechSupported: speechSupported,
    mediaRecorderSupported: mediaRecorderSupported,
    isOnline: isOnline,

    /** Best-effort mic permission state: granted|denied|prompt|unknown. Never throws. */
    async permissionState() {
      try {
        const perms = global.navigator && global.navigator.permissions;
        if (!perms || typeof perms.query !== 'function') return 'unknown';
        const status = await perms.query({ name: 'microphone' });
        return (status && status.state) || 'unknown';
      } catch (_) {
        return 'unknown'; // Firefox/Safari often don't expose the microphone name
      }
    },

    /** Snapshot of the device/browser for log records. */
    deviceInfo() {
      const n = global.navigator || {};
      return {
        userAgent: n.userAgent || 'unknown',
        platform: n.platform || 'unknown',
        online: isOnline(),
        secureContext: isSecure(),
        speech: speechSupported(),
        mediaRecorder: mediaRecorderSupported()
      };
    },

    /**
     * Full assessment of what voice can do right now. Pure (does not prompt).
     * @returns {Promise<object>} { secure, speech, mediaRecorder, online,
     *   permission, canLive, canRecord, code, reason }
     */
    async assess() {
      const secure = isSecure();
      const speech = speechSupported();
      const recorder = mediaRecorderSupported();
      const online = isOnline();
      const permission = await this.permissionState();

      // Live recognition needs: secure context + Speech API + not denied. It also
      // effectively needs a network on Chrome (server-backed), but we don't hard-
      // block on online here — we let it try and map a 'network' error if it fails.
      const canLive = secure && speech && permission !== 'denied';
      // Audio recording needs: secure context + MediaRecorder + not denied.
      const canRecord = secure && recorder && permission !== 'denied';

      let code = 'OK';
      if (!secure) code = 'INSECURE_CONTEXT';
      else if (permission === 'denied') code = 'PERMISSION_DENIED';
      else if (!speech && !recorder) code = 'UNSUPPORTED_BROWSER';
      else if (!speech && recorder) code = 'UNSUPPORTED_BROWSER'; // live unsupported; record path remains

      return {
        secure: secure, speech: speech, mediaRecorder: recorder, online: online,
        permission: permission, canLive: canLive, canRecord: canRecord,
        code: code, reason: this.message(code)
      };
    },

    /**
     * Structured voice error log. Persisted to the `voice_logs` collection
     * (local-first, cloud-mirrored best-effort) AND echoed to the console for
     * live debugging. Never throws.
     * @param {string} code   one of the canonical codes
     * @param {object} extra  { jobId, detail, source }
     */
    async log(code, extra) {
      extra = extra || {};
      const rec = {
        id: (ids() ? ids().createId('vlog') : 'vlog_' + Date.now()),
        code: code,
        jobId: extra.jobId || null,
        source: extra.source || null,
        userMessage: this.message(code),
        debugDetail: extra.detail != null ? String(extra.detail) : '',
        device: this.deviceInfo(),
        createdAt: (clock() ? clock().now() : Date.now())
      };
      try { console.warn('[voice] ' + code + (extra.detail ? ' — ' + extra.detail : ''), rec.device); } catch (_) {}
      try { if (data() && data().put) await data().put('voice_logs', rec.id, rec); } catch (_) {}
      try {
        if (data() && data().cloudReady && data().cloudReady() && global.AAA_CLOUD) {
          await global.AAA_CLOUD.upsertEntity('voice_logs', rec.id, rec);
        }
      } catch (_) {}
      return rec;
    },

    /** Read recent logs (newest first) for an optional job. */
    async recent(jobId) {
      if (!data() || !data().list) return [];
      const all = await data().list('voice_logs');
      return all
        .filter(function (l) { return !jobId || l.jobId === jobId; })
        .sort(function (a, b) { return (b.createdAt || 0) - (a.createdAt || 0); });
    }
  };

  global.AAA_VOICE_DIAGNOSTICS = Diag;
})(typeof window !== 'undefined' ? window : this);
