/*
 * AAA Executive Intelligence Dashboard — the command center for the Analysis
 * Division. One screen over REAL shared memory: domain health (revenue,
 * operations, customer, marketing, AI), overall risk level, growth opportunities
 * and critical threats from the latest accepted analyses, the analyst leaderboard,
 * supervisor-council decisions, meeting outcomes, learning trends, and prediction
 * accuracy — plus the actions that drive the org: run a team through all six
 * layers, run a debate, convene the council, hold a meeting, scan for evolution
 * gaps, and refresh rankings.
 *
 * Nothing is fabricated. Every panel reads from collectors/pipeline/council/
 * meetings/rankings; thin data says "warming up", and model actions are disabled
 * with a clear reason when the AI proxy is not configured.
 */
;(function (global) {
  'use strict';

  function U() { return global.AAA_UI; }
  function div() { return global.AAA_ANALYSIS_DIVISION; }
  function collectors() { return global.AAA_INTEL_COLLECTORS; }
  function pipeline() { return global.AAA_INTEL_PIPELINE; }
  function council() { return global.AAA_COUNCIL; }
  function meetings() { return global.AAA_MEETINGS; }
  function rankings() { return global.AAA_RANKINGS; }
  function evolution() { return global.AAA_EVOLUTION; }
  function research() { return global.AAA_RESEARCH; }

  const GREEN = '#16A34A', AMBER = '#D97706', RED = '#DC2626', GREY = '#71717A', BLUE = '#2563EB';

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]); }); }
  function pct(n) { return n == null ? '—' : Math.round(n * 100) + '%'; }
  function fmtDate(ms) { if (!ms) return ''; const d = new Date(ms); return isNaN(d.getTime()) ? '' : d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }); }
  function money(n) { return n == null ? '—' : '$' + Math.round(n).toLocaleString(); }

  function section(title) { return U().el('h2', { className: 'aaa-section-title', text: title }); }
  function empty(text) { return U().el('p', { className: 'aaa-empty', text: text }); }
  function note(text) { return U().el('p', { className: 'aaa-list-sub', text: text, style: { padding: '0 2px 8px' } }); }
  function kv(k, v, color) {
    return U().el('div', { className: 'vision-row' }, [
      U().el('span', { className: 'vision-row__k', text: k }),
      U().el('span', { className: 'vision-row__v', text: v == null ? '—' : String(v), style: color ? { color: color } : null })
    ]);
  }
  function row(html) { return U().el('div', { className: 'aaa-list-row', html: html }); }

  // ---- domain → health chip (grounded in the real metric) ----------------
  function healthFor(domain, c) {
    if (!c || c.status === 'warming_up') return { label: 'Warming up', color: GREY, detail: c && c.sample ? Object.keys(c.sample).map(function (k) { return c.sample[k] + ' ' + k; }).join(', ') : '' };
    switch (domain) {
      case 'revenue': {
        const rising = c.trend && c.trend.length >= 2 && c.trend[c.trend.length - 1].revenue >= c.trend[c.trend.length - 2].revenue;
        return { label: money(c.totalRevenue) + ' total', color: c.totalRevenue > 0 ? (rising ? GREEN : AMBER) : GREY, detail: 'avg ticket ' + money(c.avgTicket) };
      }
      case 'pricing': {
        const w = c.winRate; return { label: 'win ' + pct(w), color: w == null ? GREY : w >= 0.5 ? GREEN : w >= 0.3 ? AMBER : RED, detail: 'est. acc ' + pct(c.avgEstimateAccuracy) };
      }
      case 'customer': {
        const r = c.repeatRate; return { label: 'repeat ' + pct(r), color: r == null ? GREY : r >= 0.3 ? GREEN : r >= 0.1 ? AMBER : RED, detail: c.reviews ? (c.reviews.count + ' reviews') : '' };
      }
      case 'operations': {
        const cb = c.callbackRate; return { label: 'callback ' + pct(cb), color: cb == null ? GREY : cb <= 0.05 ? GREEN : cb <= 0.15 ? AMBER : RED, detail: c.openJobs + ' open / ' + c.closedJobs + ' closed' };
      }
      case 'marketing': {
        return { label: (c.channels ? c.channels.length : 0) + ' channels', color: c.channels && c.channels.length >= 2 ? GREEN : GREY, detail: 'live ad data not wired' };
      }
      case 'ai': {
        const cal = c.avgCalibration; return { label: 'calib ' + (cal == null ? '—' : cal), color: cal == null ? GREY : cal >= 0.7 ? GREEN : cal >= 0.5 ? AMBER : RED, detail: c.lowConfidenceCount + ' low-conf' };
      }
    }
    return { label: c.status, color: GREY, detail: '' };
  }

  function riskLevel(reports) {
    let high = 0, blocked = 0;
    reports.forEach(function (r) {

      if (Array.isArray(r.risks)) high += r.risks.length >= 3 ? 1 : 0;
      if (r.verdict === 'reject') blocked++;
    });
    if (blocked >= 1 || high >= 3) return { label: 'HIGH', color: RED };
    if (high >= 1) return { label: 'ELEVATED', color: AMBER };
    return { label: 'LOW', color: GREEN };
  }

  // ---- entry points -------------------------------------------------------
  async function open() {
    const ui = U();
    const sheet = ui.sheet({ title: 'Executive Intelligence', subtitle: 'AAA Carpet — Analysis Division command center' });
    document.body.appendChild(sheet.overlay);
    await render(sheet.body);
  }

  async function render(body) {
    const ui = U();
    body.innerHTML = '';
    body.appendChild(ui.spinner('Gathering intelligence…'));

    const D = div();
    const aiReady = !!(D && D.isReady());
    const all = await collectors().all();
    const reports = pipeline() ? await pipeline().list() : [];
    const latestByTeam = pipeline() ? await pipeline().latestByTeam() : {};
    const rankTable = rankings() ? await rankings().compute() : { ok: false };
    const votes = council() ? (await council().list()).slice(0, 5) : [];
    const councilAcc = council() ? await council().accuracy() : null;
    const meetingList = meetings() ? (await meetings().list()).slice(0, 4) : [];
    const evoList = evolution() ? (await evolution().list()).slice(0, 1) : [];
    const supMetrics = global.AAA_SUPERVISOR ? await global.AAA_SUPERVISOR.metrics() : { ok: false };
    const govMetrics = global.AAA_GOVERNANCE_ENGINE ? await global.AAA_GOVERNANCE_ENGINE.metrics() : null;
    const agentInsights = global.AAA_AGENT_SCORECARDS ? await global.AAA_AGENT_SCORECARDS.insights() : null;

    body.innerHTML = '';

    if (!aiReady) {
      const banner = ui.el('div', { className: 'aaa-list-row', style: { borderColor: AMBER } });
      banner.innerHTML = '<strong style="color:' + AMBER + '">AI proxy not configured</strong>' +
        '<div class="aaa-list-sub">Collectors below show real data. Analyst, debate, council, meeting, and evolution actions need a configured Claude proxy (Command Center → Cloud Settings).</div>';
      body.appendChild(banner);
    }

    // ---- Domain health ----
    body.appendChild(section('Intelligence Health'));
    const order = [['revenue', 'Revenue'], ['operations', 'Operational'], ['customer', 'Customer'], ['marketing', 'Marketing'], ['ai', 'AI']];
    order.forEach(function (pair) {
      const h = healthFor(pair[0], all[pair[0]]);
      const r = ui.el('div', { className: 'vision-row' }, [
        ui.el('span', { className: 'vision-row__k', text: pair[1] + ' Health' }),
        ui.el('span', { className: 'vision-row__v' }, [ui.statusBadge(h.label, h.color)])
      ]);
      body.appendChild(r);
      if (h.detail) body.appendChild(ui.el('p', { className: 'aaa-list-sub', text: h.detail, style: { margin: '-4px 2px 6px' } }));
    });
    const risk = riskLevel(reports);
    body.appendChild(kv('Risk Level', risk.label, risk.color));

    // ---- AI Governance (override / audit analytics across all guardrails) ----
    if (govMetrics) {
      body.appendChild(section('AI Governance'));
      const orPct = Math.round((govMetrics.overrideRate || 0) * 100) + '%';
      body.appendChild(kv('Safety Checks', govMetrics.safetyChecks));
      body.appendChild(kv('Blocked', govMetrics.blocked, govMetrics.blocked ? RED : GREY));
      body.appendChild(kv('Queued', govMetrics.queued, govMetrics.queued ? AMBER : GREY));
      body.appendChild(kv('Overrides', govMetrics.overrides, govMetrics.overrides ? AMBER : GREY));
      body.appendChild(kv('Override Rate', orPct, (govMetrics.overrideRate || 0) > 0.5 ? RED : GREY));
      body.appendChild(kv('False-Positive Candidates', govMetrics.falsePositiveCandidates, govMetrics.falsePositiveCandidates ? AMBER : GREY));
      if (govMetrics.reviewQueue) body.appendChild(kv('Supervisor Review Queue', govMetrics.reviewQueue, AMBER));
      if (govMetrics.alerts) body.appendChild(kv('Drift Alerts', govMetrics.alerts, RED));
      if (govMetrics.escalations) body.appendChild(kv('Open Escalations', govMetrics.escalations, RED));
      if (global.AAA_GOVERNANCE_INTEGRITY) {
        const integ = await global.AAA_GOVERNANCE_INTEGRITY.selfAudit({});
        body.appendChild(kv('Ledger Integrity', integ.ok
          ? '✅ verified · ' + integ.entries + ' entries · ' + integ.writers + ' writer(s)' + (integ.signed ? ' · signed' : '')
          : '⛔ ' + (integ.reason || 'FAILED') + (integ.writerId ? ' (writer ' + integ.writerId + ')' : ''), integ.ok ? GREEN : RED));
      }
    }

    // ---- Agent performance (Governance Intelligence Layer) ----
    if (agentInsights) {
      const anyCards = (agentInsights.top.length + agentInsights.worst.length) > 0;
      body.appendChild(section('Agent Performance'));
      if (!anyCards) {
        body.appendChild(note('No agent has enough scored outcomes yet — agents are unproven, not bad.'));
      } else {
        const fmtCard = function (c) { return c.agentType + ' · ' + pct(c.successRate) + ' success · acc ' + pct(c.accuracy) + ' · ' + (c.samples ? c.samples.considered : 0) + ' scored'; };
        if (agentInsights.top.length) { body.appendChild(note('Top performing')); agentInsights.top.forEach(function (c) { body.appendChild(row('<strong style="color:' + GREEN + '">' + esc(c.agentType) + '</strong><div class="aaa-list-sub">' + esc(fmtCard(c)) + '</div>')); }); }
        if (agentInsights.worst.length) { body.appendChild(note('Worst performing')); agentInsights.worst.forEach(function (c) { body.appendChild(row('<strong style="color:' + RED + '">' + esc(c.agentType) + '</strong><div class="aaa-list-sub">' + esc(fmtCard(c)) + '</div>')); }); }
        if (agentInsights.drifting.length) body.appendChild(kv('Drifting agents', agentInsights.drifting.map(function (c) { return c.agentType; }).join(', '), AMBER));
        if (agentInsights.excessiveOverrides.length) body.appendChild(kv('Excessive overrides', agentInsights.excessiveOverrides.map(function (c) { return c.agentType; }).join(', '), AMBER));
        if (agentInsights.needingRetraining.length) body.appendChild(kv('Needs retraining', agentInsights.needingRetraining.map(function (c) { return c.agentType; }).join(', '), RED));
        if (agentInsights.insufficientData && agentInsights.insufficientData.length) body.appendChild(kv('Insufficient data', agentInsights.insufficientData.map(function (c) { return c.agentType; }).join(', '), GREY));
      }
      if (global.AAA_GOVERNANCE_LEARNING_UI) {
        body.appendChild(ui.button({ label: '🎓 Open Learning Command Center', variant: 'secondary', full: true, onClick: function () { global.AAA_GOVERNANCE_LEARNING_UI.open(); } }));
      }
    }
    body.appendChild(kv('Prediction Accuracy (calibration)', supMetrics.ok && supMetrics.avgCalibration != null ? String(supMetrics.avgCalibration) : '—', BLUE));
    body.appendChild(kv('Close Rate', supMetrics.ok ? pct(supMetrics.closeRate) : '—'));

    // ---- Opportunities & threats (from latest accepted analyses) ----

    const opps = []; const threats = [];
    Object.keys(latestByTeam).forEach(function (tid) {
      const r = latestByTeam[tid];
      (r.opportunities || []).slice(0, 2).forEach(function (o) { opps.push({ team: r.team, text: o }); });
      (r.risks || []).slice(0, 2).forEach(function (t) { threats.push({ team: r.team, text: t }); });
    });
    body.appendChild(section('Growth Opportunities'));
    if (!opps.length) body.appendChild(empty(reports.length ? 'No opportunities surfaced yet — run a team analysis.' : 'Run a team analysis to surface opportunities.'));
    opps.slice(0, 5).forEach(function (o) { body.appendChild(row('<strong>' + esc(o.team) + '</strong><div class="aaa-list-sub">' + esc(o.text) + '</div>')); });

    body.appendChild(section('Critical Threats'));
    if (!threats.length) body.appendChild(empty('No threats surfaced yet.'));
    threats.slice(0, 5).forEach(function (t) { body.appendChild(row('<strong style="color:' + RED + '">' + esc(t.team) + '</strong><div class="aaa-list-sub">' + esc(t.text) + '</div>')); });

    // ---- Analyst rankings ----
    body.appendChild(section('Analyst Rankings'));
    if (!rankTable.ok || !rankTable.analysts.length) body.appendChild(empty('No analyst track record yet.'));
    else {
      if (rankTable.status === 'warming_up') body.appendChild(note('Warming up — analysts need ≥3 scored decisions to be "proven".'));
      rankTable.analysts.slice(0, 8).forEach(function (a) {
        const score = a.overall == null ? '—' : a.overall;
        const color = a.overall == null ? GREY : a.overall >= 70 ? GREEN : a.overall >= 50 ? AMBER : RED;
        const r = ui.el('div', { className: 'aaa-list-row' });
        r.innerHTML = '<strong>' + esc(a.analyst) + '</strong> ' + (a.tuned ? '<span class="aaa-list-sub" style="display:inline">· tuned</span>' : '') +
          '<div class="aaa-list-sub">acc ' + (a.accuracy == null ? '—' : a.accuracy) + ' · impact ' + (a.businessImpact == null ? '—' : a.businessImpact) +
          ' · risk ' + (a.riskDetection == null ? '—' : a.riskDetection) + ' · learn ' + (a.learning == null ? '—' : a.learning) +
          ' · trust ' + (a.trust == null ? '—' : a.trust) + ' · ' + a.decisions + ' decisions' + (a.proven ? '' : ' · unproven') + '</div>';
        r.appendChild(ui.statusBadge('Overall ' + score, color));
        body.appendChild(r);
      });
    }

    // ---- Supervisor council ----
    body.appendChild(section('Supervisor Council Decisions'));
    if (councilAcc && councilAcc.decided) body.appendChild(note('Council accuracy: ' + pct(councilAcc.accuracy) + ' over ' + councilAcc.decided + ' resolved decision(s).'));
    if (!votes.length) body.appendChild(empty('No council votes yet — convene the council on a major decision.'));
    votes.forEach(function (v) {
      const color = v.decision === 'approved' ? GREEN : v.decision === 'rejected' ? RED : AMBER;
      const r = ui.el('div', { className: 'aaa-list-row' });
      r.innerHTML = '<strong>' + esc(v.topic.slice(0, 90)) + '</strong>' +
        '<div class="aaa-list-sub">' + v.tally.approve + '✓ / ' + v.tally.reject + '✗ / ' + v.tally.revise + '~ · ' + fmtDate(v.createdAt) +
        (v.outcome && v.outcome.result ? ' · outcome: ' + esc(v.outcome.result) + (typeof v.wasCorrect === 'boolean' ? (v.wasCorrect ? ' ✓' : ' ✗') : '') : '') + '</div>';
      r.appendChild(ui.statusBadge(v.decision, color));
      body.appendChild(r);
    });

    // ---- Meetings ----
    body.appendChild(section('Meeting Outcomes'));
    if (!meetingList.length) body.appendChild(empty('No meetings held yet.'));
    meetingList.forEach(function (m) {
      const r = ui.el('div', { className: 'aaa-list-row' });
      r.innerHTML = '<strong>' + esc(m.name) + '</strong>' +
        '<div class="aaa-list-sub">' + fmtDate(m.createdAt) + ' · ' + (m.actionItems ? m.actionItems.length : 0) + ' action items · ' +
        (m.wins ? m.wins.length : 0) + ' wins / ' + (m.failures ? m.failures.length : 0) + ' failures</div>' +
        ((m.actionItems || []).slice(0, 3).map(function (a) { return '<div class="aaa-list-sub">• [' + esc(a.priority) + '] ' + esc(a.action) + ' (' + esc(a.owner) + ')'; }).join('') );
      body.appendChild(r);
    });

    // ---- Evolution ----
    if (evoList.length && evoList[0].gaps && evoList[0].gaps.length) {
      body.appendChild(section('Evolution — Identified Gaps'));
      evoList[0].gaps.slice(0, 4).forEach(function (g) {
        const color = g.severity === 'HIGH' ? RED : g.severity === 'MEDIUM' ? AMBER : GREY;
        const r = ui.el('div', { className: 'aaa-list-row' });
        r.innerHTML = '<strong>' + esc(g.proposedName || g.area) + '</strong> <span class="aaa-list-sub" style="display:inline">(' + esc(g.proposalType) + ')</span>' +
          '<div class="aaa-list-sub">' + esc(g.area) + ' — ' + esc(g.expectedValue || '') + '</div>';
        r.appendChild(ui.statusBadge(g.severity, color));
        if (aiReady && g.proposalType === 'analyst' && g.status !== 'created') {
          r.appendChild(ui.button({ label: 'Spawn analyst', size: 'sm', variant: 'primary', onClick: async function () {
            r.appendChild(U().spinner('Designing…'));
            const res = await evolution().createAnalyst(g);
            alertResult(res.ok ? ('Spawned "' + (res.agent && res.agent.title) + '"') : ('Failed: ' + res.error));
            await render(body);
          } }));
        }
        body.appendChild(r);
      });
    }

    // ---- Actions ----
    body.appendChild(section('Run the Division'));
    const actions = ui.el('div', { className: 'aaa-actions' });
    actions.appendChild(ui.button({ label: 'Run Team Analysis (6 layers)', icon: '🧪', variant: 'primary', full: true, disabled: !aiReady, onClick: function () { teamFlow(body); } }));
    actions.appendChild(ui.button({ label: 'Run ALL Teams', icon: '🛰', variant: 'secondary', full: true, disabled: !aiReady, onClick: function () { runAllFlow(body); } }));
    actions.appendChild(ui.button({ label: 'Convene Supervisor Council', icon: '🏛', variant: 'secondary', full: true, disabled: !aiReady, onClick: function () { councilFlow(body); } }));
    actions.appendChild(ui.button({ label: 'Hold Intelligence Meeting', icon: '🗓', variant: 'secondary', full: true, disabled: !aiReady, onClick: function () { meetingFlow(body); } }));
    actions.appendChild(ui.button({ label: 'Scan for Evolution Gaps', icon: '🧬', variant: 'secondary', full: true, disabled: !aiReady, onClick: function () { evolveFlow(body); } }));
    actions.appendChild(ui.button({ label: 'Refresh Analyst Rankings', icon: '📊', variant: 'secondary', full: true, onClick: async function () {
      body.innerHTML = ''; body.appendChild(ui.spinner('Re-scoring outcomes & ranking analysts…'));
      await rankings().refresh(); await render(body);
    } }));
    if (research()) {
      actions.appendChild(ui.button({ label: 'Research Brain (read-only)', icon: '🔭', variant: 'secondary', full: true, onClick: function () { researchFlow(body); } }));
    }
    body.appendChild(actions);

    // ---- Research Brain: recent read-only reports ----
    if (research()) {
      const reports = await research().list();
      body.appendChild(section('Research Brain'));
      body.appendChild(note('Read-only strategy research from the separate AI-Q service. Advisory only — never changes jobs, quotes, billing, or customers.'));
      if (!reports.length) body.appendChild(empty('No research yet — tap “Research Brain (read-only)”.'));
      reports.slice(0, 5).forEach(function (r) {
        const row = ui.el('div', { className: 'aaa-list-row' });
        row.innerHTML = '<strong>' + esc((r.subject ? r.subject + ' · ' : '') + (r.templateId || 'research')) + '</strong>' +
          '<div class="aaa-list-sub">' + esc(String(r.report || '').slice(0, 160)) + (String(r.report || '').length > 160 ? '…' : '') + '</div>' +
          '<div class="aaa-list-sub">' + fmtDate(r.createdAtMs) + ' · ' + (r.citations ? r.citations.length : 0) + ' citation(s)</div>';
        row.appendChild(ui.button({ label: 'Open', size: 'sm', variant: 'ghost', onClick: function () { showReport(r); } }));
        body.appendChild(row);
      });
    }
  }

  // ---- action flows -------------------------------------------------------
  function pickerSheet(title, items, onPick) {
    const ui = U();
    const s = ui.sheet({ title: title, size: 'sm' });
    items.forEach(function (it) {
      s.body.appendChild(ui.button({ label: it.label, variant: 'secondary', full: true, onClick: function () { s.close(); onPick(it.value); } }));
    });
    document.body.appendChild(s.overlay);
  }

  function textSheet(title, placeholder, onSubmit) {
    const ui = U();
    const s = ui.sheet({ title: title, size: 'sm' });
    const input = ui.el('textarea', { className: 'aaa-input aaa-textarea', attrs: { placeholder: placeholder || '' } });
    s.body.appendChild(input);
    s.body.appendChild(ui.button({ label: 'Run', variant: 'primary', full: true, onClick: function () {
      const v = input.value.trim(); if (!v) { input.focus(); return; } s.close(); onSubmit(v);
    } }));
    document.body.appendChild(s.overlay);
    setTimeout(function () { input.focus(); }, 50);
  }

  async function runResult(body, label, fn) {
    const ui = U();
    body.innerHTML = ''; body.appendChild(ui.spinner(label));
    let res; try { res = await fn(); } catch (e) { res = { ok: false, error: (e && e.message) || String(e) }; }
    await render(body);
    return res;
  }

  function teamFlow(body) {
    const D = div();
    pickerSheet('Which team?', D.teamIds().map(function (id) { return { label: D.team(id).name, value: id }; }), async function (teamId) {
      const res = await runResult(body, 'Running ' + D.team(teamId).name + ' through all 6 layers…', function () { return pipeline().runTeam(teamId); });
      alertResult(res.ok ? (D.team(teamId).name + ': ' + res.status + (res.confidence != null ? ' (' + res.confidence + '%)' : '')) : ('Failed: ' + res.error));
    });
  }

  // Research Brain: pick a template, enter a subject, run through the proxy.
  function researchFlow(body) {
    const R = research();
    if (!R) return;
    const items = R.templateIds().map(function (id) { return { label: R.TEMPLATES[id].label, value: id }; });
    items.push({ label: 'Free-form question', value: '__free' });
    pickerSheet('Research (read-only)', items, function (templateId) {
      if (templateId === '__free') {
        textSheet('Research question', 'e.g. Top carpet repair competitors in Houston…', async function (q) {
          const res = await runResult(body, 'Researching…', function () { return R.ask(q); });
          if (res.ok) showReport(res.report); else alertResult(researchErr(res));
        });
        return;
      }
      textSheet(R.TEMPLATES[templateId].label, 'Subject — e.g. a city, competitor, or material', async function (subject) {
        const res = await runResult(body, 'Researching ' + R.TEMPLATES[templateId].label + '…', function () { return R.research(templateId, subject); });
        if (res.ok) showReport(res.report); else alertResult(researchErr(res));
      });
    });
  }

  // Turn a research error into a clear, honest message (esp. "not configured").
  function researchErr(res) {
    if (res && res.error === 'RESEARCH_NOT_CONFIGURED') return 'Research Brain isn’t connected yet. An admin must set AIQ_RESEARCH_URL on the server (see netlify/functions/RESEARCH.md).';
    return 'Research failed: ' + ((res && (res.message || res.error)) || 'unknown');
  }

  // Render a stored report + its citations.
  function showReport(r) {
    const ui = U();
    const s = ui.sheet({ title: (r.subject ? r.subject + ' — ' : '') + (r.templateId || 'Research'), subtitle: 'Read-only research · advisory only' });
    s.body.appendChild(ui.el('p', { className: 'aaa-list-sub', text: r.question || '' }));
    s.body.appendChild(ui.el('div', { className: 'aaa-card', style: { whiteSpace: 'pre-wrap', lineHeight: '1.4' }, text: r.report || '' }));
    if (r.citations && r.citations.length) {
      s.body.appendChild(ui.el('h2', { className: 'aaa-section-title', text: 'Citations' }));
      r.citations.forEach(function (c) {
        const row = ui.el('div', { className: 'aaa-list-row' });
        row.innerHTML = '<strong>' + esc(c.title || 'Source') + '</strong>' + (c.url ? '<div class="aaa-list-sub">' + esc(c.url) + '</div>' : '');
        s.body.appendChild(row);
      });
    }
    s.body.appendChild(ui.button({ label: 'Close', variant: 'primary', full: true, onClick: function () { s.close(); } }));
    document.body.appendChild(s.overlay);
  }

  function runAllFlow(body) {
    (async function () {
      const res = await runResult(body, 'Running all teams through the pipeline…', function () { return pipeline().runAll(); });
      alertResult(res.ok ? (res.accepted + ' of ' + res.results.length + ' analyses accepted') : ('Failed: ' + res.error));
    })();
  }

  function councilFlow(body) {
    textSheet('Convene Council — decision to review', 'e.g. Should we raise carpet-repair pricing 10%?', async function (topic) {
      const res = await runResult(body, 'Council is voting…', function () { return council().convene({ topic: topic, context: { note: 'Owner-submitted decision.' }, meta: { source: 'manual' } }); });
      alertResult(res.ok ? ('Council: ' + res.decision.toUpperCase() + ' (' + res.tally.approve + '✓/' + res.tally.reject + '✗/' + res.tally.revise + '~)') : ('Failed: ' + res.error));
    });
  }

  function meetingFlow(body) {
    pickerSheet('Which meeting?', [
      { label: 'Daily — Operations Briefing', value: 'daily' },
      { label: 'Weekly — Executive Intelligence', value: 'weekly' },
      { label: 'Monthly — Strategic Planning', value: 'monthly' },
      { label: 'Quarterly — Business Evolution', value: 'quarterly' }
    ], async function (cadence) {
      const res = await runResult(body, 'Holding the meeting…', function () { return meetings().run(cadence); });
      alertResult(res.ok ? (res.name + ': ' + (res.actionItems ? res.actionItems.length : 0) + ' action items') : ('Failed: ' + res.error));
    });
  }

  function evolveFlow(body) {
    (async function () {
      const res = await runResult(body, 'Scanning for expertise gaps…', function () { return evolution().scan(); });
      alertResult(res.ok ? ((res.gaps ? res.gaps.length : 0) + ' gap(s) identified') : ('Failed: ' + res.error));
    })();
  }

  function alertResult(msg) {
    const ui = U();
    const s = ui.sheet({ title: 'Done', size: 'sm' });
    s.body.appendChild(ui.el('p', { className: 'aaa-dialog__message', text: msg }));
    s.body.appendChild(ui.button({ label: 'OK', variant: 'primary', full: true, onClick: function () { s.close(); } }));
    document.body.appendChild(s.overlay);
  }

  global.AAA_INTEL_DASHBOARD = { open: open, render: render };
})(typeof window !== 'undefined' ? window : this);
