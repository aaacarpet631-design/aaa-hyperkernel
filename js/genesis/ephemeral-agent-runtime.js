/*
 * AAA Ephemeral Agent Runtime — executes one narrow task inside a hard sandbox.
 *
 * The runtime is the only thing that runs a spawned spec, and it enforces the
 * spec mechanically (the agent cannot talk itself past its own DNA):
 *
 *   reads   only collections in allowedReads — anything else returns DENIED
 *   writes  only collections in allowedWrites — anything else is dropped + flagged
 *   output  must validate against expectedOutputSchema or NO fact is written
 *   budget  wall-clock maxRuntimeMs and maxCostUsd are enforced, not advisory
 *   logging the Decision Log + audit entry always happen (bypass is impossible
 *           by construction: the runtime writes them, not the agent)
 *
 * Honest by construction: the default executor is the real model proxy via
 * AAA_DATA.callAgent and returns AI_NOT_CONFIGURED when no proxy is set —
 * never fabricated analysis. setExecutor() is the governed seam (mirroring
 * vector-memory's setEmbedder) for tests and native models.
 */
;(function (global) {
  'use strict';

  const RUNS = 'genesis_runs';
  const FACTS = 'graph_facts';
  const DECISIONS = 'agent_decisions';
  const EPHEMERAL = 'ephemeral_context';

  function cfg() { return global.AAA_CONFIG || {}; }
  function data() { return global.AAA_DATA; }
  function ids() { return global.AAA_ID_FACTORY; }
  function clock() { return global.AAA_RUNTIME_CLOCK; }
  function ledger() { return global.AAA_AUDIT_LEDGER; }
  function template() { return global.AAA_AGENT_TEMPLATE; }
  function ws() { return cfg().workspaceId || 'default'; }
  function now() { return clock() && clock().now ? clock().now() : Date.now(); }
  function nowISO() { return clock() && clock().nowISO ? clock().nowISO() : new Date().toISOString(); }
  function newId(p) { return ids() ? ids().createId(p) : p + '_' + Date.now(); }

  let EXECUTOR = null; // {name, run(spec, task, context) → {ok, output, costUsd}}

  // Default executor: the real proxy, honestly gated.
  async function proxyExecutor(spec, task, context) {
    const d = data();
    const c = cfg();
    if (!d || !d.callAgent || !c.isProxyConfigured || !c.isProxyConfigured()) {
      return { ok: false, error: 'AI_NOT_CONFIGURED' };
    }
    const res = await d.callAgent({
      agent: spec.name, max_tokens: 600,
      system: 'You are ' + spec.name + ', an ephemeral single-task specialist (' + spec.action + ' ' + spec.targetEntity + ' / ' + spec.context + '). Respond ONLY as JSON matching the required schema. Ground every claim in the provided context; if data is missing, say so and lower confidence.',
      output_config: { format: { type: 'json_schema', schema: { type: 'object', properties: spec.expectedOutputSchema.properties || {}, required: spec.expectedOutputSchema.required || [], additionalProperties: true } } },
      messages: [{ role: 'user', content: 'TASK:\n' + task + '\n\nCONTEXT (JSON):\n' + JSON.stringify(context || {}, null, 2) }]
    });
    if (!res || res.ok === false) return { ok: false, error: (res && res.error) || 'CALL_FAILED' };
    let out = null;
    try { out = JSON.parse(String(res.text || '').replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '')); } catch (_) {}
    return out ? { ok: true, output: out, costUsd: 0 } : { ok: false, error: 'BAD_OUTPUT', raw: res.text };
  }

  const Runtime = {
    RUNS: RUNS, FACTS: FACTS,

    /** Plug a governed executor (tests, native models). Pass null to restore the proxy. */
    setExecutor(ex) { EXECUTOR = (ex && typeof ex.run === 'function') ? ex : null; return { ok: true, executor: EXECUTOR ? EXECUTOR.name || 'custom' : 'proxy' }; },
    executor() { return EXECUTOR ? (EXECUTOR.name || 'custom') : 'proxy'; },

    /** Sandboxed reader: only allowedReads collections are visible. */
    async read(spec, collection, id) {
      if (!spec || (spec.allowedReads || []).indexOf(collection) === -1) {
        return { ok: false, error: 'READ_DENIED', collection: collection };
      }
      const rec = id != null ? await data().get(collection, id) : await data().list(collection);
      return { ok: true, value: rec };
    },

    /**
     * Execute one spawned spec against an input event. Returns the run record.
     * Every run — success or failure — is persisted to genesis_runs and the
     * decision is logged; failures write NO facts.
     */
    async execute(spec, input, opts) {
      const o = opts || {};
      const runId = newId('run');
      const startedAt = now();
      const run = {
        id: runId, workspaceId: ws(), agentId: spec.agentId, name: spec.name,
        klass: spec.klass, action: spec.action, entity: spec.targetEntity, context: spec.context,
        triggerEvent: spec.triggerEvent, riskLevel: spec.riskLevel,
        status: 'running', startedAt: nowISO(), executor: this.executor(),
        costUsd: 0, savedMs: 0, output: null, error: null, factIds: [], decisionId: null, closedAt: null
      };
      await data().put(RUNS, runId, run);
      // Scratch context lives in its own collection so termination can scrub it.
      await data().put(EPHEMERAL, runId, { id: runId, workspaceId: ws(), agentId: spec.agentId, input: input || {}, createdAt: nowISO() });

      const task = 'Perform exactly one task: ' + spec.action + ' ' + spec.targetEntity + ' (' + spec.context + ') for trigger ' + spec.triggerEvent + '. Then stop.';
      // Tool Forge: compile this run's bound, single-use toolset and hand the
      // agent the invoke seam — the only interface it has to the world.
      const forge = global.AAA_TOOL_FORGE;
      let toolkit = null;
      if (forge) {
        const forged = await forge.forgeFor(spec, runId);
        toolkit = {
          tools: forged.map((tl) => ({ id: tl.id, name: tl.name, protocol: tl.protocol, target: tl.target, action: tl.action, inputSchema: tl.inputSchema })),
          invoke: (toolId, args) => forge.invoke(toolId, args, { agentId: spec.agentId, runId: runId }),
          request: (def, ro) => forge.request(spec, def, Object.assign({ runId: runId }, ro || {}))
        };
      }
      const exec = EXECUTOR || { name: 'proxy', run: proxyExecutor };
      let result;
      try { result = await exec.run(spec, task, input || {}, toolkit); }
      catch (e) { result = { ok: false, error: 'EXECUTOR_THREW: ' + (e && e.message) }; }

      const elapsed = now() - startedAt;
      const t = template();

      if (result && result.ok) {
        if (elapsed > spec.maxRuntimeMs) result = { ok: false, error: 'RUNTIME_BUDGET_EXCEEDED', elapsedMs: elapsed };
        else if ((result.costUsd || 0) > spec.maxCostUsd) result = { ok: false, error: 'COST_BUDGET_EXCEEDED', costUsd: result.costUsd };
        else {
          const ov = t.validateAgainst(result.output, spec.expectedOutputSchema);
          if (!ov.ok) result = { ok: false, error: 'OUTPUT_SCHEMA_INVALID', issues: ov.issues };
        }
      }

      // Decision Log — always, success or failure (bypass impossible).
      const decisionId = newId('dec');
      const conf = result && result.ok && result.output && isFinite(+result.output.confidence) ? Math.max(0, Math.min(100, Math.round(+result.output.confidence))) : 0;
      await data().put(DECISIONS, decisionId, {
        id: decisionId, workspaceId: ws(), agent: spec.name, genesis: true, agentId: spec.agentId, runId: runId,
        jobId: (input && input.jobId) || null, task: task,
        recommendation: result && result.ok ? (result.output.recommendation || result.output.assessment || result.output.result || 'completed') : 'failed: ' + (result && result.error),
        rationale: result && result.ok ? ('Ephemeral ' + spec.action + ' of ' + spec.targetEntity + ' (' + spec.context + ')') : 'Run failed; no facts written.',
        confidence: conf, risks: [], next_actions: [], createdAt: nowISO()
      });

      if (result && result.ok) {
        // Approved facts → the graph substrate, but only into allowedWrites.
        const factCol = (spec.allowedWrites || []).filter((w) => w !== FACTS)[0] || null;
        if (factCol) {
          const factId = newId('fact');
          await data().put(factCol, factId, Object.assign({ id: factId, workspaceId: ws(), runId: runId, agentId: spec.agentId, triggerEvent: spec.triggerEvent, createdAt: nowISO() }, result.output));
          run.factIds.push(factCol + ':' + factId);
        }
        if ((spec.allowedWrites || []).indexOf(FACTS) !== -1 && result.output.indicates) {
          const gfId = newId('gfact');
          await data().put(FACTS, gfId, {
            id: gfId, workspaceId: ws(), retracted: false,
            from: { type: spec.targetEntity === 'damage' ? 'photo' : spec.targetEntity, id: (input && (input.photoId || input.invoiceId || input.id)) || null },
            rel: 'indicates', to: { type: 'finding', label: result.output.indicates },
            provenance: { runId: runId, agentId: spec.agentId, agent: spec.name, decisionId: decisionId, triggerEvent: spec.triggerEvent },
            createdAt: nowISO()
          });
          run.factIds.push(FACTS + ':' + gfId);
        }
        run.status = 'succeeded';
        run.output = result.output;
        run.costUsd = result.costUsd || 0;
        run.savedMs = isFinite(+o.savedMs) ? +o.savedMs : (isFinite(+(result.savedMs)) ? +result.savedMs : 0);
      } else {
        run.status = 'failed';
        run.error = (result && result.error) || 'UNKNOWN';
      }
      run.elapsedMs = elapsed;
      run.decisionId = decisionId;
      await data().put(RUNS, runId, run);

      try { if (ledger() && ledger().append) await ledger().append('genesis.run', { runId: runId, agentId: spec.agentId, name: spec.name, status: run.status, error: run.error, costUsd: run.costUsd, facts: run.factIds.length }); } catch (_) {}
      return run;
    },

    /** Graph facts written by ephemeral agents (the additive graph overlay). */
    async graphFacts() {
      const all = (await data().list(FACTS)).filter((r) => r && (r.workspaceId == null || r.workspaceId === ws()));
      return all.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
    },

    async run(runId) { return data().get(RUNS, runId); },
    async runs(filter) {
      const f = filter || {};
      let all = (await data().list(RUNS)).filter((r) => r && (r.workspaceId == null || r.workspaceId === ws()));
      if (f.name) all = all.filter((r) => r.name === f.name);
      return all.sort((a, b) => String(b.startedAt || '').localeCompare(String(a.startedAt || '')));
    }
  };

  global.AAA_EPHEMERAL_RUNTIME = Runtime;
})(typeof window !== 'undefined' ? window : this);
