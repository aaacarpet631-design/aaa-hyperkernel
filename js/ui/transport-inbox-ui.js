/*
 * AAA Conversations — the native communication inbox (owner/manager).
 *
 * Shows conversation threads, per-message delivery status, the reply inbox,
 * failed messages (actionable), owner notifications, communication analytics,
 * and AI-suggested replies for the open thread. Sending still goes through the
 * governed store (a person approves; AI can draft, never send). Gated on
 * EDIT_CUSTOMER (office), so crew can't see customer conversations.
 */
;(function (global) {
  'use strict';

  function U() { return global.AAA_UI; }
  function core() { return global.AAA_TRANSPORT_CORE; }
  function tx() { return global.AAA_TRANSPORT; }
  function rbac() { return global.AAA_RBAC; }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
  function canSend() { const r = rbac(); return !r || r.can('EDIT_CUSTOMER'); }
  function actor() { return (rbac() && rbac().label && rbac().label()) || 'owner'; }

  const STATUS_COLOR = { pending_approval: '#F59E0B', duplicate: '#A1A1AA', queued: '#3B82F6', sending: '#3B82F6', sent: '#8B5CF6', delivered: '#10B981', failed: '#EF4444', bounced: '#EF4444', canceled: '#71717A', received: '#10B981', read: '#71717A' };

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
      container.appendChild(ui.el('div', { className: 'aaa-list-row', html: '<strong>🔒 Conversations are office-only</strong><div class="aaa-list-sub">Signed in as ' + esc(rbac().label()) + '. Customer conversations are restricted to the owner/manager.</div>' }));
      return;
    }
    if (!core()) { container.appendChild(empty('Transport core unavailable.')); return; }

    container.appendChild(ui.spinner('Loading conversations…'));
    let an, threads, failures, notifs;
    try {
      an = await core().analytics();
      threads = await core().threads();
      failures = await core().failures();
      notifs = await core().notifications({ unread: true });
    } catch (err) {
      container.innerHTML = '';
      container.appendChild(ui.el('div', { className: 'aaa-list-row', html: '<strong>Could not load conversations</strong><div class="aaa-list-sub">' + esc((err && err.message) || err) + '</div>' }));
      return;
    }
    container.innerHTML = '';

    container.appendChild(ui.el('section', { className: 'aaa-summary' }, [
      chip(an.openThreads, 'Open', '#3B82F6'),
      chip(an.unreadThreads, 'Unread', '#F59E0B'),
      chip(an.deliveryRate == null ? '—' : an.deliveryRate + '%', 'Delivered', '#10B981'),
      chip(an.failed + an.bounced, 'Failed', '#EF4444')
    ]));

    // Owner notifications.
    if (notifs.length) {
      container.appendChild(title('Notifications (' + notifs.length + ')'));
      notifs.slice(0, 6).forEach((n) => {
        const row = ui.el('div', { className: 'aaa-list-row', html: '<strong>' + esc(n.title || n.kind) + '</strong><div class="aaa-list-sub">' + esc(n.body || '') + '</div>' });
        row.appendChild(ui.button({ label: 'Dismiss', size: 'sm', variant: 'ghost', onClick: async () => { await core().markNotificationRead(n.id); await render(container); } }));
        container.appendChild(row);
      });
    }

    // Failed messages — visible + actionable.
    if (failures.length) {
      container.appendChild(title('Needs attention (' + failures.length + ')'));
      failures.slice(0, 8).forEach((m) => {
        const row = ui.el('div', { className: 'aaa-list-row', html:
          '<strong style="color:' + (STATUS_COLOR[m.status] || '#EF4444') + '">' + esc(m.status) + ' · ' + esc(m.channel) + '</strong>' +
          '<div class="aaa-list-sub">to ' + esc(m.to) + ' · ' + esc(m.failureReason || m.bounceReason || 'failed') + '</div>' });
        if (m.status === 'failed') row.appendChild(ui.button({ label: 'Retry', size: 'sm', variant: 'primary', onClick: async () => {
          const res = await core().retryFailed(m.id, { actor: actor() });
          if (!res.ok) await ui.confirm({ title: 'Not retried', message: res.message || res.error, confirmLabel: 'OK' });
          await render(container);
        } }));
        container.appendChild(row);
      });
    }

    // Conversations.
    container.appendChild(title('Conversations (' + threads.length + ')'));
    if (!threads.length) container.appendChild(empty('No conversations yet.'));
    threads.slice(0, 20).forEach((th) => {
      const row = ui.el('button', { className: 'aaa-list-row', attrs: { type: 'button', style: 'width:100%;text-align:left;cursor:pointer' }, html:
        '<strong>' + (th.unread ? '🔵 ' : '') + esc(th.peer) + ' · ' + esc(th.channel) + (th.status === 'closed' ? ' · closed' : '') + '</strong>' +
        '<div class="aaa-list-sub">' + (th.lastDirection === 'inbound' ? '↩ ' : '→ ') + esc((th.lastPreview || '').slice(0, 100)) + '</div>' });
      row.addEventListener('click', () => openThread(th.id));
      container.appendChild(row);
    });

    container.appendChild(ui.el('p', { className: 'aaa-voice-hint', text: 'AAA owns every conversation. Providers are just pipes. AI can draft and suggest, but a person sends — and every message, status, and reply is recorded.' }));
  }

  /** A single conversation: the timeline + suggested replies + actions. */
  async function renderThread(container, threadId) {
    const ui = U();
    container.innerHTML = '';
    const th = await core().thread(threadId);
    if (!th) { container.appendChild(empty('Conversation not found.')); return; }
    const msgs = await core().threadMessages(threadId);
    const sug = await core().suggestReply(threadId);

    container.appendChild(ui.el('div', { className: 'aaa-list-row', html: '<strong>' + esc(th.peer) + ' · ' + esc(th.channel) + '</strong><div class="aaa-list-sub">' + (th.customerId ? 'customer linked · ' : '') + (th.relatedId ? esc(th.relatedType || 'related') + ' ' + esc(th.relatedId) : 'no linked record') + '</div>' }));

    // Timeline.
    container.appendChild(title('Conversation'));
    if (!msgs.length) container.appendChild(empty('No messages yet.'));
    msgs.forEach((m) => container.appendChild(ui.el('div', { className: 'aaa-list-row', html:
      '<strong style="color:' + (STATUS_COLOR[m.status] || '#A1A1AA') + '">' + (m.direction === 'inbound' ? '↩ inbound' : '→ ' + esc(m.status)) + '</strong>' +
      '<div class="aaa-list-sub">“' + esc((m.body || '').slice(0, 200)) + '”</div>' +
      (m.failureReason && m.status === 'failed' ? '<div class="aaa-list-sub">⚠ ' + esc(m.failureReason) + '</div>' : '') })));

    // AI suggested replies (recommendation-only; a person approves a draft).
    container.appendChild(title('Suggested replies'));
    if (sug.intent === 'opt_out') container.appendChild(ui.el('div', { className: 'aaa-list-row', html: '<strong>🛑 Opt-out requested</strong><div class="aaa-list-sub">' + esc(sug.suggestions[0].reason) + '</div>' }));
    (sug.suggestions || []).filter((s) => s.text).forEach((s) => {
      const row = ui.el('div', { className: 'aaa-list-row', html: '<strong>' + esc(s.label) + '</strong><div class="aaa-list-sub">“' + esc(s.text) + '”</div><div class="aaa-list-sub">' + esc(s.reason) + '</div>' });
      row.appendChild(ui.button({ label: 'Draft this reply', size: 'sm', variant: 'primary', onClick: async () => {
        // Drafting a free-text reply uses the governed store via a generic template path is not available,
        // so we draft through a template when present; otherwise surface for manual send.
        if (s.templateId) {
          const res = await core().send({ templateId: s.templateId, to: th.peer, channel: th.channel, vars: {}, customerId: th.customerId, relatedType: th.relatedType, relatedId: th.relatedId, origin: 'ai', actor: 'inbox' });
          await ui.confirm({ title: res.ok ? 'Draft created' : 'Could not draft', message: res.ok ? 'A draft is waiting for your approval in Delivery.' : (res.message || res.error), confirmLabel: 'OK' });
        } else {
          await ui.confirm({ title: 'Suggested reply', message: s.text, confirmLabel: 'OK' });
        }
      } }));
      container.appendChild(row);
    });

    // Thread actions.
    const actions = ui.el('div', { className: 'aaa-form', style: { display: 'flex', gap: '8px', flexWrap: 'wrap' } });
    if (th.unread) actions.appendChild(ui.button({ label: 'Mark read', size: 'sm', variant: 'secondary', onClick: async () => { await core().markThreadRead(threadId, { actor: actor() }); renderThread(container, threadId); } }));
    actions.appendChild(ui.button({ label: th.status === 'closed' ? 'Reopen' : 'Close', size: 'sm', variant: 'ghost', onClick: async () => { th.status === 'closed' ? await core().reopenThread(threadId, { actor: actor() }) : await core().closeThread(threadId, { actor: actor() }); renderThread(container, threadId); } }));
    container.appendChild(actions);
  }

  function openThread(id) {
    const ui = U();
    const sheet = ui.sheet({ title: 'Conversation', subtitle: 'AAA Carpet — native inbox' });
    document.body.appendChild(sheet.overlay);
    renderThread(sheet.body, id);
  }

  function open() {
    const ui = U();
    const sheet = ui.sheet({ title: 'Conversations', subtitle: 'AAA Carpet — native communication inbox' });
    document.body.appendChild(sheet.overlay);
    render(sheet.body);
  }

  global.AAA_TRANSPORT_INBOX_UI = { render: render, renderThread: renderThread, open: open };
})(typeof window !== 'undefined' ? window : this);
