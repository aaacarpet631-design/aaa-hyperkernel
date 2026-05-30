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

  // One-line description of what each agent does (for the roster view).
  const ROLE_BLURB = {
    ceo: 'Sets strategy and makes the final call.',
    sales: 'Qualifies leads and judges deal value & close odds.',
    operations: 'Scheduling, crew capacity, and job feasibility.',
    marketing: 'Lead gen and channel ROI (ads, referrals, reviews).',
    accounting: 'Margins, pricing floors, and profitability checks.',
    customer_success: 'Retention, follow-ups, and review generation.',
    kpi: 'Surfaces the few numbers that matter and trends.',
    data_scientist: 'Finds patterns in jobs/estimates/outcomes.',
    compliance: 'Flags legal, safety, and contract risk.',
    supervisor: 'Scores the team against real outcomes so it learns.'
  };

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
    const provider = global.AAA_CLOUD ? global.AAA_CLOUD.provider() : null;
    const user = global.AAA_CLOUD && global.AAA_CLOUD.currentUser ? global.AAA_CLOUD.currentUser() : null;
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
      ['Cloud backend', provider ? ('Connected · ' + provider) : 'Local-only', provider ? '#10B981' : '#F59E0B'],
      ['AI agents', aiReady ? 'Online' : 'Not configured', aiReady ? '#10B981' : '#F59E0B'],
      (provider === 'firebase' ? ['Signed in', user ? ('yes (' + String(user).slice(0, 6) + '…)') : 'no', user ? '#10B981' : '#F59E0B'] : null),
      ['Customers', String(customers.length), '#A1A1AA'],
      ['Jobs', String(jobs.length), '#A1A1AA'],
      ['Agent decisions', String(decisions.length), '#A1A1AA'],
      ['Outcomes recorded', String(outcomes.length), '#A1A1AA']
    ];
    healthRows.filter(Boolean).forEach((r) => body.appendChild(kv(r[0], r[1], r[2])));
    if (!aiReady) {
      body.appendChild(ui.el('p', { className: 'aaa-dialog__message', text: 'Connect Supabase + the Claude proxy (see SETUP.md) to bring the AI team online.' }));
    }

    // ---- AI Team roster (what each agent does + its track record) ----
    body.appendChild(section('Your AI Team'));
    const reg = global.AAA_AGENTS;
    if (reg) {
      const order = ['ceo'].concat(reg.subAgents(), ['supervisor']);
      const per = (metrics && metrics.perAgent) || {};
      order.forEach((id) => {
        const a = reg.get(id); if (!a) return;
        const p = per[id];
        const statusDot = aiReady ? '🟢' : '⚪';
        body.appendChild(ui.el('div', { className: 'aaa-list-row', html:
          '<strong>' + statusDot + ' ' + esc(a.title) + '</strong> <span class="aaa-list-sub">' + (aiReady ? 'online' : 'standby') + '</span>' +
          '<div class="aaa-list-sub">' + esc(ROLE_BLURB[id] || '') + '</div>' +
          (p ? '<div class="aaa-list-sub">' + p.decisions + ' decisions · conf ' + (p.avgConfidence != null ? p.avgConfidence + '%' : '—') +
            (p.avgScore != null ? ' · accuracy ' + Math.round(p.avgScore * 100) + '%' : '') + '</div>' : '') }));
      });
      // Custom agents created by the Prompt Architect.
      (reg.customIds ? reg.customIds() : []).forEach((id) => {
        const a = reg.get(id); if (!a) return;
        const p = per[id];
        body.appendChild(ui.el('div', { className: 'aaa-list-row', html:
          '<strong>✨ ' + esc(a.title) + '</strong> <span class="aaa-list-sub">custom · ' + (aiReady ? 'online' : 'standby') + '</span>' +
          '<div class="aaa-list-sub">' + esc((a.spec && a.spec.mission) || '') + '</div>' +
          (p ? '<div class="aaa-list-sub">' + p.decisions + ' decisions</div>' : '') }));
      });
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
    if (global.AAA_PROMPT_ARCHITECT) {
      actions.appendChild(ui.button({ label: 'Create Agent (describe it)', icon: '✨', variant: 'primary', full: true, onClick: () => architectFlow(body) }));
    }
    actions.appendChild(ui.button({ label: 'Cloud Settings', icon: '⚙️', variant: 'secondary', full: true, onClick: () => settingsFlow(body) }));
    actions.appendChild(ui.button({ label: 'Run Company Standup', icon: '🧭', variant: 'primary', full: true, disabled: !aiReady, onClick: () => runStandup(body) }));
    if (provider === 'firebase' && global.AAA_CLOUD) {
      if (user) {
        actions.appendChild(ui.button({ label: 'Sign out of cloud', variant: 'ghost', full: true, onClick: async () => { global.AAA_CLOUD.signOut(); await renderInto(body); } }));
      } else {
        actions.appendChild(ui.button({ label: 'Sign in to cloud', icon: '🔑', variant: 'secondary', full: true, onClick: () => signInFlow(body) }));
      }
    }
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

    // ---- Marketing (real channel ROI) ----
    if (global.AAA_MARKETING) {
      body.appendChild(section('Marketing — Channel Performance'));
      const channels = await global.AAA_MARKETING.channelStats();
      if (!channels.length) body.appendChild(empty('No lead-source data yet. Add a “Lead source” when creating customers.'));
      channels.forEach((c) => body.appendChild(ui.el('div', { className: 'aaa-list-row', html:
        '<strong>' + esc(c.source) + '</strong>' +
        '<div class="aaa-list-sub">' + c.jobs + ' jobs · ' + c.customers + ' customers · close ' +
        (c.closeRate != null ? Math.round(c.closeRate * 100) + '%' : 'n/a') + '</div>' })));
      body.appendChild(ui.button({ label: 'Run Marketing Review', icon: '📈', variant: 'secondary', full: true, disabled: !aiReady, onClick: () => runMarketing(body) }));
    }

    // ---- Reviews ----
    if (global.AAA_REVIEW_REQUEST_ENGINE) {
      body.appendChild(section('Review Requests'));
      const reqs = await global.AAA_REVIEW_REQUEST_ENGINE.list();
      const sent = reqs.filter((r) => r.status === 'sent').length;
      body.appendChild(kv('Prepared', String(reqs.length)));
      body.appendChild(kv('Sent', String(sent), sent ? '#10B981' : '#A1A1AA'));
      if (!reqs.length) body.appendChild(empty('Review requests are prepared automatically when a job is closed.'));
    }

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

  function signInFlow(parentBody) {
    const ui = U();
    const s = ui.sheet({ title: 'Connect cloud', subtitle: 'Sign in with your AAA workspace account', size: 'sm' });
    document.body.appendChild(s.overlay);
    const email = ui.el('input', { className: 'aaa-input', attrs: { type: 'email', placeholder: 'Email', autocomplete: 'username' } });
    const pw = ui.el('input', { className: 'aaa-input', attrs: { type: 'password', placeholder: 'Password', autocomplete: 'current-password' } });
    const status = ui.el('p', { className: 'aaa-empty', text: '' });
    s.body.appendChild(ui.el('div', { className: 'aaa-form' }, [email, pw]));
    s.body.appendChild(status);
    async function attempt(fn) {
      status.textContent = 'Connecting…';
      const r = await fn(email.value.trim(), pw.value);
      if (r && r.ok) { s.close(); await renderInto(parentBody); }
      else { status.textContent = 'Could not sign in (' + ((r && (r.detail && r.detail.error && r.detail.error.message)) || (r && r.error) || 'error') + ').'; }
    }
    s.body.appendChild(ui.el('div', { className: 'aaa-dialog__actions' }, [
      ui.button({ label: 'Create account', variant: 'ghost', full: true, onClick: () => attempt(global.AAA_CLOUD.signUp.bind(global.AAA_CLOUD)) }),
      ui.button({ label: 'Sign in', variant: 'primary', full: true, onClick: () => attempt(global.AAA_CLOUD.signIn.bind(global.AAA_CLOUD)) })
    ]));
  }

  async function runMarketing(body) {
    const ui = U();
    body.innerHTML = '';
    body.appendChild(ui.spinner('Marketing agent reviewing channels…'));
    const res = await global.AAA_MARKETING.review();
    body.innerHTML = '';
    if (!res || !res.ok) {
      body.appendChild(ui.el('p', { className: 'aaa-dialog__message', text: 'Marketing review unavailable (' + ((res && res.error) || 'unknown') + ').' }));
      body.appendChild(ui.button({ label: 'Back', variant: 'ghost', full: true, onClick: () => renderInto(body) }));
      return;
    }
    body.appendChild(ui.el('p', { className: 'aaa-dialog__message', html: '<strong>' + esc(res.recommendation) + '</strong>' }));
    if (res.rationale) body.appendChild(ui.el('p', { className: 'aaa-detail-notes', text: res.rationale }));
    if (Array.isArray(res.next_actions) && res.next_actions.length) {
      body.appendChild(ui.el('h2', { className: 'aaa-section-title', text: 'Next actions' }));
      res.next_actions.forEach((a) => body.appendChild(ui.el('div', { className: 'aaa-list-row', text: a })));
    }
    body.appendChild(ui.button({ label: 'Back to overview', variant: 'ghost', full: true, onClick: () => renderInto(body) }));
  }

  function settingsFlow(parentBody) {
    const ui = U();
    const cfg = global.AAA_CONFIG || {};
    const s = ui.sheet({ title: 'Cloud Settings', subtitle: 'Connect Firebase (Google Cloud). Saved on this device only.' });
    document.body.appendChild(s.overlay);

    function field(label, key, placeholder, type) {
      const input = ui.el('input', { className: 'aaa-input', attrs: { type: type || 'text', placeholder: placeholder || '' } });
      input.value = (cfg[key] != null ? cfg[key] : '');
      input._key = key;
      return { wrap: ui.el('div', { className: 'aaa-form' }, [ui.el('label', { className: 'aaa-field-label', text: label }), input]), input: input };
    }
    const fields = [
      field('Firebase Project ID', 'firebaseProjectId', 'e.g. aaacarpet-12345'),
      field('Firebase Web API Key', 'firebaseApiKey', 'AIza…'),
      field('Workspace ID', 'workspaceId', 'e.g. aaa'),
      field('Business name', 'businessName', 'AAA Carpet'),
      field('Google review link', 'reviewUrl', 'https://g.page/r/…'),
      field('Cloud Function URL (optional)', 'firebaseFunctionUrl', 'https://us-central1-<id>.cloudfunctions.net/claudeProxy')
    ];
    fields.forEach((f) => s.body.appendChild(f.wrap));
    const status = ui.el('p', { className: 'aaa-empty', text: '' });
    s.body.appendChild(status);

    s.body.appendChild(ui.el('div', { className: 'aaa-dialog__actions' }, [
      ui.button({ label: 'Cancel', variant: 'ghost', full: true, onClick: () => s.close() }),
      ui.button({ label: 'Save', variant: 'primary', full: true, onClick: async () => {
        const patch = {};
        fields.forEach((f) => { patch[f.input._key] = f.input.value.trim() || null; });
        if (cfg.set) cfg.set(patch);
        s.close();
        await renderInto(parentBody);
      } })
    ]));
    status.textContent = (cfg.isFirebaseConfigured && cfg.isFirebaseConfigured())
      ? 'Connected to Firebase. Sign in to sync.'
      : 'Enter your Firebase Project ID + Web API key + a Workspace ID to connect.';
  }

  function metricBadge(label, val, kind) {
    let color = '#94A3B8';
    if (kind === 'health') { const n = parseInt(val, 10); color = n >= 80 ? '#10B981' : n >= 50 ? '#F59E0B' : '#EF4444'; }
    else if (kind === 'risk') { color = val === 'HIGH' ? '#EF4444' : val === 'MEDIUM' ? '#F59E0B' : '#10B981'; }
    else { color = val === 'HIGH' ? '#10B981' : val === 'MEDIUM' ? '#F59E0B' : '#94A3B8'; }
    return U().statusBadge(label + ': ' + val, color);
  }

  function renderSpec(container, spec, parentBody, sheet) {
    const ui = U(); const a = spec.analysis || {};
    container.innerHTML = '';
    container.appendChild(ui.el('h2', { className: 'aaa-section-title', text: spec.name || 'Agent' }));
    if (spec.mission) container.appendChild(ui.el('p', { className: 'aaa-detail-notes', text: spec.mission }));
    container.appendChild(ui.el('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '0.4rem', margin: '0.5rem 0' } }, [
      metricBadge('Health', (a.healthScore != null ? a.healthScore + '%' : '—'), 'health'),
      metricBadge('Value', a.businessValue || '—', 'good'),
      metricBadge('Automation', a.automationPotential || '—', 'good'),
      metricBadge('Risk', a.risk || '—', 'risk')
    ]));
    const list = (t, arr) => {
      if (Array.isArray(arr) && arr.length) {
        container.appendChild(ui.el('h2', { className: 'aaa-section-title', text: t }));
        arr.forEach((x) => container.appendChild(ui.el('div', { className: 'aaa-list-row', text: x })));
      }
    };
    list('Goals', spec.goals); list('Workflow', spec.workflow); list('Guardrails', spec.constraints);
    list('Escalation', spec.escalationRules); list('Integrations', spec.integrations); list('Success metrics', spec.successMetrics);
    container.appendChild(ui.el('div', { className: 'aaa-dialog__actions' }, [
      ui.button({ label: 'Discard', variant: 'ghost', full: true, onClick: () => { container.innerHTML = ''; } }),
      ui.button({ label: 'Save as Agent', variant: 'primary', full: true, onClick: async () => {
        await global.AAA_PROMPT_ARCHITECT.saveAgent(spec);
        sheet.close();
        await renderInto(parentBody);
      } })
    ]));
  }

  function architectFlow(parentBody) {
    const ui = U();
    const arch = global.AAA_PROMPT_ARCHITECT;
    const s = ui.sheet({ title: 'Create an Agent', subtitle: 'Describe what you want in plain English' });
    document.body.appendChild(s.overlay);
    if (!arch.isReady || !arch.isReady()) {
      s.body.appendChild(ui.el('p', { className: 'aaa-dialog__message', text:
        'Connect the AI proxy first (Cloud Settings → Cloud Function URL = /api/claude). Then the Architect can design agents from a description.' }));
      return;
    }
    s.body.appendChild(ui.el('label', { className: 'aaa-field-label', text: 'Describe the agent or process' }));
    const ta = ui.el('textarea', { className: 'aaa-input aaa-textarea', attrs: { placeholder: 'e.g. An agent that follows up on a lead 24 hours after an estimate is sent and books a callback.' } });
    s.body.appendChild(ta);
    const out = ui.el('div', {});
    s.body.appendChild(ui.button({ label: 'Generate', icon: '✨', variant: 'primary', full: true, onClick: async () => {
      out.innerHTML = ''; out.appendChild(ui.spinner('Designing your agent…'));
      const r = await arch.design(ta.value);
      if (!r.ok) { out.innerHTML = ''; out.appendChild(ui.el('p', { className: 'aaa-dialog__message', text: 'Could not design (' + (r.error || 'unknown') + ').' })); return; }
      renderSpec(out, r.spec, parentBody, s);
    } }));
    s.body.appendChild(out);
  }

  function section(title) { return U().el('h2', { className: 'aaa-section-title', text: title }); }
  function empty(text) { return U().el('p', { className: 'aaa-empty', text: text }); }
  function kv(k, v, color) {
    return U().el('div', { className: 'vision-row' }, [
      U().el('span', { className: 'vision-row__k', text: k }),
      U().el('span', { className: 'vision-row__v', text: v, style: color ? { color: color } : null })
    ]);
  }

  global.AAA_COMMAND_CENTER = { open: open, render: renderInto };
})(typeof window !== 'undefined' ? window : this);
