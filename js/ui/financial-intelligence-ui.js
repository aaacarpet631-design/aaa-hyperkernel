/*
 * AAA Financial Intelligence — the Controller Agent's dashboard.
 *
 * Owner-only (VIEW_FINANCIALS). Renders the read-only analysis from
 * AAA_CONTROLLER.analyze(): a financial-health score, risk & cash-flow alerts,
 * per-job costing signals, tax/categorization issues, and the receipt pipeline.
 *
 * The dashboard SHOWS recommendations; it never posts to the books. Where a
 * finding needs a human action, it names the screen/action the owner should use
 * (those actions are human-gated + audited by the Runtime Gateway elsewhere).
 * No fabricated numbers — empty/low-data states say so.
 */
;(function (global) {
  'use strict';

  function U() { return global.AAA_UI; }
  function controller() { return global.AAA_CONTROLLER; }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
  function money(v) { const n = Number(v); return isFinite(n) ? '$' + n.toFixed(2) : '—'; }

  const SEV_ICON = { critical: '🔴', warning: '🟠', info: '🔵' };
  const SEV_COLOR = { critical: '#EF4444', warning: '#F59E0B', info: '#3B82F6' };
  const AREA_TITLE = { risk: 'Risk & Profitability', cashflow: 'Cash Flow', jobcost: 'Job Costing', tax: 'Tax & Categorization', receipts: 'Receipt Pipeline' };
  const AREA_ORDER = ['risk', 'cashflow', 'jobcost', 'tax', 'receipts'];

  function chip(value, label, color) {
    return U().el('div', { className: 'aaa-chip' }, [
      U().el('span', { className: 'aaa-chip__value', text: String(value), style: { color: color || 'var(--muted)' } }),
      U().el('span', { className: 'aaa-chip__label', text: label }),
      U().el('div', { className: 'aaa-chip__bar', style: { background: color || 'var(--muted)', opacity: '0.85' } })
    ]);
  }
  function title(t) { return U().el('h2', { className: 'aaa-section-title', text: t }); }
  function empty(t) { return U().el('p', { className: 'aaa-empty', text: t }); }

  function findingRow(f) {
    const ui = U();
    return ui.el('div', { className: 'aaa-list-row', html:
      '<strong style="color:' + (SEV_COLOR[f.severity] || '#A1A1AA') + '">' + (SEV_ICON[f.severity] || '•') + ' ' + esc(f.title) + '</strong>' +
      '<div class="aaa-list-sub">' + esc(f.detail) + '</div>' +
      (f.recommendation ? '<div class="aaa-list-sub">→ ' + esc(f.recommendation) + '</div>' : '') +
      (f.gatewayAction ? '<div class="aaa-list-sub" style="opacity:.7">Needs a person · gated action: ' + esc(f.gatewayAction) + '</div>' : '') });
  }

  async function render(container) {
    const ui = U();
    container.innerHTML = '';

    const rbac = global.AAA_RBAC;
    if (rbac && !rbac.can('VIEW_FINANCIALS')) {
      container.appendChild(ui.el('div', { className: 'aaa-list-row', html:
        '<strong>🔒 Financial Intelligence is owner-only</strong>' +
        '<div class="aaa-list-sub">Signed in as ' + esc(rbac.label()) + '. The books and financial analysis are restricted to the owner.</div>' }));
      return;
    }
    if (!controller()) { container.appendChild(empty('Controller agent unavailable.')); return; }

    container.appendChild(ui.spinner('Analyzing the books…'));
    const a = await controller().analyze();
    container.innerHTML = '';
    if (!a || !a.ok) { container.appendChild(empty('No accounting data to analyze yet.')); return; }

    // Health score header.
    const scoreColor = a.score >= 80 ? '#10B981' : (a.score >= 60 ? '#F59E0B' : '#EF4444');
    container.appendChild(ui.el('div', { className: 'aaa-list-row', html:
      '<strong style="font-size:1.1em">Financial Health: <span style="color:' + scoreColor + '">' + a.score + '/100</span></strong>' +
      '<div class="aaa-list-sub">' + a.counts.critical + ' critical · ' + a.counts.warning + ' warning · ' + a.counts.info + ' info · as of ' + esc(new Date(a.generatedAt).toLocaleString()) + '</div>' }));

    // Health chips.
    const h = a.health;
    container.appendChild(ui.el('section', { className: 'aaa-summary' }, [
      chip(money(h.profit), 'Profit', h.profit >= 0 ? '#10B981' : '#EF4444'),
      chip(h.marginPct != null ? h.marginPct + '%' : '—', 'Margin', '#A1A1AA'),
      chip(money(h.collected), 'Collected', '#10B981')
    ]));
    container.appendChild(ui.el('section', { className: 'aaa-summary' }, [
      chip(money(h.outstanding), 'Outstanding', h.outstanding > 0 ? '#DC2626' : '#A1A1AA'),
      chip(h.collectionRatePct != null ? h.collectionRatePct + '%' : '—', 'Collection Rate', '#3B82F6'),
      chip(money(h.expensed), 'Expenses', '#F59E0B')
    ]));

    // Findings grouped by area, in priority order.
    const byArea = {};
    a.findings.forEach((f) => { (byArea[f.area] = byArea[f.area] || []).push(f); });
    let any = false;
    AREA_ORDER.forEach((area) => {
      const list = byArea[area];
      if (!list || !list.length) return;
      any = true;
      container.appendChild(title(AREA_TITLE[area] || area));
      list.forEach((f) => container.appendChild(findingRow(f)));
    });
    if (!any) container.appendChild(ui.el('div', { className: 'aaa-list-row', html: '<strong>✅ No issues detected</strong><div class="aaa-list-sub">The books look healthy against current thresholds.</div>' }));

    // Cash flow numbers (always shown for transparency).
    const cf = a.cashflow;
    if (cf) {
      container.appendChild(title('Cash Flow (trailing run-rate)'));
      if (cf.dataSufficient === false) {
        container.appendChild(empty('Not enough recent activity to project cash flow yet.'));
      } else {
        container.appendChild(ui.el('section', { className: 'aaa-summary' }, [
          chip(money(cf.monthlyInflow), 'In / mo', '#10B981'),
          chip(money(cf.monthlyOutflow), 'Out / mo', '#F59E0B'),
          chip(cf.runwayMonths != null ? cf.runwayMonths + ' mo' : '—', 'Runway', cf.runwayMonths != null && cf.runwayMonths < 1 ? '#EF4444' : '#3B82F6')
        ]));
      }
    }

    // Job costing table (worst first), only jobs with activity.
    if (a.jobCosting && a.jobCosting.length) {
      container.appendChild(title('Per-Job Costing'));
      a.jobCosting.slice(0, 8).forEach((j) => {
        const flag = j.flags.indexOf('LOSS') !== -1 ? ' 🔴 loss' : (j.flags.indexOf('UNBILLED') !== -1 ? ' 🟠 unbilled' : '');
        container.appendChild(ui.el('div', { className: 'aaa-list-row', html:
          '<strong>' + esc(j.name) + flag + '</strong>' +
          '<div class="aaa-list-sub">billed ' + money(j.billed) + ' · collected ' + money(j.revenue) + ' · cost ' + money(j.cost) + ' · profit ' + money(j.profit) + '</div>' }));
      });
    }

    // Receipt pipeline link-through.
    if (a.receipts) {
      container.appendChild(title('Receipt Pipeline'));
      container.appendChild(ui.el('div', { className: 'aaa-list-row', html:
        '<strong>' + a.receipts.queueDepth + ' in queue</strong>' +
        '<div class="aaa-list-sub">needs review ' + a.receipts.needsReview + ' · duplicates ' + a.receipts.duplicates + ' · posted ' + a.receipts.posted +
        (a.receipts.classifierAccuracyPct != null ? ' · AI accuracy ' + a.receipts.classifierAccuracyPct + '%' : '') + '</div>' }));
      if (global.AAA_RECEIPT_INTAKE_UI) {
        container.appendChild(ui.button({ label: 'Open Receipts', icon: '🧾', variant: 'secondary', full: true, onClick: () => global.AAA_RECEIPT_INTAKE_UI.open() }));
      }
    }

    container.appendChild(ui.el('p', { className: 'aaa-voice-hint', text: 'Analysis only. The Controller never posts to the books — every accounting action stays human-approved and audited.' }));
  }

  // Full-screen bottom sheet (matches the other command-center entry points).
  function open() {
    const ui = U();
    const sheet = ui.sheet({ title: 'Financial Intelligence', subtitle: 'AAA Carpet — Controller agent' });
    document.body.appendChild(sheet.overlay);
    render(sheet.body);
  }

  global.AAA_FINANCIAL_INTEL_UI = { render: render, open: open };
})(typeof window !== 'undefined' ? window : this);
