/*
 * AAA Mission Manager — the Global Agent Manager, built ON TOP of everything.
 *
 * Accepts a mission and drives it through the full hierarchy without
 * replacing a single existing module:
 *
 *   tenant     AAA_TENANT_GUARD deep-scans the context — cross-tenant
 *              missions are refused before any model sees them
 *   risk       classifyRisk(): safety gate + escalation policy → low|medium|
 *              high|critical (deterministic, token-free)
 *   plan       AAA_PLANNING_DESK builds the validated task graph
 *   delegate   AAA_GLOBAL_DESK dispatches each task to its department persona
 *              with the mission's market context — every result arrives as a
 *              sealed Decision Envelope
 *   review     AAA_REVIEW_PROTOCOL audits every envelope; a critical reject
 *              blocks the phase (the brake works mechanically)
 *   approve    approval phases PAUSE the mission; only a human-approved
 *              envelope passes (the manager cannot approve its own work)
 *   reroute    a failed delegation is retried ONCE through the supervisor
 *              persona and the reroute is recorded — never silently dropped
 *   ledger     every transition lands in the hash-chained audit ledger
 *
 * Honest by construction: no planner model → no mission ('a fabricated plan
 * is worse than no plan'); missing guard/desk/reviewer → named refusal, not
 * a permissive default.
 */
