/*
 * AAA Command Center — executive observability over the AI Operating System.
 *
 * Read-only views of REAL shared-memory data: system health, learning metrics
 * (Supervisor), the live agent-decision feed, and the meeting log. Plus two
 * real actions: run a company standup (CEO + sub-agent meeting) and snapshot
 * KPIs. Nothing is fabricated — empty/low-data states say so honestly.
 *
 * Opened from the dashboard header. Uses the shared AAA_UI kit.
 */
;(function (global) {
  'use strict';

  function U() { return global.AAA_UI; }
  function data() { return global.AAA_DATA; }

  function fmtPct(n) { return n == null ? '—' : Math.round(n * 100) + '%'; }
  function fmtDate(ms) {
    if (!ms) return '';
    const d = new Date(ms);
    return isNaN(d.getTime()) ? '' : d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  async function open() {
    const ui = U();
    const sheet = ui.sheet({ title: 'Command Center', subtitle: 'AAA Carpet — AI operations' });
    document.body.appendChild(sheet.overlay);
    await renderInto(sheet.body);
  }

  async function renderInto(body) {
    const ui = U();
    body.innerHTML = '';
    body.appendChild(ui.spinner('Loading operations…'));

    const cfg = global.AAA_CONFIG || {};
    const jobs = await data().listJobs();
    const customers = await data().listCustomers();
    const decisions = (await data().list('agent_decisions')).slice().sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    const logs = (await data().list('agent_logs')).slice().sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    const outcomes = await data().list('outcomes');
    const metrics = global.AAA_SUPERVISOR ? await global.AAA_SUPERVISOR.metrics() : { ok: false };
    const aiReady = global.AAA_AGENT_OS && global.AAA_AGENT_OS.isReady && global.AAA_AGENT_OS.isReady();

    body.innerHTML = '';

    // ---- System health ----
    body.appendChild(section('System Health'));
    const healthRows = [
      ['Cloud (Supabase)', cfg.isSupabaseConfigured && cfg.isSupabaseConfigured() ? 'Connected' : 'Local-only', cfg.isSupabaseConfigured && cfg.isSupabaseConfigured() ? '#10B981' : '#F59E0B'],
      ['AI agents', aiReady ? 'Online' : 'Not configured', aiReady ? '#10B981' : '#F59E0B'],
      ['Customers', String(customers.length), '#A1A1AA'],
      ['Jobs', String(jobs.length), '#A1A1AA'],
      ['Agent decisions', String(decisions.length), '#A1A1AA'],
      ['Outcomes recorded', String(outcomes.length), '#A1A1AA']
    ];
    healthRows.forEach((r) => body.appendChild(kv(r[0], r[1], r[2])));
    if (!aiReady) {
      body.appendChild(ui.el('p', { className: 'aaa-dialog__message', text: 'Connect Supabase + the Claude proxy (see SETUP.md) to bring the AI team online.' }));
    }

    // ---- Learning / performance ----
    body.appendChild(section('Performance & Learning'));
    if (metrics.ok && metrics.status === 'ok') {
      body.appendChild(kv('Close rate', fmtPct(metrics.closeRate)));
      body.appendChild(kv('Recommendation calibration', fmtPct(metrics.avgCalibration)));
      body.appendChild(kv('Estimate accuracy', fmtPct(metrics.avgEstimateAccuracy)));
    } else {
      body.appendChild(ui.el('div', { className: 'aaa-list-row', html:
        '<strong>Warming up.</strong><div class="aaa-list-sub">Learning metrics unlock after a few recorded outcomes. So far: ' +
        (metrics.sample ? metrics.sample.outcomes : 0) + ' outcomes, ' + (metrics.sample ? metrics.sample.scoredDecisions : 0) + ' scored decisions.</div>' }));
    }
    // per-agent track record
    if (metrics.perAgent && Object.keys(metrics.perAgent).length) {
      body.appendChild(ui.el('h2', { className: 'aaa-section-title', text: 'Agent track record' }));
      Object.keys(metrics.perAgent).forEach((a) => {
        const p = metrics.perAgent[a];
        body.appendChild(ui.el('div', { className: 'aaa-list-row', html:
          '<strong>' + esc(a) + '</strong>' +
          '<div class="aaa-list-sub">' + p.decisions + ' decisions · avg confidence ' + (p.avgConfidence != null ? p.avgConfidence + '%' : '—') +
          ' · accuracy ' + (p.avgScore != null ? fmtPct(p.avgScore) : 'n/a (' + p.scoredCount + ' scored)') + '</div>' }));
      });
    }

    // ---- Actions ----
    const actions = ui.el('div', { className: 'closure-actions' });
    actions.appendChild(ui.button({ label: 'Run Company Standup', icon: '🧭', variant: 'primary', full: true, disabled: !aiReady, onClick: () => runStandup(body) }));
    if (global.AAA_AUTOMATION) {
      const autoOn = global.AAA_AUTOMATION.enabled();
      actions.appendChild(ui.button({
        label: 'Auto-pilot: ' + (autoOn ? 'On' : 'Off'), icon: autoOn ? '✅' : '⏸',
        variant: autoOn ? 'success' : 'secondary', full: true,
        onClick: async () => { global.AAA_AUTOMATION.setEnabled(!autoOn); await renderInto(body); }
      }));
      if (autoOn && !aiReady) body.appendChild(ui.el('p', { className: 'aaa-empty', text: 'Auto-pilot is on but idle until the AI proxy is configured.' }));
    }
    actions.appendChild(ui.button({ label: 'Snapshot KPIs', icon: '📸', variant: 'secondary', full: true, onClick: async () => {
      const m = global.AAA_SUPERVISOR ? await global.AAA_SUPERVISOR.metrics() : {};
      await data().saveKpiSnapshot('day', m);
      await renderInto(body);
    } }));
    body.appendChild(actions);

    // ---- Agent meetings ----
    body.appendChild(section('Agent Meetings'));
    const meetings = logs.filter((l) => l.agent === 'meeting').slice(0, 5);
    if (!meetings.length) body.appendChild(empty('No meetings yet.'));
    meetings.forEach((m) => {
      const d = m.context && m.context.decision;
      body.appendChild(ui.el('div', { className: 'aaa-list-row', html:
        '<strong>' + esc(m.message || 'Meeting') + '</strong>' +
        (d ? '<div class="aaa-list-sub">→ ' + esc(d.recommendation || '') + ' (' + (d.confidence != null ? d.confidence + '%' : '—') + ')</div>' : '') +
        '<div class="aaa-list-sub">' + esc(fmtDate(m.createdAt)) + '</div>' }));
    });

    // ---- Decision feed ----
    body.appendChild(section('Recent Agent Decisions'));
    const recent = decisions.slice(0, 8);
    if (!recent.length) body.appendChild(empty('No decisions yet. Open a job and tap “Ask AI Team”.'));
    recent.forEach((d) => {
      body.appendChild(ui.el('div', { className: 'aaa-list-row', html:
        '<strong>' + esc(d.agent || 'agent') + '</strong> · ' + (d.confidence != null ? d.confidence + '%' : '—') +
        (typeof d.score === 'number' ? ' · scored ' + fmtPct(d.score) : '') +
        '<div class="aaa-list-sub">' + esc(d.decision || '') + '</div>' +
        '<div class="aaa-list-sub">' + esc(fmtDate(d.createdAt)) + '</div>' }));
    });
  }

  async function runStandup(body) {
    const ui = U();
    body.innerHTML = '';
    body.appendChild(ui.spinner('The team is meeting…'));
    const jobs = await data().listJobs();
    const open = jobs.filter((j) => j.currentState !== 'CLOSED');
    const context = {
      openJobs: open.length,
      pipeline: open.map((j) => ({ customer: j.customerName, state: j.currentState, scheduled: j.scheduledDate })),
      totalCustomers: (await data().listCustomers()).length
    };
    const result = await global.AAA_AGENT_OS.runMeeting(
      'Daily standup: what are the 1-3 highest-impact things AAA Carpet should do today?',
      context, global.AAA_AGENTS.subAgents()
    );
    if (!result || !result.ok) {
      body.innerHTML = '';
      body.appendChild(ui.el('p', { className: 'aaa-dialog__message', text: 'Standup could not complete (' + ((result && result.error) || 'unknown') + ').' }));
      body.appendChild(ui.button({ label: 'Back', variant: 'ghost', full: true, onClick: () => renderInto(body) }));
      return;
    }
    // snapshot KPIs alongside the standup
    try { await data().saveKpiSnapshot('standup', global.AAA_SUPERVISOR ? await global.AAA_SUPERVISOR.metrics() : {}); } catch (_) {}
    await renderInto(body);
  }

  function section(title) { return U().el('h2', { className: 'aaa-section-title', text: title }); }
  function empty(text) { return U().el('p', { className: 'aaa-empty', text: text }); }
  function kv(k, v, color) {
    return U().el('div', { className: 'vision-row' }, [
      U().el('span', { className: 'vision-row__k', text: k }),
      U().el('span', { className: 'vision-row__v', text: v, style: color ? { color: color } : null })
    ]);
  }

  global.AAA_COMMAND_CENTER = { open: open };
})(typeof window !== 'undefined' ? window : this);
