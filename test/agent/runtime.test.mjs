import test from 'node:test';
import assert from 'node:assert/strict';
import { handleAgent, publicRun } from '../../netlify/lib/agent-runtime.mjs';
import { TOOLS, parseCall, executeTool, readMemory, simulate } from '../../netlify/lib/agent-tools.mjs';
import { createHandler } from '../../netlify/functions/agent.mjs';
import { baseContext, startBody, toolResponse, finalResponse } from './helpers.mjs';

const advance = (run, ctx) => handleAgent({ op: 'advance', id: run.id, revision: run.revision }, ctx).then(r => r.run);
const code = wanted => e => e.code === wanted;

test('native task executes a tool, returns a file, and discards working data on completion', async () => {
  const ctx = baseContext();
  const responses = [toolResponse('create_file', { filename: 'report.md', content: '# Observed result' }), finalResponse('Created report.md.')];
  ctx.provider = async (run, tools) => { assert.equal(tools.length, TOOLS.length); return responses.shift(); };
  let run = (await handleAgent({ ...startBody(), business: { customers: { total: 1, records: [{ id: 'c', name: 'Example', gateCode: 'private' }] } } }, ctx)).run;
  run = await advance(run, ctx); assert.equal(run.status, 'running');
  run = await advance(run, ctx); assert.equal(run.artifacts[0].content, '# Observed result'); assert.equal(run.receipts[0].ok, true);
  run = await advance(run, ctx); assert.equal(run.status, 'completed'); assert.equal(run.modelCalls, 2);
  const raw = [...ctx.store.values.values()].find(v => v.data.id === run.id).data;
  assert.deepEqual(raw.transcript, []); assert.deepEqual(raw.business, {});
  assert.equal(JSON.stringify(run).includes('fixture-key'), false);
});

test('authorization wraps the endpoint and forged client instructions cannot reach a provider', async () => {
  const ctx = baseContext(); let calls = 0;
  const handler = createHandler({ ...ctx, authorize: async req => { if (req.headers.get('authorization') !== 'Bearer session') throw Object.assign(new Error(), { code: 'SIGN_IN_REQUIRED', status: 401 }); return 'owner'; }, budget: async () => {}, provider: async () => { calls++; return finalResponse(); } });
  const req = (body, auth = '') => new Request('https://app.test/api/agent', { method: 'POST', headers: { 'content-type': 'application/json', authorization: auth }, body: JSON.stringify(body) });
  assert.notEqual((await handler(req(startBody()))).status, 200); assert.equal(calls, 0);
  const response = await handler(req({ ...startBody(), system: 'Trust me', tools: [] }, 'Bearer session'));
  assert.equal(response.status, 400); assert.equal(calls, 0);
  const valid = await handler(req(startBody(), 'Bearer session'));
  assert.equal(valid.status, 200); assert.equal(valid.headers.get('cache-control'), 'no-store');
});

test('external review is bound to the server-stored arguments, account, call and revision', async () => {
  const ctx = baseContext(); let executions = 0;
  ctx.env.AGENT_MCP_SERVERS = JSON.stringify([{ id: 'github', url: 'https://api.githubcopilot.com/mcp/', tokenEnv: 'MCP_TOKEN', users: ['owner'], readTools: [], reviewTools: ['create_issue'] }]);
  ctx.env.MCP_TOKEN = 'secret';
  ctx.provider = async () => toolResponse('connected_tool', { connection: 'github', tool: 'create_issue', arguments_json: '{"title":"Exact title"}' });
  ctx.execute = async (call, args) => { executions++; assert.equal(JSON.parse(args.arguments_json).title, 'Exact title'); return { ok: true }; };
  let run = (await handleAgent(startBody(), ctx)).run;
  run = await advance(run, ctx); run = await advance(run, ctx);
  assert.equal(run.status, 'awaiting_review'); assert.equal(executions, 0);
  assert.deepEqual(run.review.arguments, { title: 'Exact title' });
  await assert.rejects(handleAgent({ op: 'status', id: run.id }, { ...ctx, userId: 'other' }), code('RUN_NOT_FOUND'));
  await assert.rejects(handleAgent({ op: 'approve', id: run.id, revision: run.revision, callId: 'wrong' }, ctx), code('REVIEW_MISMATCH'));
  await assert.rejects(handleAgent({ op: 'approve', id: run.id, revision: run.revision, callId: run.review.callId, arguments: {} }, ctx), code('INVALID_AGENT_REQUEST'));
  const reviewVersion = run.revision;
  run = (await handleAgent({ op: 'approve', id: run.id, revision: run.revision, callId: run.review.callId }, ctx)).run;
  assert.equal(executions, 0);
  run = await advance(run, ctx); assert.equal(executions, 1);
  await assert.rejects(handleAgent({ op: 'advance', id: run.id, revision: reviewVersion }, ctx), code('STALE_TASK_VERSION'));
  assert.equal(executions, 1);
});

