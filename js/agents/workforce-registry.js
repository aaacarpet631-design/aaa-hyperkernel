/*
 * AAA Workforce Registry — the roster of ALWAYS-ON agents (the workforce),
 * distinct from and COMPOSED WITH the persona registry (AAA_AGENTS).
 *
 * AAA_AGENTS answers "who can think" (personas, prompts, models). This
 * registry answers "who is ON DUTY": which standing agents exist, what each
 * is for, when it runs, what it may touch, how much risk it may carry, and
 * how it is doing (health, failures, cost). Records are persisted per
 * workspace so the scheduler computes due work from stored nextRunAt — never
 * from an in-memory timer.
 *
 * Safety posture: agents register DISABLED unless explicitly enabled; the
 * department must route to a real persona (unknown departments are refused);
 * risk ceilings and approval policy are data the scheduler enforces, not
 * suggestions. Every enable/disable lands in the audit ledger.
 */
;(function (global) {
  'use strict';

  const COLLECTION = 'workforce_agents';
  const CADENCES = { '15m': 15 * 60e3, hourly: 60 * 60e3, daily: 24 * 60 * 60e3 };
  const RISKS = ['low', 'medium', 'high'];
  const MIN_CADENCE_MS = 60e3;

  function cfg() { return global.AAA_CONFIG || {}; }
  function data() { return global.AAA_DATA; }
  function clock() { return global.AAA_RUNTIME_CLOCK; }
  function ledger() { return global.AAA_AUDIT_LEDGER; }
  function desk() { return global.AAA_GLOBAL_DESK; }
  function personas() { return global.AAA_AGENTS; }
  function ws() { return cfg().workspaceId || 'default'; }
  function now() { return clock() && clock().now ? clock().now() : Date.now(); }
  function nowISO() { return clock() && clock().nowISO ? clock().nowISO() : new Date().toISOString(); }

  function cadenceMs(cadence) {
    if (CADENCES[cadence]) return CADENCES[cadence];
    const n = +cadence;
    return isFinite(n) && n >= MIN_CADENCE_MS ? n : null;
  }

  async function audit(type, payload) {
    try { if (ledger() && ledger().append) await ledger().append(type, payload); } catch (_) { /* best-effort */ }
  }

  function validateDef(def) {
    const issues = [];
    const d = def || {};
    if (!d.id || !/^[a-z][a-z0-9_]*$/.test(String(d.id))) issues.push('id required (snake_case)');
    if (!d.name) issues.push('name required');
    if (!d.purpose) issues.push('purpose required');
    if (!d.mission) issues.push('mission required (the standing objective text)');
    if (cadenceMs(d.cadence) == null) issues.push('cadence must be 15m|hourly|daily or ms >= ' + MIN_CADENCE_MS);
    if (RISKS.indexOf(d.riskCeiling) === -1) issues.push('riskCeiling must be ' + RISKS.join('|'));
    if (!Array.isArray(d.triggers) || !d.triggers.length) issues.push('triggers required (schedule | event:<type>)');
    (d.triggers || []).forEach(function (tr) {
      if (tr !== 'schedule' && !/^event:[a-z0-9_.]+$/.test(String(tr))) issues.push('bad trigger "' + tr + '"');
    });
    const gd = desk();
    const persona = d.agent || (gd && gd.routeFor ? gd.routeFor(d.department) : null);
    if (!persona) issues.push('department "' + d.department + '" does not route to a persona');
    else if (personas() && personas().get && !personas().get(persona)) issues.push('persona "' + persona + '" is not registered');
    return issues.length ? { ok: false, issues: issues } : { ok: true, persona: persona };
  }

  const Registry = {
    COLLECTION: COLLECTION,
    CADENCES: Object.keys(CADENCES),
    cadenceMs: cadenceMs,
    validateDef: validateDef,

    /** Register a standing agent. DISABLED by default — enabling is a decision. */
    register: async function (def) {
      const v = validateDef(def);
      if (!v.ok) return v;
      if (!data()) return { ok: false, error: 'NO_DATA_LAYER' };
      const existing = await data().get(COLLECTION, def.id);
      if (existing && (existing.workspaceId == null || existing.workspaceId === ws())) return { ok: false, error: 'ALREADY_REGISTERED', id: def.id };
      const rec = {
        id: def.id, workspaceId: ws(), name: String(def.name),
        department: String(def.department || ''), persona: v.persona,
        purpose: String(def.purpose), mission: String(def.mission),
        enabled: def.enabled === true,
        cadence: def.cadence, triggers: def.triggers.slice(),
        allowedTools: Array.isArray(def.allowedTools) ? def.allowedTools.slice() : [],
        dataScopes: Array.isArray(def.dataScopes) ? def.dataScopes.slice() : [],
        country: def.country || null,
        riskCeiling: def.riskCeiling,
        approvalPolicy: def.approvalPolicy === 'always' ? 'always' : 'risk_gated',
        taskKind: def.taskKind || null,
        budgetUsd: isFinite(+def.budgetUsd) && +def.budgetUsd > 0 ? +def.budgetUsd : null,
        lastRunAt: null, nextRunAt: nowISO(),
        status: def.enabled === true ? 'idle' : 'paused',
        health: 'ok', costUsd: 0, failures: 0, consecutiveFailures: 0, runs: 0,
        createdAt: nowISO()
      };
      await data().put(COLLECTION, rec.id, rec);
      await audit('workforce.agent.registered', { agentId: rec.id, department: rec.department, persona: rec.persona, enabled: rec.enabled, riskCeiling: rec.riskCeiling });
      return { ok: true, agent: rec };
    },

    /** Flip an agent on/off — an owner decision, always audited. */
    setEnabled: async function (agentId, on) {
      const rec = await this.get(agentId);
      if (!rec) return { ok: false, error: 'NOT_FOUND' };
      rec.enabled = on === true;
      rec.status = rec.enabled ? 'idle' : 'paused';
      if (rec.enabled) rec.nextRunAt = nowISO(); // due immediately on enable
      await data().put(COLLECTION, rec.id, rec);
      await audit('workforce.agent.' + (rec.enabled ? 'enabled' : 'disabled'), { agentId: rec.id });
      return { ok: true, agent: rec };
    },

    /** Record a completed tick: schedule the next one, track health + cost. */
    markRun: async function (agentId, res) {
      const r = res || {};
      const rec = await this.get(agentId);
      if (!rec) return { ok: false, error: 'NOT_FOUND' };
      const at = now();
      rec.lastRunAt = nowISO();
      rec.nextRunAt = new Date(at + cadenceMs(rec.cadence)).toISOString();
      rec.status = rec.enabled ? 'idle' : 'paused';
      rec.runs = (rec.runs || 0) + 1;
      rec.costUsd = Math.round(((rec.costUsd || 0) + (+r.costUsd || 0)) * 10000) / 10000;
      if (r.ok === false) {
        rec.failures = (rec.failures || 0) + 1;
        rec.consecutiveFailures = (rec.consecutiveFailures || 0) + 1;
        rec.health = rec.failures >= 3 ? 'failing' : 'degraded';
      } else if (r.ok === true) {
        rec.consecutiveFailures = 0;
        if (rec.health !== 'ok') rec.health = 'ok'; // a clean run restores health (failures counter stays for history)
      }
      await data().put(COLLECTION, rec.id, rec);
      return { ok: true, agent: rec };
    },

    /**
     * Quarantine: pull a repeatedly-failing agent OFF DUTY. Disabled +
     * status 'quarantined' + audited with the reason. Revival is a human
     * decision (setEnabled true), never automatic.
     */
    quarantine: async function (agentId, reason) {
      const rec = await this.get(agentId);
      if (!rec) return { ok: false, error: 'NOT_FOUND' };
      rec.enabled = false;
      rec.status = 'quarantined';
      await data().put(COLLECTION, rec.id, rec);
      await audit('workforce.agent.quarantined', { agentId: rec.id, reason: reason || null, consecutiveFailures: rec.consecutiveFailures || 0 });
      return { ok: true, agent: rec };
    },

    /** Transient status while the scheduler is executing this agent. */
    setStatus: async function (agentId, status) {
      const rec = await this.get(agentId);
      if (!rec) return { ok: false, error: 'NOT_FOUND' };
      rec.status = status;
      await data().put(COLLECTION, rec.id, rec);
      return { ok: true };
    },

    get: async function (agentId) {
      if (!data()) return null;
      const rec = await data().get(COLLECTION, agentId);
      return rec && (rec.workspaceId == null || rec.workspaceId === ws()) ? rec : null;
    },

    list: async function (filter) {
      if (!data()) return [];
      const f = filter || {};
      let all = (await data().list(COLLECTION)).filter(function (r) { return r && (r.workspaceId == null || r.workspaceId === ws()); });
      if (f.enabled != null) all = all.filter(function (r) { return r.enabled === f.enabled; });
      if (f.department) all = all.filter(function (r) { return r.department === f.department; });
      return all.sort(function (a, b) { return String(a.id).localeCompare(String(b.id)); });
    },

    /**
     * The five safe default agents. All DISABLED, all draft-only by mission
     * text, all low risk ceiling. Idempotent — existing records are kept.
     */
    seedDefaults: async function () {
      const defaults = [
        { id: 'lead_watcher', name: 'Lead Watcher', department: 'sales', riskCeiling: 'low', cadence: 'hourly', triggers: ['schedule', 'event:lead.created'], dataScopes: ['leads', 'customers'], purpose: 'Watch new leads and draft follow-up recommendations.', mission: 'Review recent leads and draft follow-up recommendations for the owner. Drafts and recommendations only — do not send anything.' },
        { id: 'estimate_guardian', name: 'Estimate Guardian', department: 'finance', riskCeiling: 'low', cadence: 'daily', triggers: ['schedule', 'event:estimate.added'], dataScopes: ['quotes', 'price_book'], purpose: 'Check estimates for margin and risk; draft owner-review notes.', mission: 'Review recent estimates for margin and risk problems and draft owner-review notes. Drafts only — never change a price.' },
        { id: 'review_collector', name: 'Review Collector', department: 'customer', riskCeiling: 'low', cadence: 'daily', triggers: ['schedule', 'event:job.closed'], dataScopes: ['jobs', 'customers'], purpose: 'Watch completed jobs and draft review-request actions.', mission: 'Review recently completed jobs and draft review-request actions for the owner to approve. Drafts only — do not contact customers.' },
        { id: 'repo_watcher', name: 'Repo Watcher', department: 'analytics', riskCeiling: 'low', cadence: 'daily', triggers: ['schedule'], dataScopes: ['events'], purpose: 'Watch repository PR/CI state and draft owner summaries.', mission: 'Summarize repository pull-request and CI state for the owner as a draft briefing. Read-only analysis — take no repository actions.' },
        { id: 'morning_briefing', name: 'Morning Briefing', department: 'executive', riskCeiling: 'low', cadence: 'daily', triggers: ['schedule'], dataScopes: ['jobs', 'quotes', 'leads'], purpose: 'Compile the daily operational summary.', mission: 'Compile a daily operational briefing (jobs, quotes, leads, exceptions) for the owner. Summary only — recommend, never act.' }
      ];
      let installed = 0;
      for (const d of defaults) {
        const existing = await this.get(d.id);
        if (existing) continue;
        const r = await this.register(d);
        if (r.ok) installed++;
      }
      return { ok: true, installed: installed, total: defaults.length };
    }
  };

  global.AAA_WORKFORCE_REGISTRY = Registry;
})(typeof window !== 'undefined' ? window : this);
