/* Client orchestration. The authenticated server owns credentials, tools,
 * task state, execution limits and exact-action approval checks. */
;(function (global) {
  'use strict';
  const FIELDS = ['id', 'name', 'customerId', 'jobId', 'currentState', 'status', 'type', 'result', 'source', 'scheduledDate', 'createdAt', 'closedAt', 'recordedAt', 'total', 'quoteTotal', 'amount', 'revenue', 'cost', 'paid', 'estimatedTimeMins'];
  const cfg = () => global.AAA_CONFIG || {};
  const workspace = () => cfg().workspaceId || 'default';
  const ERRORS = {
    SIGN_IN_REQUIRED: 'Sign in through Cloud Settings to use the task assistant.',
    INVALID_SESSION: 'Your sign-in has expired. Sign in again through Cloud Settings.',
    APP_AUTH_NOT_CONFIGURED: 'The task endpoint needs its server sign-in configuration.',
    APP_ACCESS_DENIED: 'This account is not enabled for the task assistant.',
    AGENT_MODEL_NOT_CONFIGURED: 'Connect an AI provider on the server to run tasks.',
    OPENROUTER_CREDITS_REQUIRED: 'Your OpenRouter account needs API credits. No task was completed.',
    INVALID_PROVIDER_KEY: 'The configured provider API key was rejected. Replace it in server settings.',
    RATE_LIMITED: 'The request limit was reached. Wait a minute, then resume this task.',
    RUN_BUSY: 'An action is still running. Refresh its status before continuing.',
    STALE_TASK_VERSION: 'This task changed in another tab. Refresh its status before continuing.',
    ACTION_OUTCOME_UNKNOWN: 'An action was interrupted. Check its destination before trying it again.',
    NETWORK_ERROR: 'Connection lost. Resume this task to check what finished.',
    TASK_EXPIRED: 'This task has expired. Start a new task.',
    REVIEW_EXPIRED: 'This action review has expired. Start a new task with current information.',
    NO_ALLOWED_MODEL_FOR_TENANT: 'The workspace model policy does not allow an available task model.'
  };

  async function request(body) {
    const headers = cfg().sessionHeaders ? cfg().sessionHeaders() : {};
    if (!headers.authorization) throw Object.assign(new Error(ERRORS.SIGN_IN_REQUIRED), { code: 'SIGN_IN_REQUIRED' });
    let response, result;
    try {
      response = await global.fetch('/api/agent', { method: 'POST', redirect: 'error', headers: Object.assign({ 'content-type': 'application/json' }, headers), body: JSON.stringify(body), signal: AbortSignal.timeout(50000) });
      result = await response.json();
    } catch (_) { throw Object.assign(new Error(ERRORS.NETWORK_ERROR), { code: 'NETWORK_ERROR' }); }
    if (!response.ok || !result.ok) {
      const code = result.error || 'TASK_REQUEST_FAILED';
      throw Object.assign(new Error(ERRORS[code] || ('Task request failed: ' + code)), { code: code });
    }
    return result;
  }

  async function snapshot() {
    const output = {};
    if (!global.AAA_DATA) return output;
    for (const collection of ['jobs', 'customers', 'outcomes']) {
      const records = (await global.AAA_DATA.list(collection)).filter(r => r.workspaceId == null || r.workspaceId === workspace());
      output[collection] = { total: records.length, records: records.slice(-100).map(r => Object.fromEntries(FIELDS.filter(k => ['string', 'number', 'boolean'].includes(typeof r[k])).map(k => [k, typeof r[k] === 'string' ? r[k].slice(0, 300) : r[k]]))) };
    }
    return output;
  }

  function card(run) { return { type: 'agent_task', title: 'Task assistant', run: run, summary: run.text || (run.status === 'awaiting_review' ? 'Review the proposed action.' : 'Task ' + run.status) }; }
  async function remember(run) {
    if (global.AAA_DATA) await global.AAA_DATA.put('agent_runs', run.id, { id: run.id, workspaceId: workspace(), run: run, updatedAt: Date.now() });
    return run;
  }

  const Agent = {
    request: request, snapshot: snapshot, card: card,
    errorText(code) { return ERRORS[code] || code || 'Task failed.'; },
    async capabilities() { return request({ op: 'capabilities', workspace: workspace() }); },
    async start(text, opts) {
      const o = opts || {}, caps = await this.capabilities();
      const preferred = o.model || (cfg().flag && cfg().flag('taskModel', null)) || cfg().premiumModel;
      let model = caps.models.includes(preferred) ? preferred : caps.models[0];
      if (o.model && !caps.models.includes(o.model)) model = null;
      if (!model) throw Object.assign(new Error(ERRORS.AGENT_MODEL_NOT_CONFIGURED), { code: 'AGENT_MODEL_NOT_CONFIGURED' });
      if (global.AAA_TENANT_MODEL_POLICY && global.AAA_TENANT_MODEL_POLICY.pick) {
        const picked = await global.AAA_TENANT_MODEL_POLICY.pick(model);
        if (!picked.ok || !caps.models.includes(picked.model) || (o.model && picked.model !== o.model)) throw Object.assign(new Error(ERRORS.NO_ALLOWED_MODEL_FOR_TENANT), { code: 'NO_ALLOWED_MODEL_FOR_TENANT' });
        model = picked.model;
      }
      const id = o.taskId || global.crypto.randomUUID();
      const body = { op: 'start', id: id, prompt: text, model: model, workspace: workspace(), files: o.files || [], business: o.shareBusiness ? await snapshot() : {}, history: String(o.history || '').slice(-12000) };
      // Persist the id before sending: resume an uncertain start by its id.
      const pending = { id: id, status: 'starting', revision: 0, model: model, text: 'Checking task status…', receipts: [], artifacts: [] };
      await remember(pending); if (o.onProgress) await o.onProgress(pending);
      return this.run((await request(body)).run, o);
    },
    async run(run, opts) {
      const o = opts || {};
      for (let n = 0; n < 32; n++) {
        await remember(run); if (o.onProgress) await o.onProgress(run);
        if (run.status !== 'running' || run.busy || (o.control && o.control.stop)) return run;
        run = (await request({ op: 'advance', id: run.id, revision: run.revision })).run;
      }
      return run;
    },
    async resume(id, opts) { return this.run((await request({ op: 'status', id: id })).run, opts); },
    async decide(run, approve, opts) {
      return this.run((await request({ op: approve ? 'approve' : 'reject', id: run.id, revision: run.revision, callId: run.review.callId })).run, opts);
    },
    async cancel(run) {
      const current = (await request({ op: 'status', id: run.id })).run;
      return remember((await request({ op: 'cancel', id: current.id, revision: current.revision })).run);
    },
    async files(fileList) {
      const list = Array.from(fileList || []);
      if (list.length > 3 || list.some(f => f.size > 100000 || !/\.(txt|md|csv|json|js|py|html|css|sql|yaml)$/i.test(f.name)) || list.reduce((n, f) => n + f.size, 0) > 200000) throw new Error('Attach up to 3 text, Markdown, CSV, JSON or source files, at most 100 KB each and 200 KB total.');
      const files = [];
      for (const f of list) files.push({ filename: f.name.replace(/[^a-zA-Z0-9_.-]/g, '_').replace(/^[^a-zA-Z0-9]+/, 'file_').slice(0, 100), content: await f.text() });
      if (new Set(files.map(f => f.filename)).size !== files.length) throw new Error('Attached filenames must be different.');
      return files;
    }
  };
  global.AAA_TASK_AGENT = Agent;
})(typeof window !== 'undefined' ? window : this);
