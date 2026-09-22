import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { OPEN_MODELS } from '../../netlify/lib/agent-models.mjs';

const source = await readFile(new URL('../../js/copilot/task-agent.js', import.meta.url), 'utf8');
function client(pick) {
  const requests = [], saved = [];
  const window = {
    AAA_CONFIG: { workspaceId: 'workspace', sessionHeaders: () => ({ authorization: 'Bearer fixture' }) },
    AAA_DATA: { put: async (...args) => saved.push(args) },
    AAA_TENANT_MODEL_POLICY: pick ? { pick } : null,
    crypto: { randomUUID: () => 'stable-client-task-id' },
    fetch: async (url, options) => {
      assert.equal(url, '/api/agent');
      const body = JSON.parse(options.body); requests.push(body);
      if (body.op === 'capabilities') return Response.json({ ok: true, models: OPEN_MODELS });
      assert.equal(body.op, 'start');
      assert.ok(saved.length, 'the run ID is persisted before start is submitted');
      return Response.json({ ok: true, run: { id: body.id, model: body.model, status: 'completed', artifacts: [], receipts: [] } });
    }
  };
  runInNewContext(source, { window, AbortSignal });
  return { agent: window.AAA_TASK_AGENT, requests };
}

test('an explicit model and queued task ID reach the server without substitution', async () => {
  for (const model of OPEN_MODELS) {
    const { agent, requests } = client();
    const run = await agent.start('Calculate 6 times 7', { model, taskId: 'queued-stable-task-id' });
    assert.equal(run.model, model);
    assert.equal(requests.at(-1).id, 'queued-stable-task-id');
    assert.equal(requests.at(-1).model, model);
  }
});

test('unavailable or workspace-replaced explicit models cannot start a paid task', async () => {
  const missing = client();
  await assert.rejects(missing.agent.start('Task', { model: 'missing/model' }), e => e.code === 'AGENT_MODEL_NOT_CONFIGURED');
  assert.equal(missing.requests.length, 1);
  const denied = client(async () => ({ ok: true, model: OPEN_MODELS[1] }));
  await assert.rejects(denied.agent.start('Task', { model: OPEN_MODELS[0] }), e => e.code === 'NO_ALLOWED_MODEL_FOR_TENANT');
  assert.equal(denied.requests.length, 1);
});
