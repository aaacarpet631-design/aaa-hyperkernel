/*
 * AAA Event Stream — owner-only view of the native event bus.
 *
 * Shows the contract catalog (the events AAA speaks), the immutable event log
 * (newest first), chain integrity (tamper status), and throughput analytics.
 * Read-only window onto AAA_EVENT_BUS — no external broker, no infrastructure.
 * Gated on VIEW_FINANCIALS (owner) to match the owner-only event_log collection.
 */
;(function (global) {
  'use strict';

  function U() { return global.AAA_UI; }
  function bus() { return global.AAA_EVENT_BUS; }
  function rbac() { return global.AAA_RBAC; }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
  const GOOD = '#10B981', BAD = '#EF4444';

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
      container.appendChild(ui.el('div', { className: 'aaa-list-row', html: '<strong>🔒 The Event Stream is owner-only</strong><div class="aaa-list-sub">Signed in as ' + esc(rbac().label ? rbac().label() : '') + '. The event log can carry business data, so it is owner-only.</div>' }));
      return;
    }
    if (!bus()) { container.appendChild(empty('Event bus unavailable.')); return; }

    container.appendChild(ui.spinner('Loading event stream…'));
    let log, chain, an, contracts;
    try { log = await bus().log(); chain = await bus().verifyChain(); an = await bus().analytics(); contracts = bus().contracts(); }
    catch (err) { container.innerHTML = ''; container.appendChild(ui.el('div', { className: 'aaa-list-row', html: '<strong>Could not load the event stream</strong><div class="aaa-list-sub">' + esc((err && err.message) || err) + '</div>' })); return; }
    container.innerHTML = '';

    container.appendChild(ui.el('section', { className: 'aaa-summary' }, [
      chip(an.total, 'Events', '#3B82F6'),
      chip(contracts.length, 'Contracts', '#8B5CF6'),
      chip(chain.ok ? '✓' : '⚠', 'Chain', chain.ok ? GOOD : BAD)
    ]));

    container.appendChild(title('Chain integrity'));
    container.appendChild(ui.el('div', { className: 'aaa-list-row', html: chain.ok
      ? '<strong style="color:' + GOOD + '">✓ Intact — ' + chain.length + ' events</strong><div class="aaa-list-sub">Every event is hash-chained to its predecessor; no tampering detected.</div>'
      : '<strong style="color:' + BAD + '">⚠ ' + chain.breaks.length + ' break(s)</strong><div class="aaa-list-sub">' + esc(chain.breaks.map((b) => 'seq ' + b.seq + ': ' + b.reason).slice(0, 5).join(' · ')) + '</div>' }));

    container.appendChild(title('Event contracts'));
    contracts.forEach((c) => container.appendChild(ui.el('div', { className: 'aaa-list-row', html:
      '<strong>' + esc(c.type) + ' · v' + c.version + (c.bridged ? ' · bridged' : '') + '</strong><div class="aaa-list-sub">' + esc(c.description) + ' · ' + (an.byType[c.type] || 0) + ' logged</div>' })));

    container.appendChild(title('Recent events (' + log.length + ')'));
    if (!log.length) container.appendChild(empty('No events yet.'));
    log.slice(0, 20).forEach((e) => container.appendChild(ui.el('div', { className: 'aaa-list-row', html:
      '<strong>#' + e.seq + ' · ' + esc(e.type) + '</strong><div class="aaa-list-sub">' + esc(e.at) + ' · ' + esc(e.source || 'app') + ' · ' + esc(JSON.stringify(e.payload).slice(0, 120)) + '</div>' })));

    container.appendChild(ui.el('p', { className: 'aaa-voice-hint', text: 'AAA owns the event contracts and the log — no broker, no vendor, offline-safe. Every event is schema-validated and hash-chained.' }));
  }

  function open() {
    const ui = U();
    const sheet = ui.sheet({ title: 'Event Stream', subtitle: 'AAA Carpet — native event bus' });
    document.body.appendChild(sheet.overlay);
    render(sheet.body);
  }

  global.AAA_EVENT_STREAM_UI = { render: render, open: open };
})(typeof window !== 'undefined' ? window : this);
