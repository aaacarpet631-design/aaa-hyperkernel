/*
 * AAA AI Operations Command Center — owner-only mission control.
 *
 * One screen: the owner briefing (digest), system health, and a single unified
 * action queue of everything awaiting a decision across the whole AI org — each
 * item opens the module that owns it. Read-only aggregation; it acts on nothing.
 * Gated on VIEW_FINANCIALS (owner).
 */
;(function (global) {
  'use strict';

  function U() { return global.AAA_UI; }
  function OPS() { return global.AAA_AI_OPS; }
  function rbac() { return global.AAA_RBAC; }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
  const COLOR = { ok: '#10B981', warn: '#F59E0B', crit: '#EF4444', unknown: '#71717A' };
  const KIND = { incident: { icon: '🚨', color: '#EF4444' }, executive: { icon: '🏛', color: '#F59E0B' }, privacy: { icon: '🔐', color: '#F59E0B' }, council: { icon: '⚖️', color: '#3B82F6' }, calibration: { icon: '🎚️', color: '#3B82F6' }, pricing: { icon: '💲', color: '#8B5CF6' }, transport: { icon: '📨', color: '#8B5CF6' } };

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
      container.appendChild(ui.el('div', { className: 'aaa-list-row', html: '<strong>🔒 The AI Operations Center is owner-only</strong><div class="aaa-list-sub">Signed in as ' + esc(rbac().label()) + '.</div>' }));
      return;
    }
    if (!OPS()) { container.appendChild(empty('AI Operations Center unavailable.')); return; }

    container.appendChild(ui.spinner('Gathering operations…'));
    let digest, summary, queue;
    try { digest = await OPS().digest(); summary = await OPS().summary(); queue = await OPS().actionQueue(); }
    catch (err) { container.innerHTML = ''; container.appendChild(ui.el('div', { className: 'aaa-list-row', html: '<strong>Could not load operations</strong><div class="aaa-list-sub">' + esc((err && err.message) || err) + '</div>' })); return; }
    container.innerHTML = '';

    // Briefing.
    container.appendChild(ui.el('div', { className: 'aaa-list-row', html: '<strong>' + esc(digest.headline) + '</strong>' }));
    const h = summary.health || {};
    container.appendChild(ui.el('section', { className: 'aaa-summary' }, [
      chip(summary.pendingDecisions, 'To decide', summary.pendingDecisions ? '#F59E0B' : '#10B981'),
      chip(h.status ? h.status.toUpperCase() : '—', 'Health', COLOR[h.status] || COLOR.unknown),
      chip(summary.agentActivity.decisions, 'Agent actions', '#3B82F6'),
      chip(summary.governance.activeVersions, 'Active versions', '#8B5CF6')
    ]));

    // Unified action queue.
    container.appendChild(title('Action queue (' + queue.length + ')'));
    if (!queue.length) container.appendChild(empty('Nothing is waiting on you. ✅'));
    queue.slice(0, 30).forEach((x) => {
      const d = KIND[x.kind] || { icon: '•', color: 'var(--muted)' };
      const row = ui.el('div', { className: 'aaa-list-row', html:
        '<strong style="color:' + d.color + '">' + d.icon + ' ' + esc(x.title) + '</strong><div class="aaa-list-sub">' + esc(x.kind) + ' · ' + esc(x.summary) + '</div>' });
      if (x.openModule && global[x.openModule] && global[x.openModule].open) row.appendChild(ui.button({ label: 'Open', size: 'sm', variant: 'secondary', onClick: () => global[x.openModule].open() }));
      container.appendChild(row);
    });

    container.appendChild(ui.el('p', { className: 'aaa-voice-hint', text: 'Mission control unifies every decision waiting on you — it surfaces and routes, but acts on nothing. You decide; the system records it.' }));
  }

  function open() {
    const ui = U();
    const sheet = ui.sheet({ title: 'AI Operations Center', subtitle: 'AAA Carpet — mission control' });
    document.body.appendChild(sheet.overlay);
    render(sheet.body);
  }

  global.AAA_AI_OPS_UI = { render: render, open: open };
})(typeof window !== 'undefined' ? window : this);
