/*
 * AAA Planning Desk — objective → bounded, VALIDATED task graph.
 *
 * The planner contract from the hierarchical-teams playbook, made mechanical:
 * a planner model proposes a phase/task graph, and this module refuses to
 * accept it unless it is actually executable and safe —
 *
 *   structure   unique phase ids, dependencies that exist, no cycles
 *   safety      every state_change/deployment task carries a rollback AND a
 *               verification step (no irreversible steps without an exit)
 *   governance  approval-mode phases can only be passed with an APPROVED
 *               Decision Envelope — the planner cannot waive the human
 *   honesty     blocking_issues → the graph lands status 'blocked', and with
 *               no model configured plan() returns AI_NOT_CONFIGURED — a
 *               fabricated plan is worse than no plan
 *
 * Execution is dependency-ordered: runnable() only surfaces phases whose
 * dependencies are complete; advance() refuses out-of-order transitions.
 * setExecutor() is the governed seam (mirrors ephemeral-agent-runtime).
 */
;(function (global) {
  'use strict';

  const COLLECTION = 'task_graphs';
  const MODES = ['read_only', 'state_change', 'approval', 'deployment', 'verification'];
  const MUTATING = { state_change: true, deployment: true };

  function cfg() { return global.AAA_CONFIG || {}; }
  function data() { return global.AAA_DATA; }
  function ids() { return global.AAA_ID_FACTORY; }
  function clock() { return global.AAA_RUNTIME_CLOCK; }
  function ledger() { return global.AAA_AUDIT_LEDGER; }
  function envelope() { return global.AAA_DECISION_ENVELOPE; }
  function ws() { return cfg().workspaceId || 'default'; }
  function nowISO() { return clock() && clock().nowISO ? clock().nowISO() : new Date().toISOString(); }
  function newId(p) { return ids() && ids().createId ? ids().createId(p) : p + '_' + Math.random().toString(36).slice(2, 10); }

  const PLAN_SCHEMA = {
    type: 'object',
    properties: {
      objective: { type: 'string' },
      assumptions: { type: 'array', items: { type: 'string' } },
      phases: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            phase_id: { type: 'string' }, name: { type: 'string' },
            mode: { type: 'string', enum: MODES },
            dependencies: { type: 'array', items: { type: 'string' } },
            tasks: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  task_id: { type: 'string' }, owner_role: { type: 'string' },
                  inputs: { type: 'array', items: { type: 'string' } },
                  tools: { type: 'array', items: { type: 'string' } },
                  verification: { type: 'array', items: { type: 'string' } },
                  rollback: { type: 'array', items: { type: 'string' } }
                },
                required: ['task_id', 'owner_role']
              }
            }
          },
          required: ['phase_id', 'name', 'mode']
        }
      },
      blocking_issues: { type: 'array', items: { type: 'string' } }
    },
    required: ['objective', 'phases'],
    additionalProperties: true
  };

  const DEFAULT_SYSTEM =
    'You are the Planning Agent for AAA HyperKernel. Convert the assigned business objective into the SMALLEST bounded task graph that can succeed. ' +
    'Separate read-only discovery from state-changing execution. Every state_change or deployment task MUST carry rollback steps and a verification method. ' +
    'Mark phases that commit money, legal exposure, external communication, or deployment as mode "approval" so a human gate is enforced. ' +
    'Identify internationalization requirements explicitly (locale, currency, tax regime, jurisdiction, data residency). ' +
    'If the objective would cross tenant boundaries, do not plan it — name it in blocking_issues. ' +
    'If required information is missing, state assumptions explicitly and keep them narrow. Respond ONLY as JSON matching the required schema.';

  let EXECUTOR = null; // {name, run(spec, task, context) → {ok, output}}

  async function proxyExecutor(spec, task, context) {
    const d = data();
    const c = cfg();
    if (!d || !d.callAgent || !c.isProxyConfigured || !c.isProxyConfigured()) {
      return { ok: false, error: 'AI_NOT_CONFIGURED' };
    }
    const res = await d.callAgent({
      agent: spec.role, max_tokens: 1500, system: spec.system,
      output_config: { format: { type: 'json_schema', schema: PLAN_SCHEMA } },
      messages: [{ role: 'user', content: 'OBJECTIVE:\n' + task + '\n\nCONTEXT (JSON):\n' + JSON.stringify(context || {}, null, 2) }]
    });
    if (!res || res.ok === false) return { ok: false, error: (res && res.error) || 'CALL_FAILED' };
    let out = null;
    try { out = JSON.parse(String(res.text || '').replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '')); } catch (_) { /* fallthrough */ }
    return out ? { ok: true, output: out } : { ok: false, error: 'BAD_OUTPUT', raw: res.text };
  }

  // ---- graph validation ------------------------------------------------------
  function validateGraph(graph) {
    const issues = [];
    const g = graph || {};
    if (!g.objective) issues.push('objective required');
    const phases = Array.isArray(g.phases) ? g.phases : [];
    if (!phases.length) issues.push('at least one phase required');

    const seen = {};
    phases.forEach(function (p, idx) {
      const label = 'phase[' + idx + ']';
      if (!p || !p.phase_id) { issues.push(label + ': phase_id required'); return; }
      if (seen[p.phase_id]) issues.push(label + ': duplicate phase_id "' + p.phase_id + '"');
      seen[p.phase_id] = p;
      if (MODES.indexOf(p.mode) === -1) issues.push(p.phase_id + ': mode must be one of ' + MODES.join('|'));
    });

    // Dependencies exist + no cycles (iterative DFS).
    phases.forEach(function (p) {
      (p.dependencies || []).forEach(function (dep) {
        if (!seen[dep]) issues.push(p.phase_id + ': unknown dependency "' + dep + '"');
      });
    });
    const state = {}; // node → 1 visiting, 2 done
    function hasCycle(id, stack) {
      if (state[id] === 2) return false;
      if (state[id] === 1) { issues.push('dependency cycle: ' + stack.concat(id).join(' → ')); return true; }
      state[id] = 1;
      const p = seen[id];
      const deps = (p && p.dependencies) || [];
      for (let i = 0; i < deps.length; i++) {
        if (seen[deps[i]] && hasCycle(deps[i], stack.concat(id))) return true;
      }
      state[id] = 2;
      return false;
    }
    for (const id in seen) { if (hasCycle(id, [])) break; }

    // Mutating phases: every task needs rollback + verification.
    phases.forEach(function (p) {
      if (!p || !MUTATING[p.mode]) return;
      (p.tasks || []).forEach(function (task) {
        if (!task) return;
        if (!Array.isArray(task.rollback) || !task.rollback.length) issues.push(p.phase_id + '/' + task.task_id + ': ' + p.mode + ' task requires rollback steps');
        if (!Array.isArray(task.verification) || !task.verification.length) issues.push(p.phase_id + '/' + task.task_id + ': ' + p.mode + ' task requires a verification method');
      });
      if (!(p.tasks || []).length) issues.push(p.phase_id + ': ' + p.mode + ' phase has no tasks');
    });

    // Owner roles must exist when a registry is installed.
    const reg = global.AAA_AGENTS;
    if (reg && reg.get) {
      phases.forEach(function (p) {
        (p.tasks || []).forEach(function (task) {
          if (task && task.owner_role && !reg.get(task.owner_role)) issues.push(p.phase_id + '/' + task.task_id + ': unknown owner_role "' + task.owner_role + '"');
        });
      });
    }
    return issues.length ? { ok: false, issues: issues } : { ok: true };
  }

  const PlanningDesk = {
    COLLECTION: COLLECTION,
    PLAN_SCHEMA: PLAN_SCHEMA,
    MODES: MODES,
    validateGraph: validateGraph,

    /** Plug a governed executor (tests, native models). Pass null to restore the proxy. */
    setExecutor(ex) { EXECUTOR = (ex && typeof ex.run === 'function') ? ex : null; return { ok: true, executor: EXECUTOR ? EXECUTOR.name || 'custom' : 'proxy' }; },

    /**
     * Plan an objective: run the planner model, validate the proposed graph,
     * persist it with per-phase status. Invalid graphs are REFUSED with named
     * issues; blocking_issues land the graph as status 'blocked'.
     */
    async plan(objective, opts) {
      const o = opts || {};
      if (!objective) return { ok: false, error: 'NO_OBJECTIVE' };
      const system = global.AAA_PROMPT_REGISTRY ? await global.AAA_PROMPT_REGISTRY.resolve('planner', DEFAULT_SYSTEM) : DEFAULT_SYSTEM;
      const exec = EXECUTOR || { name: 'proxy', run: proxyExecutor };
      let result;
      try { result = await exec.run({ role: 'planner', system: system, schema: PLAN_SCHEMA }, String(objective), o.context || {}); }
      catch (e) { result = { ok: false, error: 'EXECUTOR_THREW: ' + (e && e.message) }; }
      if (!result || result.ok === false) return { ok: false, error: (result && result.error) || 'PLAN_FAILED' };

      const graph = result.output || {};
      const v = validateGraph(graph);
      if (!v.ok) return { ok: false, error: 'INVALID_GRAPH', issues: v.issues };

      const blocked = Array.isArray(graph.blocking_issues) && graph.blocking_issues.length > 0;
      const rec = {
        id: newId('plan'), workspaceId: ws(), objective: String(objective),
        assumptions: graph.assumptions || [], blockingIssues: graph.blocking_issues || [],
        status: blocked ? 'blocked' : 'active',
        phases: graph.phases.map(function (p) {
          return {
            phaseId: p.phase_id, name: p.name, mode: p.mode,
            dependencies: p.dependencies || [], tasks: p.tasks || [],
            status: 'pending', envelopeId: null, completedAt: null
          };
        }),
        createdAt: nowISO()
      };
      if (!data()) return { ok: false, error: 'NO_DATA_LAYER' };
      await data().put(COLLECTION, rec.id, rec);
      try { if (ledger() && ledger().append) await ledger().append('plan.created', { planId: rec.id, phases: rec.phases.length, status: rec.status, objective: rec.objective.slice(0, 120) }); } catch (_) {}
      return { ok: true, plan: rec };
    },

    /** Phases whose dependencies are all complete and that are still pending. */
    async runnable(planId) {
      const plan = await data().get(COLLECTION, planId);
      if (!plan) return { ok: false, error: 'NOT_FOUND' };
      if (plan.status === 'blocked') return { ok: false, error: 'PLAN_BLOCKED', issues: plan.blockingIssues };
      const done = {};
      plan.phases.forEach(function (p) { if (p.status === 'completed') done[p.phaseId] = true; });
      const ready = plan.phases.filter(function (p) {
        return p.status === 'pending' && (p.dependencies || []).every(function (d) { return done[d]; });
      });
      return { ok: true, phases: ready };
    },

    /**
     * Transition a phase. Dependency order is enforced, and an approval-mode
     * phase can only complete with an APPROVED Decision Envelope — the graph
     * cannot route around the human.
     */
    async advance(planId, phaseId, opts) {
      const o = opts || {};
      const plan = await data().get(COLLECTION, planId);
      if (!plan) return { ok: false, error: 'NOT_FOUND' };
      if (plan.status === 'blocked') return { ok: false, error: 'PLAN_BLOCKED', issues: plan.blockingIssues };
      const phase = plan.phases.filter(function (p) { return p.phaseId === phaseId; })[0];
      if (!phase) return { ok: false, error: 'UNKNOWN_PHASE', phaseId: phaseId };
      if (phase.status === 'completed') return { ok: false, error: 'ALREADY_COMPLETED' };

      const done = {};
      plan.phases.forEach(function (p) { if (p.status === 'completed') done[p.phaseId] = true; });
      const unmet = (phase.dependencies || []).filter(function (d) { return !done[d]; });
      if (unmet.length) return { ok: false, error: 'DEPENDENCIES_INCOMPLETE', unmet: unmet };

      if (phase.mode === 'approval') {
        const env = envelope();
        if (!env) return { ok: false, error: 'ENVELOPE_MODULE_MISSING', reason: 'approval phases cannot pass ungoverned' };
        if (!o.envelopeId) return { ok: false, error: 'APPROVAL_REQUIRED', reason: 'pass the id of an approved decision envelope' };
        const rec = await env.get(o.envelopeId);
        if (!rec) return { ok: false, error: 'ENVELOPE_NOT_FOUND', envelopeId: o.envelopeId };
        if (!rec.approval || rec.approval.status !== 'approved') {
          return { ok: false, error: 'ENVELOPE_NOT_APPROVED', status: rec.approval && rec.approval.status };
        }
        phase.envelopeId = o.envelopeId;
      }

      phase.status = 'completed';
      phase.completedAt = nowISO();
      if (plan.phases.every(function (p) { return p.status === 'completed'; })) plan.status = 'completed';
      await data().put(COLLECTION, plan.id, plan);
      try { if (ledger() && ledger().append) await ledger().append('plan.phase.completed', { planId: plan.id, phaseId: phaseId, mode: phase.mode, envelopeId: phase.envelopeId || null }); } catch (_) {}
      return { ok: true, plan: plan, phase: phase };
    },

    async get(planId) { return data() ? data().get(COLLECTION, planId) : null; },

    async list(filter) {
      if (!data()) return [];
      const f = filter || {};
      let all = (await data().list(COLLECTION)).filter(function (p) { return p && (p.workspaceId == null || p.workspaceId === ws()); });
      if (f.status) all = all.filter(function (p) { return p.status === f.status; });
      return all.sort(function (a, b) { return String(b.createdAt || '').localeCompare(String(a.createdAt || '')); });
    }
  };

  global.AAA_PLANNING_DESK = PlanningDesk;
})(typeof window !== 'undefined' ? window : this);
