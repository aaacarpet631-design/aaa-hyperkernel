/*
 * AAA Workforce Scheduler — deterministic ticks, not timers.
 *
 * The source of truth is PERSISTED STATE (each agent's nextRunAt), never
 * setInterval: runDue(now) computes due work from the registry and executes
 * it. A browser tab, a test, a Cloud Function cron, or a server worker can
 * all drive the same tick — the scheduler core does not know or care which
 * (see docs/CONTINUOUS_AGENT_WORKFORCE.md for the runner topology).
 *
 * Nothing runs unless EVERYTHING holds:
 *   kill switch   config 'continuousAgentsEnabled' (default FALSE) gates all
 *                 scheduled + event execution; runNow() is the one exception
 *                 (a manual, in-session owner action — still fully governed)
 *   governance    mission manager, tenant guard, planning desk, review
 *                 protocol, decision envelope, global desk must all be
 *                 present — a missing guard is a refusal, not a permission
 *   enablement    disabled agents never run, scheduled or manual
 *   risk ceiling  the mission is risk-classified (token-free) BEFORE any
 *                 model call; above the agent's ceiling → job 'blocked'
 *   governance-in-flight  all real work goes through AAA_MISSION_MANAGER,
 *                 so tenant guard, model policy, review, human approval,
 *                 reroute, and audit apply exactly as they do everywhere
 *
 * Every execution is a Workforce Queue job; a failing agent fails ITS job
 * and the tick moves on — one bad agent never takes down the tick.
 */
