/*
 * AAA Assisted Drafts — office-only review of AI-drafted customer messages.
 *
 * Shows each Instruct-suggested message awaiting a human, with the model that
 * produced it (governed id + version, confidence, risk, output checksum) and an
 * edit / approve / reject control. Approving marks it ready to send by the normal
 * channel — the system never sends it. Gated on EDIT_CUSTOMER (owner + manager).
 */
;(function (global) {
  'use strict';

  function U() { return global.AAA_UI; }
  function Q() { return global.AAA_ASSISTED_DRAFTS; }
  function rbac() { return global.AAA_RBAC; }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
  function actor() { return (rbac() && rbac().label && rbac().label()) || 'owner'; }
  function canUse() { const r = rbac(); return !r || r.can('EDIT_CUSTOMER'); }
  const STATUS = { pending_owner: '#F59E0B', approved: '#10B981', rejected: '#71717A' };

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
      container.appendChild(ui.el('div', { className: 'aaa-list-row', html: '<strong>🔒 Assisted drafts are office-only</strong><div class="aaa-list-sub">Signed in as ' + esc(rbac().label()) + '.</div>' }));
      return;
    }
    if (!Q()) { container.appendChild(empty('Assisted draft queue unavailable.')); return; }

    container.appendChild(ui.spinner('Loading drafts…'));
    let drafts;
    try { drafts = await Q().list(); } catch (err) { container.innerHTML = ''; container.appendChild(ui.el('div', { className: 'aaa-list-row', html: '<strong>Could not load drafts</strong><div class="aaa-list-sub">' + esc((err && err.message) || err) + '</div>' })); return; }
    container.innerHTML = '';

    const pending = drafts.filter((d) => d.status === 'pending_owner');
    container.appendChild(ui.el('section', { className: 'aaa-summary' }, [
      chip(pending.length, 'Pending you', pending.length ? '#F59E0B' : '#10B981'),
      chip(drafts.filter((d) => d.status === 'approved').length, 'Approved', '#10B981'),
      chip(drafts.filter((d) => d.status === 'rejected').length, 'Rejected', '#71717A')
    ]));

    container.appendChild(title('Drafts awaiting you'));
    if (!pending.length) container.appendChild(empty('No drafts awaiting approval.'));
    pending.forEach((d) => {
      const m = d.model || {};
      const text = d.editedText != null ? d.editedText : d.suggestedText;
      const row = ui.el('div', { className: 'aaa-list-row', html:
        '<strong style="color:' + (STATUS[d.status] || '#A1A1AA') + '">' + esc(d.intent) + ' → ' + esc(d.to) + '</strong>' +
        '<div class="aaa-list-sub">' + (text ? esc(text) : '<em>model unavailable — write your own</em>') + '</div>' +
        '<div class="aaa-list-sub">' + (m.modelId ? '🤖 ' + esc(m.modelId) + ' · gov ' + esc(String(m.governanceVersion || '—')) + ' · conf ' + (m.confidence == null ? '—' : m.confidence) + ' · risk ' + (m.riskScore == null ? '—' : m.riskScore) + ' · ✓' + esc(String(m.outputChecksum || '')) : 'no model output') + '</div>' });
      const actions = ui.el('div', { className: 'aaa-form', style: { display: 'flex', gap: '8px', flexWrap: 'wrap' } });
      actions.appendChild(ui.button({ label: 'Edit', size: 'sm', variant: 'secondary', onClick: async () => {
        const next = ui.prompt ? await ui.prompt({ title: 'Edit message', message: 'Edit before approving:', value: text || '' }) : null;
        if (next != null) { await Q().edit(d.id, next, { actor: actor() }); await render(container); }
      } }));
      actions.appendChild(ui.button({ label: 'Approve (ready to send)', size: 'sm', variant: 'primary', onClick: async () => {
        const res = await Q().approve(d.id, { actor: actor() });
        await ui.confirm({ title: res.ok ? 'Approved' : 'Not approved', message: res.ok ? res.note : (res.message || res.error), confirmLabel: 'OK' });
        await render(container);
      } }));
      actions.appendChild(ui.button({ label: 'Reject', size: 'sm', variant: 'ghost', onClick: async () => { await Q().reject(d.id, { actor: actor(), reason: 'Rejected by owner' }); await render(container); } }));
      row.appendChild(actions);
      container.appendChild(row);
    });

    container.appendChild(ui.el('p', { className: 'aaa-voice-hint', text: 'The model suggests; you decide. Approving marks the message ready — the system never sends a customer message on its own.' }));
  }

  function open() {
    const ui = U();
    const sheet = ui.sheet({ title: 'Assisted Drafts', subtitle: 'AAA Carpet — AI-drafted messages, owner-approved' });
    document.body.appendChild(sheet.overlay);
    render(sheet.body);
  }

  global.AAA_ASSISTED_DRAFTS_UI = { render: render, open: open };
})(typeof window !== 'undefined' ? window : this);
