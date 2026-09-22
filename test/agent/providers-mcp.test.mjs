import test from 'node:test';
import assert from 'node:assert/strict';
import { modelStep, appendModel, appendToolResults } from '../../netlify/lib/agent-provider.mjs';
import { TOOLS } from '../../netlify/lib/agent-tools.mjs';
import { connections, discover, callConnected, requiresReview } from '../../netlify/lib/agent-mcp.mjs';
import { boundedFetch } from '../../netlify/lib/agent-network.mjs';

const json = value => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });

test('OpenAI Responses keeps reasoning and function outputs in a native multi-step conversation', async () => {
  const run = { model: 'gpt-6-astra', transcript: [{ role: 'user', content: 'Calculate.' }] };
  const output = [{ type: 'reasoning', encrypted_content: 'opaque', summary: [] }, { type: 'function_call', name: 'calculate', call_id: 'call_a', arguments: '{"operation":"sum","values":[1,2]}' }];
  const result = await modelStep(run, TOOLS, { env: { OPENAI_API_KEY: 'secret', OPENAI_BASE_URL: 'https://gateway.example/v1' }, fetchImpl: async (url, opts) => {
    assert.equal(url, 'https://gateway.example/v1/responses'); assert.equal(opts.redirect, 'error');
    const body = JSON.parse(opts.body); assert.equal(body.store, false); assert.equal(body.tools[0].strict, true); assert.equal(body.parallel_tool_calls, false);
    return json({ status: 'completed', output, usage: { input_tokens: 12, output_tokens: 4 } });
  } });
  appendModel(run, result); run.pending = result.calls.map(c => ({ ...c, result: { ok: true, result: 3 } })); appendToolResults(run);
  assert.equal(run.transcript[1].encrypted_content, 'opaque'); assert.equal(run.transcript.at(-1).type, 'function_call_output'); assert.equal(run.transcript.at(-1).call_id, 'call_a');
});

test('Anthropic uses tool_use/tool_result and incomplete responses cannot execute tools', async () => {
  const run = { model: 'claude-sonnet-4-6', transcript: [{ role: 'user', content: 'Calculate.' }] };
  const content = [{ type: 'tool_use', id: 'tool_a', name: 'calculate', input: { operation: 'sum', values: [1, 2] } }];
  const env = { ANTHROPIC_API_KEY: 'secret', ANTHROPIC_BASE_URL: 'https://gateway.example' };
  const result = await modelStep(run, TOOLS, { env, fetchImpl: async (url, opts) => {
    assert.equal(url, 'https://gateway.example/v1/messages'); assert.ok(JSON.parse(opts.body).tools[0].input_schema); return json({ stop_reason: 'tool_use', content });
  } });
  appendModel(run, result); run.pending = result.calls.map(c => ({ ...c, result: { ok: false, error: 'TEST_ERROR' } })); appendToolResults(run);
  assert.equal(run.transcript.at(-1).content[0].type, 'tool_result'); assert.equal(run.transcript.at(-1).content[0].is_error, true);
  await assert.rejects(modelStep(run, TOOLS, { env, fetchImpl: async () => json({ stop_reason: 'max_tokens', content }) }), e => e.code === 'PROVIDER_INCOMPLETE');
});

test('provider refusals, 429s and streamed oversized responses fail honestly', async () => {
  const run = { model: 'gpt-6-astra', transcript: [] }, env = { OPENAI_API_KEY: 'secret' };
  await assert.rejects(modelStep(run, TOOLS, { env, fetchImpl: async () => json({ status: 'completed', output: [{ type: 'message', content: [{ type: 'refusal', refusal: 'No' }] }] }) }), e => e.code === 'PROVIDER_REFUSAL');
  await assert.rejects(modelStep(run, TOOLS, { env, fetchImpl: async () => new Response('secret upstream', { status: 429 }) }), e => e.code === 'PROVIDER_RATE_LIMITED' && !e.message.includes('secret'));
  const response = await boundedFetch(async () => new Response('x'.repeat(20)), 'https://example.test', {}, 10);
  await assert.rejects(response.text(), e => e.code === 'UPSTREAM_RESPONSE_TOO_LARGE');
});

test('official MCP SDK initializes, discovers an allowed tool, validates it and executes it', async () => {
  const connection = { id: 'fixture', url: 'https://mcp.example/mcp', token: 'secret', readTools: ['echo'], reviewTools: [] };
  const methods = [], state = {};
  const fetchImpl = async (url, opts) => {
    assert.equal(new URL(url).origin, 'https://mcp.example'); assert.equal(opts.redirect, 'error');
    const headers = new Headers(opts.headers); assert.equal(headers.get('authorization'), 'Bearer secret');
    if (opts.method === 'GET') return new Response(null, { status: 405 });
    const req = JSON.parse(opts.body); methods.push(req.method);
    if (req.id == null) return new Response(null, { status: 202 });
    const tool = { name: 'echo', description: 'Echo', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false } };
    const result = req.method === 'initialize' ? { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } } :
      req.method === 'tools/list' ? { tools: [tool, { ...tool, name: 'not_allowed' }] } : { content: [{ type: 'text', text: req.params.arguments.text }] };
    const response = json({ jsonrpc: '2.0', id: req.id, result });
    if (req.method === 'initialize') response.headers.set('mcp-session-id', 'session-private');
    else assert.equal(headers.get('mcp-session-id'), 'session-private');
    return response;
  };
  const found = await discover(connection, { fetchImpl, state }); assert.deepEqual(found.map(t => t.name), ['echo']);
  assert.equal(state.sessionId, 'session-private');
  const result = await callConnected(connection, 'echo', { text: 'actual SDK roundtrip' }, { fetchImpl, state: structuredClone(state) }); assert.equal(result.text, 'actual SDK roundtrip'); assert.equal(result.ok, true);
  await assert.rejects(callConnected(connection, 'echo', { wrong: 1 }, { fetchImpl, state }), e => e.code === 'INVALID_TOOL_ARGUMENTS');
  assert.equal(methods.filter(m => m === 'tools/call').length, 1);
  assert.equal(methods.filter(m => m === 'initialize').length, 1, 'browser/tool session survives separate function requests');
});

test('connection access and read/write policy are server-owned and fail closed', () => {
  const config = { id: 'github', url: 'https://api.githubcopilot.com/mcp/', tokenEnv: 'MCP_TOKEN', users: ['owner'], readTools: ['get_file'], reviewTools: ['create_issue'] };
  const env = { AGENT_MCP_SERVERS: JSON.stringify([config]), MCP_TOKEN: 'secret' };
  assert.equal(connections(env, 'other').length, 0);
  const c = connections(env, 'owner')[0]; assert.equal(requiresReview(c, 'get_file'), false); assert.equal(requiresReview(c, 'create_issue'), true);
  assert.throws(() => requiresReview(c, 'delete_repository'), e => e.code === 'TOOL_NOT_ALLOWED');
  for (const url of ['http://example.test/mcp', 'https://127.0.0.1/mcp', 'https://localhost/mcp', 'https://user:pass@example.test/mcp']) {
    assert.throws(() => connections({ ...env, AGENT_MCP_SERVERS: JSON.stringify([{ ...config, url }]) }, 'owner'), e => e.code === 'INVALID_MCP_CONFIG');
  }
});
