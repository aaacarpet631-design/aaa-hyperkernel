/* private-gpu-translate — offline unit test (self-contained; no harness, no network). */
'use strict';
const T = require('./private-gpu-translate.js');

let pass = 0, fail = 0;
function ok(name, cond) { if (cond) { pass++; } else { fail++; console.log('  FAIL: ' + name); } }
function eq(name, a, b) { ok(name + ' (' + JSON.stringify(a) + ' === ' + JSON.stringify(b) + ')', a === b); }

// ---- toRequest ----
const req = T.toRequest({ system: 'be brief', messages: [{ role: 'user', content: 'hi' }], model: 'llama-3', max_tokens: 64 });
ok('system becomes the first system message', req.messages[0].role === 'system' && req.messages[0].content === 'be brief');
ok('user message preserved', req.messages[1].role === 'user' && req.messages[1].content === 'hi');
eq('model honored', req.model, 'llama-3');
eq('max_tokens honored', req.max_tokens, 64);

const req2 = T.toRequest({ messages: [{ role: 'user', content: { a: 1 } }] });
eq('default model applied when none given', req2.model, 'local-model');
eq('max_tokens defaults', req2.max_tokens, 512);
ok('non-string content is serialized', typeof req2.messages[0].content === 'string' && /"a":1/.test(req2.messages[0].content));
ok('no system message when none provided', req2.messages.every((m) => m.role !== 'system'));

// ---- fromResponse ----
const out = T.fromResponse({ choices: [{ message: { content: 'hello there' }, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 2 } });
ok('extracts assistant text', out.ok === true && out.text === 'hello there');
ok('builds content blocks + usage', out.content[0].text === 'hello there' && out.usage.output_tokens === 2);
eq('passes finish reason', out.stop_reason, 'stop');
const empty = T.fromResponse({});
ok('empty/garbled response degrades to empty text (no fake output)', empty.ok === true && empty.text === '');

// ---- endpointFor ----
eq('appends the chat path', T.endpointFor('http://10.0.0.5:8000'), 'http://10.0.0.5:8000/v1/chat/completions');
eq('does not double-append', T.endpointFor('http://x/v1/chat/completions'), 'http://x/v1/chat/completions');
eq('strips trailing slash', T.endpointFor('http://x:8000/'), 'http://x:8000/v1/chat/completions');
eq('empty base → null', T.endpointFor(''), null);

console.log('private-gpu-translate: ' + pass + ' passed, ' + fail + ' failed');
if (fail) process.exit(1);
