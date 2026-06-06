/*
 * AAA Quote Lifecycle — the owner pipeline dashboard for AAA_QUOTES.
 *
 * Owner-only (VIEW_FINANCIALS) because it surfaces margin/cost. Status filters,
 * pipeline + won/lost views, a follow-up queue, a quote detail drawer with the
 * margin/risk snapshot + supervisor notes, and human-gated actions (review →
 * send → won/lost). The customer view is rendered separately and carries no
 * internal numbers. Nothing here posts to the books or finalizes autonomously.
 */
;(function (global) {
  'use strict';

  function U() { return global.AAA_UI; }
  function store() { return global.AAA_QUOTES; }
  function rbac() { return global.AAA_RBAC; }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
  function money(v) { const n = Number(v); return isFinite(n) ? '$' + n.toFixed(2) : '—'; }

  const state = { filter: 'pipeline' };
  const STATUS_COLOR = { draft: '#94A3B8', reviewed: '#3B82F6', sent: '#8B5CF6', follow_up_due: '#F59E0B', won: '#10B981', lost: '#EF4444', expired: '#A1A1AA', archived: '#71717A' };
  const FILTERS = [
    { id: 'pipeline', label: 'Pipeline' }, { id: 'follow', label: 'Follow-up' },
    { id: 'draft', label: 'Draft' }, { id: 'reviewed', label: 'Reviewed' }, { id: 'sent', label: 'Sent' },
    { id: 'won', label: 'Won' }, { id: 'lost', label: 'Lost' }, { id: 'all', label: 'All' }
  ];

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
      container.appendChild(ui.el('div', { className: 'aaa-list-row', html: '<strong>🔒 Quotes are owner-only</strong><div class="aaa-list-sub">Signed in as ' + esc(rbac().label()) + '. The quote pipeline shows margins, so it is restricted to the owner.</div>' }));
      return;
    }
    if (!store()) { container.appendChild(empty('Quote store unavailable.')); return; }

    container.appendChild(ui.spinner('Loading quotes…'));
    const stats = await store().stats();
    let quotes;
    if (state.filter === 'pipeline') quotes = (await store().list()).filter((q) => ['draft', 'reviewed', 'sent', 'follow_up_due'].indexOf(q.status) !== -1);
    else if (state.filter === 'follow') quotes = await store().followUpQueue(3);
    else if (state.filter === 'all') quotes = await store().list();
    else quotes = await store().byStatus(state.filter);
    container.innerHTML = '';

    // Snapshot.
    container.appendChild(ui.el('section', { className: 'aaa-summary' }, [
      chip(money(stats.pipelineValue), 'Pipeline', '#8B5CF6'),
      chip(stats.closeRatePct != null ? stats.closeRatePct + '%' : '—', 'Close Rate', '#10B981'),
      chip(money(stats.wonMargin), 'Won Margin', '#10B981')
    ]));
    container.appendChild(ui.el('section', { className: 'aaa-summary' }, [
      chip(stats.counts.draft + stats.counts.reviewed, 'In Progress', '#3B82F6'),
      chip(stats.counts.sent + stats.counts.follow_up_due, 'Awaiting', '#F59E0B'),
      chip(money(stats.wonRevenue), 'Won Revenue', '#10B981')
    ]));

    // Filters.
    const filterRow = ui.el('div', { className: 'aaa-form', style: { display: 'flex', gap: '6px', flexWrap: 'wrap' } });
    FILTERS.forEach((f) => filterRow.appendChild(ui.button({ label: f.label, size: 'sm', variant: state.filter === f.id ? 'primary' : 'secondary', onClick: () => { state.filter = f.id; render(container); } })));
    container.appendChild(filterRow);

    // List.
    container.appendChild(title((FILTERS.find((f) => f.id === state.filter) || {}).label + ' (' + quotes.length + ')'));
    if (!quotes.length) { container.appendChild(empty('No quotes here.')); return; }
    quotes.forEach((q) => {
      const row = ui.el('button', { className: 'aaa-list-row', attrs: { type: 'button', style: 'width:100%;text-align:left;cursor:pointer' }, html:
        '<strong>' + esc(q.customerName || 'Quote') + ' · ' + money(q.customerTotal) + '</strong>' +
        '<div class="aaa-list-sub"><span style="color:' + (STATUS_COLOR[q.status] || '#A1A1AA') + '">● ' + esc(q.status) + '</span>' +
        ' · ' + esc((q.serviceType || []).join(', ')) +
        (q.marginPct != null ? ' · margin ' + q.marginPct + '%' : '') +
        (q.risk != null ? ' · risk ' + q.risk : '') + '</div>' });
      row.addEventListener('click', () => openDetail(q.id));
      container.appendChild(row);
    });
  }

  /** Quote detail — internal margin/risk (owner) + customer view + actions + supervisor notes. */
  function renderDetail(container, q) {
    const ui = U();
    container.innerHTML = '';
    if (!q) { container.appendChild(empty('Quote not found.')); return; }

    container.appendChild(ui.el('div', { className: 'aaa-list-row', html:
      '<strong>' + esc(q.customerName || 'Quote') + '</strong><div class="aaa-list-sub"><span style="color:' + (STATUS_COLOR[q.status] || '#A1A1AA') + '">● ' + esc(q.status) + '</span>' +
      (q.leadSource ? ' · ' + esc(q.leadSource) : '') + (q.zip ? ' · ' + esc(q.zip) : '') + '</div>' }));

    // Internal margin/risk snapshot (owner-only screen).
    container.appendChild(title('Margin & Risk (internal)'));
    container.appendChild(ui.el('section', { className: 'aaa-summary' }, [
      chip(money(q.customerTotal), 'Quote', '#3B82F6'),
      chip(money(q.internalCost && q.internalCost.total), 'Cost', '#F59E0B'),
      chip(q.marginPct != null ? q.marginPct + '%' : '—', 'Margin', '#10B981')
    ]));
    container.appendChild(ui.el('section', { className: 'aaa-summary' }, [
      chip(q.confidence != null ? q.confidence : '—', 'Confidence', '#3B82F6'),
      chip(q.risk != null ? q.risk : '—', 'Risk', STATUS_COLOR[q.severity === 'high' ? 'lost' : q.severity === 'medium' ? 'follow_up_due' : 'won'] || '#A1A1AA'),
      chip(money(q.grossMargin), 'Gross (actual)', '#10B981')
    ]));

    // Customer-facing receipt (what the customer would see — no internal numbers).
    const cv = store().customerView(q);
    container.appendChild(title('Customer Quote (no internal numbers)'));
    (cv.items || []).forEach((it) => container.appendChild(ui.el('div', { className: 'aaa-list-row', html: '<strong>' + esc(it.description) + '</strong><div class="aaa-list-sub">' + money(it.amount) + '</div>' })));
    container.appendChild(ui.el('div', { className: 'aaa-list-row', html: '<strong>Total: ' + money(cv.total) + '</strong>' }));

    // Actions (human-gated through the store/gateway).
    const actor = (rbac() && rbac().label && rbac().label()) || 'owner';
    const actions = ui.el('div', { className: 'aaa-form', style: { display: 'flex', gap: '8px', flexWrap: 'wrap' } });
    const refresh = async () => { const fresh = await store().get(q.id); renderDetail(container, fresh); };
    const act = async (fn) => { const res = await fn(); if (!res.ok) await ui.confirm({ title: 'Not allowed', message: res.message || res.error, confirmLabel: 'OK' }); await refresh(); };
    if (q.status === 'draft') actions.appendChild(ui.button({ label: 'Mark reviewed', size: 'sm', variant: 'primary', onClick: () => act(() => store().markReviewed(q.id, { actor: actor })) }));
    if (q.status === 'reviewed') actions.appendChild(ui.button({ label: 'Send to customer', size: 'sm', variant: 'primary', onClick: () => act(() => store().send(q.id, { actor: actor })) }));
    if (['sent', 'follow_up_due'].indexOf(q.status) !== -1) actions.appendChild(ui.button({ label: 'Set follow-up', size: 'sm', variant: 'secondary', onClick: () => act(() => store().setFollowUp(q.id, { actor: actor })) }));
    if (['sent', 'follow_up_due', 'reviewed'].indexOf(q.status) !== -1) {
      actions.appendChild(ui.button({ label: 'Mark WON', size: 'sm', variant: 'success', onClick: () => resolveSheet(q, 'won', container) }));
      actions.appendChild(ui.button({ label: 'Mark LOST', size: 'sm', variant: 'ghost', onClick: () => resolveSheet(q, 'lost', container) }));
    }
    if (['won', 'lost', 'expired'].indexOf(q.status) !== -1) actions.appendChild(ui.button({ label: 'Archive', size: 'sm', variant: 'ghost', onClick: () => act(() => store().archive(q.id, { actor: actor })) }));
    container.appendChild(actions);
    if (q.wonLostReason) container.appendChild(ui.el('div', { className: 'aaa-list-row', html: '<div class="aaa-list-sub">Outcome reason: ' + esc(q.wonLostReason) + '</div>' }));

    // Status history.
    container.appendChild(title('Status history'));
    (q.statusHistory || []).forEach((h) => container.appendChild(ui.el('div', { className: 'aaa-list-row', html: '<div class="aaa-list-sub">' + esc(h.status) + ' · ' + esc(h.at) + (h.by ? ' · ' + esc(h.by) : '') + (h.reason ? ' · ' + esc(h.reason) : '') + '</div>' })));

    // Supervisor notes.
    container.appendChild(title('Supervisor notes'));
    if (!(q.supervisorNotes || []).length) container.appendChild(empty('No supervisor notes yet.'));
    (q.supervisorNotes || []).forEach((n) => container.appendChild(ui.el('div', { className: 'aaa-list-row', html: '<div class="aaa-list-sub">🧭 ' + esc(n.note) + (n.qualityScore != null ? ' · quality ' + n.qualityScore : '') + (n.riskScore != null ? ' · risk ' + n.riskScore : '') + '</div>' })));

    container.appendChild(ui.el('p', { className: 'aaa-voice-hint', text: 'Analysis + pipeline only. Sending needs a person; nothing here posts to the books or finalizes a price autonomously.' }));
  }

  function resolveSheet(q, result, dashContainer) {
    const ui = U();
    const s = ui.sheet({ title: result === 'won' ? 'Mark WON' : 'Mark LOST', size: 'sm' });
    document.body.appendChild(s.overlay);
    const reason = ui.el('input', { className: 'aaa-input', attrs: { type: 'text', placeholder: result === 'won' ? 'Why did we win? (price, speed, trust…)' : 'Why did we lose? (price, timing, competitor…)' } });
    const fields = [reason];
    let finalPrice, jobCost;
    if (result === 'won') {
      finalPrice = ui.el('input', { className: 'aaa-input', attrs: { type: 'number', step: '0.01', inputmode: 'decimal', placeholder: 'Final price ($)' } });
      jobCost = ui.el('input', { className: 'aaa-input', attrs: { type: 'number', step: '0.01', inputmode: 'decimal', placeholder: 'Job cost ($, optional)' } });
      fields.push(finalPrice, jobCost);
    }
    s.body.appendChild(ui.el('div', { className: 'aaa-form' }, fields));
    const actor = (rbac() && rbac().label && rbac().label()) || 'owner';
    s.body.appendChild(ui.button({ label: 'Save', variant: 'primary', full: true, onClick: async () => {
      if (!reason.value.trim()) return;
      const res = result === 'won'
        ? await store().markWon(q.id, { actor: actor, reason: reason.value.trim(), finalPrice: finalPrice && finalPrice.value, jobCost: jobCost && jobCost.value })
        : await store().markLost(q.id, { actor: actor, reason: reason.value.trim() });
      s.close();
      if (!res.ok) { await ui.confirm({ title: 'Not allowed', message: res.message || res.error, confirmLabel: 'OK' }); }
      const fresh = await store().get(q.id); renderDetail(dashContainer, fresh);
    } }));
    s.body.appendChild(ui.button({ label: 'Cancel', variant: 'ghost', full: true, onClick: () => s.close() }));
  }

  async function openDetail(id) {
    const ui = U();
    const sheet = ui.sheet({ title: 'Quote', subtitle: 'AAA Carpet — quote detail' });
    document.body.appendChild(sheet.overlay);
    const q = await store().get(id);
    renderDetail(sheet.body, q);
  }

  function open() {
    const ui = U();
    const sheet = ui.sheet({ title: 'Quotes', subtitle: 'AAA Carpet — quote pipeline' });
    document.body.appendChild(sheet.overlay);
    render(sheet.body);
  }

  global.AAA_QUOTE_LIFECYCLE_UI = { render: render, renderDetail: renderDetail, open: open, _state: state };
})(typeof window !== 'undefined' ? window : this);