;(function (global) {
  'use strict';

  const RISK_RANK = { low: 1, medium: 2, high: 3, critical: 4 };
  const MAX_STEPS = 10; // deterministic bound on mission stepping per job

  function cfg() { return global.AAA_CONFIG || {}; }
  function flag(k, d) { return cfg().flag ? cfg().flag(k, d) : d; }
  function clock() { return global.AAA_RUNTIME_CLOCK; }
  function registry() { return global.AAA_WORKFORCE_REGISTRY; }
  function queue() { return global.AAA_WORKFORCE_QUEUE; }
  function missions() { return global.AAA_MISSION_MANAGER; }
  function nowISO() { return clock() && clock().nowISO ? clock().nowISO() : new Date().toISOString(); }

  const REQUIRED = ['AAA_MISSION_MANAGER', 'AAA_TENANT_GUARD', 'AAA_PLANNING_DESK', 'AAA_REVIEW_PROTOCOL', 'AAA_DECISION_ENVELOPE', 'AAA_GLOBAL_DESK', 'AAA_WORKFORCE_REGISTRY', 'AAA_WORKFORCE_QUEUE'];

  function missingGovernance() {
    return REQUIRED.filter(function (g) { return !global[g]; });
  }

  // Dead-letter policy: after N consecutive failures the agent is pulled off
  // duty (quarantined, audited) and its latest job is parked in dead_letter.
  // Revival is a human decision.
  async function maybeQuarantine(agentId, jobId) {
    const rec = await registry().get(agentId);
    const limit = +flag('workforceQuarantineAfter', 3);
    if (!rec || (rec.consecutiveFailures || 0) < limit) return false;
    await registry().quarantine(agentId, 'quarantined after ' + rec.consecutiveFailures + ' consecutive failures');
    if (jobId) { try { await queue().transition(jobId, 'dead_letter', { governanceNote: 'dead-lettered by quarantine policy' }); } catch (_) { /* best-effort */ } }
    return true;
  }

  async function executeAgent(agent, trigger, eventSummary, opts) {
    const o = opts || {};
    const q = queue();
    const mm = missions();

    // Per-agent lease: in an at-least-once world two runners may hold the
    // same due agent; only the lease holder executes (the other is deferred,
    // not failed). Absent lease module → single-runner mode, unchanged.
    const lm = global.AAA_WORKFORCE_LEASE;
    const leaseOwner = o.owner || 'local';
    if (lm) {
      const got = await lm.acquire('agent:' + agent.id, { owner: leaseOwner, ttlMs: o.leaseTtlMs });
      if (!got.ok) return { ok: false, error: 'LEASE_HELD', holder: got.holder, agentId: agent.id, deferred: true };
    }
    async function done(result) {
      if (lm) { try { await lm.release('agent:' + agent.id, leaseOwner); } catch (_) { /* best-effort */ } }
      return result;
    }

    // Idempotent tick: the same due-mark (agent + nextRunAt) enqueues once,
    // no matter how many runners or retries deliver it.
    const tickToken = o.tickToken || (trigger === 'schedule' ? 'sched@' + agent.nextRunAt : null);
    const enq = await q.enqueue({ agentId: agent.id, trigger: trigger, inputSummary: eventSummary || agent.mission, tickToken: tickToken });
    if (!enq.ok) {
      if (enq.error === 'DUPLICATE_TICK') return done({ ok: false, error: 'DUPLICATE_TICK', jobId: enq.job.id, agentId: agent.id, deferred: true });
      return done({ ok: false, error: enq.error, agentId: agent.id });
    }
    const jobId = enq.job.id;

    // Budget ceiling — spend control BEFORE any model work. Blocked, not
    // failed: raising the budget (a human decision) can requeue it.
    if (agent.budgetUsd != null && (agent.costUsd || 0) >= agent.budgetUsd) {
      await q.transition(jobId, 'running');
      await q.transition(jobId, 'blocked', { error: 'BUDGET_EXCEEDED', governanceNote: 'spent $' + agent.costUsd + ' of $' + agent.budgetUsd + ' ceiling' });
      await registry().markRun(agent.id, { ok: false });
      await maybeQuarantine(agent.id, jobId);
      return done({ ok: false, error: 'BUDGET_EXCEEDED', jobId: jobId, agentId: agent.id });
    }

    // Risk ceiling — token-free classification BEFORE any model work.
    const risk = mm.classifyRisk(agent.mission, {});
    if ((RISK_RANK[risk.level] || 4) > (RISK_RANK[agent.riskCeiling] || 1)) {
      await q.transition(jobId, 'running');
      await q.transition(jobId, 'blocked', { risk: risk.level, error: 'RISK_CEILING', governanceNote: 'mission risk ' + risk.level + ' exceeds ceiling ' + agent.riskCeiling });
      await registry().markRun(agent.id, { ok: false });
      await maybeQuarantine(agent.id, jobId);
      return done({ ok: false, error: 'RISK_CEILING', jobId: jobId, agentId: agent.id });
    }

    await q.transition(jobId, 'running', { risk: risk.level });
    await registry().setStatus(agent.id, 'running');

    // All real work goes through the mission manager — no side door.
    const started = await mm.start(agent.mission, {
      country: agent.country || undefined,
      impact: undefined,
      context: { workforceAgentId: agent.id, dataScopes: agent.dataScopes || [], trigger: trigger }
    });
    if (!started.ok) {
      await q.transition(jobId, 'failed', { error: started.error, governanceNote: 'mission refused before any model call' });
      await registry().markRun(agent.id, { ok: false });
      await maybeQuarantine(agent.id, jobId);
      return done({ ok: false, error: started.error, jobId: jobId, agentId: agent.id });
    }
    const missionId = started.mission.id;

    let mission = started.mission;
    let steps = 0;
    while (mission.status === 'active' && steps < MAX_STEPS) {
      const stepped = await mm.step(missionId);
      if (!stepped.ok) {
        await q.transition(jobId, 'failed', { missionId: missionId, error: stepped.error });
        await registry().markRun(agent.id, { ok: false });
        await maybeQuarantine(agent.id, jobId);
        return done({ ok: false, error: stepped.error, jobId: jobId, agentId: agent.id });
      }
      mission = stepped.mission;
      steps++;
    }

    let result;
    if (mission.status === 'completed') {
      const phases = Object.keys(mission.phaseResults || {}).length;
      result = await q.transition(jobId, 'completed', { missionId: missionId, outputSummary: 'mission completed: ' + phases + ' phase(s), ' + (mission.reroutes || []).length + ' reroute(s)' });
      await registry().markRun(agent.id, { ok: true });
    } else if (mission.status === 'awaiting_approval') {
      result = await q.transition(jobId, 'awaiting_approval', { missionId: missionId, outputSummary: 'paused for human approval (' + (mission.pendingApprovals || []).length + ' gate(s))', governanceNote: 'the workforce cannot approve its own work' });
      await registry().markRun(agent.id, { ok: true });
    } else if (mission.status === 'needs_revision' || mission.status === 'blocked') {
      // Carry the mission's REAL causes — an AI outage is not a review verdict.
      const causes = (mission.failures || []).map(function (f) { return f.error; });
      const err = mission.status === 'blocked' ? 'MISSION_BLOCKED' : (causes[causes.length - 1] || 'NEEDS_REVISION');
      result = await q.transition(jobId, 'blocked', { missionId: missionId, error: err, governanceNote: causes.join('; ') || null });
      await registry().markRun(agent.id, { ok: false });
      await maybeQuarantine(agent.id, jobId);
    } else {
      result = await q.transition(jobId, 'failed', { missionId: missionId, error: 'STEP_BUDGET_EXCEEDED', governanceNote: 'mission still active after ' + MAX_STEPS + ' steps' });
      await registry().markRun(agent.id, { ok: false });
      await maybeQuarantine(agent.id, jobId);
    }
    return done({ ok: result.ok !== false, jobId: jobId, missionId: missionId, status: result.job ? result.job.status : null, agentId: agent.id });
  }

  const Scheduler = {
    RISK_RANK: RISK_RANK,
    REQUIRED: REQUIRED,
    missingGovernance: missingGovernance,

    /** Is the global kill switch open? Default is OFF (false). */
    enabled: function () { return flag('continuousAgentsEnabled', false) === true; },

    /** Enabled schedule-triggered agents whose persisted nextRunAt has passed. */
    due: async function (atISO) {
      const reg = registry();
      if (!reg) return [];
      const at = atISO || nowISO();
      const all = await reg.list({ enabled: true });
      return all.filter(function (a) {
        return a.status !== 'running' && (a.triggers || []).indexOf('schedule') !== -1 && String(a.nextRunAt || '') <= at;
      });
    },

    /**
     * One deterministic tick: run every due agent exactly once. Safe to call
     * from a test, a UI button, or a server cron — state, not timers.
     */
    runDue: async function (opts) {
      const o = opts || {};
      if (!this.enabled()) return { ok: true, ran: 0, results: [], skipped: 'CONTINUOUS_AGENTS_DISABLED' };
      const missing = missingGovernance();
      if (missing.length) return { ok: false, ran: 0, error: 'GOVERNANCE_MISSING', missing: missing };
      const dueList = await this.due(o.at);
      // Concurrency cap: at most N agents execute per tick; the rest stay
      // due (their nextRunAt is untouched) and are named, not dropped.
      const cap = Math.max(1, +flag('workforceMaxConcurrent', 2));
      const toRun = dueList.slice(0, cap);
      const deferred = dueList.slice(cap).map(function (a) { return a.id; });
      const results = [];
      for (const agent of toRun) {
        try { results.push(await executeAgent(agent, 'schedule', null, { owner: o.owner })); }
        catch (e) {
          // A throwing agent fails its own lane; the tick continues.
          results.push({ ok: false, error: 'AGENT_THREW: ' + (e && e.message), agentId: agent.id });
          try { await registry().markRun(agent.id, { ok: false }); } catch (_) { /* best-effort */ }
        }
      }
      return { ok: true, ran: results.length, deferred: deferred, results: results };
    },

    /**
     * Manual, in-session owner action ("Run now"). Not gated by the kill
     * switch — it is not continuous execution — but gated by RBAC
     * (MANAGE_AUTOMATION), agent enablement, and the full governance path.
     */
    runNow: async function (agentId) {
      const rb = global.AAA_RBAC;
      if (rb && rb.can && !rb.can('MANAGE_AUTOMATION')) return { ok: false, error: 'FORBIDDEN', required: 'MANAGE_AUTOMATION' };
      const missing = missingGovernance();
      if (missing.length) return { ok: false, error: 'GOVERNANCE_MISSING', missing: missing };
      const agent = await registry().get(agentId);
      if (!agent) return { ok: false, error: 'NOT_FOUND' };
      if (!agent.enabled) return { ok: false, error: 'AGENT_DISABLED', reason: 'enable the agent first — disabled means disabled' };
      if (agent.status === 'running') return { ok: false, error: 'ALREADY_RUNNING' };
      return executeAgent(agent, 'manual', null, { owner: 'manual:' + (rb && rb.role ? rb.role() : 'owner') });
    },

    /** Event-triggered execution (continuous → kill switch applies). */
    onEvent: async function (type, payload, opts) {
      const o = opts || {};
      if (!this.enabled()) return { ok: true, ran: 0, skipped: 'CONTINUOUS_AGENTS_DISABLED' };
      const missing = missingGovernance();
      if (missing.length) return { ok: false, ran: 0, error: 'GOVERNANCE_MISSING', missing: missing };
      const trigger = 'event:' + type;
      const all = await registry().list({ enabled: true });
      const hit = all.filter(function (a) { return a.status !== 'running' && (a.triggers || []).indexOf(trigger) !== -1; });
      const results = [];
      for (const agent of hit) {
        const summary = agent.mission + ' [trigger ' + trigger + (payload && payload.id ? ' ' + payload.id : '') + ']';
        const token = payload && payload.id ? trigger + '@' + payload.id : null;
        try { results.push(await executeAgent(agent, trigger, summary, { owner: o.owner, tickToken: token })); }
        catch (e) { results.push({ ok: false, error: 'AGENT_THREW: ' + (e && e.message), agentId: agent.id }); }
      }
      return { ok: true, ran: results.length, results: results };
    }
  };

  global.AAA_WORKFORCE_SCHEDULER = Scheduler;
})(typeof window !== 'undefined' ? window : this);
