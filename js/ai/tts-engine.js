/*
 * AAA TTS Engine — spoken output for the field app (read quotes, notes, and
 * sidekick replies aloud, hands-free on a job site).
 *
 * Provider order, honest and degrading:
 *   1. server  — POST text to the /api/tts proxy → NVIDIA Riva TTS NIM
 *                (e.g. chatterbox-tts-multilingual), play the returned WAV.
 *   2. browser — the platform speechSynthesis voice, as a no-infra fallback.
 *   3. none    — neither available → return a clear result, never throw.
 *
 * If the server NIM is configured but unreachable, speak() falls back to the
 * browser voice so a flaky GPU host never silences the app. Mirrors the rest of
 * the codebase: a singleton attached to the global, every method resolves to a
 * result object, no fabrication.
 */
;(function (global) {
  'use strict';

  function cfg() { return global.AAA_CONFIG || { flag: function (_k, d) { return d; } }; }

  const DEFAULT_ENDPOINT = '/api/tts';

  function endpoint() { return cfg().flag('ttsEndpoint', DEFAULT_ENDPOINT); }
  function enabled() { return cfg().flag('ttsEnabled', true) !== false; }
  function hasBrowserTTS() { return !!(global.speechSynthesis && global.SpeechSynthesisUtterance); }
  function hasServerTTS() { return !!endpoint(); }

  /** Pure provider choice given capabilities — exposed for tests. */
  function chooseProvider(state) {
    if (!state || !state.enabled) return 'none';
    if (state.server) return 'server';
    if (state.browser) return 'browser';
    return 'none';
  }

  const TTS = {
    DEFAULT_ENDPOINT: DEFAULT_ENDPOINT,
    _chooseProvider: chooseProvider,
    _current: null,

    /** Is any TTS path usable here? */
    isConfigured() { return enabled() && (hasServerTTS() || hasBrowserTTS()); },

    /**
     * Speak text. Resolves to { ok, via } or { ok:false, error, message }.
     * @param {string} text
     * @param {object} [opts] { voice, language }
     */
    async speak(text, opts) {
      opts = opts || {};
      const t = String(text == null ? '' : text).trim();
      if (!t) return { ok: false, error: 'EMPTY_TEXT', message: 'Nothing to speak.' };

      const provider = chooseProvider({ enabled: enabled(), server: hasServerTTS(), browser: hasBrowserTTS() });
      if (provider === 'none') return { ok: false, error: 'TTS_UNAVAILABLE', message: 'No text-to-speech is available here.' };

      if (provider === 'server') {
        const r = await this._speakServer(t, opts);
        if (r.ok) return r;
        // GPU host down / not configured at runtime → don't go silent.
        if (hasBrowserTTS()) {
          const b = this._speakBrowser(t, opts);
          return b.ok ? Object.assign(b, { fallbackFrom: r.error }) : r;
        }
        return r;
      }
      return this._speakBrowser(t, opts);
    },

    async _speakServer(text, opts) {
      try {
        const res = await global.fetch(endpoint(), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            text: text,
            voice: opts.voice || cfg().flag('ttsVoice', null),
            language: opts.language || cfg().flag('ttsLanguage', null)
          })
        });
        const ct = (res.headers && res.headers.get && res.headers.get('content-type')) || '';
        // The proxy returns audio bytes on success, JSON on error.
        if (!res.ok || ct.indexOf('application/json') !== -1) {
          let code = 'TTS_FAILED', message = 'Speech synthesis failed.';
          try { const j = await res.json(); code = j.error || code; message = j.message || message; } catch (_) {}
          return { ok: false, error: code, message: message };
        }
        const blob = await res.blob();
        await this._play(blob);
        return { ok: true, via: 'riva' };
      } catch (err) {
        return { ok: false, error: 'TTS_NETWORK', message: String((err && err.message) || err) };
      }
    },

    _speakBrowser(text, opts) {
      try {
        const u = new global.SpeechSynthesisUtterance(text);
        if (opts && opts.language) u.lang = opts.language;
        this.stop();
        global.speechSynthesis.speak(u);
        this._current = { type: 'browser' };
        return { ok: true, via: 'browser' };
      } catch (err) {
        return { ok: false, error: 'BROWSER_TTS_FAILED', message: String((err && err.message) || err) };
      }
    },

    async _play(blob) {
      this.stop();
      const url = global.URL.createObjectURL(blob);
      const audio = new global.Audio(url);
      this._current = { type: 'audio', audio: audio, url: url };
      audio.addEventListener('ended', () => { try { global.URL.revokeObjectURL(url); } catch (_) {} });
      try { await audio.play(); } catch (_) { /* autoplay policy may defer; UI gesture covers it */ }
    },

    /** Stop any in-progress playback/speech. */
    stop() {
      const c = this._current;
      if (!c) return;
      if (c.type === 'audio') {
        try { c.audio.pause(); } catch (_) {}
        try { global.URL.revokeObjectURL(c.url); } catch (_) {}
      } else if (c.type === 'browser') {
        try { global.speechSynthesis.cancel(); } catch (_) {}
      }
      this._current = null;
    }
  };

  global.AAA_TTS = TTS;
})(typeof window !== 'undefined' ? window : this);
