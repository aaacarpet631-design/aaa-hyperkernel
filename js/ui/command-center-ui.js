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
    const customRecs = global.AAA_PROMPT_ARCHITECT ? await global.AAA_PROMPT_ARCHITECT.list() : [];
    const customMap = {}; customRecs.forEach((r) => { customMap[r.id] = r; });

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
      // Custom agents (Prompt Architect / Marketplace) — with auto-run toggle.
      (reg.customIds ? reg.customIds() : []).forEach((id) => {
        const a = reg.get(id); if (!a) return;
        const rec = customMap[id];
        const trig = (rec && rec.trigger) || (a.spec && a.spec.trigger) || {};
        const p = per[id];
        const row = ui.el('div', { className: 'aaa-list-row' });
        row.innerHTML =
          '<strong>✨ ' + esc(a.title) + '</strong> <span class="aaa-list-sub">custom · ' + (aiReady ? 'online' : 'standby') + '</span>' +
          '<div class="aaa-list-sub">' + esc((a.spec && a.spec.mission) || '') + '</div>' +
          (trig.event && trig.event !== 'none' ? '<div class="aaa-list-sub">auto-run on ' + esc(trig.event) + '</div>' : '') +
          (p ? '<div class="aaa-list-sub">' + p.decisions + ' decisions</div>' : '');
        if (rec && trig.event && trig.event !== 'none' && global.AAA_PROMPT_ARCHITECT) {
          row.appendChild(ui.button({
            label: 'Auto-run: ' + (rec.triggerEnabled ? 'On' : 'Off'), size: 'sm',
            variant: rec.triggerEnabled ? 'success' : 'ghost',
            onClick: async () => { await global.AAA_PROMPT_ARCHITECT.setTriggerEnabled(id, !rec.triggerEnabled); await renderInto(body); }
          }));
        }
        body.appendChild(row);
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

    // ---- Self-Improvement (Layer 13) ----
    if (global.AAA_SELF_IMPROVEMENT) {
      body.appendChild(section('Self-Improvement'));
      const survey = await global.AAA_SELF_IMPROVEMENT.analyze();
      if (survey.ok) {
        const tuned = survey.agents.filter((a) => a.tuned);
        body.appendChild(ui.el('div', { className: 'aaa-list-row', html:
          '<strong>' + survey.eligible + ' agent(s) ready to learn</strong>' +
          '<div class="aaa-list-sub">Needs ' + survey.minScored + '+ scored decisions per agent. ' + tuned.length + ' currently tuned.</div>' }));
        survey.agents.forEach((a) => {
          if (!a.tuned && !a.eligible) return;
          const t = a.tuning;
          body.appendChild(ui.el('div', { className: 'aaa-list-row', html:
            '<strong>' + (a.tuned ? '🧠 ' : '○ ') + esc(a.title) + '</strong>' +
            '<div class="aaa-list-sub">' + a.scoredCount + ' scored · win ' + fmtPct(a.winRate) + ' · conf ' + (a.avgConfidence != null ? a.avgConfidence + '%' : '—') + ' · calibration ' + fmtPct(a.avgCalibration) + '</div>' +
            (t ? '<div class="aaa-list-sub">' + esc(t.calibration) + ' · bias ' + (t.confidenceBias >= 0 ? '+' : '') + t.confidenceBias + ' · v' + t.version + (t.summary ? ' — ' + esc(t.summary) : '') + '</div>' : '') }));
        });
        if (survey.eligible > 0) {
          body.appendChild(ui.button({ label: 'Learn from outcomes', icon: '🧠', variant: 'primary', full: true, disabled: !aiReady, onClick: () => improveFlow(body) }));
        } else {
          body.appendChild(empty('Record more won/lost outcomes — the team starts tuning itself once any agent has ' + survey.minScored + ' scored decisions.'));
        }
      }
    }

    // ---- Actions ----
    const actions = ui.el('div', { className: 'closure-actions' });
    if (global.AAA_INTEL_DASHBOARD) {
      actions.appendChild(ui.button({ label: 'Executive Intelligence', icon: '🧠', variant: 'primary', full: true, onClick: () => global.AAA_INTEL_DASHBOARD.open() }));
    }
    if (global.AAA_PROMPT_ARCHITECT) {
      actions.appendChild(ui.button({ label: 'Create Agent (describe it)', icon: '✨', variant: 'primary', full: true, onClick: () => architectFlow(body) }));
    }
    if (global.AAA_MARKETPLACE) {
      actions.appendChild(ui.button({ label: 'Agent Marketplace', icon: '🏪', variant: 'secondary', full: true, onClick: () => marketplaceFlow(body) }));
    }
    actions.appendChild(ui.button({ label: 'Cloud Settings', icon: '⚙️', variant: 'secondary', full: true, onClick: () => settingsFlow(body) }));
    if (global.AAA_MEASUREMENT_QUOTE && (!global.AAA_RBAC || global.AAA_RBAC.can('VIEW_PRICING_RATES'))) {
      actions.appendChild(ui.button({ label: 'Pricing / Rate Card', icon: '💲', variant: 'secondary', full: true, onClick: () => rateCardFlow(body) }));
    }
    if (global.AAA_RUNTIME_GATEWAY && (!global.AAA_RBAC || global.AAA_RBAC.can('VIEW_AUDIT_LOG'))) {
      actions.appendChild(ui.button({ label: 'Audit Log', icon: '🛡', variant: 'secondary', full: true, onClick: () => auditFlow(body) }));
    }
    if (global.AAA_PREDICTION_LEDGER_UI) {
      actions.appendChild(ui.button({ label: 'Prediction Ledger', icon: '🎯', variant: 'secondary', full: true, onClick: () => global.AAA_PREDICTION_LEDGER_UI.open() }));
    }
    if (global.AAA_RECEIPT_INTAKE_UI && (!global.AAA_RBAC || global.AAA_RBAC.can('VIEW_FINANCIALS'))) {
      actions.appendChild(ui.button({ label: 'Receipts', icon: '🧾', variant: 'secondary', full: true, onClick: () => global.AAA_RECEIPT_INTAKE_UI.open() }));
    }
    if (global.AAA_FINANCIAL_INTEL_UI && (!global.AAA_RBAC || global.AAA_RBAC.can('VIEW_FINANCIALS'))) {
      actions.appendChild(ui.button({ label: 'Financial Intelligence', icon: '📊', variant: 'secondary', full: true, onClick: () => global.AAA_FINANCIAL_INTEL_UI.open() }));
    }
    if (global.AAA_ESTIMATOR_UI && (!global.AAA_RBAC || global.AAA_RBAC.can('CREATE_QUOTE'))) {
      actions.appendChild(ui.button({ label: 'AI Estimator', icon: '📐', variant: 'secondary', full: true, onClick: () => global.AAA_ESTIMATOR_UI.open() }));
    }
    if (global.AAA_QUOTE_LIFECYCLE_UI && (!global.AAA_RBAC || global.AAA_RBAC.can('VIEW_FINANCIALS'))) {
      actions.appendChild(ui.button({ label: 'Quotes', icon: '📋', variant: 'secondary', full: true, onClick: () => global.AAA_QUOTE_LIFECYCLE_UI.open() }));
    }
    if (global.AAA_PRICING_OPTIMIZER_UI && (!global.AAA_RBAC || global.AAA_RBAC.can('VIEW_FINANCIALS'))) {
      actions.appendChild(ui.button({ label: 'Pricing Optimizer', icon: '📈', variant: 'secondary', full: true, onClick: () => global.AAA_PRICING_OPTIMIZER_UI.open() }));
    }
    if (global.AAA_LEARNING_FEEDBACK_UI && (!global.AAA_RBAC || global.AAA_RBAC.can('VIEW_FINANCIALS'))) {
      actions.appendChild(ui.button({ label: 'Learning Feedback', icon: '🔁', variant: 'secondary', full: true, onClick: () => global.AAA_LEARNING_FEEDBACK_UI.open() }));
    }
    if (global.AAA_CALIBRATION_UI && (!global.AAA_RBAC || global.AAA_RBAC.can('VIEW_FINANCIALS'))) {
      actions.appendChild(ui.button({ label: 'Calibration', icon: '🎛', variant: 'secondary', full: true, onClick: () => global.AAA_CALIBRATION_UI.open() }));
    }
    if (global.AAA_TRANSPORT_DASHBOARD_UI && (!global.AAA_RBAC || global.AAA_RBAC.can('EDIT_CUSTOMER'))) {
      actions.appendChild(ui.button({ label: 'Delivery', icon: '📨', variant: 'secondary', full: true, onClick: () => global.AAA_TRANSPORT_DASHBOARD_UI.open() }));
    }
    if (global.AAA_TRANSPORT_INBOX_UI && (!global.AAA_RBAC || global.AAA_RBAC.can('EDIT_CUSTOMER'))) {
      actions.appendChild(ui.button({ label: 'Conversations', icon: '💬', variant: 'secondary', full: true, onClick: () => global.AAA_TRANSPORT_INBOX_UI.open() }));
    }
    if (global.AAA_SECURITY_UI && (!global.AAA_RBAC || global.AAA_RBAC.can('MANAGE_SETTINGS'))) {
      actions.appendChild(ui.button({ label: 'Security Center', icon: '🛡', variant: 'secondary', full: true, onClick: () => global.AAA_SECURITY_UI.open() }));
    }
    if (global.AAA_EVENT_STREAM_UI && (!global.AAA_RBAC || global.AAA_RBAC.can('VIEW_FINANCIALS'))) {
      actions.appendChild(ui.button({ label: 'Event Stream', icon: '🔁', variant: 'secondary', full: true, onClick: () => global.AAA_EVENT_STREAM_UI.open() }));
    }
    if (global.AAA_PRIVACY_DASHBOARD_UI && (!global.AAA_RBAC || global.AAA_RBAC.can('MANAGE_SETTINGS'))) {
      actions.appendChild(ui.button({ label: 'Data Governance', icon: '🔐', variant: 'secondary', full: true, onClick: () => global.AAA_PRIVACY_DASHBOARD_UI.open() }));
    }
    if (global.AAA_RELIABILITY_UI && (!global.AAA_RBAC || global.AAA_RBAC.can('VIEW_FINANCIALS'))) {
      actions.appendChild(ui.button({ label: 'Reliability', icon: '📟', variant: 'secondary', full: true, onClick: () => global.AAA_RELIABILITY_UI.open() }));
    }
    if (global.AAA_OUTCOME_INTELLIGENCE_UI && (!global.AAA_RBAC || global.AAA_RBAC.can('VIEW_FINANCIALS'))) {
      actions.appendChild(ui.button({ label: 'Outcome Intelligence', icon: '🧠', variant: 'secondary', full: true, onClick: () => global.AAA_OUTCOME_INTELLIGENCE_UI.open() }));
    }
    if (global.AAA_EXECUTIVE_COUNCIL_UI && (!global.AAA_RBAC || global.AAA_RBAC.can('VIEW_FINANCIALS'))) {
      actions.appendChild(ui.button({ label: 'Executive Council', icon: '🏛', variant: 'secondary', full: true, onClick: () => global.AAA_EXECUTIVE_COUNCIL_UI.open() }));
    }
    if (global.AAA_LEARNING_FABRIC_UI && (!global.AAA_RBAC || global.AAA_RBAC.can('VIEW_FINANCIALS'))) {
      actions.appendChild(ui.button({ label: 'Learning Fabric', icon: '🧬', variant: 'secondary', full: true, onClick: () => global.AAA_LEARNING_FABRIC_UI.open() }));
    }
    if (global.AAA_DIGITAL_TWIN_UI && (!global.AAA_RBAC || global.AAA_RBAC.can('VIEW_FINANCIALS'))) {
      actions.appendChild(ui.button({ label: 'Digital Twin', icon: '🔮', variant: 'secondary', full: true, onClick: () => global.AAA_DIGITAL_TWIN_UI.open() }));
    }
    if (global.AAA_FINANCIAL_INTELLIGENCE_UI && (!global.AAA_RBAC || global.AAA_RBAC.can('VIEW_FINANCIALS'))) {
      actions.appendChild(ui.button({ label: 'Financial Intelligence', icon: '💰', variant: 'secondary', full: true, onClick: () => global.AAA_FINANCIAL_INTELLIGENCE_UI.open() }));
    }
    if (global.AAA_AI_OPS_UI && (!global.AAA_RBAC || global.AAA_RBAC.can('VIEW_FINANCIALS'))) {
      actions.appendChild(ui.button({ label: 'AI Operations Center', icon: '🛰', variant: 'primary', full: true, onClick: () => global.AAA_AI_OPS_UI.open() }));
    }
    if (global.AAA_PROPOSAL_REVIEW_UI && (!global.AAA_RBAC || global.AAA_RBAC.can('MANAGE_GOVERNANCE'))) {
      actions.appendChild(ui.button({ label: 'Learning Proposals', icon: '🔁', variant: 'secondary', full: true, onClick: () => global.AAA_PROPOSAL_REVIEW_UI.open() }));
    }
    if (global.AAA_AGENT_EVAL_UI && (!global.AAA_RBAC || global.AAA_RBAC.can('VIEW_FINANCIALS'))) {
      actions.appendChild(ui.button({ label: 'Agent Evaluation Lab', icon: '🧪', variant: 'secondary', full: true, onClick: () => global.AAA_AGENT_EVAL_UI.open() }));
    }
    if (global.AAA_KNOWLEDGE_OS_UI && (!global.AAA_RBAC || global.AAA_RBAC.can('VIEW_ALL_JOBS'))) {
      actions.appendChild(ui.button({ label: 'Knowledge OS', icon: '📚', variant: 'secondary', full: true, onClick: () => global.AAA_KNOWLEDGE_OS_UI.open() }));
    }
    if (global.AAA_OWNER_COPILOT_UI && (!global.AAA_RBAC || global.AAA_RBAC.can('VIEW_FINANCIALS'))) {
      actions.appendChild(ui.button({ label: 'Owner Copilot — Daily Briefing', icon: '☀', variant: 'primary', full: true, onClick: () => global.AAA_OWNER_COPILOT_UI.open() }));
    }
    if (global.AAA_MODEL_UI && (!global.AAA_RBAC || global.AAA_RBAC.can('MANAGE_GOVERNANCE'))) {
      actions.appendChild(ui.button({ label: 'Native Model Lab', icon: '🧠', variant: 'secondary', full: true, onClick: () => global.AAA_MODEL_UI.open() }));
    }
    if (global.AAA_MODEL_GOVERNANCE_UI && (!global.AAA_RBAC || global.AAA_RBAC.can('MANAGE_GOVERNANCE'))) {
      actions.appendChild(ui.button({ label: 'Model Governance (NVIDIA)', icon: '🟩', variant: 'secondary', full: true, onClick: () => global.AAA_MODEL_GOVERNANCE_UI.open() }));
    }
    if (global.AAA_ASSISTED_DRAFTS_UI && (!global.AAA_RBAC || global.AAA_RBAC.can('EDIT_CUSTOMER'))) {
      actions.appendChild(ui.button({ label: 'Assisted Drafts', icon: '✍️', variant: 'secondary', full: true, onClick: () => global.AAA_ASSISTED_DRAFTS_UI.open() }));
    }
    if (global.AAA_SENSING_UI && (!global.AAA_RBAC || global.AAA_RBAC.can('EDIT_CUSTOMER'))) {
      actions.appendChild(ui.button({ label: 'Sensing — Signals', icon: '📡', variant: 'secondary', full: true, onClick: () => global.AAA_SENSING_UI.open() }));
    }
    if (global.AAA_AGENT_COUNCIL_UI && (!global.AAA_RBAC || global.AAA_RBAC.can('VIEW_FINANCIALS'))) {
      actions.appendChild(ui.button({ label: 'Supervisor Council', icon: '⚖️', variant: 'secondary', full: true, onClick: () => global.AAA_AGENT_COUNCIL_UI.open() }));
    }
    if (global.AAA_PROVENANCE_UI && (!global.AAA_RBAC || global.AAA_RBAC.can('VIEW_FINANCIALS'))) {
      actions.appendChild(ui.button({ label: 'Provenance', icon: '🧭', variant: 'secondary', full: true, onClick: () => global.AAA_PROVENANCE_UI.open() }));
    }
    if (global.AAA_GOVERNANCE_UI && (!global.AAA_RBAC || global.AAA_RBAC.can('MANAGE_GOVERNANCE'))) {
      actions.appendChild(ui.button({ label: 'Governance', icon: '🏛', variant: 'secondary', full: true, onClick: () => global.AAA_GOVERNANCE_UI.open() }));
    }
    if (global.AAA_REPLAY_SANDBOX_UI && (!global.AAA_RBAC || global.AAA_RBAC.can('MANAGE_GOVERNANCE'))) {
      actions.appendChild(ui.button({ label: 'Replay Sandbox', icon: '⏵', variant: 'secondary', full: true, onClick: () => global.AAA_REPLAY_SANDBOX_UI.open() }));
    }
    if (global.AAA_LEGAL_WAR_ROOM && (!global.AAA_RBAC || global.AAA_RBAC.can('VIEW_LEGAL'))) {
      actions.appendChild(ui.button({ label: 'Legal War Room', icon: '⚖️', variant: 'secondary', full: true, onClick: () => global.AAA_LEGAL_WAR_ROOM.open() }));
    }
    if (global.AAA_CREW_UI && (!global.AAA_RBAC || global.AAA_RBAC.can('MANAGE_CREW'))) {
      actions.appendChild(ui.button({ label: 'Crew & Tools', icon: '👷', variant: 'secondary', full: true, onClick: () => global.AAA_CREW_UI.open() }));
    }
    if (global.AAA_CONTRACTS_UI && (!global.AAA_RBAC || global.AAA_RBAC.can('CREATE_QUOTE'))) {
      actions.appendChild(ui.button({ label: 'Contracts', icon: '✍️', variant: 'secondary', full: true, onClick: () => global.AAA_CONTRACTS_UI.open() }));
    }
    if (global.AAA_SCHEDULE_UI && (!global.AAA_RBAC || global.AAA_RBAC.can('EDIT_JOB'))) {
      actions.appendChild(ui.button({ label: 'Schedule & Dispatch', icon: '🗓', variant: 'secondary', full: true, onClick: () => global.AAA_SCHEDULE_UI.open() }));
    }
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

    // ---- Decision challenges (Internal Challenge Protocol) ----
    if (global.AAA_CHALLENGE_UI && global.AAA_CHALLENGE_UI.renderSection) {
      try { await global.AAA_CHALLENGE_UI.renderSection(body); } catch (_) {}
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

  // Self-Improvement: tune every eligible agent from its real track record,
  // then show exactly what changed and why (grounded in outcomes).
  async function improveFlow(body) {
    const ui = U();
    body.innerHTML = '';
    body.appendChild(ui.spinner('Learning from real outcomes…'));
    const result = await global.AAA_SELF_IMPROVEMENT.improveAll();
    body.innerHTML = '';
    if (!result || !result.ok) {
      const why = (result && result.error) === 'INSUFFICIENT_DATA'
        ? 'Not enough scored decisions yet (need ' + (result.need || 3) + ' per agent). Record more won/lost outcomes.'
        : 'Could not learn (' + ((result && result.error) || 'unknown') + ').';
      body.appendChild(ui.el('p', { className: 'aaa-dialog__message', text: why }));
      body.appendChild(ui.button({ label: 'Back', variant: 'ghost', full: true, onClick: () => renderInto(body) }));
      return;
    }
    body.appendChild(ui.el('h2', { className: 'aaa-section-title', text: 'Tuned ' + result.improved + ' agent(s) from real outcomes' }));
    result.results.forEach((r) => {
      if (!r.ok) {
        body.appendChild(ui.el('div', { className: 'aaa-list-row', html:
          '<strong>' + esc(r.agentId) + '</strong><div class="aaa-list-sub">skipped — ' + esc(r.error || '') + '</div>' }));
        return;
      }
      const t = r.tuning;
      body.appendChild(ui.el('div', { className: 'aaa-list-row', html:
        '<strong>🧠 ' + esc((global.AAA_AGENTS.get(r.agentId) || {}).title || r.agentId) + '</strong>' +
        '<div class="aaa-list-sub">' + esc(t.calibration) + ' · confidence bias ' + (t.confidenceBias >= 0 ? '+' : '') + t.confidenceBias + ' · v' + t.version + '</div>' +
        (t.summary ? '<div class="aaa-list-sub">' + esc(t.summary) + '</div>' : '') +
        (t.promptAddendum ? '<div class="aaa-list-sub">↳ added guidance: ' + esc(t.promptAddendum.slice(0, 140)) + (t.promptAddendum.length > 140 ? '…' : '') + '</div>' : '') }));
      body.appendChild(ui.button({ label: 'Revert ' + ((global.AAA_AGENTS.get(r.agentId) || {}).title || r.agentId), size: 'sm', variant: 'ghost',
        onClick: async () => { await global.AAA_SELF_IMPROVEMENT.revert(r.agentId); await renderInto(body); } }));
    });
    body.appendChild(ui.el('p', { className: 'aaa-empty', text: 'These tunings apply to every future decision and get re-scored against new outcomes — so the team keeps adjusting.' }));
    body.appendChild(ui.button({ label: 'Done', variant: 'primary', full: true, onClick: () => renderInto(body) }));
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

    // ---- Role (RBAC) — who is using this device. Owner-only to change. ----
    if (global.AAA_RBAC) {
      const rbac = global.AAA_RBAC;
      s.body.appendChild(ui.el('h2', { className: 'aaa-section-title', text: 'Device role' }));
      if (rbac.can('MANAGE_SETTINGS')) {
        const sel = ui.el('select', { className: 'aaa-input' });
        rbac.ROLES.forEach((r) => {
          const opt = ui.el('option', { text: rbac.label(r), attrs: { value: r } });
          if (r === rbac.role()) opt.setAttribute('selected', 'selected');
          sel.appendChild(opt);
        });
        sel.addEventListener('change', () => {
          rbac.setRole(sel.value);
          status.textContent = 'Role set to ' + rbac.label() + '. Restricted areas update immediately.';
        });
        s.body.appendChild(ui.el('div', { className: 'aaa-form' }, [
          ui.el('label', { className: 'aaa-field-label', text: 'This device is used by' }), sel
        ]));
        s.body.appendChild(ui.el('p', { className: 'aaa-voice-hint', text: 'Crew see only field work. Managers run production. Owner sees financials.' }));
      } else {
        s.body.appendChild(ui.el('div', { className: 'aaa-list-row', html: '<strong>Role: ' + esc(rbac.label()) + '</strong><div class="aaa-list-sub">Only the owner can change roles.</div>' }));
      }
    }

    const status = ui.el('p', { className: 'aaa-empty', text: '' });
    s.body.appendChild(status);

    const diag = ui.el('div', {});
    function kvRow(k, v, color) {
      return ui.el('div', { className: 'vision-row' }, [
        ui.el('span', { className: 'vision-row__k', text: k }),
        ui.el('span', { className: 'vision-row__v', text: v, style: color ? { color: color } : null })
      ]);
    }
    async function runTest() {
      diag.innerHTML = ''; diag.appendChild(ui.spinner('Testing AI connection…'));
      const provider = global.AAA_CLOUD ? global.AAA_CLOUD.provider() : null;
      const ready = !!(global.AAA_AGENT_OS && global.AAA_AGENT_OS.isReady && global.AAA_AGENT_OS.isReady());
      let ping;
      if (global.AAA_DATA && global.AAA_DATA.callAgent) {
        const r = await global.AAA_DATA.callAgent({ agent: 'diagnostic', model: 'claude-haiku-4-5', max_tokens: 16, messages: [{ role: 'user', content: 'Reply with exactly: OK' }] });
        if (r && r.ok) ping = { text: '✓ reachable — "' + String(r.text || '').slice(0, 40) + '"', color: '#10B981' };
        else {
          const det = r && r.detail; const dmsg = det && (det.error || det.message) ? (' (' + (det.error || det.message) + ')') : '';
          ping = { text: '✗ ' + ((r && r.error) || 'failed') + dmsg, color: '#EF4444' };
        }
      } else ping = { text: '✗ data layer missing', color: '#EF4444' };

      // Second probe: run a real agent (structured output + JSON parse), which
      // is the path the AI Agents actually use. A green ping with a red agent
      // run means the proxy is fine but the model output isn't parsing.
      let agentProbe = null;
      if (ping.color === '#10B981' && global.AAA_AGENT_OS && global.AAA_AGENT_OS.runAgent) {
        const a = await global.AAA_AGENT_OS.runAgent('kpi', 'Reply that the connection test succeeded.', { test: true });
        if (a && a.ok) agentProbe = { text: '✓ decision parsed — "' + String(a.recommendation || '').slice(0, 40) + '"', color: '#10B981' };
        else agentProbe = { text: '✗ ' + ((a && a.error) || 'failed') + (a && a.raw ? ' — model said: "' + String(a.raw).slice(0, 50) + '"' : ''), color: '#EF4444' };
      }

      diag.innerHTML = '';
      diag.appendChild(kvRow('Cloud provider', provider || 'none', provider ? '#10B981' : '#F59E0B'));
      diag.appendChild(kvRow('Proxy URL', cfg.proxyUrl || '(none)'));
      diag.appendChild(kvRow('Proxy configured', (cfg.isProxyConfigured && cfg.isProxyConfigured()) ? 'yes' : 'no', (cfg.isProxyConfigured && cfg.isProxyConfigured()) ? '#10B981' : '#F59E0B'));
      diag.appendChild(kvRow('Agents ready', ready ? 'yes' : 'no', ready ? '#10B981' : '#F59E0B'));
      diag.appendChild(kvRow('AI ping', ping.text, ping.color));
      if (agentProbe) diag.appendChild(kvRow('Agent run', agentProbe.text, agentProbe.color));
    }

    s.body.appendChild(ui.el('div', { className: 'aaa-dialog__actions' }, [
      ui.button({ label: 'Save', variant: 'primary', full: true, onClick: async () => {
        const patch = {};
        fields.forEach((f) => { patch[f.input._key] = f.input.value.trim() || null; });
        if (cfg.set) cfg.set(patch);
        status.textContent = 'Saved. Now tap “Test AI connection”.';
      } }),
      ui.button({ label: 'Test AI connection', variant: 'secondary', full: true, onClick: runTest })
    ]));
    s.body.appendChild(diag);
    s.body.appendChild(ui.button({ label: 'Done', variant: 'ghost', full: true, onClick: async () => { s.close(); await renderInto(parentBody); } }));
    status.textContent = (cfg.isFirebaseConfigured && cfg.isFirebaseConfigured())
      ? 'Connected to Firebase. Save, then Test AI connection.'
      : 'Enter Project ID + Web API key + Workspace ID + Cloud Function URL (/api/claude), Save, then Test.';
  }

  // Owner-facing rate card editor. Reads the live rates from the measurement
  // quote module, lets the owner set their real prices, and persists them via
  // AAA_CONFIG.set({ rateCard }) — the same override the quote engine reads.
  function rateCardFlow(parentBody) {
    const ui = U();
    const Q = global.AAA_MEASUREMENT_QUOTE;
    if (!Q) return;
    const cfg = global.AAA_CONFIG || {};
    const defaults = Q.defaultRates();
    const current = Q.currentRates();
    const s = ui.sheet({ title: 'Pricing / Rate Card', subtitle: 'Your rates feed every measurement quote. Saved on this device.' });
    document.body.appendChild(s.overlay);

    // [key, label, unit-hint]. Order groups labor, materials, then tuning knobs.
    const FIELDS = [
      ['install_per_sqft', 'Carpet install (labor)', '$ / ft²'],
      ['material_per_sqft', 'Carpet material', '$ / ft²'],
      ['pad_per_sqft', 'Padding', '$ / ft²'],
      ['stretch_per_sqft', 'Carpet stretching', '$ / ft²'],
      ['repair_per_linear_ft', 'Carpet repair', '$ / linear ft'],
      ['shampoo_per_sqft', 'Carpet cleaning', '$ / ft²'],
      ['stairs_each', 'Stairs', '$ / stair'],
      ['hallway_per_sqft', 'Hallway', '$ / ft²'],
      ['apartment_turn_flat', 'Apartment turn', '$ / unit (flat)'],
      ['commercial_per_sqft', 'Commercial install', '$ / ft²'],
      ['waste_factor', 'Material waste factor', '0.10 = +10%'],
      ['min_job', 'Minimum job charge', '$'],
      ['range_spread', 'Quote range spread', '0.12 = ±12%']
    ];
    const inputs = {};
    FIELDS.forEach(([key, label, hint]) => {
      const input = ui.el('input', { className: 'aaa-input', attrs: { type: 'number', step: '0.01', inputmode: 'decimal', placeholder: String(defaults[key]) } });
      input.value = current[key] != null ? String(current[key]) : '';
      inputs[key] = input;
      s.body.appendChild(ui.el('div', { className: 'aaa-form' }, [
        ui.el('label', { className: 'aaa-field-label', text: label + ' (' + hint + ')' }), input
      ]));
    });

    const status = ui.el('p', { className: 'aaa-empty', text: 'Blank fields use the default shown in grey.' });
    s.body.appendChild(status);
    s.body.appendChild(ui.el('div', { className: 'aaa-dialog__actions' }, [
      ui.button({ label: 'Save rates', variant: 'primary', full: true, onClick: () => {
        const card = {};
        FIELDS.forEach(([key]) => {
          const raw = inputs[key].value.trim();
          if (raw === '') return;                 // leave unset → default applies
          const n = Number(raw);
          if (isFinite(n) && n >= 0) card[key] = n;
        });
        if (cfg.set) cfg.set({ rateCard: card });
        status.textContent = 'Saved ' + Object.keys(card).length + ' rate(s). New quotes use these immediately.';
      } }),
      ui.button({ label: 'Reset to defaults', variant: 'ghost', full: true, onClick: () => {
        if (cfg.set) cfg.set({ rateCard: {} });
        FIELDS.forEach(([key]) => { inputs[key].value = ''; });
        status.textContent = 'Reset — all rates back to defaults.';
      } })
    ]));
    s.body.appendChild(ui.button({ label: 'Done', variant: 'ghost', full: true, onClick: () => s.close() }));
  }

  // Owner-facing audit trail: every gateway decision (allowed/denied/error),
  // including AI-blocked attempts. Read-only — the log is append-only by design.
  async function auditFlow(parentBody) {
    const ui = U();
    const s = ui.sheet({ title: 'Audit Log', subtitle: 'Every guarded action — who, what, allowed or denied' });
    document.body.appendChild(s.overlay);
    s.body.appendChild(ui.spinner('Loading audit trail…'));
    const entries = await global.AAA_RUNTIME_GATEWAY.recentAudit(80);
    s.body.innerHTML = '';
    if (!entries.length) { s.body.appendChild(ui.el('p', { className: 'aaa-empty', text: 'No audited actions yet.' })); }
    const color = { allowed: '#10B981', denied: '#EF4444', error: '#F59E0B' };
    entries.forEach((e) => {
      s.body.appendChild(ui.el('div', { className: 'aaa-list-row', html:
        '<strong style="color:' + (color[e.decision] || '#A1A1AA') + '">' + esc(e.decision.toUpperCase()) + ' · ' + esc(e.action) + '</strong>' +
        '<div class="aaa-list-sub">' + esc(e.origin) + (e.actor ? ' · ' + esc(String(e.actor)) : '') + (e.role ? ' (' + esc(e.role) + ')' : '') + (e.reason ? ' · ' + esc(e.reason) : '') + '</div>' +
        '<div class="aaa-list-sub">' + esc(fmtDate(Date.parse(e.at))) + (e.target ? ' · ' + esc(e.target.type || '') + ' ' + esc(String(e.target.id || '')) : '') + '</div>' }));
    });
    s.body.appendChild(ui.button({ label: 'Done', variant: 'ghost', full: true, onClick: () => s.close() }));
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
    if (spec.trigger && spec.trigger.event && spec.trigger.event !== 'none') {
      container.appendChild(ui.el('div', { className: 'aaa-list-row', html:
        '<strong>Auto-run</strong><div class="aaa-list-sub">on ' + esc(spec.trigger.event) +
        (spec.trigger.delayHours ? ' (after ~' + spec.trigger.delayHours + 'h)' : '') +
        ' — ' + esc(spec.trigger.task || '') + '</div>' }));
    }
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

  async function marketplaceFlow(parentBody) {
    const ui = U();
    const m = global.AAA_MARKETPLACE;
    const s = ui.sheet({ title: 'Agent Marketplace', subtitle: 'Prebuilt AAA Carpet agents — install in one tap' });
    document.body.appendChild(s.overlay);
    const items = m.catalog();
    for (const cat of m.categories()) {
      s.body.appendChild(ui.el('h2', { className: 'aaa-section-title', text: cat }));
      const inCat = items.filter((x) => x.category === cat);
      for (const it of inCat) {
        const installed = await m.isInstalled(it.id);
        const row = ui.el('div', { className: 'aaa-list-row' });
        row.innerHTML = '<strong>' + esc(it.name) + '</strong><div class="aaa-list-sub">' + esc(it.mission) + '</div>' +
          (it.trigger && it.trigger.event !== 'none' ? '<div class="aaa-list-sub">auto-run on ' + esc(it.trigger.event) + '</div>' : '');
        row.appendChild(ui.button({
          label: installed ? 'Installed ✓' : 'Install', size: 'sm', variant: installed ? 'ghost' : 'primary', disabled: installed,
          onClick: async () => { await m.install(it.id); s.close(); await renderInto(parentBody); }
        }));
        s.body.appendChild(row);
      }
    }
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
