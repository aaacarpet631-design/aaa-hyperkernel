/*
 * AAA Financial Intelligence — owner-only financial command surface.
 *
 * The books as a decision view: P&L, AR aging, financial KPIs (margins, DSO,
 * expense ratio), expense breakdown, anomaly flags, and a simple forecast.
 * Read-only — it posts nothing and changes no invoice. Gated on VIEW_FINANCIALS.
 */
;(function (global) {
  'use strict';

  function U() { return global.AAA_UI; }
  function FI() { return global.AAA_FINANCIAL_INTELLIGENCE; }
  function rbac() { return global.AAA_RBAC; }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
  function money(n) { return n == null ? '—' : '$' + Number(n).toLocaleString(); }

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
      container.appendChild(ui.el('div', { className: 'aaa-list-row', html: '<strong>🔒 Financial Intelligence is owner-only</strong><div class="aaa-list-sub">Signed in as ' + esc(rbac().label()) + '. The books are owner-only.</div>' }));
      return;
    }
    if (!FI()) { container.appendChild(empty('Financial Intelligence unavailable.')); return; }

    container.appendChild(ui.spinner('Reading the books…'));
    let ov, fc;
    try { ov = await FI().overview(); fc = await FI().forecast(3); }
    catch (err) { container.innerHTML = ''; container.appendChild(ui.el('div', { className: 'aaa-list-row', html: '<strong>Could not load financials</strong><div class="aaa-list-sub">' + esc((err && err.message) || err) + '</div>' })); return; }
    container.innerHTML = '';

    container.appendChild(ui.el('section', { className: 'aaa-summary' }, [
      chip(money(ov.pnl.revenue), 'Revenue', '#3B82F6'),
      chip(money(ov.pnl.netProfit), 'Net profit', ov.pnl.netProfit >= 0 ? '#10B981' : '#EF4444'),
      chip(ov.pnl.netMargin == null ? '—' : ov.pnl.netMargin + '%', 'Net margin', '#10B981'),
      chip(ov.kpis.dso == null ? '—' : ov.kpis.dso + 'd', 'DSO', '#8B5CF6')
    ]));

    // P&L.
    container.appendChild(title('Profit & loss'));
    container.appendChild(ui.el('div', { className: 'aaa-list-row', html:
      '<div class="aaa-list-sub">Revenue (paid): ' + money(ov.pnl.revenue) + ' · Billed: ' + money(ov.pnl.billed) + '</div>' +
      '<div class="aaa-list-sub">Expenses: ' + money(ov.pnl.expenses) + ' · Expense ratio: ' + (ov.kpis.expenseRatio == null ? '—' : ov.kpis.expenseRatio + '%') + '</div>' +
      '<div class="aaa-list-sub"><strong>Net profit: ' + money(ov.pnl.netProfit) + '</strong></div>' }));

    // AR aging.
    container.appendChild(title('A/R aging (' + money(ov.ar.outstanding) + ' outstanding)'));
    const b = ov.ar.buckets;
    container.appendChild(ui.el('div', { className: 'aaa-list-row', html:
      '<div class="aaa-list-sub">Current ' + money(b.current) + ' · 30d ' + money(b.d30) + ' · 60d ' + money(b.d60) + ' · <span style="color:#EF4444">90d+ ' + money(b.d90plus) + '</span></div>' +
      (ov.ar.overdue ? '<div class="aaa-list-sub">⚠ ' + money(ov.ar.overdue) + ' overdue</div>' : '') }));

    // Expense breakdown.
    container.appendChild(title('Expenses by category'));
    if (!ov.expenseBreakdown.categories.length) container.appendChild(empty('No expenses recorded.'));
    ov.expenseBreakdown.categories.slice(0, 8).forEach((c) => container.appendChild(ui.el('div', { className: 'aaa-list-row', html: '<strong>' + esc(c.category) + '</strong><div class="aaa-list-sub">' + money(c.amount) + ' · ' + c.pct + '%</div>' })));

    // Anomalies.
    if (ov.anomalies.length) {
      container.appendChild(title('Watch'));
      ov.anomalies.forEach((a) => container.appendChild(ui.el('div', { className: 'aaa-list-row', html: '<strong style="color:#F59E0B">⚠ ' + esc(a.kind.replace(/_/g, ' ')) + ' · ' + esc(a.month) + '</strong><div class="aaa-list-sub">' + money(a.value) + ' vs ~' + money(a.baseline) + ' typical</div>' })));
    }

    // Forecast.
    container.appendChild(title('Forecast'));
    container.appendChild(ui.el('div', { className: 'aaa-list-row', html: '<div class="aaa-list-sub">~' + money(fc.monthlyNet) + '/mo net → ' + money(fc.projectedNet) + ' over ' + fc.horizon + ' months. ' + esc(fc.note) + '</div>' }));

    container.appendChild(ui.el('p', { className: 'aaa-voice-hint', text: 'Computed from your books — read-only. It posts nothing and changes no invoice; it shows you where the money is.' }));
  }

  function open() {
    const ui = U();
    const sheet = ui.sheet({ title: 'Financial Intelligence', subtitle: 'AAA Carpet — P&L, A/R, KPIs, forecast' });
    document.body.appendChild(sheet.overlay);
    render(sheet.body);
  }

  global.AAA_FINANCIAL_INTELLIGENCE_UI = { render: render, open: open };
})(typeof window !== 'undefined' ? window : this);
