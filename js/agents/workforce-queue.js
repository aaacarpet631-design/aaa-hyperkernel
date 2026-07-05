/*
 * AAA Workforce Queue — the auditable job ledger for the agent workforce.
 *
 * Every unit of standing-agent work is a JOB with a deterministic state
 * machine. Transitions outside the map are REFUSED (no job can teleport from
 * queued to completed), timestamps are set by the queue (not the caller),
 * and every transition is chained into the audit ledger with the entry id
 * recorded back on the job (auditRefs) — so "what did the workforce do while
 * I was away" is a query, not an act of faith.
 *
 *   queued → running | cancelled
 *   running → awaiting_approval | completed | failed | blocked
 *   awaiting_approval → completed | failed | cancelled
 *   blocked → queued | cancelled          (unblock = requeue, on purpose)
 *   failed → queued                       (retry is explicit)
 *   completed / cancelled → terminal
 */
;(function (global) {
  'use strict';

  const COLLECTION = 'workforce_jobs';
  const TRANSITIONS = {
    queued: ['running', 'cancelled'],
    running: ['awaiting_approval', 'completed', 'failed', 'blocked'],
    awaiting_approval: ['completed', 'failed', 'cancelled'],
    blocked: ['queued', 'cancelled', 'dead_letter'],
    failed: ['queued', 'dead_letter'],
    dead_letter: ['queued', 'cancelled'],   // revival is explicit and human
    completed: [],
    cancelled: []
  };
  const TERMINAL = { completed: true, cancelled: true };

  function cfg() { return global.AAA_CONFIG || {}; }
  function data() { return global.AAA_DATA; }
  function ids() { return global.AAA_ID_FACTORY; }
  function clock() { return global.AAA_RUNTIME_CLOCK; }
  function ledger() { return global.AAA_AUDIT_LEDGER; }
  function ws() { return cfg().workspaceId || 'default'; }
  function nowISO() { return clock() && clock().nowISO ? clock().nowISO() : new Date().toISOString(); }
  function newId(p) { return ids() && ids().createId ? ids().createId(p) : p + '_' + Math.random().toString(36).slice(2, 10); }

  const Queue = {
    COLLECTION: COLLECTION,
    STATES: Object.keys(TRANSITIONS),
    TRANSITIONS: TRANSITIONS,

    /**
     * Create a job in 'queued'. When a tickToken is supplied, enqueue is
     * IDEMPOTENT: a second enqueue for the same agent+token returns the
     * existing job (DUPLICATE_TICK) instead of creating double work — the
     * at-least-once world's retry becomes exactly-one job.
     */
    enqueue: async function (input) {
      const i = input || {};
      if (!i.agentId) return { ok: false, error: 'NO_AGENT' };
      if (!data()) return { ok: false, error: 'NO_DATA_LAYER' };
      if (i.tickToken) {
        const dup = (await this.list({ agentId: i.agentId })).filter(function (j) { return j.tickToken === i.tickToken; })[0];
        if (dup) return { ok: false, error: 'DUPLICATE_TICK', job: dup, tickToken: i.tickToken };
      }
      const rec = {
        id: newId('wjob'), workspaceId: ws(),
        agentId: i.agentId, missionId: i.missionId || null,
        tickToken: i.tickToken || null,
        trigger: i.trigger || 'schedule',
        inputSummary: i.inputSummary != null ? String(i.inputSummary).slice(0, 400) : null,
        governance: { risk: i.risk || null, killSwitch: null, notes: [] },
        outputSummary: null, error: null,
        auditRefs: [],
        status: 'queued',
        createdAt: nowISO(), startedAt: null, endedAt: null
      };
      await data().put(COLLECTION, rec.id, rec);
      try {
        const e = ledger() && ledger().append ? await ledger().append('workforce.job.queued', { jobId: rec.id, agentId: rec.agentId, trigger: rec.trigger }) : null;
        if (e && e.id) { rec.auditRefs.push(e.id); await data().put(COLLECTION, rec.id, rec); }
      } catch (_) { /* best-effort */ }
      return { ok: true, job: rec };
    },

    /** Deterministic state transition; illegal moves are refused by name. */
    transition: async function (jobId, to, patch) {
      const rec = await this.get(jobId);
      if (!rec) return { ok: false, error: 'NOT_FOUND' };
      const allowed = TRANSITIONS[rec.status] || [];
      if (allowed.indexOf(to) === -1) {
        return { ok: false, error: 'BAD_TRANSITION', from: rec.status, to: to, allowed: allowed };
      }
      const p = patch || {};
      if (p.missionId !== undefined) rec.missionId = p.missionId;
      if (p.outputSummary !== undefined) rec.outputSummary = p.outputSummary != null ? String(p.outputSummary).slice(0, 600) : null;
      if (p.error !== undefined) rec.error = p.error;
      if (p.governanceNote) rec.governance.notes.push(String(p.governanceNote));
      if (p.risk !== undefined) rec.governance.risk = p.risk;
      rec.status = to;
      if (to === 'running' && !rec.startedAt) rec.startedAt = nowISO();
      if (TERMINAL[to] || to === 'failed' || to === 'blocked' || to === 'dead_letter') rec.endedAt = nowISO();
      if (to === 'queued') { rec.endedAt = null; rec.error = null; } // retry/unblock resets
      await data().put(COLLECTION, rec.id, rec);
      try {
        const e = ledger() && ledger().append ? await ledger().append('workforce.job.' + to, { jobId: rec.id, agentId: rec.agentId, missionId: rec.missionId, error: rec.error || null }) : null;
        if (e && e.id) { rec.auditRefs.push(e.id); await data().put(COLLECTION, rec.id, rec); }
      } catch (_) { /* best-effort */ }
      return { ok: true, job: rec };
    },

    get: async function (jobId) {
      if (!data()) return null;
      const rec = await data().get(COLLECTION, jobId);
      return rec && (rec.workspaceId == null || rec.workspaceId === ws()) ? rec : null;
    },

    /** Workspace-scoped jobs, newest first; filter { agentId, status }. */
    list: async function (filter) {
      if (!data()) return [];
      const f = filter || {};
      let all = (await data().list(COLLECTION)).filter(function (r) { return r && (r.workspaceId == null || r.workspaceId === ws()); });
      if (f.agentId) all = all.filter(function (r) { return r.agentId === f.agentId; });
      if (f.status) all = all.filter(function (r) { return r.status === f.status; });
      return all.sort(function (a, b) { return String(b.createdAt || '').localeCompare(String(a.createdAt || '')); });
    }
  };

  global.AAA_WORKFORCE_QUEUE = Queue;
})(typeof window !== 'undefined' ? window : this);
