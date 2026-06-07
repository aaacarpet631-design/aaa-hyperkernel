/*
 * chatterbox-tts — pure, dependency-free helpers for the NVIDIA Riva TTS NIM
 * (e.g. nvcr.io/nim/nvidia/chatterbox-tts-multilingual). The NIM exposes an
 * HTTP API on its NIM_HTTP_API_PORT (default 9000):
 *
 *   POST /v1/audio/synthesize        offline synth → a full WAV (form-data in)
 *   GET  /v1/audio/list_voices       available voice names
 *   GET  /v1/health/ready            readiness probe
 *
 * The offline synthesize request is multipart form-data with fields `text`,
 * `language` and (optionally) `voice` / `sample_rate_hz` / `encoding`. This
 * module only builds/validates that contract and maps errors — no network, no
 * SDK — so the Netlify proxy and the unit tests both reuse it. The serving NIM
 * runs on the operator's GPU host; nothing here assumes a GPU.
 *
 * NOTE (honest): exact field names/voice ids should be confirmed against the
 * running NIM via /v1/audio/list_voices; defaults follow NVIDIA's documented
 * curl (`-F language=en-US -F text=...`).
 */
'use strict';

const SYNTHESIZE_PATH = '/v1/audio/synthesize';
const VOICES_PATH = '/v1/audio/list_voices';
const HEALTH_PATH = '/v1/health/ready';

const DEFAULT_LANGUAGE = 'en-US';
const MAX_TEXT_CHARS = 5000; // guard one synth call from an accidental giant payload

/** Strip trailing slashes from a base URL (e.g. http://gpu-host:9000). */
function normalizeBaseUrl(url) {
  return String(url == null ? '' : url).trim().replace(/\/+$/, '');
}
function synthesizeUrl(base) { return normalizeBaseUrl(base) + SYNTHESIZE_PATH; }
function voicesUrl(base) { return normalizeBaseUrl(base) + VOICES_PATH; }
function healthUrl(base) { return normalizeBaseUrl(base) + HEALTH_PATH; }

/** Validate text before spending a synth request. */
function validateText(text, opts) {
  const max = (opts && opts.maxChars) || MAX_TEXT_CHARS;
  if (typeof text !== 'string') return { ok: false, code: 'NO_TEXT', message: 'No text provided to synthesize.' };
  const t = text.trim();
  if (!t) return { ok: false, code: 'EMPTY_TEXT', message: 'Text was empty.' };
  if (t.length > max) return { ok: false, code: 'TEXT_TOO_LONG', message: 'Text exceeds the ' + max + '-character limit.' };
  return { ok: true, text: t };
}

/**
 * Build the form-data field map Riva expects. The caller turns this into a
 * FormData (server) — kept as a plain object so it's trivially testable.
 * @param {object} body    { text, voice?, language?, sampleRate?/sample_rate_hz?, encoding? }
 * @param {object} [defaults] { voice?, language?, sampleRate? } from env
 */
function buildSynthFields(body, defaults) {
  body = body || {};
  defaults = defaults || {};
  const fields = {
    text: String(body.text == null ? '' : body.text).trim(),
    language: String(body.language || defaults.language || DEFAULT_LANGUAGE)
  };
  const voice = body.voice || defaults.voice;
  if (voice) fields.voice = String(voice);
  const sr = body.sampleRate || body.sample_rate_hz || defaults.sampleRate;
  if (sr) fields.sample_rate_hz = String(sr);
  if (body.encoding) fields.encoding = String(body.encoding);
  return fields;
}

/** Map an HTTP status to a stable client code + safe message (no secrets). */
function mapProviderError(status) {
  const s = Number(status) || 0;
  if (s === 401 || s === 403) return { code: 'PROVIDER_AUTH_FAILED', message: 'TTS service rejected the request.' };
  if (s === 404) return { code: 'TTS_ENDPOINT_NOT_FOUND', message: 'TTS synthesize endpoint not found — check the NIM URL/version.' };
  if (s === 429) return { code: 'PROVIDER_RATE_LIMITED', message: 'TTS service is rate-limiting; retry shortly.' };
  if (s >= 500 || s === 0) return { code: 'PROVIDER_UNAVAILABLE', message: 'TTS service is unavailable; try again later.' };
  return { code: 'TTS_FAILED', message: 'Speech synthesis failed (' + s + ').' };
}

module.exports = {
  SYNTHESIZE_PATH, VOICES_PATH, HEALTH_PATH, DEFAULT_LANGUAGE, MAX_TEXT_CHARS,
  normalizeBaseUrl, synthesizeUrl, voicesUrl, healthUrl,
  validateText, buildSynthFields, mapProviderError
};
