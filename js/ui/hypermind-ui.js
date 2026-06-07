/*
 * AAA HyperMind Console — make the autonomous loop legible (HM-5).
 *
 * Read + steer the continuous cognition loop from one owner-facing panel:
 *   • Status      — enabled / running / autonomy / cadence / last tick
 *   • Controls    — start/stop the loop, toggle full autonomy (kill switch),
 *                   run one cycle now
 *   • Loop log    — recent ticks with per-phase ran/skipped/error
 *   • Autonomy    — the autonomous-action ledger (proposed/applied/skipped)
 *   • Tunings     — every active autonomous calibration + one-click rollback
 *
 * Owner-only (gated on VIEW_FINANCIALS). Read-only over real data; the only
 * mutations are the owner's own controls (start/stop/autonomy/rollback), each of
 * which routes through the governed driver/executor. Honest empty/error states.
 */
;(function (global) {
  'use strict';

  function U() { return global.AAA_UI; }
  function HM() { return global.AAA_HYPERMIND; }
  function EX() { return global.AAA_HYPERMIND_EXECUTOR; }
  function CAL() { return global.AAA_CALIBRATION_REGISTRY; }
  function rbac() { return global.AAA_RBAC; }

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
  function fmtDate(v) { if (!v) return ''; const d = new Date(typeof v === 'number' ? v : Date.parse(v)); return isNaN(d.getTime()) ? '' : d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }); }
  function dot(status) { return status === 'ok' ? '🟢' : status === 'degraded' ? '🟡' : status === 'error' ? '🔴' : '⚪'; }

  function section(title) { return U().el('h2', { className: 'aaa-section-title', text: title }); }
  function row(html) { return U().el('div', { className: 'aaa-list-row', html: html }); }

  async function open() {
    const ui = U();
    const sheet = ui.sheet({ title: 'HyperMind', subtitle: 'Continuous cognition loop' });
    document.body.appendChild(sheet.overlay);
    await render(sheet.body);
  }

  async function render(container) {
    const ui = U();
    container.innerHTML = '';

    // Owner-only.
    if (rbac() && rbac().can && !rbac().can('VIEW_FINANCIALS')) {
      container.appendChild(row('🔒 HyperMind is <strong>owner-only</strong>.'));
      return;
    }
    if (!HM()) { container.appendChild(row('HyperMind is not available in this build.')); return; }

    container.appendChild(ui.spinner('Loading HyperMind…'));
    let status, ticks, actions, versions;
    try {
      status = HM().status();
      ticks = await HM().history(8);
      actions = EX() && EX().history ? await EX().history(8) : [];
      versions = CAL() && CAL().versions ? (await CAL().versions()).filter((v) => v.active && !v.rolledBack) : [];
    } catch (e) {
      container.innerHTML = '';
      container.appendChild(row('⚠️ Could not load HyperMind. ' + esc((e && e.message) || e)));
      return;
    }
    container.innerHTML = '';

    // ---- Status ----
    container.appendChild(section('Status'));
    const running = status.running ? '🟢 running' : (status.enabled ? '🟡 enabled (idle)' : '⚪ stopped');
    const auto = status.autoApply ? '🤖 fully autonomous' : '✋ advisory (proposes only)';
    container.appendChild(row('<strong>' + running + '</strong> · ' + auto +
      '<div class="aaa-list-sub">cadence ' + Math.round((status.intervalMs || 0) / 1000) + 's · ' + (status.tickCount || 0) + ' ticks · last ' + (status.lastTickAt ? dot(status.lastStatus) + ' ' + fmtDate(status.lastTickAt) : '—') + '</div>'));

    // ---- Controls ----
    container.appendChild(section('Controls'));
    container.appendChild(ui.button({ label: status.enabled ? 'Stop HyperMind' : 'Start HyperMind', icon: status.enabled ? '⏹' : '▶️', variant: status.enabled ? 'secondary' : 'primary', full: true, onClick: async () => { HM().setEnabled(!status.enabled); await render(container); } }));
    container.appendChild(ui.button({ label: status.autoApply ? 'Switch to advisory (kill autonomy)' : 'Enable full autonomy', icon: status.autoApply ? '✋' : '🤖', variant: 'secondary', full: true, onClick: async () => { HM().setAutoApply(!status.autoApply); await render(container); } }));
    container.appendChild(ui.button({ label: 'Run one cycle now', icon: '🔄', variant: 'secondary', full: true, onClick: async () => { await HM().tick({ source: 'manual' }); await render(container); } }));

    // ---- Autonomous actions ledger ----
    container.appendChild(section('Autonomous Actions'));
    if (!actions.length) container.appendChild(row('<span class="aaa-list-sub">No autonomous actions yet.</span>'));
    actions.forEach((a) => {
      const mode = a.mode === 'autonomous' ? '🤖' : a.mode === 'rollback' ? '↩️' : '✋';
      container.appendChild(row(mode + ' <strong>' + esc(a.mode) + '</strong> — ' + (a.applied || 0) + ' applied · ' + (a.skipped || 0) + ' skipped · ' + (a.proposed || 0) + ' proposed' +
        (a.promptTunings ? ' · ' + a.promptTunings + ' prompt' : '') +
        '<div class="aaa-list-sub">' + fmtDate(a.at) + '</div>'));
    });

    // ---- Active autonomous tunings + rollback ----
    container.appendChild(section('Active Tunings'));
    if (!versions.length) container.appendChild(row('<span class="aaa-list-sub">No calibration applied.</span>'));
    versions.forEach((v) => {
      const r = row((v.autonomous ? '🤖 ' : '👤 ') + '<strong>' + esc(v.agent) + '</strong> v' + v.version +
        '<div class="aaa-list-sub">confidence ' + (v.confidenceBias >= 0 ? '+' : '') + v.confidenceBias + ' · risk ' + (v.riskBias >= 0 ? '+' : '') + v.riskBias + ' · ' + fmtDate(v.appliedAt) + '</div>');
      container.appendChild(r);
      container.appendChild(ui.button({ label: 'Roll back ' + v.agent, icon: '↩️', variant: 'secondary', full: true, onClick: async () => { if (EX() && EX().rollback) { const ok = ui.confirm ? await ui.confirm('Roll back ' + v.agent + ' calibration?') : true; if (ok) { await EX().rollback(v.agent); await render(container); } } } }));
    });
    if (versions.length > 1) container.appendChild(ui.button({ label: 'Roll back ALL autonomous tunings', icon: '⏮', variant: 'secondary', full: true, onClick: async () => { if (EX() && EX().rollbackAll) { const ok = ui.confirm ? await ui.confirm('Roll back every autonomous tuning?') : true; if (ok) { await EX().rollbackAll(); await render(container); } } } }));

    // ---- Recent loop ticks ----
    container.appendChild(section('Loop Log'));
    if (!ticks.length) container.appendChild(row('<span class="aaa-list-sub">No ticks recorded yet.</span>'));
    ticks.forEach((tk) => {
      const phases = (tk.phases || []).map((p) => p.phase + ':' + (p.status === 'ran' ? '✓' : p.status === 'skipped' ? '–' : '✗')).join(' ');
      container.appendChild(row(dot(tk.status) + ' <strong>' + esc(tk.status) + '</strong> <span class="aaa-list-sub">' + fmtDate(tk.at) + ' · ' + esc(tk.source || '') + '</span>' +
        '<div class="aaa-list-sub">' + esc(phases) + '</div>'));
    });

    // ---- Honest disclaimer ----
    container.appendChild(row('<span class="aaa-list-sub">Autonomy applies INTERNAL learning only (calibration, prompt tunings). It never changes a price, sends a message, or moves money — those stay human-gated.</span>'));
  }

  global.AAA_HYPERMIND_UI = { open: open, render: render };
})(typeof window !== 'undefined' ? window : this);
