/* AAA_TTS client — provider selection, server path, graceful fallback. */
'use strict';
const { makeRunner } = require('../helpers/harness');

// Minimal stubs for the browser bits AAA_TTS touches.
function fakeAudioFactory(log) {
  return function Audio(url) {
    log.played = url;
    return { play: async () => { log.playCount = (log.playCount || 0) + 1; }, pause: () => { log.paused = true; }, addEventListener: () => {} };
  };
}
function fakeResponse({ ok = true, contentType = 'audio/wav', jsonBody = null } = {}) {
  return {
    ok: ok,
    headers: { get: (k) => (k.toLowerCase() === 'content-type' ? contentType : null) },
    async blob() { return { __blob: true }; },
    async json() { return jsonBody || {}; }
  };
}

module.exports = function run() {
  const t = makeRunner('tts');
  const G = global; G.window = G;

  // Config stub with adjustable flags.
  let flags = { ttsEndpoint: '/api/tts', ttsEnabled: true };
  G.AAA_CONFIG = { flag: (k, d) => (flags[k] != null ? flags[k] : d) };

  // Browser stubs.
  G.URL = { createObjectURL: () => 'blob:x', revokeObjectURL: () => {} };
  const audioLog = {};
  G.Audio = fakeAudioFactory(audioLog);

  delete require.cache[require.resolve('../../js/ai/tts-engine.js')];
  require('../../js/ai/tts-engine.js');
  const TTS = G.AAA_TTS;
  t.ok('exposed', !!TTS && typeof TTS.speak === 'function');

  // --- pure provider choice --------------------------------------------------
  t.eq('disabled -> none', TTS._chooseProvider({ enabled: false, server: true, browser: true }), 'none');
  t.eq('server preferred', TTS._chooseProvider({ enabled: true, server: true, browser: true }), 'server');
  t.eq('browser when no server', TTS._chooseProvider({ enabled: true, server: false, browser: true }), 'browser');
  t.eq('none when nothing', TTS._chooseProvider({ enabled: true, server: false, browser: false }), 'none');

  // --- isConfigured ----------------------------------------------------------
  t.ok('configured with server endpoint', TTS.isConfigured() === true);

  return (async () => {
    // --- empty text ---------------------------------------------------------
    const empty = await TTS.speak('   ');
    t.ok('empty text rejected', empty.ok === false && empty.error === 'EMPTY_TEXT');

    // --- server success: fetches endpoint, plays audio ----------------------
    let lastReq = null;
    G.fetch = async (url, init) => { lastReq = { url, init }; return fakeResponse({ ok: true, contentType: 'audio/wav' }); };
    const s = await TTS.speak('Quote total is twelve hundred dollars', { voice: 'Aria' });
    t.ok('server speak ok', s.ok === true && s.via === 'riva');
    t.eq('posts to /api/tts', lastReq.url, '/api/tts');
    t.ok('sends text in body', JSON.parse(lastReq.init.body).text.indexOf('twelve hundred') !== -1);
    t.ok('audio was played', audioLog.playCount >= 1);

    // --- server returns JSON error -> falls back to browser voice -----------
    G.fetch = async () => fakeResponse({ ok: false, contentType: 'application/json', jsonBody: { error: 'TTS_NOT_CONFIGURED', message: 'no url' } });
    let spoke = null;
    G.speechSynthesis = { speak: (u) => { spoke = u; }, cancel: () => {} };
    G.SpeechSynthesisUtterance = function (text) { this.text = text; };
    const fb = await TTS.speak('hello there');
    t.ok('falls back to browser', fb.ok === true && fb.via === 'browser');
    t.eq('records what it fell back from', fb.fallbackFrom, 'TTS_NOT_CONFIGURED');
    t.ok('browser utterance got the text', spoke && spoke.text === 'hello there');

    // --- server error with NO browser fallback -> honest failure ------------
    delete G.speechSynthesis; delete G.SpeechSynthesisUtterance;
    G.fetch = async () => fakeResponse({ ok: false, contentType: 'application/json', jsonBody: { error: 'PROVIDER_UNAVAILABLE', message: 'down' } });
    const failed = await TTS.speak('hi');
    t.ok('server error surfaced when no fallback', failed.ok === false && failed.error === 'PROVIDER_UNAVAILABLE');

    // --- no server endpoint, browser only -----------------------------------
    flags = { ttsEndpoint: '', ttsEnabled: true };
    G.speechSynthesis = { speak: () => {}, cancel: () => {} };
    G.SpeechSynthesisUtterance = function (text) { this.text = text; };
    const br = await TTS.speak('browser only');
    t.ok('browser-only path used', br.ok === true && br.via === 'browser');

    // --- disabled entirely --------------------------------------------------
    flags = { ttsEndpoint: '/api/tts', ttsEnabled: false };
    const off = await TTS.speak('nope');
    t.ok('disabled -> unavailable', off.ok === false && off.error === 'TTS_UNAVAILABLE');

    return t.report();
  })();
};