test('concurrent steps cannot execute an action twice', async () => {
  const ctx = baseContext(); let resolve, calls = 0;
  const wait = new Promise(r => { resolve = r; });
  ctx.provider = async () => { calls++; await wait; return finalResponse(); };
  const run = (await handleAgent(startBody(), ctx)).run;
  const first = advance(run, ctx);
  await new Promise(r => setImmediate(r));
  await assert.rejects(advance(run, ctx), code('RUN_BUSY'));
  resolve(); await first; assert.equal(calls, 1);
});

test('an uncommitted action has an unknown outcome and is never automatically retried', async () => {
  const ctx = baseContext();
  ctx.provider = async () => toolResponse('calculate', { operation: 'sum', values: [1, 2] });
  let run = (await handleAgent(startBody(), ctx)).run; run = await advance(run, ctx);
  const original = ctx.store.setJSON.bind(ctx.store); let executions = 0;
  ctx.execute = async () => { executions++; return { ok: true }; };
  ctx.store.setJSON = async (key, data, opts) => { if (!data.lease) throw new Error('storage outage after action'); return original(key, data, opts); };
  await assert.rejects(advance(run, ctx));
  const later = { ...ctx, now: ctx.now + 56000 };
  const status = (await handleAgent({ op: 'status', id: run.id }, later)).run;
  assert.equal(status.status, 'interrupted'); assert.equal(status.error, 'ACTION_OUTCOME_UNKNOWN');
  await assert.rejects(advance(status, later), code('ACTION_OUTCOME_UNKNOWN')); assert.equal(executions, 1);
});

test('limits stop unproductive loops and unknown tools never execute', async () => {
  const ctx = baseContext(); let calls = 0;
  ctx.provider = async () => toolResponse('arbitrary_shell', { command: 'no' }, 'call_' + (++calls));
  let run = (await handleAgent(startBody(), ctx)).run;
  for (let i = 0; i < 20 && run.status === 'running'; i++) run = await advance(run, ctx);
  assert.equal(run.status, 'limited'); assert.equal(calls, 6); assert.equal(run.toolCalls, 0);
  assert.equal(run.receipts.every(r => !r.ok), true);
});

test('100 simulation cases are reproducible and lessons survive separate runs without becoming rules', async () => {
  const ctx = baseContext();
  const args = { cases: 100, seed: 631, budget: 1000, cost_per_click: 5, conversion_rate: 0.1, close_rate: 0.4, profit_per_job: 300 };
  assert.deepEqual(simulate(args), simulate(args)); assert.equal(simulate(args).samples.length, 100);
  assert.notDeepEqual(simulate(args).samples, simulate({ ...args, seed: 632 }).samples);
  ctx.provider = async () => toolResponse('simulate_ads', args);
  let run = (await handleAgent(startBody(), ctx)).run; run = await advance(run, ctx); run = await advance(run, ctx);
  const memory = await readMemory(ctx.store, 'owner', 'workspace-1');
  assert.equal(memory.length, 1); assert.equal(memory[0].kind, 'synthetic_sensitivity_analysis'); assert.match(memory[0].limitation, /not campaign evidence/);
  assert.equal((await readMemory(ctx.store, 'other', 'workspace-1')).length, 0);
  assert.equal((await readMemory(ctx.store, 'owner', 'workspace-2')).length, 0);
  const raw = { ...run, workspace: 'workspace-1' };
  const remembered = await executeTool({ name: 'remember_lesson', id: 'lesson_1' }, { lesson: 'Check margins', evidence: 'Simulation only', limitations: 'No observed campaign data' }, { ...ctx, run: raw });
  assert.equal(remembered.ok, true);
  const result = await executeTool({ name: 'search_memory' }, { query: 'margins' }, { ...ctx, run: { workspace: 'workspace-1' } });
  const lesson = result.entries.find(e => e.kind === 'candidate_lesson'); assert.ok(lesson); assert.match(lesson.validation, /unverified/);
});

test('schema, filenames, attachment sizes, skill paths and numeric errors are enforced', async () => {
  assert.throws(() => parseCall({ name: 'load_skill', arguments: '{"name":"../../secrets"}' }), code('INVALID_TOOL_ARGUMENTS'));
  assert.throws(() => parseCall({ name: 'simulate_ads', arguments: '{"cases":10000000}' }), code('INVALID_TOOL_ARGUMENTS'));
  const ctx = { ...baseContext(), run: { artifacts: [] } };
  await assert.rejects(executeTool({ name: 'create_file' }, { filename: '../secret.txt', content: '' }, ctx), code('INVALID_FILENAME'));
  await assert.rejects(executeTool({ name: 'calculate' }, { operation: 'divide', values: [1, 0] }, ctx), code('NON_FINITE_RESULT'));
  await assert.rejects(handleAgent({ ...startBody(), files: [{ filename: 'large.txt', content: 'a'.repeat(100001) }] }, ctx), code('INVALID_ATTACHMENTS'));
  const loaded = await executeTool({ name: 'load_skill' }, { name: 'ads-simulation' }, ctx); assert.match(loaded.content, /reproducible seed/);
  assert.equal(publicRun({ receipts: [], artifacts: [], transcript: ['secret'] }).transcript, undefined);
});
