/*
 * Transcription function — pure-logic unit tests (no network, no OpenAI).
 *
 * Exercises netlify/functions/transcribe-lib.mjs: audio validation (missing /
 * empty / oversize / content-type), Whisper confidence derivation from segment
 * logprobs, response normalization to the client shape, and provider-error
 * mapping. The .mjs lib is loaded via dynamic import (the suite runner awaits us).
 */
'use strict';
const path = require('path');
const { makeRunner, ROOT } = require('../helpers/harness');

module.exports = async function run() {
  const t = makeRunner('transcribe');
  const lib = await import(path.join(ROOT, 'netlify/functions/transcribe-lib.mjs'));

  // ---- validateAudio -----------------------------------------------------
  t.eq('missing file → NO_AUDIO', lib.validateAudio(null).code, 'NO_AUDIO');
  t.eq('no size → NO_AUDIO', lib.validateAudio({ type: 'audio/webm' }).code, 'NO_AUDIO');
  t.eq('empty file → EMPTY_AUDIO', lib.validateAudio({ size: 0, type: 'audio/webm' }).code, 'EMPTY_AUDIO');
  t.ok('valid webm ok', lib.validateAudio({ size: 1000, type: 'audio/webm' }).ok === true);
  t.ok('valid mp4 audio ok', lib.validateAudio({ size: 1000, type: 'audio/mp4' }).ok === true);
  t.ok('empty type allowed (browser blob)', lib.validateAudio({ size: 1000, type: '' }).ok === true);
  t.eq('text/plain rejected', lib.validateAudio({ size: 1000, type: 'text/plain' }).code, 'UNSUPPORTED_AUDIO_TYPE');
  t.eq('oversize → AUDIO_TOO_LARGE', lib.validateAudio({ size: lib.MAX_AUDIO_BYTES + 1, type: 'audio/webm' }).code, 'AUDIO_TOO_LARGE');
  t.ok('exactly at limit ok', lib.validateAudio({ size: lib.MAX_AUDIO_BYTES, type: 'audio/webm' }).ok === true);

  // ---- deriveConfidence --------------------------------------------------
  t.eq('no segments → 0 (honest unknown)', lib.deriveConfidence({ text: 'hi' }), 0);
  t.eq('empty segments → 0', lib.deriveConfidence({ segments: [] }), 0);
  // avg_logprob 0 → exp(0)=1 → 100%
  t.eq('logprob 0 → 100', lib.deriveConfidence({ segments: [{ avg_logprob: 0, start: 0, end: 1 }] }), 100);
  // avg_logprob -0.2 → exp ≈ 0.8187 → 82
  t.eq('logprob -0.2 → ~82', lib.deriveConfidence({ segments: [{ avg_logprob: -0.2, start: 0, end: 1 }] }), 82);
  // duration-weighted: a long confident segment should dominate a short unsure one
  const weighted = lib.deriveConfidence({ segments: [
    { avg_logprob: 0, start: 0, end: 9 },        // 9s @ 100%
    { avg_logprob: -2, start: 9, end: 10 }       // 1s @ ~13.5%
  ] });
  t.ok('duration-weighted favors the long segment (>85)', weighted > 85);
  t.ok('confidence clamped 0..100', lib.deriveConfidence({ segments: [{ avg_logprob: 5, start: 0, end: 1 }] }) === 100);

  // ---- normalizeWhisperResponse ------------------------------------------
  const norm = lib.normalizeWhisperResponse({ text: '  fix the stairs  ', segments: [{ avg_logprob: -0.1, start: 0, end: 2 }] });
  t.eq('transcript trimmed', norm.transcript, 'fix the stairs');
  t.ok('confidence present from segments', norm.confidence > 0 && norm.confidence <= 100);
  t.eq('missing text → empty transcript', lib.normalizeWhisperResponse({}).transcript, '');
  t.eq('plain json (no segments) → confidence 0', lib.normalizeWhisperResponse({ text: 'hello' }).confidence, 0);

  // ---- mapProviderError --------------------------------------------------
  t.eq('401 → PROVIDER_AUTH_FAILED', lib.mapProviderError({ status: 401 }).code, 'PROVIDER_AUTH_FAILED');
  t.eq('403 → PROVIDER_AUTH_FAILED', lib.mapProviderError({ status: 403 }).code, 'PROVIDER_AUTH_FAILED');
  t.eq('429 → PROVIDER_RATE_LIMITED', lib.mapProviderError({ status: 429 }).code, 'PROVIDER_RATE_LIMITED');
  t.eq('500 → PROVIDER_UNAVAILABLE', lib.mapProviderError({ status: 500 }).code, 'PROVIDER_UNAVAILABLE');
  t.eq('network throw (status 0) → PROVIDER_UNAVAILABLE', lib.mapProviderError(new Error('fetch failed')).code, 'PROVIDER_UNAVAILABLE');
  t.eq('400 → TRANSCRIPTION_FAILED', lib.mapProviderError({ status: 400 }).code, 'TRANSCRIPTION_FAILED');
  t.ok('error messages carry no secrets', !/sk-|api[_-]?key/i.test(JSON.stringify(['401', '429', '500'].map((s) => lib.mapProviderError({ status: Number(s) })))));

  // ---- json helper -------------------------------------------------------
  const r = lib.json({ ok: true }, 200);
  t.ok('json() returns a Response', r && typeof r.status === 'number' && r.status === 200);

  return t.report();
};
