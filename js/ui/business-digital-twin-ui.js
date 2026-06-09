/*
 * AAA Business Digital Twin — owner-only executive planning surface.
 *
 * Shows the current-state model (baseline KPIs), lets the owner run a strategic
 * lever (hire, add a truck, ad spend, price change, new territory), and renders
 * the before/after, the monthly projection, the net profit impact, and the
 * stated assumptions. A planning model — read-only, no action taken. Gated on
 * VIEW_FINANCIALS (owner).
 */
;(function (global) {
  'use strict';

  function U() { return global.AAA_UI; }
  function T() { return global.AAA_DIGITAL_TWIN; }
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

  const PRESETS = [
    { lever: 'hiring', magnitude: 1, label: 'Hire a crew' },
    { lever: 'add_truck', magnitude: 1, label: 'Add a truck' },
    { lever: 'ads_spend', magnitude: 1000, label: '+$1k/mo ads' },
    { lever: 'price_change', magnitude: 0.1, label: '+10% price' },
    { lever: 'price_change', magnitude: -0.1, label: '−10% price' },
    { lever: 'new_territory', magnitude: 15, label: 'New territory' }
  ];

  async function render(container) {
    const ui = U();
    container.innerHTML = '';
    if (rbac() && !rbac().can('VIEW_FINANCIALS')) {
      container.appendChild(ui.el('div', { className: 'aaa-list-row', html: '<strong>🔒 The Digital Twin is owner-only</strong><div class="aaa-list-sub">Signed in as ' + esc(rbac().label()) + '. It models revenue + margin, so it is owner-only.</div>' }));
      return;
    }
    if (!T()) { container.appendChild(empty('Digital Twin unavailable.')); return; }

    container.appendChild(ui.spinner('Building the business model…'));
    let base;
    try { base = await T().baseline(); } catch (err) { container.innerHTML = ''; container.appendChild(ui.el('div', { className: 'aaa-list-row', html: '<strong>Could not load the twin</strong><div class="aaa-list-sub">' + esc((err && err.message) || err) + '</div>' })); return; }
    container.innerHTML = '';

    container.appendChild(title('Current model'));
    container.appendChild(ui.el('section', { className: 'aaa-summary' }, [
      chip(money(base.monthlyRevenue), 'Revenue/mo', '#3B82F6'),
      chip(money(base.monthlyProfit), 'Profit/mo', '#10B981'),
      chip(base.monthlyWins, 'Jobs/mo', '#8B5CF6'),
      chip(Math.round(base.winRate * 100) + '%', 'Win rate', '#A1A1AA')
    ]));
    container.appendChild(ui.el('div', { className: 'aaa-list-row', html: '<div class="aaa-list-sub">Modeled from ' + base.sample + ' historical jobs · avg job ' + money(base.avgJobValue) + ' · ' + base.avgMargin + '% margin · ' + base.capacityUtil + '% capacity used</div>' }));

    container.appendChild(title('Simulate a strategic move'));
    const form = ui.el('div', { className: 'aaa-form', style: { display: 'flex', gap: '8px', flexWrap: 'wrap' } });
    PRESETS.forEach((p) => form.appendChild(ui.button({ label: p.label, size: 'sm', variant: 'secondary', onClick: () => runScenario(container, p) })));
    container.appendChild(form);
    container.appendChild(ui.el('p', { className: 'aaa-voice-hint', text: 'A planning model from your own history — projections state their assumptions and are estimates, not guarantees. Nothing here changes the business.' }));
  }

  async function runScenario(dashContainer, preset) {
    const ui = U();
    const res = await T().simulate({ lever: preset.lever, magnitude: preset.magnitude, horizonMonths: 12 });
    const sheet = ui.sheet({ title: preset.label || preset.lever, subtitle: 'AAA Carpet — 12-month projection' });
    document.body.appendChild(sheet.overlay);
    renderResult(sheet.body, res);
  }

  /** Render a simulation result (before/after + projection + assumptions). */
  function renderResult(container, res) {
    const ui = U();
    container.innerHTML = '';
    if (!res || !res.ok) { container.appendChild(empty('Could not run the scenario.')); return; }
    const up = res.delta.monthlyProfit >= 0;
    container.appendChild(ui.el('section', { className: 'aaa-summary' }, [
      chip((res.netProfitImpact >= 0 ? '+' : '') + money(res.netProfitImpact), 'Net (12mo)', up ? '#10B981' : '#EF4444'),
      chip((res.delta.monthlyProfit >= 0 ? '+' : '') + money(res.delta.monthlyProfit), 'Profit/mo Δ', up ? '#10B981' : '#EF4444'),
      chip(res.confidence + '%', 'Confidence', '#3B82F6')
    ]));

    container.appendChild(title('Before → after (monthly)'));
    container.appendChild(ui.el('div', { className: 'aaa-list-row', html:
      '<div class="aaa-list-sub">Revenue ' + money(res.baseline.monthlyRevenue) + ' → <strong>' + money(res.projected.monthlyRevenue) + '</strong></div>' +
      '<div class="aaa-list-sub">Profit ' + money(res.baseline.monthlyProfit) + ' → <strong>' + money(res.projected.monthlyProfit) + '</strong></div>' +
      '<div class="aaa-list-sub">Jobs ' + res.baseline.monthlyWins + ' → <strong>' + res.projected.monthlyWins + '</strong></div>' }));

    container.appendChild(title('Assumptions'));
    (res.assumptions || []).forEach((a) => container.appendChild(ui.el('div', { className: 'aaa-list-row', html: '<div class="aaa-list-sub">• ' + esc(a) + '</div>' })));
    container.appendChild(ui.el('div', { className: 'aaa-list-row', html: '<div class="aaa-list-sub">' + esc(res.note) + '</div>' }));

    container.appendChild(ui.button({ label: 'Save this plan', variant: 'secondary', full: true, onClick: async () => { await T().save({ lever: res.lever, magnitude: res.magnitude }, res, { actor: (rbac() && rbac().label && rbac().label()) || 'owner' }); await ui.confirm({ title: 'Saved', message: 'Plan saved for later comparison.', confirmLabel: 'OK' }); } }));
  }

  function open() {
    const ui = U();
    const sheet = ui.sheet({ title: 'Business Digital Twin', subtitle: 'AAA Carpet — executive planning' });
    document.body.appendChild(sheet.overlay);
    render(sheet.body);
  }

  global.AAA_DIGITAL_TWIN_UI = { render: render, renderResult: renderResult, open: open };
})(typeof window !== 'undefined' ? window : this);
