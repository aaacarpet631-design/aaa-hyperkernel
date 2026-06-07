/*
 * AAA Calibration — owner-only governance inbox.
 *
 * Pending calibration proposals (approve / reject / simulate), the active
 * calibration per agent (with one-click rollback + version history), and an
 * impact simulator ("what would have happened?"). Every apply/reject/rollback is
 * human-gated + audited in the registry; nothing here changes a price.
 */
;(function (global) {
  'use strict';

  function U() { return global.AAA_UI; }
  function reg() { return global.AAA_CALIBRATION_REGISTRY; }
  function rbac() { return global.AAA_RBAC; }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
  function signed(n) { return (Number(n) > 0 ? '+' : '') + Number(n || 0); }

  function chip(value, label, color) {
    return U().el('div', { className: 'aaa-chip' }, [
      U().el('span', { className: 'aaa-chip__value', text: String(value), style: { color: color || 'var(--muted)' } }),
      U().el('span', { className: 'aaa-chip__label', text: label }),
      U().el('div', { className: 'aaa-chip__bar', style: { background: color || 'var(--muted)', opacity: '0.85' } })
    ]);
  }
  function title(t) { return U().el('h2', { className: 'aaa-section-title', text: t }); }
  function empty(t) { return U().el('p', { className: 'aaa-empty', text: t }); }

  async function render(container) {
    const ui = U();
    container.innerHTML = '';
    if (rbac() && !rbac().can('VIEW_FINANCIALS')) {
      container.appendChild(ui.el('div', { className: 'aaa-list-row', html: '<strong>🔒 Calibration is owner-only</strong><div class="aaa-list-sub">Signed in as ' + esc(rbac().label()) + '. Governing AI tuning is restricted to the owner.</div>' }));
      return;
    }
    if (!reg()) { container.appendChild(empty('Calibration registry unavailable.')); return; }

    container.appendChild(ui.spinner('Loading calibration inbox…'));
    let pending, versions;
    try {
      pending = await reg().listProposals('pending');
      versions = await reg().versions();
    } catch (err) {
      container.innerHTML = '';
      container.appendChild(ui.el('div', { className: 'aaa-list-row', html: '<strong>Could not load calibration</strong><div class="aaa-list-sub">' + esc((err && err.message) || err) + '</div>' }));
      return;
    }
    const active = versions.filter((v) => v.active);
    container.innerHTML = '';

    container.appendChild(ui.el('section', { className: 'aaa-summary' }, [
      chip(pending.length, 'Pending', '#F59E0B'),
      chip(active.length, 'Active', '#10B981'),
      chip(versions.length, 'Versions', '#3B82F6')
    ]));

    // Generate proposals from current learning signals.
    container.appendChild(ui.button({ label: 'Generate proposals from learning', icon: '🧠', variant: 'secondary', full: true, onClick: async () => {
      const actor = (rbac() && rbac().label && rbac().label()) || 'owner';
      await reg().propose({ actor: actor });
      await render(container);
    } }));

    // ---- Calibration Inbox (pending) ----
    container.appendChild(title('Calibration Inbox'));
    if (!pending.length) container.appendChild(empty('No pending proposals. Generate from learning once a few predictions have closed.'));
    for (const p of pending) container.appendChild(await proposalCard(p, container));

    // ---- Active calibration + rollback center ----
    container.appendChild(title('Active Calibration'));
    if (!active.length) container.appendChild(empty('No calibration applied — agents run at baseline.'));
    active.forEach((v) => {
      const row = ui.el('div', { className: 'aaa-list-row', html:
        '<strong>' + esc(v.agent) + ' · v' + v.version + '</strong>' +
        '<div class="aaa-list-sub">confidence bias ' + signed(v.confidenceBias) + ' · risk bias ' + signed(v.riskBias) + (v.segmentAdjustments && v.segmentAdjustments.length ? ' · ' + v.segmentAdjustments.length + ' segment tweak(s)' : '') + '</div>' +
        (v.beforeAfter ? '<div class="aaa-list-sub">alignment ' + fmtRate(v.beforeAfter.before) + ' → ' + fmtRate(v.beforeAfter.after) + '</div>' : '') });
      const actions = ui.el('div', { className: 'aaa-form', style: { display: 'flex', gap: '8px', flexWrap: 'wrap' } });
      actions.appendChild(ui.button({ label: 'Roll back', size: 'sm', variant: 'ghost', onClick: async () => {
        const actor = (rbac() && rbac().label && rbac().label()) || 'owner';
        const ok = await ui.confirm({ title: 'Roll back calibration?', message: 'Revert ' + v.agent + ' to the previous version (or baseline). Reversible and audited.', confirmLabel: 'Roll back' });
        if (!ok) return;
        const res = await reg().rollback(v.agent, { actor: actor });
        if (!res.ok) await ui.confirm({ title: 'Not allowed', message: res.message || res.error, confirmLabel: 'OK' });
        await render(container);
      } }));
      actions.appendChild(ui.button({ label: 'History', size: 'sm', variant: 'secondary', onClick: () => historyDrawer(v.agent) }));
      row.appendChild(actions);
      container.appendChild(row);
    });

    container.appendChild(ui.el('p', { className: 'aaa-voice-hint', text: 'Governance only. Calibration tunes agent confidence after you approve it — it never changes a price, and every action is audited and reversible.' }));
  }

  async function proposalCard(p, container) {
    const ui = U();
    let sim = null; try { sim = await reg().simulate({ agent: p.agent, confidenceBias: p.confidenceBias }); } catch (_) {}
    const card = ui.el('div', { className: 'aaa-list-row', html:
      '<strong>' + esc(p.agent) + ' · confidence ' + signed(p.confidenceBias) + ' · risk ' + signed(p.riskBias) + '</strong>' +
      '<div class="aaa-list-sub">' + esc(p.rationale) + '</div>' +
      (p.segmentAdjustments && p.segmentAdjustments.length ? '<div class="aaa-list-sub">Segment tweaks: ' + esc(p.segmentAdjustments.map((s) => s.segmentKey + ' ' + signed(s.confidenceBias)).join(', ')) + '</div>' : '') +
      (sim && sim.sample ? '<div class="aaa-list-sub">🔮 Simulated alignment ' + fmtRate(sim.beforeAlignmentRate) + ' → ' + fmtRate(sim.afterAlignmentRate) + ' over ' + sim.sample + ' closures (no live change)</div>' : '<div class="aaa-list-sub">🔮 Not enough closures to simulate yet</div>') });
    const actions = ui.el('div', { className: 'aaa-form', style: { display: 'flex', gap: '8px', flexWrap: 'wrap' } });
    const actor = (rbac() && rbac().label && rbac().label()) || 'owner';
    actions.appendChild(ui.button({ label: 'Approve & apply', size: 'sm', variant: 'primary', onClick: async () => {
      const ok = await ui.confirm({ title: 'Approve calibration?', message: 'Apply confidence bias ' + signed(p.confidenceBias) + ' to ' + p.agent + '. Reversible + audited. It tunes confidence only — no prices change.', confirmLabel: 'Approve' });
      if (!ok) return;
      const res = await reg().approve(p.id, { actor: actor });
      if (!res.ok) await ui.confirm({ title: 'Not allowed', message: res.message || res.error, confirmLabel: 'OK' });
      await render(container);
    } }));
    actions.appendChild(ui.button({ label: 'Reject', size: 'sm', variant: 'ghost', onClick: async () => { await reg().reject(p.id, { actor: actor }); await render(container); } }));
    card.appendChild(actions);
    return card;
  }

  function fmtRate(r) { return r == null ? '—' : Math.round(r * 100) + '%'; }

  async function historyDrawer(agent) {
    const ui = U();
    const s = ui.sheet({ title: 'Version history', subtitle: agent });
    document.body.appendChild(s.overlay);
    const versions = await reg().versions(agent);
    if (!versions.length) s.body.appendChild(empty('No versions.'));
    versions.forEach((v) => s.body.appendChild(ui.el('div', { className: 'aaa-list-row', html:
      '<strong>v' + v.version + (v.active ? ' · active' : '') + (v.rolledBack ? ' · rollback' : '') + '</strong>' +
      '<div class="aaa-list-sub">conf ' + signed(v.confidenceBias) + ' · risk ' + signed(v.riskBias) + ' · ' + esc(v.appliedAt || '') + (v.appliedBy ? ' · ' + esc(v.appliedBy) : '') + '</div>' })));
    s.body.appendChild(ui.button({ label: 'Done', variant: 'ghost', full: true, onClick: () => s.close() }));
  }

  function open() {
    const ui = U();
    const sheet = ui.sheet({ title: 'Calibration', subtitle: 'AAA Carpet — governed AI tuning' });
    document.body.appendChild(sheet.overlay);
    render(sheet.body);
  }

  global.AAA_CALIBRATION_UI = { render: render, open: open };
})(typeof window !== 'undefined' ? window : this);