;(function (global) {
  'use strict';

  const COLLECTION = 'missions';
  const REROUTE_ROLE = 'supervisor';

  function cfg() { return global.AAA_CONFIG || {}; }
  function flag(k, d) { return cfg().flag ? cfg().flag(k, d) : d; }
  function data() { return global.AAA_DATA; }
  function ids() { return global.AAA_ID_FACTORY; }
  function clock() { return global.AAA_RUNTIME_CLOCK; }
  function ledger() { return global.AAA_AUDIT_LEDGER; }
  function guard() { return global.AAA_TENANT_GUARD; }
  function planner() { return global.AAA_PLANNING_DESK; }
  function desk() { return global.AAA_GLOBAL_DESK; }
  function reviewer() { return global.AAA_REVIEW_PROTOCOL; }
  function gate() { return global.AAA_ACTION_GATE; }
  function escalation() { return global.AAA_ESCALATION; }
  function ws() { return cfg().workspaceId || 'default'; }
  function nowISO() { return clock() && clock().nowISO ? clock().nowISO() : new Date().toISOString(); }
  function newId(p) { return ids() && ids().createId ? ids().createId(p) : p + '_' + Math.random().toString(36).slice(2, 10); }

  async function audit(type, payload) {
    try { if (ledger() && ledger().append) await ledger().append(type, payload); } catch (_) { /* best-effort */ }
  }

  function taskText(task, phase) {
    const parts = ['Task ' + task.task_id + ' of phase "' + phase.name + '"'];
    if (Array.isArray(task.inputs) && task.inputs.length) parts.push('Inputs: ' + task.inputs.join(', '));
    if (Array.isArray(task.tools) && task.tools.length) parts.push('Tools: ' + task.tools.join(', '));
    if (Array.isArray(task.verification) && task.verification.length) parts.push('Verify by: ' + task.verification.join('; '));
    return parts.join('. ');
  }

  const MissionManager = {
    COLLECTION: COLLECTION,

    /**
     * Deterministic, token-free risk classification for a mission.
     * deny from the gate → critical; gate approval-flag or escalation
     * high-stakes → high; material money → medium; else low.
     */
    classifyRisk: function (mission, opts) {
      const o = opts || {};
      const reasons = [];
      let level = 'low';
      const g = gate();
      if (g && g.assess) {
        const r = g.assess(String(mission || ''));
        if (r.decision === 'deny') { level = 'critical'; reasons.push('safety gate: DENY (' + (r.categories || []).join(',') + ')'); }
        else if (r.decision === 'needs_approval') { level = 'high'; reasons.push('safety gate: needs approval (' + (r.categories || []).join(',') + ')'); }
      }
      const e = escalation();
      const amount = o.impact && isFinite(+o.impact.amount) ? +o.impact.amount : null;
      if (level !== 'critical' && e && e.assess) {
        const ctx = amount != null ? { estimates: [{ estimatedQuoteRange: '$' + amount }] } : {};
        const s = e.assess(ctx, { recommendation: String(mission || '') });
        if (s.highStakes) { if (level === 'low' || level === 'medium') level = 'high'; reasons.push('escalation: high-stakes'); }
      }
      if (level === 'low' && amount != null && amount >= +flag('missionMaterialUsd', 750)) { level = 'medium'; reasons.push('material money: ' + amount); }
      return { level: level, reasons: reasons };
    },

    /**
     * Accept a mission: tenant-guard the context, classify risk, build the
     * validated plan. Returns the persisted mission (status 'active', or
     * 'blocked' if the planner flagged blocking issues).
     */
    start: async function (mission, opts) {
      const o = opts || {};
      if (!mission) return { ok: false, error: 'NO_MISSION' };
      if (!data()) return { ok: false, error: 'NO_DATA_LAYER' };
      const tg = guard();
      if (!tg) return { ok: false, error: 'TENANT_GUARD_MISSING', reason: 'unguarded missions are not allowed' };
      const gc = tg.guardContext(o.context);
      if (!gc.ok) return { ok: false, error: 'TENANT_BOUNDARY', foreign: gc.foreign };
      const pd = planner();
      if (!pd) return { ok: false, error: 'PLANNING_DESK_MISSING' };

      const risk = this.classifyRisk(mission, o);
      const planned = await pd.plan(String(mission), { context: Object.assign({}, o.context || {}, { risk: risk.level, country: o.country || null }) });
      if (!planned.ok) return { ok: false, error: planned.error, issues: planned.issues };

      const rec = {
        id: newId('mission'), workspaceId: ws(), mission: String(mission),
        planId: planned.plan.id, country: o.country || null, impact: o.impact || null,
        risk: risk, status: planned.plan.status === 'blocked' ? 'blocked' : 'active',
        phaseResults: {}, pendingApprovals: [], reroutes: [], failures: [],
        createdAt: nowISO(), closedAt: null
      };
      await data().put(COLLECTION, rec.id, rec);
      await audit('mission.started', { missionId: rec.id, planId: rec.planId, risk: risk.level, country: rec.country, status: rec.status });
      return { ok: true, mission: rec };
    },

    /**
     * Execute every currently-runnable phase once. Non-approval phases are
     * delegated task-by-task and reviewed; approval phases pause the mission
     * with their envelopes listed in pendingApprovals. Call step() again
     * after humans approve (via approvePhase) to continue.
     */
    step: async function (missionId) {
      const m = await data().get(COLLECTION, missionId);
      if (!m) return { ok: false, error: 'NOT_FOUND' };
      if (m.status === 'blocked' || m.status === 'completed' || m.status === 'failed') return { ok: false, error: 'MISSION_' + m.status.toUpperCase() };
      const pd = planner(), gd = desk(), rp = reviewer();
      if (!gd) return { ok: false, error: 'GLOBAL_DESK_MISSING' };
      if (!rp) return { ok: false, error: 'REVIEW_PROTOCOL_MISSING', reason: 'unreviewed delegation is not allowed' };

      const run = await pd.runnable(m.planId);
      if (!run.ok) return { ok: false, error: run.error, issues: run.issues };
      const activity = [];

      for (const phase of run.phases) {
        if (phase.mode === 'approval') {
          // Delegate the gate question itself, then PAUSE for the human.
          for (const task of (phase.tasks || [])) {
            const already = m.pendingApprovals.filter(function (p) { return p.phaseId === phase.phaseId && p.taskId === task.task_id; })[0];
            if (already) continue;
            const d = await gd.dispatch(taskText(task, phase) + '. Decide whether to approve proceeding; state the commitment plainly.', {
              agent: task.owner_role, country: m.country || undefined, impact: m.impact || undefined,
              context: { missionId: m.id, phaseId: phase.phaseId, mode: 'approval' }
            });
            if (!d.ok) { m.failures.push({ phaseId: phase.phaseId, taskId: task.task_id, error: d.error }); continue; }
            m.pendingApprovals.push({ phaseId: phase.phaseId, taskId: task.task_id, envelopeId: d.envelope.id, status: d.approval.status });
            activity.push({ phase: phase.phaseId, task: task.task_id, kind: 'approval_requested', envelopeId: d.envelope.id });
          }
          continue;
        }

        // Delegate every task; reroute a failure once through the supervisor.
        let phaseOk = true;
        const envelopes = [];
        for (const task of (phase.tasks || [])) {
          let d = await gd.dispatch(taskText(task, phase), {
            agent: task.owner_role, country: m.country || undefined,
            context: { missionId: m.id, phaseId: phase.phaseId, objective: m.mission }
          });
          if (!d.ok && task.owner_role !== REROUTE_ROLE) {
            m.reroutes.push({ phaseId: phase.phaseId, taskId: task.task_id, from: task.owner_role, to: REROUTE_ROLE, cause: d.error });
            await audit('mission.reroute', { missionId: m.id, phaseId: phase.phaseId, taskId: task.task_id, from: task.owner_role, to: REROUTE_ROLE, cause: d.error });
            d = await gd.dispatch(taskText(task, phase), { agent: REROUTE_ROLE, country: m.country || undefined, context: { missionId: m.id, phaseId: phase.phaseId, objective: m.mission, reroutedFrom: task.owner_role } });
          }
          if (!d.ok) {
            phaseOk = false;
            m.failures.push({ phaseId: phase.phaseId, taskId: task.task_id, error: d.error });
            activity.push({ phase: phase.phaseId, task: task.task_id, kind: 'failed', error: d.error });
            continue;
          }
          // Independent review — the brake that works mechanically.
          const rev = await rp.reviewEnvelope(d.envelope.id, { context: { missionId: m.id, phaseId: phase.phaseId } });
          if (rev.ok && rev.enforcement === 'envelope_rejected') {
            phaseOk = false;
            m.failures.push({ phaseId: phase.phaseId, taskId: task.task_id, error: 'REVIEW_REJECTED', reviewId: rev.verdict.id });
            activity.push({ phase: phase.phaseId, task: task.task_id, kind: 'review_rejected', reviewId: rev.verdict.id });
            continue;
          }
          envelopes.push(d.envelope.id);
          activity.push({ phase: phase.phaseId, task: task.task_id, kind: 'completed', envelopeId: d.envelope.id, reviewed: rev.ok === true });
        }

        if (phaseOk) {
          const adv = await pd.advance(m.planId, phase.phaseId);
          if (adv.ok) {
            m.phaseResults[phase.phaseId] = { envelopes: envelopes, completedAt: nowISO() };
            await audit('mission.phase.completed', { missionId: m.id, phaseId: phase.phaseId, envelopes: envelopes.length });
          }
        }
      }

      // Recompute status from the plan's truth, not from optimism.
      const plan = await pd.get(m.planId);
      const stillPending = m.pendingApprovals.filter(function (p) { return !plan.phases.some(function (ph) { return ph.phaseId === p.phaseId && ph.status === 'completed'; }); });
      if (plan.status === 'completed') { m.status = 'completed'; m.closedAt = nowISO(); }
      else if (m.failures.length && activity.every(function (a) { return a.kind === 'failed' || a.kind === 'review_rejected'; }) && activity.length) m.status = 'needs_revision';
      else if (stillPending.length && activity.filter(function (a) { return a.kind === 'completed'; }).length === 0) m.status = 'awaiting_approval';
      else m.status = 'active';
      await data().put(COLLECTION, m.id, m);
      if (m.status === 'completed') await audit('mission.completed', { missionId: m.id, planId: m.planId, reroutes: m.reroutes.length, failures: m.failures.length });
      return { ok: true, mission: m, activity: activity };
    },

    /**
     * Pass a human-approved envelope through an approval phase. The manager
     * NEVER approves envelopes itself — this only forwards a decision a human
     * already made (planning-desk re-verifies the approval).
     */
    approvePhase: async function (missionId, phaseId, envelopeId) {
      const m = await data().get(COLLECTION, missionId);
      if (!m) return { ok: false, error: 'NOT_FOUND' };
      const adv = await planner().advance(m.planId, phaseId, { envelopeId: envelopeId });
      if (!adv.ok) return adv;
      m.phaseResults[phaseId] = { envelopes: [envelopeId], completedAt: nowISO() };
      m.pendingApprovals = m.pendingApprovals.filter(function (p) { return p.phaseId !== phaseId; });
      const plan = await planner().get(m.planId);
      m.status = plan.status === 'completed' ? 'completed' : 'active';
      if (m.status === 'completed') m.closedAt = nowISO();
      await data().put(COLLECTION, m.id, m);
      await audit('mission.gate.passed', { missionId: m.id, phaseId: phaseId, envelopeId: envelopeId });
      return { ok: true, mission: m };
    },

    get: async function (missionId) { return data() ? data().get(COLLECTION, missionId) : null; },

    /** Workspace-scoped missions, newest first; filter { status }. */
    list: async function (filter) {
      if (!data()) return [];
      const f = filter || {};
      let all = (await data().list(COLLECTION)).filter(function (r) { return r && (r.workspaceId == null || r.workspaceId === ws()); });
      if (f.status) all = all.filter(function (r) { return r.status === f.status; });
      return all.sort(function (a, b) { return String(b.createdAt || '').localeCompare(String(a.createdAt || '')); });
    }
  };

  global.AAA_MISSION_MANAGER = MissionManager;
})(typeof window !== 'undefined' ? window : this);
