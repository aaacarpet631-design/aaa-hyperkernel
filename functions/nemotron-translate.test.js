/* Offline unit tests for the Nemotron translator's pure logic (no network). */
'use strict';
const { toOpenAIContent, resolveModel, toRequest, fromResponse, DEFAULT_MODEL } = require('./nemotron-translate');

let pass = 0, fail = 0;
const ok = (n, c) => c ? pass++ : (fail++, console.log('FAIL:', n));

// toOpenAIContent
ok('string passes through', toOpenAIContent('hi') === 'hi');
ok('text blocks collapse to string', toOpenAIContent([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }]) === 'ab');
const img = toOpenAIContent([{ type: 'text', text: 'look' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'XXX' } }]);
ok('image block -> multimodal parts', Array.isArray(img) && img.length === 2);
ok('image becomes data URL', img[1].type === 'image_url' && img[1].image_url.url === 'data:image/png;base64,XXX');
ok('url-source image kept', toOpenAIContent([{ type: 'image', source: { type: 'url', url: 'http://x/y.jpg' } }])[0].image_url.url === 'http://x/y.jpg');
ok('non-array non-string -> empty', toOpenAIContent(null) === '');

// resolveModel — Claude ids fall back, nvidia ids are honored
ok('claude id falls back to default', resolveModel('claude-opus-4-8') === DEFAULT_MODEL);
ok('falls back to provided default', resolveModel('claude-sonnet-4-6', 'nvidia/custom') === 'nvidia/custom');
ok('nvidia/* honored', resolveModel('nvidia/nemotron-foo') === 'nvidia/nemotron-foo');
ok('bare nemotron honored', resolveModel('nemotron-x') === 'nemotron-x');
ok('empty falls back', resolveModel('') === DEFAULT_MODEL);

// toRequest — system hoisted, roles mapped, model resolved
const req = toRequest({ system: 'be terse', model: 'claude-opus-4-8', max_tokens: 50, messages: [
  { role: 'user', content: 'q' }, { role: 'assistant', content: 'a' }
] });
ok('system becomes first message', req.messages[0].role === 'system' && req.messages[0].content === 'be terse');
ok('user/assistant roles preserved', req.messages[1].role === 'user' && req.messages[2].role === 'assistant');
ok('max_tokens carried', req.max_tokens === 50);
ok('claude model resolved to nemotron default', req.model === DEFAULT_MODEL);
ok('opts.defaultModel wins', toRequest({ messages: [{ role: 'user', content: 'x' }] }, { defaultModel: 'nvidia/z' }).model === 'nvidia/z');
ok('default max_tokens 1024', toRequest({ messages: [{ role: 'user', content: 'x' }] }).max_tokens === 1024);
ok('unknown role coerced to user', toRequest({ messages: [{ role: 'tool', content: 'x' }] }).messages[0].role === 'user');

// fromResponse — OpenAI shape -> app shape
const resp = fromResponse({ choices: [{ message: { content: 'hello', reasoning_content: 'because' }, finish_reason: 'stop' }], usage: { prompt_tokens: 7, completion_tokens: 3 } });
ok('text extracted', resp.ok === true && resp.text === 'hello');
ok('content block built', resp.content.length === 1 && resp.content[0].text === 'hello');
ok('usage normalized', resp.usage.input_tokens === 7 && resp.usage.output_tokens === 3);
ok('stop_reason mapped', resp.stop_reason === 'stop');
ok('reasoning surfaced separately', resp.reasoning === 'because');
const empty = fromResponse({});
ok('empty response is safe', empty.ok === true && empty.text === '' && empty.content.length === 0);

console.log('\n%d passed, %d failed', pass, fail);
process.exit(fail ? 1 : 0);
