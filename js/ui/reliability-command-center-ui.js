/*
 * AAA Reliability Command Center — owner-only one-pane monitoring.
 *
 * Overall health, metric tiles (transport, conversion, prediction/agent
 * accuracy, calibration, backlogs, sync, integrity) with status colors, active
 * alerts, and the incident timeline (open / resolve). Read-only over the system;
 * it observes and surfaces — a person acts. Gated on VIEW_FINANCIALS (owner),
 * since it aggregates conversion/margin-derived metrics.
 */
;(function (global) {
  'use strict';

  function U() { return global.AAA_UI; }
  function R() { return global.AAA_RELIABILITY; }
  function rbac() { return global.AAA_RBAC; }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
  function actor() { return (rbac() && rbac().label && rbac().label()) || 'owner'; }
  const COLOR = { ok: '#10B981', warn: '#F59E0B', crit: '#EF4444', unknown: '#71717A' };

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
      container.appendChild(ui.el('div', { className: 'aaa-list-row', html: '<strong>🔒 The Reliability Command Center is owner-only</strong><div class="aaa-list-sub">Signed in as ' + esc(rbac().label()) + '. It aggregates conversion/margin metrics, so it is owner-only.</div>' }));
      return;
    }
    if (!R()) { container.appendChild(empty('Reliability module unavailable.')); return; }

    container.appendChild(ui.spinner('Gathering system health…'));
    let health, metrics, alerts, incidents;
    try { health = await R().health(); metrics = await R().metrics(); alerts = await R().alerts(); incidents = await R().incidents('open'); }
    catch (err) { container.innerHTML = ''; container.appendChild(ui.el('div', { className: 'aaa-list-row', html: '<strong>Could not load reliability</strong><div class="aaa-list-sub">' + esc((err && err.message) || err) + '</div>' })); return; }
    container.innerHTML = '';

    container.appendChild(ui.el('section', { className: 'aaa-summary' }, [
      chip(health.status === 'unknown' ? '—' : health.status.toUpperCase(), 'Health', COLOR[health.status]),
      chip(health.score == null ? '—' : health.score + '%', 'Metrics OK', COLOR[health.score >= 80 ? 'ok' : health.score >= 50 ? 'warn' : 'crit']),
      chip(alerts.length, 'Alerts', alerts.length ? (alerts.some((a) => a.status === 'crit') ? COLOR.crit : COLOR.warn) : COLOR.ok),
      chip(incidents.length, 'Open incidents', incidents.length ? COLOR.crit : COLOR.ok)
    ]));

    container.appendChild(ui.button({ label: 'Snapshot + evaluate', icon: '📈', variant: 'secondary', full: true, onClick: async () => { await R().snapshot(); await R().evaluate(); await render(container); } }));

    // Active alerts.
    if (alerts.length) {
      container.appendChild(title('Active alerts'));
      alerts.forEach((a) => container.appendChild(ui.el('div', { className: 'aaa-list-row', html:
        '<strong style="color:' + COLOR[a.status] + '">' + (a.status === 'crit' ? '⛔' : '🟠') + ' ' + esc(a.label) + ' — ' + esc(String(a.value)) + esc(a.unit || '') + '</strong>' + (a.detail ? '<div class="aaa-list-sub">' + esc(a.detail) + '</div>' : '') })));
    }

    // Metric tiles.
    container.appendChild(title('Metrics'));
    metrics.forEach((x) => container.appendChild(ui.el('div', { className: 'aaa-list-row', html:
      '<strong style="color:' + COLOR[x.status] + '">' + esc(x.label) + '</strong><div class="aaa-list-sub">' + esc(x.value == null ? '—' : String(x.value)) + esc(x.unit || '') + ' · ' + esc(x.status) + (x.detail ? ' · ' + esc(x.detail) : '') + '</div>' })));

    // Incident timeline.
    container.appendChild(title('Incident timeline'));
    if (!incidents.length) container.appendChild(empty('No open incidents.'));
    incidents.forEach((i) => {
      const row = ui.el('div', { className: 'aaa-list-row', html:
        '<strong style="color:' + COLOR[i.severity] + '">' + esc(i.title) + '</strong><div class="aaa-list-sub">since ' + esc(i.firstSeenAt || '') + ' · ' + (i.occurrences || 1) + 'x' + (i.lastValue != null ? ' · last ' + esc(String(i.lastValue)) : '') + '</div>' });
      row.appendChild(ui.button({ label: 'Resolve', size: 'sm', variant: 'ghost', onClick: async () => { await R().resolveIncident(i.id, { actor: actor() }); await render(container); } }));
      container.appendChild(row);
    });

    container.appendChild(ui.el('p', { className: 'aaa-voice-hint', text: 'Observability only — the command center surfaces system health, alerts, and incidents. It never auto-remediates; you decide and act.' }));
  }

  function open() {
    const ui = U();
    const sheet = ui.sheet({ title: 'Reliability Command Center', subtitle: 'AAA Carpet — system health & incidents' });
    document.body.appendChild(sheet.overlay);
    render(sheet.body);
  }

  global.AAA_RELIABILITY_UI = { render: render, open: open };
})(typeof window !== 'undefined' ? window : this);
