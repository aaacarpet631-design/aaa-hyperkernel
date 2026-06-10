/*
 * AAA Voice Input Adapter — voice-ready, never voice-dependent.
 *
 * A thin abstraction over the browser SpeechRecognition API. If the API exists,
 * listen() streams a transcript to a callback; if not (or no DOM, e.g. tests),
 * it degrades gracefully to text input and reports supported:false. No external
 * paid speech services. Pure capability detection — no side effects until listen().
 */
;(function (global) {
  'use strict';

  function SR() { return (typeof global !== 'undefined') && (global.SpeechRecognition || global.webkitSpeechRecognition) || null; }

  const Adapter = {
    /** Is browser speech recognition available here? */
    isSupported() { return !!SR(); },

    /** Recommended input mode for the UI to render. */
    mode() { return this.isSupported() ? 'voice_or_text' : 'text'; },

    /**
     * Begin listening. onResult(transcript, { final }) is called as text
     * arrives. Returns a handle { supported, stop() }. When unsupported it
     * returns { supported:false, fallback:'text' } and never throws.
     */
    listen(onResult, onError) {
      const Impl = SR();
      if (!Impl) return { supported: false, fallback: 'text' };
      var rec;
      try {
        rec = new Impl();
        rec.continuous = false; rec.interimResults = true; rec.lang = 'en-US';
        rec.onresult = function (e) {
          var txt = ''; var isFinal = false;
          for (var i = e.resultIndex; i < e.results.length; i++) { txt += e.results[i][0].transcript; if (e.results[i].isFinal) isFinal = true; }
          if (typeof onResult === 'function') onResult(txt, { final: isFinal });
        };
        rec.onerror = function (e) { if (typeof onError === 'function') onError(e && e.error); };
        rec.start();
      } catch (e) { if (typeof onError === 'function') onError(e && e.message); return { supported: false, fallback: 'text', error: e && e.message }; }
      return { supported: true, stop: function () { try { rec.stop(); } catch (_) {} } };
    }
  };

  global.AAA_VOICE_INPUT_ADAPTER = Adapter;
})(typeof window !== 'undefined' ? window : this);
