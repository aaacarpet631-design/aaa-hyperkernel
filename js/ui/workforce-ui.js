/*
 * AAA Workforce UI — the Agent Workforce Command Center, in the app.
 *
 * One panel where the owner sees and steers the standing agents: who is on
 * duty, enabled/paused, health, last/next run, failures, cost, the latest
 * job (and its mission/approval state), plus explicit controls — Run now,
 * Pause/Enable, View log, Open approvals. The kill-switch state is shown
 * honestly: when continuous execution is OFF the panel says so and still
 * shows all state (visibility without execution).
 *
 * Same interaction contract as the approval inbox: renderModel() is pure,
 * every button dispatches through ONE act() path shared with tests, a
 * single delegated listener per host, live re-render after every action,
 * and honest notes when an action is refused. UI gating is a courtesy —
 * the scheduler enforces RBAC/enablement/governance again itself.
 */
;(function (global) {
  'use strict';

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]); }); }
  async function quiet(fn, d) { try { const r = await fn(); return r == null ? d : r; } catch (_) { return d; } }

  function registry() { return global.AAA_WORKFORCE_REGISTRY; }
  function queue() { return global.AAA_WORKFORCE_QUEUE; }
  function scheduler() { return global.AAA_WORKFORCE_SCHEDULER; }
  function rbac() { return global.AAA_RBAC; }
  function uikit() { return global.AAA_UI; }

  function canManage() {
    const r = rbac();
    return !r || !r.can ? true : !!r.can('MANAGE_AUTOMATION');
  }
  function fmtTime(iso) { return iso ? String(iso).replace('T', ' ').slice(0, 16) : '—'; }

  let LOG_AGENT = null; // which agent's job log is expanded

  const WorkforceUI = {
    /** Pure read model: agents + latest job + counts + kill-switch state. */
    renderModel: async function () {
      const model = { canManage: canManage(), continuousEnabled: false, agents: [], counts: { enabled: 0, awaiting: 0, failing: 0 } };
      const s = scheduler();
      model.continuousEnabled = !!(s && s.enabled && s.enabled());
      const reg = registry();
      if (!reg) return model;
      const agents = await quiet(function () { return reg.list(); }, []);
      const q = queue();
      for (const a of agents) {
        const jobs = q ? await quiet(function () { return q.list({ agentId: a.id }); }, []) : [];
        const last = jobs[0] || null;
        const awaiting = jobs.filter(function (j) { return j.status === 'awaiting_approval'; }).length;
        model.agents.push({
          id: a.id, name: a.name, department: a.department, persona: a.persona,
          purpose: a.purpose, enabled: a.enabled, status: a.status, health: a.health,
          cadence: a.cadence, riskCeiling: a.riskCeiling,
          lastRunAt: a.lastRunAt, nextRunAt: a.nextRunAt,
          failures: a.failures || 0, runs: a.runs || 0, costUsd: a.costUsd || 0,
          lastJob: last ? { id: last.id, status: last.status, missionId: last.missionId, error: last.error, trigger: last.trigger } : null,
          awaiting: awaiting,
          log: LOG_AGENT === a.id ? jobs.slice(0, 8).map(function (j) { return { id: j.id, status: j.status, trigger: j.trigger, error: j.error, at: j.createdAt }; }) : null
        });
        if (a.enabled) model.counts.enabled++;
        model.counts.awaiting += awaiting;
        if (a.health === 'failing') model.counts.failing++;
      }
      return model;
    },

    /** One dispatch path for buttons and tests alike. */
    act: async function (action, refs) {
      const r = refs || {};
      if (action === 'toggle') {
        if (!canManage()) return { ok: false, error: 'FORBIDDEN', required: 'MANAGE_AUTOMATION' };
        const reg = registry();
        if (!reg) return { ok: false, error: 'REGISTRY_MISSING' };
        const agent = await reg.get(r.agentId);
        if (!agent) return { ok: false, error: 'NOT_FOUND' };
        return reg.setEnabled(r.agentId, !agent.enabled);
      }
      if (action === 'run') {
        const s = scheduler();
        if (!s) return { ok: false, error: 'SCHEDULER_MISSING' };
        return s.runNow(r.agentId); // RBAC + enablement + governance enforced inside
      }
      if (action === 'log') { LOG_AGENT = LOG_AGENT === r.agentId ? null : r.agentId; return { ok: true, log: LOG_AGENT }; }
      if (action === 'approvals') {
        const inbox = global.AAA_APPROVAL_INBOX_UI;
        if (!inbox || !inbox.open) return { ok: false, error: 'APPROVAL_INBOX_MISSING' };
        return inbox.open();
      }
      if (action === 'tick') {
        const s = scheduler();
        if (!s) return { ok: false, error: 'SCHEDULER_MISSING' };
        if (!canManage()) return { ok: false, error: 'FORBIDDEN', required: 'MANAGE_AUTOMATION' };
        return s.runDue();
      }
      return { ok: false, error: 'UNKNOWN_ACTION', action: action };
    },

    agentRowHtml: function (a, opts) {
      const o = opts || {};
      const controls = o.canManage
        ? '<button type="button" class="wf-btn" data-act="run" data-agent="' + esc(a.id) + '">Run now</button>' +
          '<button type="button" class="wf-btn" data-act="toggle" data-agent="' + esc(a.id) + '">' + (a.enabled ? 'Pause' : 'Enable') + '</button>'
        : '';
      const logBtn = '<button type="button" class="wf-btn" data-act="log" data-agent="' + esc(a.id) + '">View log</button>';
      const approvalsBtn = a.awaiting > 0 ? '<button type="button" class="wf-btn wf-btn--attn" data-act="approvals" data-agent="' + esc(a.id) + '">Open approval (' + a.awaiting + ')</button>' : '';
      const lastJob = a.lastJob ? esc(a.lastJob.status) + (a.lastJob.error ? ' — ' + esc(a.lastJob.error) : '') : 'no runs yet';
      const log = (a.log || []).map(function (j) {
        return '<div class="wf-log-row">' + esc(fmtTime(j.at)) + ' · ' + esc(j.trigger) + ' · ' + esc(j.status) + (j.error ? ' — ' + esc(j.error) : '') + '</div>';
      }).join('');
      return '<div class="wf-row" data-agent="' + esc(a.id) + '">' +
        '<div class="wf-head"><strong>' + esc(a.name) + '</strong> · ' + esc(a.department) + ' · ' + (a.enabled ? 'enabled' : 'paused') + ' · ' + esc(a.status) + ' · health ' + esc(a.health) + '</div>' +
        '<div class="wf-meta">cadence ' + esc(a.cadence) + ' · risk ≤ ' + esc(a.riskCeiling) + ' · runs ' + esc(a.runs) + ' · failures ' + esc(a.failures) + ' · cost $' + esc(a.costUsd) + '</div>' +
        '<div class="wf-meta">last ' + esc(fmtTime(a.lastRunAt)) + ' · next ' + esc(fmtTime(a.nextRunAt)) + ' · last job: ' + lastJob + '</div>' +
        '<div class="wf-actions">' + controls + logBtn + approvalsBtn + '</div>' +
        (a.log ? '<div class="wf-log">' + (log || '<div class="wf-log-row">no jobs</div>') + '</div>' : '') +
        '</div>';
    },

    /** Delegated click handler — thin DOM adapter over act(). */
    _onClick: async function (evTarget, host) {
      const btn = evTarget && evTarget.closest ? evTarget.closest('.wf-btn') : null;
      if (!btn || !btn.getAttribute) return null;
      const res = await this.act(btn.getAttribute('data-act'), { agentId: btn.getAttribute('data-agent') });
      if (host) {
        if (res && res.ok === false) {
          const note = res.error === 'FORBIDDEN' ? 'Your role cannot manage agents (needs MANAGE_AUTOMATION).' : 'Refused: ' + res.error;
          host.setAttribute && host.setAttribute('data-wf-note', note);
        }
        await this.mount(host);
      }
      return res;
    },

    mount: async function (el) {
      if (typeof document === 'undefined' || !document.getElementById) return { ok: false, error: 'NO_DOM' };
      const host = el || document.getElementById('workforce-panel');
      if (!host) return { ok: false, error: 'NO_ANCHOR' };
      const model = await this.renderModel();
      const self = this;
      const rows = model.agents.map(function (a) { return self.agentRowHtml(a, { canManage: model.canManage }); }).join('');
      const note = host.getAttribute && host.getAttribute('data-wf-note');
      host.innerHTML =
        '<div class="wf-panel">' +
        '<h2 class="wf-title">Agent Workforce (' + model.counts.enabled + ' on duty)</h2>' +
        '<p class="wf-switch">' + (model.continuousEnabled
          ? 'Continuous execution is ON.'
          : 'Continuous execution is OFF (kill switch). Agents run only when you press Run now.') + '</p>' +
        (model.counts.awaiting ? '<p class="wf-attn">' + model.counts.awaiting + ' job(s) waiting on your approval.</p>' : '') +
        (model.canManage ? '' : '<p class="wf-readonly">Read-only: your role cannot manage agents.</p>') +
        (note ? '<p class="wf-note">' + esc(note) + '</p>' : '') +
        (rows || '<p class="wf-empty">No standing agents registered.</p>') +
        '</div>';
      if (host.removeAttribute) host.removeAttribute('data-wf-note');
      if (host.addEventListener && !host._wfWired) {
        host._wfWired = true;
        host.addEventListener('click', function (ev) { self._onClick(ev && ev.target, host); });
      }
      return { ok: true, counts: model.counts };
    },

    /** Command-center surface: the standard bottom sheet. */
    open: function () {
      const ui = uikit();
      if (typeof document === 'undefined' || !ui || !ui.sheet) return { ok: false, error: 'NO_DOM' };
      const s = ui.sheet({ title: 'Agent Workforce', subtitle: 'Standing agents — governed, visible, owner-controlled' });
      document.body.appendChild(s.overlay);
      this.mount(s.body);
      return { ok: true, close: s.close };
    }
  };

  global.AAA_WORKFORCE_UI = WorkforceUI;
})(typeof window !== 'undefined' ? window : this);
