/*
 * AAA Sensing — office-only signal log.
 *
 * Shows the real-world signals the system noticed on its own (inbound SMS, missed
 * calls, web leads) and the PENDING owner-approval draft each produced. Read-only;
 * it surfaces what was sensed and routes you to the Assisted Drafts queue to act.
 * The system perceives automatically; it still proposes, never sends. Gated on
 * EDIT_CUSTOMER (owner + manager).
 */
;(function (global) {
  'use strict';

  function U() { return global.AAA_UI; }
  function S() { return global.AAA_SENSING; }
  function rbac() { return global.AAA_RBAC; }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
  function canUse() { const r = rbac(); return !r || r.can('EDIT_CUSTOMER'); }
  const ICON = { inbound_sms: '💬', missed_call: '📞', web_lead: '📝' };

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
    if (rbac() && !canUse()) {
      container.appendChild(ui.el('div', { className: 'aaa-list-row', html: '<strong>🔒 The signal log is office-only</strong><div class="aaa-list-sub">Signed in as ' + esc(rbac().label()) + '.</div>' }));
      return;
    }
    if (!S()) { container.appendChild(empty('Sensing layer unavailable.')); return; }

    container.appendChild(ui.spinner('Loading sensed signals…'));
    let signals, m;
    try { signals = await S().list(); m = await S().metrics(); }
    catch (err) { container.innerHTML = ''; container.appendChild(ui.el('div', { className: 'aaa-list-row', html: '<strong>Could not load signals</strong><div class="aaa-list-sub">' + esc((err && err.message) || err) + '</div>' })); return; }
    container.innerHTML = '';

    container.appendChild(ui.el('section', { className: 'aaa-summary' }, [
      chip(m.total, 'Signals', '#3B82F6'),
      chip(m.draftsCreated, 'Drafts queued', m.draftsCreated ? '#F59E0B' : '#10B981'),
      chip(Object.keys(m.byType || {}).length, 'Channels', '#8B5CF6')
    ]));

    if (global.AAA_ASSISTED_DRAFTS_UI) container.appendChild(ui.button({ label: 'Review drafts in the approval queue', icon: '✍️', variant: 'secondary', full: true, onClick: () => global.AAA_ASSISTED_DRAFTS_UI.open() }));

    container.appendChild(title('Recent signals'));
    if (!signals.length) container.appendChild(empty('No signals sensed yet. Webhooks (SMS, missed calls, web leads) appear here.'));
    signals.slice(0, 25).forEach((s) => container.appendChild(ui.el('div', { className: 'aaa-list-row', html:
      '<strong>' + (ICON[s.type] || '•') + ' ' + esc(s.type) + (s.source ? ' · ' + esc(s.source) : '') + '</strong>' +
      '<div class="aaa-list-sub">' + esc((s.payload && (s.payload.from || s.payload.phone || s.payload.email)) || '') + (s.payload && s.payload.body ? ' · “' + esc(String(s.payload.body).slice(0, 60)) + '”' : '') + '</div>' +
      '<div class="aaa-list-sub">' + (s.draftId ? '→ suggested ' + esc(s.intent || 'reply') + ' queued for approval' : 'recorded') + ' · ' + esc(s.createdAt || '') + '</div>' })));

    container.appendChild(ui.el('p', { className: 'aaa-voice-hint', text: 'The system notices signals on its own and suggests a response — it never sends one. You approve every customer message in the queue.' }));
  }

  function open() {
    const ui = U();
    const sheet = ui.sheet({ title: 'Sensing', subtitle: 'AAA Carpet — signals → suggested replies (owner-approved)' });
    document.body.appendChild(sheet.overlay);
    render(sheet.body);
  }

  global.AAA_SENSING_UI = { render: render, open: open };
})(typeof window !== 'undefined' ? window : this);
