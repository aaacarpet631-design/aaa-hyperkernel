import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { randomUUID } from 'node:crypto';
import { createHandler } from '../../netlify/functions/agent.mjs';
import { executeTool } from '../../netlify/lib/agent-tools.mjs';
import { MemoryStore, toolResponse, finalResponse } from './helpers.mjs';

const scripts = await Promise.all(['task-agent', 'chat-message-store', 'offline-chat-queue', 'chat-canvas'].map(async name =>
  [name, await readFile(new URL('../../js/copilot/' + name + '.js', import.meta.url), 'utf8')]));

function fixture() {
  const local = new Map(), remote = new MemoryStore(), requests = [];
  const state = { owner: 'owner', drop: null, statusError: null, modelCalls: 0, toolCalls: 0 };
  const handler = createHandler({ store: remote, env: { OPENAI_API_KEY: 'fixture' },
    authorize: async req => req.headers.get('authorization').slice(7), budget: async () => {},
    provider: async run => {
      state.modelCalls++;
      return run.modelCalls === 1 ? toolResponse('calculate', { operation: 'sum', values: [12, 30] }) : finalResponse('42');
    },
    execute: async (...args) => { state.toolCalls++; return executeTool(...args); }
  });
  function client(workspace = 'work') {
    const window = {
      AAA_CONFIG: { workspaceId: workspace, sessionHeaders: () => ({ authorization: 'Bearer ' + state.owner }) },
      AAA_DATA: {
        get: async (collection, id) => structuredClone(local.get(collection + '/' + id) || null),
        put: async (collection, id, value) => local.set(collection + '/' + id, structuredClone(value)),
        list: async collection => [...local.entries()].filter(([key]) => key.startsWith(collection + '/')).map(([, value]) => structuredClone(value))
      },
      crypto: { randomUUID },
      fetch: async (url, options) => {
        const body = JSON.parse(options.body); requests.push(body);
        if (body.op === 'status' && state.statusError) {
          if (state.statusError === 'network') throw new TypeError('Connection lost');
          return Response.json({ ok: false, error: state.statusError }, { status: 401 });
        }
        if (body.op === 'start' && state.drop === 'before-start') { state.drop = null; throw new TypeError('Connection lost'); }
        const response = await handler(new Request('https://fixture.test' + url, options));
        if (state.drop === 'after-' + body.op) { state.drop = null; throw new TypeError('Connection lost'); }
        return response;
      }
    };
    const context = { window, AbortSignal };
    for (const [name, source] of scripts) runInNewContext(source, context, { filename: name + '.js' });
    return window;
  }
  return { state, local, remote, requests, client };
}

const networkError = error => error.code === 'NETWORK_ERROR';
const starts = world => world.requests.filter(body => body.op === 'start');

test('a lost start request resumes after reload with its exact ID, model, files and context', async () => {
  const world = fixture(), page = world.client(); world.state.drop = 'before-start';
  const id = randomUUID();
  await assert.rejects(page.AAA_TASK_AGENT.start('Calculate the attached values', {
    taskId: id, files: [{ filename: 'values.csv', content: '12,30' }], history: 'Original conversation'
  }), networkError);
  const original = starts(world)[0];
  const run = await world.client().AAA_TASK_AGENT.resume(id);
  assert.equal(run.status, 'completed'); assert.equal(run.text, '42');
  assert.deepEqual(starts(world), [original, original]);
  assert.equal(world.state.modelCalls, 2); assert.equal(world.state.toolCalls, 1);
  assert.equal(world.remote.values.size, 1);
  const saved = world.local.get('agent_runs/' + id);
  assert.equal(saved.startRequest, undefined, 'private retry input is discarded once the server acknowledges the run');
  assert.equal(JSON.stringify(saved).includes('values.csv'), false);
});

for (const drop of ['after-start', 'after-advance']) test(drop + ' resumes the existing server task without a second start or duplicate tool', async () => {
  const world = fixture(), page = world.client(), id = randomUUID(); world.state.drop = drop;
  await assert.rejects(page.AAA_TASK_AGENT.start('Calculate', { taskId: id }), networkError);
  const run = await world.client().AAA_TASK_AGENT.resume(id);
  assert.equal(run.status, 'completed'); assert.equal(starts(world).length, 1);
  assert.equal(world.state.modelCalls, 2); assert.equal(world.state.toolCalls, 1);
});

