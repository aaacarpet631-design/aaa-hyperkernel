import test from 'node:test';
import assert from 'node:assert/strict';
import { OPEN_MODELS, availableModels, modelCatalog } from '../../netlify/lib/agent-models.mjs';
import { modelStep, appendModel, appendToolResults } from '../../netlify/lib/agent-provider.mjs';
import { TOOLS } from '../../netlify/lib/agent-tools.mjs';
import { handleAgent } from '../../netlify/lib/agent-runtime.mjs';
import { baseContext, startBody } from './helpers.mjs';

for (const model of OPEN_MODELS) test(model + ' completes the native tool loop with preserved reasoning', async () => {
  const ctx = baseContext(); ctx.env = { OPENROUTER_API_KEY: 'fixture-only-secret' };
  let calls = 0;
  ctx.fetchImpl = async (url, options) => {
    assert.equal(url, 'https://openrouter.ai/api/v1/chat/completions');
    assert.equal(options.headers.authorization, 'Bearer fixture-only-secret'); assert.equal(options.redirect, 'error');
    const payload = JSON.parse(options.body);
    assert.equal(payload.model, model); assert.equal(payload.tools[0].type, 'function'); assert.equal(payload.provider.require_parameters, true);
    let message;
    if (++calls === 1) message = { role: 'assistant', content: null, reasoning_details: [{ type: 'reasoning.encrypted', data: 'opaque-block', index: 0 }], tool_calls: [{ type: 'function', id: 'calc_1', function: { name: 'calculate', arguments: '{"operation":"sum","values":[12,30]}' } }] };
    else {
      assert.deepEqual(payload.messages.at(-2).reasoning_details, [{ type: 'reasoning.encrypted', data: 'opaque-block', index: 0 }]);
      assert.equal(payload.messages.at(-1).role, 'tool'); assert.equal(JSON.parse(payload.messages.at(-1).content).result, 42);
      message = { role: 'assistant', content: 'The calculated total is 42.' };
    }
    return new Response(JSON.stringify({ choices: [{ finish_reason: calls === 1 ? 'tool_calls' : 'stop', message }], usage: { prompt_tokens: 30, completion_tokens: 20 } }));
  };
  let run = (await handleAgent({ ...startBody(), model }, ctx)).run;
  for (let n = 0; n < 4 && run.status === 'running'; n++) run = (await handleAgent({ op: 'advance', id: run.id, revision: run.revision }, ctx)).run;
  assert.equal(run.status, 'completed'); assert.equal(calls, 2); assert.equal(run.usage.input, 60); assert.equal(run.text, 'The calculated total is 42.');
  assert.equal(JSON.stringify(run).includes('opaque-block'), false); assert.equal(JSON.stringify(run).includes('fixture-only-secret'), false);
});

test('unconfigured models are visible but cannot start; no model silently changes', async () => {
  assert.deepEqual(availableModels({}), []); assert.equal(modelCatalog({}).filter(m => m.provider === 'openrouter' && !m.configured).length, 3);
  const ctx = baseContext();
  await assert.rejects(handleAgent({ ...startBody(), model: OPEN_MODELS[0] }, ctx), e => e.code === 'AGENT_MODEL_NOT_CONFIGURED');
  await assert.rejects(handleAgent({ ...startBody(), model: 'unreviewed/model' }, ctx), e => e.code === 'AGENT_MODEL_NOT_CONFIGURED');
});

test('missing credits, invalid keys, truncation and refusal produce useful errors', async () => {
  const run = { model: OPEN_MODELS[0], transcript: [] }, env = { OPENROUTER_API_KEY: 'fixture' };
  for (const [status, code] of [[401, 'INVALID_PROVIDER_KEY'], [402, 'OPENROUTER_CREDITS_REQUIRED'], [429, 'PROVIDER_RATE_LIMITED']]) {
    await assert.rejects(modelStep(run, TOOLS, { env, fetchImpl: async () => new Response('secret error', { status }) }), e => e.code === code && !e.message.includes('secret'));
  }
  for (const [finish_reason, message, code] of [
    ['length', { role: 'assistant', content: '{' }, 'PROVIDER_INCOMPLETE'],
    ['stop', { role: 'assistant', content: '', refusal: 'No' }, 'PROVIDER_REFUSAL'],
    ['tool_calls', { role: 'assistant', tool_calls: [] }, 'INVALID_AGENT_RESPONSE']
  ]) await assert.rejects(modelStep(run, TOOLS, { env, fetchImpl: async () => new Response(JSON.stringify({ choices: [{ finish_reason, message }] })) }), e => e.code === code);
});

test('raw reasoning strings remain private native continuation data too', () => {
  const run = { model: OPEN_MODELS[2], transcript: [], pending: [{ id: 'c', result: { ok: true } }] };
  appendModel(run, { output: { role: 'assistant', reasoning: 'private continuation', content: null } }); appendToolResults(run);
  assert.equal(run.transcript[0].reasoning, 'private continuation'); assert.equal(run.transcript[1].tool_call_id, 'c');
});
