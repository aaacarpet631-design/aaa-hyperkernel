/*
 * AAA Tool Forge — dynamic interface generation, the mirror of agent DNA.
 *
 * If agents are spliced dynamically but bolted to static hardcoded tools, the
 * bottleneck just moves. The Forge maintains no repository of OpenAPI specs:
 * when the Agent Factory splices a Class C specialist, the Forge compiles the
 * exact programmatic interface the agent needs — a microscopic, single-use,
 * schema-strict tool BOUND to that agent and run — and discards it at
 * termination. The agent is handed a wrench that fits one bolt: it cannot
 * hallucinate a capability, because invoke() physically restricts what runs.
 *
 * Tool DNA registries:
 *   Protocol: GraphQL | REST | Cypher | Local_RPC | BLE_Telemetry
 *   Target:   KnowledgeGraph | PWALedger | SquarespaceWebhook | HardwareSensor
 *   Action:   Mutate | Query | Validate | Revert | Hash
 *
 * BYOT (Bring Your Own Tool): a running agent may REQUEST a tool it lacks.
 * Internal (Local_RPC) requests forge immediately; external protocols are
 * HELD fail-closed for a human with a written reason. Every forge, every
 * invocation, every discard is audited, and each forged bridge is written to
 * the Knowledge Graph (agent —forged→ tool —bridges→ target).
 *
 * Honest by construction: external/hardware protocols have NO built-in
 * drivers. Invoking an unbound tool returns TOOL_TARGET_UNBOUND — the kernel
 * never simulates telemetry. registerHandler() is the governed driver seam.
 *
 * One deliberate divergence from the "delete the code before a human even
 * realizes there was a gap" framing: tools are discarded (refuse to execute
 * forever after) but their definitions and invocation logs are immutable
 * audit state. Nothing in this kernel disappears silently.
 */
