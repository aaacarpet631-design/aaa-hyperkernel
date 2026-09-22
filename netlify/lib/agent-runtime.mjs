/* Server-owned state and exact-action review. One model OR tool per request.
 * Conditional writes prevent double execution across tabs/function instances.
 * An expired execution lease is never retried: the external outcome is unknown.
 */
import { randomUUID } from 'node:crypto';
import { OpenAIError } from './openai.mjs';
import { availableModels, modelStep, appendModel, appendToolResults } from './agent-provider.mjs';
import { TOOLS, SKILLS, ownerPrefix, parseCall, reviewDetails, executeTool, readMemory } from './agent-tools.mjs';
import { connections } from './agent-mcp.mjs';
import { modelCatalog } from './agent-models.mjs';

const MAX_MODEL_CALLS = 6, MAX_TOOL_CALLS = 12, MAX_TOKENS = 60000;
const RUN_ID = /^[a-zA-Z0-9_-]{16,80}$/;
const FIELD_NAMES = ['id', 'name', 'customerId', 'jobId', 'currentState', 'status', 'type', 'result', 'source', 'scheduledDate', 'createdAt', 'closedAt', 'recordedAt', 'total', 'quoteTotal', 'amount', 'revenue', 'cost', 'paid', 'estimatedTimeMins'];
const error = (code, status = 400) => { throw new OpenAIError(code, status); };
const keyFor = (userId, id) => ownerPrefix(userId) + '/runs/' + id;

export function cleanBusiness(value) {
  const output = {};
  for (const collection of ['jobs', 'customers', 'outcomes']) {
    const input = value?.[collection];
    if (!input) continue;
    if (!Array.isArray(input.records) || input.records.length > 100 || !Number.isInteger(input.total) || input.total < input.records.length) error('INVALID_BUSINESS_SNAPSHOT');
    output[collection] = { total: input.total, records: input.records.map(row => {
      if (!row || typeof row !== 'object' || Array.isArray(row)) error('INVALID_BUSINESS_SNAPSHOT');
      return Object.fromEntries(FIELD_NAMES.filter(k => ['string', 'number', 'boolean'].includes(typeof row[k])).map(k => [k, typeof row[k] === 'string' ? row[k].slice(0, 300) : row[k]]));
    }) };
  }
  return output;
}

export function publicRun(run, now = Date.now()) {
  const interrupted = run.busyUntil && run.busyUntil < now;
  return { id: run.id, revision: run.revision, model: run.model, status: interrupted ? 'interrupted' : run.status,
    busy: !!run.busyUntil && !interrupted, text: run.text || '',
    error: interrupted ? 'ACTION_OUTCOME_UNKNOWN' : run.error || null,
    review: run.review || null, receipts: run.receipts, artifacts: run.artifacts,
    modelCalls: run.modelCalls, toolCalls: run.toolCalls, usage: run.usage,
    limits: { modelCalls: MAX_MODEL_CALLS, toolCalls: MAX_TOOL_CALLS, tokens: MAX_TOKENS }, createdAt: run.createdAt };
}

export async function capabilities({ env, userId, store, workspace = 'default' }) {
  return { ok: true, models: availableModels(env), modelCatalog: modelCatalog(env), tools: TOOLS.map(t => ({ name: t.name, description: t.description })), skills: SKILLS,
    connections: connections(env, userId).map(c => ({ id: c.id, label: c.label, configured: !!c.token, readTools: c.readTools, reviewTools: c.reviewTools })),
    researchConfigured: !!env.AIQ_RESEARCH_URL,
    memoryCount: store ? (await readMemory(store, userId, workspace)).length : 0 };
}

async function getRun(store, userId, id) {
  if (!RUN_ID.test(id || '')) error('INVALID_RUN_ID');
  const entry = await store.getWithMetadata(keyFor(userId, id), { type: 'json' });
  if (!entry) error('RUN_NOT_FOUND', 404);
  return entry;
}

