/*
 * AAA Data Governance — owner-only privacy dashboard.
 *
 * Shows the PII inventory (what personal data is held, where), retention status
 * (what's past its window), the encrypted-vault status, a per-customer data
 * export (portability / DSAR), and the erasure workflow (request → approve →
 * execute, redacting PII in place). Every privacy action is gateway-audited and
 * owner-only; AI can never erase or reconfigure. Gated on MANAGE_SETTINGS.
 */
;(function (global) {
  'use strict';

  function U() { return global.AAA_UI; }
  function P() { return global.AAA_PRIVACY; }
  function rbac() { return global.AAA_RBAC; }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
  function canAdmin() { const r = rbac(); return !r || r.can('MANAGE_SETTINGS'); }
  function actor() { return (rbac() && rbac().label && rbac().label()) || 'owner'; }
  const GOOD = '#10B981', WARN = '#F59E0B';

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
    if (rbac() && !canAdmin()) {
      container.appendChild(ui.el('div', { className: 'aaa-list-row', html: '<strong>🔒 Data Governance is owner-only</strong><div class="aaa-list-sub">Signed in as ' + esc(rbac().label()) + '. Privacy controls are restricted to the owner.</div>' }));
      return;
    }
    if (!P()) { container.appendChild(empty('Privacy module unavailable.')); return; }

    container.appendChild(ui.spinner('Loading data governance…'));
    let scan, ret, requests;
    try { scan = await P().scan(); ret = await P().retentionStatus(); requests = await P().listRequests(); }
    catch (err) { container.innerHTML = ''; container.appendChild(ui.el('div', { className: 'aaa-list-row', html: '<strong>Could not load data governance</strong><div class="aaa-list-sub">' + esc((err && err.message) || err) + '</div>' })); return; }
    container.innerHTML = '';

    container.appendChild(ui.el('section', { className: 'aaa-summary' }, [
      chip(scan.totalPII, 'PII records', '#3B82F6'),
      chip(ret.totalExpired, 'Past retention', ret.totalExpired ? WARN : GOOD),
      chip(requests.filter((r) => r.status === 'pending').length, 'Erasure pending', requests.some((r) => r.status === 'pending') ? WARN : GOOD)
    ]));

    // PII inventory.
    container.appendChild(title('PII inventory'));
    scan.collections.filter((c) => c.records > 0).forEach((c) => container.appendChild(ui.el('div', { className: 'aaa-list-row', html:
      '<strong>' + esc(c.collection) + '</strong><div class="aaa-list-sub">' + c.withPII + ' of ' + c.records + ' records carry PII · fields: ' + esc((c.fields || []).join(', ')) + '</div>' })));

    // Retention.
    container.appendChild(title('Retention'));
    ret.categories.forEach((c) => container.appendChild(ui.el('div', { className: 'aaa-list-row', html:
      '<strong>' + esc(c.category) + ' · ' + (c.retentionDays ? c.retentionDays + 'd' : 'kept') + '</strong><div class="aaa-list-sub">' + c.records + ' records · ' + (c.expired ? '<span style="color:' + WARN + '">' + c.expired + ' past window</span>' : 'none expired') + '</div>' })));

    // Export (portability / DSAR).
    container.appendChild(title('Export customer data (portability)'));
    container.appendChild(ui.button({ label: 'Export a customer…', icon: '⬇', variant: 'secondary', full: true, onClick: async () => {
      const id = await promptText(ui, 'Export customer data', 'Enter the customer id to export.');
      if (!id) return;
      const bundle = await P().exportCustomer(id);
      await ui.confirm({ title: bundle.ok ? 'Export ready' : 'Not exported', message: bundle.ok ? (bundle.recordCount + ' record(s) across customer/jobs/quotes/messages/vault. (Bundle returned to the app for download.)') : (bundle.error || 'error'), confirmLabel: 'OK' });
    } }));

    // Erasure workflow.
    container.appendChild(title('Right to be forgotten'));
    container.appendChild(ui.button({ label: 'Request erasure…', icon: '🗑', variant: 'ghost', full: true, onClick: async () => {
      const id = await promptText(ui, 'Request erasure', 'Enter the customer id to erase. A person must approve before any data is redacted.');
      if (!id) return;
      const res = await P().requestErasure({ subjectType: 'customer', subjectId: id, actor: actor() });
      if (!res.ok) await ui.confirm({ title: 'Not filed', message: res.message || res.error, confirmLabel: 'OK' });
      await render(container);
    } }));
    if (!requests.length) container.appendChild(empty('No erasure requests.'));
    requests.slice(0, 10).forEach((r) => {
      const row = ui.el('div', { className: 'aaa-list-row', html:
        '<strong>' + esc(r.subjectType) + ' ' + esc(r.subjectId) + ' · ' + esc(r.status) + '</strong>' +
        '<div class="aaa-list-sub">' + esc(r.requestedAt || '') + (r.manifest ? ' · erased ' + r.manifest.length + ' record(s)' : '') + '</div>' });
      if (r.status === 'pending') row.appendChild(ui.button({ label: 'Approve & erase', size: 'sm', variant: 'primary', onClick: async () => {
        const ok = await ui.confirm({ title: 'Erase this customer’s data?', message: 'This redacts personal data in place and drops vault entries. It cannot be undone.', confirmLabel: 'Erase' });
        if (!ok) return;
        const res = await P().approveErasure(r.id, { actor: actor() });
        if (!res.ok) await ui.confirm({ title: 'Not erased', message: res.message || res.error, confirmLabel: 'OK' });
        await render(container);
      } }));
      container.appendChild(row);
    });

    container.appendChild(ui.el('p', { className: 'aaa-voice-hint', text: 'AAA owns and governs the data: PII is inventoried, sensitive fields are encrypted at rest, retention is enforced, and erasure is human-approved + audited.' }));
  }

  async function promptText(ui, titleText, message) {
    if (ui.prompt) return ui.prompt({ title: titleText, message: message });
    await ui.confirm({ title: titleText, message: message + ' (entry UI unavailable in this build)', confirmLabel: 'OK' });
    return null;
  }

  function open() {
    const ui = U();
    const sheet = ui.sheet({ title: 'Data Governance', subtitle: 'AAA Carpet — privacy, retention, erasure' });
    document.body.appendChild(sheet.overlay);
    render(sheet.body);
  }

  global.AAA_PRIVACY_DASHBOARD_UI = { render: render, open: open };
})(typeof window !== 'undefined' ? window : this);
