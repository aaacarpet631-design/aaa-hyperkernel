/* Offline unit tests for the Chatterbox/Riva TTS helpers (no network). */
'use strict';
const tts = require('./chatterbox-tts');

let pass = 0, fail = 0;
const ok = (n, c) => c ? pass++ : (fail++, console.log('FAIL:', n));
const eq = (n, a, b) => ok(n + ' (got ' + JSON.stringify(a) + ')', a === b);

// --- URL builders + normalization ------------------------------------------
eq('strips trailing slash', tts.normalizeBaseUrl('http://h:9000/'), 'http://h:9000');
eq('strips multiple slashes', tts.normalizeBaseUrl('http://h:9000///'), 'http://h:9000');
eq('synthesize url', tts.synthesizeUrl('http://h:9000'), 'http://h:9000/v1/audio/synthesize');
eq('voices url', tts.voicesUrl('http://h:9000/'), 'http://h:9000/v1/audio/list_voices');
eq('health url', tts.healthUrl('http://h:9000'), 'http://h:9000/v1/health/ready');

// --- validateText -----------------------------------------------------------
ok('rejects non-string', tts.validateText(null).code === 'NO_TEXT');
ok('rejects empty', tts.validateText('   ').code === 'EMPTY_TEXT');
ok('trims and accepts', tts.validateText('  hi  ').ok === true && tts.validateText('  hi  ').text === 'hi');
ok('rejects too long', tts.validateText('x'.repeat(6000)).code === 'TEXT_TOO_LONG');
ok('respects custom max', tts.validateText('hello', { maxChars: 3 }).code === 'TEXT_TOO_LONG');

// --- buildSynthFields -------------------------------------------------------
const f1 = tts.buildSynthFields({ text: '  Hello world ' });
eq('text trimmed', f1.text, 'Hello world');
eq('default language', f1.language, 'en-US');
ok('no voice when none given', !('voice' in f1));

const f2 = tts.buildSynthFields({ text: 'hi', language: 'es-ES', voice: 'Aria', sampleRate: 22050, encoding: 'LINEAR_PCM' });
eq('explicit language', f2.language, 'es-ES');
eq('voice passed', f2.voice, 'Aria');
eq('sample rate stringified', f2.sample_rate_hz, '22050');
eq('encoding passed', f2.encoding, 'LINEAR_PCM');

const f3 = tts.buildSynthFields({ text: 'hi' }, { voice: 'EnvVoice', language: 'fr-FR' });
eq('env default voice', f3.voice, 'EnvVoice');
eq('env default language', f3.language, 'fr-FR');
ok('body voice overrides env default', tts.buildSynthFields({ text: 'hi', voice: 'Body' }, { voice: 'Env' }).voice === 'Body');
eq('sample_rate_hz alias accepted', tts.buildSynthFields({ text: 'hi', sample_rate_hz: 16000 }).sample_rate_hz, '16000');

// --- mapProviderError -------------------------------------------------------
eq('401 -> auth', tts.mapProviderError(401).code, 'PROVIDER_AUTH_FAILED');
eq('403 -> auth', tts.mapProviderError(403).code, 'PROVIDER_AUTH_FAILED');
eq('404 -> endpoint', tts.mapProviderError(404).code, 'TTS_ENDPOINT_NOT_FOUND');
eq('429 -> rate', tts.mapProviderError(429).code, 'PROVIDER_RATE_LIMITED');
eq('500 -> unavailable', tts.mapProviderError(500).code, 'PROVIDER_UNAVAILABLE');
eq('0 -> unavailable', tts.mapProviderError(0).code, 'PROVIDER_UNAVAILABLE');
eq('418 -> generic', tts.mapProviderError(418).code, 'TTS_FAILED');

console.log(pass + ' passed, ' + fail + ' failed');
if (fail) process.exit(1);