;(function (global) {
  'use strict';

  const TOOLS = 'forged_tools';
  const INVOCATIONS = 'tool_invocations';
  const REQUESTS = 'tool_requests';
  const FACTS = 'graph_facts';

  function cfg() { return global.AAA_CONFIG || {}; }
  function data() { return global.AAA_DATA; }
  function ids() { return global.AAA_ID_FACTORY; }
  function clock() { return global.AAA_RUNTIME_CLOCK; }
  function rbac() { return global.AAA_RBAC; }
  function ledger() { return global.AAA_AUDIT_LEDGER; }
  function template() { return global.AAA_AGENT_TEMPLATE; }
  function ws() { return cfg().workspaceId || 'default'; }
  function nowISO() { return clock() && clock().nowISO ? clock().nowISO() : new Date().toISOString(); }
  function mine(r) { return r && (r.workspaceId == null || r.workspaceId === ws()); }
  function newId(p) { return ids() ? ids().createId(p) : p + '_' + Date.now(); }
  function slug(v) { return String(v == null ? '' : v).toLowerCase().trim().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, ''); }
  async function audit(type, payload) { try { if (ledger() && ledger().append) await ledger().append(type, payload); } catch (_) {} }

  // ---- Tool DNA -------------------------------------------------------------
  const PROTOCOLS = ['Local_RPC', 'GraphQL', 'REST', 'Cypher', 'BLE_Telemetry'];
  const TARGETS = ['KnowledgeGraph', 'PWALedger', 'SquarespaceWebhook', 'HardwareSensor'];
  const ACTIONS = ['Mutate', 'Query', 'Validate', 'Revert', 'Hash'];
  const INTERNAL = ['Local_RPC'];                       // forge immediately
  const MUTATING = ['Mutate', 'Revert'];                // single-use by default

  function fnv1a(str) { let h = 0x811c9dc5; const s = String(str); for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0; } return ('0000000' + (h >>> 0).toString(16)).slice(-8); }
  function canonical(v) { if (v == null || typeof v !== 'object') return JSON.stringify(v === undefined ? null : v); if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']'; return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + canonical(v[k])).join(',') + '}'; }

  // Driver seam: 'Protocol|Target' → async handler(args, ctx). Built-ins are
  // local and safe; external/hardware drivers must be explicitly registered.
  const HANDLERS = {};
  function handlerKey(protocol, target) { return protocol + '|' + target; }

  HANDLERS[handlerKey('Local_RPC', 'PWALedger')] = async function (args, ctx) {
    const tool = ctx.tool;
    if (tool.action === 'Mutate') {
      const col = tool.binding.collection;
      const id = newId('led');
      const rec = Object.assign({ id: id, workspaceId: ws(), toolId: tool.id, runId: tool.boundRunId, createdAt: nowISO() }, args);
      await data().put(col, id, rec);
      return { ok: true, written: col + ':' + id };
    }
    if (tool.action === 'Validate') {
      const v = template().validateAgainst(args.payload, tool.binding.schema || tool.inputSchema);
      return { ok: true, valid: v.ok, issues: v.issues };
    }
    return { ok: false, error: 'ACTION_NOT_BOUND' };
  };

  HANDLERS[handlerKey('Local_RPC', 'KnowledgeGraph')] = async function (args, ctx) {
    const tool = ctx.tool;
    if (tool.action === 'Query') {
      const all = (await data().list(FACTS)).filter(mine).filter((f) => !f.retracted);
      const rel = args.rel ? String(args.rel) : null;
      return { ok: true, facts: all.filter((f) => !rel || f.rel === rel).slice(0, Number(args.limit) || 25) };
    }
    if (tool.action === 'Hash') return { ok: true, hash: fnv1a(canonical(args.payload)) };
    if (tool.action === 'Revert') {
      const f = await data().get(FACTS, String(args.factId || ''));
      if (!f || !f.provenance || f.provenance.runId !== tool.boundRunId) return { ok: false, error: 'NOT_YOUR_FACT' };
      await data().put(FACTS, f.id, Object.assign({}, f, { retracted: true, retractedAt: nowISO(), retractedReason: 'tool revert' }));
      return { ok: true, retracted: f.id };
    }
    return { ok: false, error: 'ACTION_NOT_BOUND' };
  };

  function validDna(protocol, target, action) {
    const issues = [];
    if (PROTOCOLS.indexOf(protocol) === -1) issues.push('unknown protocol: ' + protocol);
    if (TARGETS.indexOf(target) === -1) issues.push('unknown target: ' + target);
    if (ACTIONS.indexOf(action) === -1) issues.push('unknown action: ' + action);
    return issues;
  }

  async function mint(def, spec, runId) {
    const tool = {
      id: newId('tool'), workspaceId: ws(),
      name: def.name || (slug(def.action) + '_' + slug(def.subject || def.target)),
      protocol: def.protocol, target: def.target, action: def.action,
      inputSchema: def.inputSchema || { required: [], properties: {} },
      binding: Object.assign({}, def.binding || {}),
      boundAgentId: spec.agentId, boundAgent: spec.name, boundRunId: runId || null,
      maxInvocations: def.maxInvocations != null ? def.maxInvocations : (MUTATING.indexOf(def.action) !== -1 ? 1 : 25),
      invocations: 0, discarded: false, forgedAt: nowISO(), discardedAt: null,
      provenance: { triggerEvent: spec.triggerEvent, council: spec.council, byot: !!def.byot }
    };
    await data().put(TOOLS, tool.id, tool);
    // The new programmatic bridge is itself knowledge: agent —forged→ tool.
    const gfId = newId('gfact');
    await data().put(FACTS, gfId, {
      id: gfId, workspaceId: ws(), retracted: false,
      from: { type: 'agent', id: spec.agentId, label: spec.name },
      rel: 'forged', to: { type: 'tool', id: tool.id, label: tool.name + ' → ' + tool.target },
      provenance: { runId: runId || null, agentId: spec.agentId, toolId: tool.id },
      createdAt: nowISO()
    });
    await audit('genesis.tool_forged', { toolId: tool.id, name: tool.name, protocol: tool.protocol, target: tool.target, action: tool.action, agent: spec.name, byot: !!def.byot });
    return tool;
  }

  const Forge = {
    TOOLS: TOOLS, INVOCATIONS: INVOCATIONS, REQUESTS: REQUESTS,
    PROTOCOLS: PROTOCOLS.slice(), TARGETS: TARGETS.slice(), ACTIONS: ACTIONS.slice(),

    /** Register an external/hardware driver (governed seam). */
    registerHandler(protocol, target, fn) {
      if (typeof fn !== 'function') return { ok: false, error: 'HANDLER_REQUIRED' };
      HANDLERS[handlerKey(protocol, target)] = fn;
      return { ok: true };
    },

    /** Deterministic tool name from its DNA. */
    nameFor(action, subject) { return slug(action) + '_' + slug(subject); },

    /**
     * Compile the standard toolset for a spliced agent at spawn time: a
     * ledger-mutator per allowed write collection (single-use), a graph
     * query, a validator, and a hasher — each bound to this agent + run.
     */
    async forgeFor(spec, runId) {
      const tools = [];
      const writes = (spec.allowedWrites || []).filter((w) => w !== FACTS);
      for (const col of writes) {
        tools.push(await mint({
          name: this.nameFor('mutate', col), protocol: 'Local_RPC', target: 'PWALedger', action: 'Mutate',
          inputSchema: spec.expectedOutputSchema, binding: { collection: col }
        }, spec, runId));
      }
      tools.push(await mint({ name: this.nameFor('query', 'knowledge graph'), protocol: 'Local_RPC', target: 'KnowledgeGraph', action: 'Query', inputSchema: { required: [], properties: { rel: { type: 'string' }, limit: { type: 'number' } } } }, spec, runId));
      tools.push(await mint({ name: this.nameFor('validate', spec.targetEntity), protocol: 'Local_RPC', target: 'PWALedger', action: 'Validate', inputSchema: { required: ['payload'], properties: { payload: { type: 'object' } } }, binding: { schema: spec.expectedOutputSchema } }, spec, runId));
      tools.push(await mint({ name: this.nameFor('hash', 'payload'), protocol: 'Local_RPC', target: 'KnowledgeGraph', action: 'Hash', inputSchema: { required: ['payload'], properties: {} } }, spec, runId));
      return tools;
    },

    /**
     * BYOT: a running agent requests a tool it lacks. Internal protocols
     * forge immediately; external/hardware protocols are HELD fail-closed
     * (a human approves with a written reason). DNA is validated — an
     * unknown protocol/target/action cannot be requested into existence.
     */
    async request(spec, def, opts) {
      const o = opts || {};
      const d = def || {};
      const issues = validDna(d.protocol, d.target, d.action);
      if (issues.length) return { ok: false, error: 'INVALID_TOOL_DNA', issues: issues };
      if (INTERNAL.indexOf(d.protocol) !== -1) {
        const tool = await mint(Object.assign({ byot: true }, d), spec, o.runId || null);
        return { ok: true, tool: tool };
      }
      const id = newId('treq');
      const req = { id: id, workspaceId: ws(), spec: { agentId: spec.agentId, name: spec.name, triggerEvent: spec.triggerEvent, council: spec.council }, def: d, runId: o.runId || null, justification: String(o.justification || ''), status: 'held', heldAt: nowISO() };
      await data().put(REQUESTS, id, req);
      await audit('genesis.tool_request_held', { requestId: id, agent: spec.name, protocol: d.protocol, target: d.target, action: d.action });
      return { ok: false, held: req };
    },

    /** Release a held BYOT request — human, authority, written reason. */
    async approveRequest(requestId, opts) {
      const o = opts || {};
      const r = rbac();
      if (r && r.can && !r.can('OVERRIDE_AI_DECISION')) return { ok: false, error: 'FORBIDDEN' };
      const reason = String(o.reason == null ? '' : o.reason).trim();
      if (reason.length < 20) return { ok: false, error: 'JUSTIFICATION_REQUIRED', minChars: 20 };
      const req = await data().get(REQUESTS, requestId);
      if (!req || req.status !== 'held') return { ok: false, error: 'NOT_HELD' };
      const tool = await mint(Object.assign({ byot: true }, req.def), Object.assign({ agentId: req.spec.agentId, name: req.spec.name, triggerEvent: req.spec.triggerEvent, council: req.spec.council }, {}), req.runId);
      await data().put(REQUESTS, requestId, Object.assign({}, req, { status: 'approved', approvedAt: nowISO(), reason: reason, toolId: tool.id }));
      await audit('genesis.tool_request_approved', { requestId: requestId, toolId: tool.id, reason: reason });
      return { ok: true, tool: tool };
    },

    /**
     * Invoke a forged tool. Enforced mechanically: binding (only the bound
     * agent/run), discard state, invocation budget, args-vs-inputSchema, and
     * driver presence. Every invocation — success or failure — is logged.
     */
    async invoke(toolId, args, caller) {
      const c = caller || {};
      const tool = await data().get(TOOLS, toolId);
      const log = async (ok, error, result) => {
        const id = newId('tinv');
        await data().put(INVOCATIONS, id, { id: id, workspaceId: ws(), toolId: toolId, tool: tool ? tool.name : null, runId: c.runId || null, agentId: c.agentId || null, argsHash: fnv1a(canonical(args || {})), ok: ok, error: error || null, at: nowISO() });
        return Object.assign({ ok: ok }, error ? { error: error } : {}, result || {});
      };
      if (!tool) return log(false, 'TOOL_NOT_FOUND');
      if (tool.discarded) return log(false, 'TOOL_DISCARDED');
      if (tool.boundAgentId !== c.agentId || (tool.boundRunId && tool.boundRunId !== c.runId)) return log(false, 'TOOL_NOT_YOURS');
      if (tool.invocations >= tool.maxInvocations) return log(false, 'TOOL_EXHAUSTED');
      const v = template().validateAgainst(args || {}, tool.inputSchema);
      if (!v.ok) return log(false, 'INVALID_ARGS', { issues: v.issues });
      const handler = HANDLERS[handlerKey(tool.protocol, tool.target)];
      if (!handler) return log(false, 'TOOL_TARGET_UNBOUND');
      await data().put(TOOLS, tool.id, Object.assign({}, tool, { invocations: tool.invocations + 1 }));
      let res;
      try { res = await handler(args || {}, { tool: tool }); }
      catch (e) { return log(false, 'HANDLER_THREW: ' + (e && e.message)); }
      if (!res || res.ok === false) return log(false, (res && res.error) || 'HANDLER_FAILED');
      return log(true, null, res);
    },

    /** Discard every tool bound to a run (refuse forever; definitions remain audited). */
    async discardFor(runId) {
      const all = (await data().list(TOOLS)).filter(mine).filter((t) => t.boundRunId === runId && !t.discarded);
      for (const t of all) {
        await data().put(TOOLS, t.id, Object.assign({}, t, { discarded: true, discardedAt: nowISO() }));
        await audit('genesis.tool_discarded', { toolId: t.id, name: t.name, runId: runId, invocations: t.invocations });
      }
      return { ok: true, discarded: all.length };
    },

    async tools(filter) {
      const f = filter || {};
      let all = (await data().list(TOOLS)).filter(mine);
      if (f.runId) all = all.filter((t) => t.boundRunId === f.runId);
      return all.sort((a, b) => String(b.forgedAt || '').localeCompare(String(a.forgedAt || '')));
    },
    async requests() { return (await data().list(REQUESTS)).filter(mine); },
    async invocations(toolId) { return (await data().list(INVOCATIONS)).filter(mine).filter((i) => !toolId || i.toolId === toolId); }
  };

  global.AAA_TOOL_FORGE = Forge;
})(typeof window !== 'undefined' ? window : this);
