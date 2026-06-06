/*
 * AAA Delivery — customer messaging dashboard (office/owner).
 *
 * Shows delivery status (sent/delivered/failed/bounced), the pending-approval
 * queue (the review gate — approve/cancel), and pending retries. Gated on
 * EDIT_CUSTOMER (office), so crew can't send. Approving routes through the
 * store's gateway-audited path; nothing sends without a person.
 */
;(function (global) {
  'use strict';

  function U() { return global.AAA_UI; }
  function tx() { return global.AAA_TRANSPORT; }
  function rbac() { return global.AAA_RBAC; }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
  function canSend() { const r = rbac(); return !r || r.can('EDIT_CUSTOMER'); }

  const STATUS_COLOR = { pending_approval: '#F59E0B', duplicate: '#A1A1AA', queued: '#3B82F6', sending: '#3B82F6', sent: '#8B5CF6', delivered: '#10B981', failed: '#EF4444', bounced: '#EF4444', canceled: '#71717A' };

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
    if (rbac() && !canSend()) {
      container.appendChild(ui.el('div', { className: 'aaa-list-row', html: '<strong>🔒 Messaging is office-only</strong><div class="aaa-list-sub">Signed in as ' + esc(rbac().label()) + '. Sending customer messages is restricted.</div>' }));
      return;
    }
    if (!tx()) { container.appendChild(empty('Transport unavailable.')); return; }

    container.appendChild(ui.spinner('Loading delivery…'));
    let stats, pending;
    try { stats = await tx().stats(); pending = await tx().pendingApproval(); }
    catch (err) { container.innerHTML = ''; container.appendChild(ui.el('div', { className: 'aaa-list-row', html: '<strong>Could not load delivery</strong><div class="aaa-list-sub">' + esc((err && err.message) || err) + '</div>' })); return; }
    container.innerHTML = '';

    container.appendChild(ui.el('section', { className: 'aaa-summary' }, [
      chip(stats.delivered, 'Delivered', '#10B981'),
      chip(stats.sent, 'Sent', '#8B5CF6'),
      chip(stats.pendingApproval, 'Pending Approval', '#F59E0B')
    ]));
    container.appendChild(ui.el('section', { className: 'aaa-summary' }, [
      chip(stats.failed, 'Failed', '#EF4444'),
      chip(stats.bounced, 'Bounced', '#EF4444'),
      chip(stats.pendingRetry, 'Pending Retry', '#3B82F6')
    ]));

    // Scheduler: auto-draft due review requests (still pending approval).
    if (global.AAA_TRANSPORT_SCHEDULER) {
      container.appendChild(ui.button({ label: 'Run review scheduler', icon: '⏰', variant: 'secondary', full: true, onClick: async () => {
        const r = await global.AAA_TRANSPORT_SCHEDULER.runReviewRequests({});
        await render(container);
        if (r && r.ok) await ui.confirm({ title: 'Scheduler ran', message: r.drafted + ' review message(s) drafted for your approval.', confirmLabel: 'OK' });
      } }));
    }

    // The review gate: pending approval queue.
    container.appendChild(title('Pending Approval'));
    if (!pending.length) container.appendChild(empty('Nothing waiting to send.'));
    pending.forEach((m) => {
      const row = ui.el('div', { className: 'aaa-list-row', html:
        '<strong style="color:' + (STATUS_COLOR[m.status] || '#A1A1AA') + '">' + esc(m.category || m.templateId) + ' · ' + esc(m.channel) + '</strong>' +
        '<div class="aaa-list-sub">to ' + esc(m.to) + (m.duplicateOf ? ' · ⚠ possible duplicate' : '') + '</div>' +
        '<div class="aaa-list-sub">“' + esc((m.body || '').slice(0, 120)) + '”</div>' });
      const actions = ui.el('div', { className: 'aaa-form', style: { display: 'flex', gap: '8px', flexWrap: 'wrap' } });
      const actor = (rbac() && rbac().label && rbac().label()) || 'owner';
      actions.appendChild(ui.button({ label: m.status === 'duplicate' ? 'Approve anyway' : 'Approve & send', size: 'sm', variant: 'primary', onClick: async () => {
        const ok = await ui.confirm({ title: 'Send this message?', message: m.channel.toUpperCase() + ' to ' + m.to + '. This sends a real customer message.', confirmLabel: 'Approve & send' });
        if (!ok) return;
        const res = await tx().approve(m.id, { actor: actor, overrideDuplicate: m.status === 'duplicate' });
        if (!res.ok) await ui.confirm({ title: 'Not sent', message: res.message || res.error, confirmLabel: 'OK' });
        await render(container);
      } }));
      actions.appendChild(ui.button({ label: 'Cancel', size: 'sm', variant: 'ghost', onClick: async () => { await tx().cancel(m.id, { actor: actor }); await render(container); } }));
      row.appendChild(actions);
      container.appendChild(row);
    });

    // Recent delivery history.
    container.appendChild(title('Recent'));
    const recent = (await tx().list()).filter((m) => ['queued', 'sending', 'sent', 'delivered', 'failed', 'bounced'].indexOf(m.status) !== -1).slice(0, 12);
    if (!recent.length) container.appendChild(empty('No messages sent yet.'));
    recent.forEach((m) => container.appendChild(ui.el('div', { className: 'aaa-list-row', html:
      '<strong style="color:' + (STATUS_COLOR[m.status] || '#A1A1AA') + '">' + esc(m.status) + ' · ' + esc(m.channel) + '</strong>' +
      '<div class="aaa-list-sub">' + esc(m.category || m.templateId) + ' → ' + esc(m.to) + (m.attempts > 1 ? ' · ' + m.attempts + ' attempts' : '') + (m.bounceReason ? ' · bounced: ' + esc(m.bounceReason) : '') + (m.failureReason && m.status === 'failed' ? ' · ' + esc(m.failureReason) : '') + '</div>' })));

    container.appendChild(ui.el('p', { className: 'aaa-voice-hint', text: 'Every message is reviewed by a person before it sends. AI can draft, never send. Every send, failure, and retry is recorded.' }));
  }

  function open() {
    const ui = U();
    const sheet = ui.sheet({ title: 'Delivery', subtitle: 'AAA Carpet — customer messaging' });
    document.body.appendChild(sheet.overlay);
    render(sheet.body);
  }

  global.AAA_TRANSPORT_DASHBOARD_UI = { render: render, open: open };
})(typeof window !== 'undefined' ? window : this);