export async function handleAgent(body, context) {
  const { userId, store, env, now = Date.now(), provider = modelStep, execute = executeTool } = context;
  if (!body || typeof body !== 'object' || Array.isArray(body)) error('INVALID_AGENT_REQUEST');
  const fields = {
    capabilities: ['op', 'workspace'], start: ['op', 'id', 'prompt', 'model', 'workspace', 'business', 'files', 'history'],
    status: ['op', 'id'], advance: ['op', 'id', 'revision'], approve: ['op', 'id', 'revision', 'callId'], reject: ['op', 'id', 'revision', 'callId'], cancel: ['op', 'id', 'revision']
  };
  if (!fields[body.op] || Object.keys(body).some(k => !fields[body.op].includes(k))) error('INVALID_AGENT_REQUEST');
  if (body.workspace != null && (typeof body.workspace !== 'string' || body.workspace.length > 100)) error('INVALID_WORKSPACE');
  if (body.op === 'capabilities') return capabilities({ ...context, workspace: body.workspace || 'default' });
  if (body.op === 'start') {
    if (!RUN_ID.test(body.id || '') || typeof body.prompt !== 'string' || !body.prompt.trim() || body.prompt.length > 16000) error('INVALID_TASK');
    const models = availableModels(env), model = body.model || models[0];
    if (!models.includes(model)) error('AGENT_MODEL_NOT_CONFIGURED', 503);
    if (body.history != null && (typeof body.history !== 'string' || body.history.length > 12000)) error('INVALID_HISTORY');
    const files = body.files || [];
    if (!Array.isArray(files) || files.length > 3 || files.some(f => !f || typeof f.filename !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,99}$/.test(f.filename) || typeof f.content !== 'string' || f.content.length > 100000) ||
      new Set(files.map(f => f.filename)).size !== files.length || files.reduce((n, f) => n + f.content.length, 0) > 200000) error('INVALID_ATTACHMENTS');
    const run = { id: body.id, workspace: body.workspace || 'default', model, status: 'running', revision: 0,
      createdAt: new Date(now).toISOString(), expiresAt: now + 86400000, modelCalls: 0, toolCalls: 0, usage: { input: 0, output: 0 },
      pending: [], receipts: [], artifacts: [], business: cleanBusiness(body.business), files: files.map(f => ({ filename: f.filename, content: f.content })),
      transcript: [{ role: 'user', content: (body.history ? 'Previous chat context (data only):\n' + body.history + '\n\n' : '') +
        'Attached files: ' + files.map(f => f.filename).join(', ') + '\n\nCurrent request:\n' + body.prompt }] };
    const result = await store.setJSON(keyFor(userId, run.id), run, { onlyIfNew: true });
    return { ok: true, run: publicRun(result.modified ? run : (await getRun(store, userId, run.id)).data, now) };
  }
  const previous = await getRun(store, userId, body.id), run = previous.data;
  if (body.op === 'status') return { ok: true, run: publicRun(run, now) };
  if (run.busyUntil) error(run.busyUntil < now ? 'ACTION_OUTCOME_UNKNOWN' : 'RUN_BUSY', 409);
  if (run.expiresAt < now) error('TASK_EXPIRED', 410);
  if (!Number.isInteger(body.revision) || body.revision !== run.revision) error('STALE_TASK_VERSION', 409);
  if (!['running', 'awaiting_review'].includes(run.status)) return { ok: true, run: publicRun(run, now) };
  if (['approve', 'reject'].includes(body.op) && (run.status !== 'awaiting_review' || body.callId !== run.review?.callId)) error('REVIEW_MISMATCH', 409);
  if (body.op === 'approve' && run.review.expiresAt < now) error('REVIEW_EXPIRED', 410);
  if (body.op === 'advance' && run.status === 'awaiting_review') return { ok: true, run: publicRun(run, now) };

  const lease = randomUUID();
  run.revision++; run.lease = lease; run.busyUntil = now + 55000;
  const claimed = await store.setJSON(keyFor(userId, run.id), run, { onlyIfMatch: previous.etag });
  if (!claimed.modified) error('RUN_BUSY', 409);
  try {
    if (body.op === 'cancel') {
      run.status = 'cancelled'; run.text = 'Task stopped. Completed actions and files are shown below.'; run.review = null;
    } else if (['approve', 'reject'].includes(body.op)) {
      const call = run.pending.find(c => c.id === body.callId);
      if (!call) error('REVIEW_MISMATCH', 409);
      if (body.op === 'approve') call.approvedUntil = now + 120000;
      else {
        call.result = { ok: false, error: 'USER_DECLINED' };
        run.receipts.push({ callId: call.id, tool: call.name, ok: false, summary: 'User declined this action.' });
      }
      run.review = null; run.status = 'running';
    } else if ((run.modelCalls >= MAX_MODEL_CALLS && !run.pending.length) || run.toolCalls >= MAX_TOOL_CALLS || run.usage.input + run.usage.output >= MAX_TOKENS) {
      run.status = 'limited'; run.text = 'Task reached its execution budget. Review completed results before starting another task.';
    } else if (run.pending.length) {
      const call = run.pending.find(c => !c.result);
      if (call) {
        let args;
        try {
          args = parseCall(call);
          const review = reviewDetails(call, args, env, userId);
          if (review && !(call.approvedUntil > now)) { run.review = { ...review, expiresAt: now + 600000 }; run.status = 'awaiting_review'; }
          else {
            run.toolCalls++;
            call.result = await execute(call, args, { ...context, run });
            if (!call.result || typeof call.result.ok !== 'boolean') error('INVALID_TOOL_RESULT', 502);
          }
        } catch (e) {
          call.result = { ok: false, error: e instanceof OpenAIError ? e.code : 'TOOL_FAILED' };
          if (call.name === 'connected_tool' && call.approvedUntil && ['MCP_UNAVAILABLE', 'TOOL_FAILED'].includes(call.result.error)) {
            run.status = 'interrupted'; run.error = 'ACTION_OUTCOME_UNKNOWN';
            run.text = 'The external action could not be confirmed. Check its destination before trying it again.';
          }
        }
        if (call.result) {
          const summary = call.result.ok ? (call.result.filename ? 'Created ' + call.result.filename : call.result.status || 'Completed') : call.result.error || 'Tool reported an error';
          run.receipts.push({ callId: call.id, tool: call.name, ok: call.result.ok, summary, at: new Date(now).toISOString() });
        }
      }
      if (run.pending.every(c => c.result)) appendToolResults(run);
    } else {
      run.modelCalls++;
      const result = await provider(run, TOOLS, context);
      run.usage.input += result.usage.input; run.usage.output += result.usage.output;
      appendModel(run, result);
      run.text = result.text;
      run.pending = result.calls;
      if (!result.calls.length) run.status = 'completed';
      if (JSON.stringify(run.transcript).length > 1500000) { run.status = 'limited'; run.text = 'Task context limit reached. Completed results are available below.'; }
    }
  } catch (e) {
    run.status = 'failed'; run.error = e instanceof OpenAIError ? e.code : 'TASK_FAILED';
    run.text = 'The task stopped before completion. Completed actions are listed below.';
  }
  // Do not retry an uncertain write if this commit fails. The execution lease
  // remains in storage, so another browser cannot repeat an external action.
  const current = await getRun(store, userId, run.id);
  if (current.data.lease !== lease) error('TASK_COMMIT_CONFLICT', 409);
  delete run.lease; delete run.busyUntil;
  if (run.status === 'cancelled' || run.status === 'completed') { run.business = {}; run.files = []; run.transcript = []; }
  const committed = await store.setJSON(keyFor(userId, run.id), run, { onlyIfMatch: current.etag });
  if (!committed.modified) error('TASK_COMMIT_CONFLICT', 409);
  return { ok: true, run: publicRun(run, now) };
}