test('a saved request cannot be resubmitted under a different account or workspace', async () => {
  const world = fixture(), id = randomUUID(); world.state.drop = 'before-start';
  await assert.rejects(world.client().AAA_TASK_AGENT.start('Private task', { taskId: id }), networkError);
  world.state.owner = 'other';
  await assert.rejects(world.client().AAA_TASK_AGENT.resume(id), error => error.code === 'RECOVERY_ACCOUNT_MISMATCH');
  world.state.owner = 'owner';
  await assert.rejects(world.client('another-workspace').AAA_TASK_AGENT.resume(id), error => error.code === 'RECOVERY_WORKSPACE_MISMATCH');
  assert.equal(starts(world).length, 1); assert.equal(world.state.modelCalls, 0);
});

test('failed status checks never authorize a new start', async () => {
  const world = fixture(), id = randomUUID(); world.state.drop = 'before-start';
  await assert.rejects(world.client().AAA_TASK_AGENT.start('Task', { taskId: id }), networkError);
  for (const statusError of ['network', 'INVALID_SESSION', 'APP_ACCESS_DENIED']) {
    world.state.statusError = statusError;
    await assert.rejects(world.client().AAA_TASK_AGENT.resume(id), error => error.code === (statusError === 'network' ? 'NETWORK_ERROR' : statusError));
  }
  assert.equal(starts(world).length, 1);
});

test('expired retry inputs and a changed workspace model policy cannot restart a task', async () => {
  const world = fixture(), id = randomUUID(); world.state.drop = 'before-start';
  await assert.rejects(world.client().AAA_TASK_AGENT.start('Task', { taskId: id }), networkError);
  const page = world.client();
  page.AAA_TENANT_MODEL_POLICY = { pick: async () => ({ ok: true, model: 'different-model' }) };
  await assert.rejects(page.AAA_TASK_AGENT.resume(id), error => error.code === 'NO_ALLOWED_MODEL_FOR_TENANT');
  world.local.get('agent_runs/' + id).startRequest.savedAt = Date.now() - 86400001;
  await assert.rejects(world.client().AAA_TASK_AGENT.resume(id), error => error.code === 'TASK_EXPIRED');
  assert.equal(starts(world).length, 1);
});

test('legacy missing requests and uncertain server actions are never recreated', async () => {
  const world = fixture(), page = world.client(), missingId = randomUUID();
  await page.AAA_DATA.put('agent_runs', missingId, { id: missingId, workspaceId: 'work', run: { id: missingId, status: 'starting' } });
  await assert.rejects(page.AAA_TASK_AGENT.resume(missingId), error => error.code === 'RUN_NOT_FOUND');
  const run = await page.AAA_TASK_AGENT.start('Task', { control: { stop: true } });
  const entry = [...world.remote.values.values()][0]; entry.data.lease = 'uncertain'; entry.data.busyUntil = Date.now() - 1;
  const resumed = await world.client().AAA_TASK_AGENT.resume(run.id);
  assert.equal(resumed.status, 'interrupted'); assert.equal(resumed.error, 'ACTION_OUTCOME_UNKNOWN');
  assert.equal(starts(world).length, 1); assert.equal(world.state.modelCalls, 0);
});

test('offline replay keeps failed messages queued, stops in order, and reuses the existing chat card', async () => {
  const world = fixture(), page = world.client(), queue = page.AAA_OFFLINE_CHAT_QUEUE;
  queue.setOnline(false);
  await page.AAA_CHAT_CANVAS.send('First task', { agentTask: true });
  await page.AAA_CHAT_CANVAS.send('Second task', { agentTask: true });
  const queued = await queue.pending();
  queue.setOnline(true); world.state.drop = 'after-start';
  const failed = await page.AAA_CHAT_CANVAS.replayQueue({});
  assert.equal(failed.replayed, 0); assert.equal(failed.error, 'NETWORK_ERROR');
  assert.equal((await queue.pending()).length, 2);
  assert.equal((await page.AAA_CHAT_MESSAGE_STORE.thread()).filter(m => m.role === 'user' && m.status === 'queued').length, 2);
  const reloaded = world.client();
  const replayed = await reloaded.AAA_CHAT_CANVAS.replayQueue({});
  assert.equal(replayed.replayed, 2); assert.equal((await reloaded.AAA_OFFLINE_CHAT_QUEUE.pending()).length, 0);
  const messages = await reloaded.AAA_CHAT_MESSAGE_STORE.thread();
  assert.equal(messages.filter(m => m.role === 'user').length, 2);
  assert.equal(messages.filter(m => m.role === 'assistant').length, 2);
  assert.equal(messages.filter(m => m.card?.run?.id === queued[0].opts.taskId).length, 1);
  assert.deepEqual(starts(world).map(body => body.id), queued.map(item => item.opts.taskId));
  assert.equal(world.state.toolCalls, 2);
});
