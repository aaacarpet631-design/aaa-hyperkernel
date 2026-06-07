/*
 * AAA Learning Feedback — owner-only panel for prediction closure.
 *
 * Shows whether Pricing Optimizer recommendations were validated / contradicted
 * / inconclusive once later quotes resolved, the Supervisor confidence trend
 * (calibration signal — advisory, never auto-applied), a supporting-quotes
 * drawer, and an owner "mark reviewed" action (audited). Read-only over the
 * books; it never changes a price.
 */
;(function (global) {
  'use strict';

  function U() { return global.AAA_UI; }
  function closure() { return global.AAA_PREDICTION_CLOSURE; }
  function rbac() { return global.AAA_RBAC; }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

  const STATUS = { validated: { icon: '✅', color: '#10B981' }, contradicted: { icon: '❌', color: '#EF4444' }, inconclusive: { icon: '⏳', color: '#F59E0B' } };
  const state = { filter: 'all' };
  const FILTERS = [{ id: 'all', label: 'All' }, { id: 'validated', label: 'Validated' }, { id: 'contradicted', label: 'Contradicted' }, { id: 'inconclusive', label: 'Inconclusive' }];

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
      container.appendChild(ui.el('div', { className: 'aaa-list-row', html: '<strong>🔒 Learning Feedback is owner-only</strong><div class="aaa-list-sub">Signed in as ' + esc(rbac().label()) + '. Closure analysis shows win-rate/margin, so it is owner-only.</div>' }));
      return;
    }
    if (!closure()) { container.appendChild(empty('Learning feedback unavailable.')); return; }

    container.appendChild(ui.spinner('Closing the loop on past recommendations…'));
    let evals, calib;
    try {
      // Persist any newly-conclusive closures, then read the live view.
      await closure().close({ actor: (rbac() && rbac().label && rbac().label()) || 'owner' });
      evals = await closure().evaluate();
      calib = await closure().calibrationSummary();
    } catch (err) {
      container.innerHTML = '';
      container.appendChild(ui.el('div', { className: 'aaa-list-row', html: '<strong>Could not load learning feedback</strong><div class="aaa-list-sub">' + esc((err && err.message) || err) + '</div>' }));
      return;
    }
    container.innerHTML = '';

    if (!evals.length) {
      container.appendChild(ui.el('div', { className: 'aaa-list-row', html: '<strong>No predictions to close yet</strong><div class="aaa-list-sub">Track a Pricing Optimizer recommendation as a prediction, then come back once more quotes resolve.</div>' }));
      return;
    }

    const counts = evals.reduce((a, e) => { a[e.status] = (a[e.status] || 0) + 1; return a; }, {});
    container.appendChild(ui.el('section', { className: 'aaa-summary' }, [
      chip(counts.validated || 0, 'Validated', '#10B981'),
      chip(counts.contradicted || 0, 'Contradicted', '#EF4444'),
      chip(counts.inconclusive || 0, 'Inconclusive', '#F59E0B')
    ]));

    // Supervisor confidence trend (calibration signal — advisory).
    const opt = (calib.agents || []).find((a) => a.agent === 'pricing_optimizer');
    container.appendChild(title('Supervisor calibration (advisory)'));
    if (opt && opt.closures) {
      container.appendChild(ui.el('div', { className: 'aaa-list-row', html: '<strong>Validation rate: ' + (opt.validationRate != null ? Math.round(opt.validationRate * 100) + '%' : '—') + '</strong><div class="aaa-list-sub">' + opt.validated + ' validated · ' + opt.contradicted + ' contradicted · suggested confidence bias ' + (opt.suggestedConfidenceBias > 0 ? '+' : '') + opt.suggestedConfidenceBias + ' (not applied)</div>' }));
    } else {
      container.appendChild(empty('No conclusive closures yet — calibration is advisory and waits for data.'));
    }

    // Filters + list.
    const filterRow = ui.el('div', { className: 'aaa-form', style: { display: 'flex', gap: '6px', flexWrap: 'wrap' } });
    FILTERS.forEach((f) => filterRow.appendChild(ui.button({ label: f.label, size: 'sm', variant: state.filter === f.id ? 'primary' : 'secondary', onClick: () => { state.filter = f.id; render(container); } })));
    container.appendChild(filterRow);

    const list = state.filter === 'all' ? evals : evals.filter((e) => e.status === state.filter);
    container.appendChild(title('Predictions (' + list.length + ')'));
    if (!list.length) container.appendChild(empty('None in this view.'));
    list.forEach((e) => container.appendChild(card(e, container)));

    container.appendChild(ui.el('p', { className: 'aaa-voice-hint', text: 'Learning only. Calibration signals are advisory — nothing reprices or retunes automatically.' }));
  }

  function card(e, container) {
    const ui = U();
    const st = STATUS[e.status] || { icon: '•', color: '#A1A1AA' };
    const c = ui.el('div', { className: 'aaa-list-row', html:
      '<strong style="color:' + st.color + '">' + st.icon + ' ' + esc(e.type || 'recommendation') + ' · ' + esc(e.segmentKey) + '</strong>' +
      '<div class="aaa-list-sub">' + esc(e.explanation) + '</div>' +
      '<div class="aaa-list-sub">conf Δ ' + (e.confidenceDelta > 0 ? '+' : '') + e.confidenceDelta + ' · risk Δ ' + (e.riskDelta > 0 ? '+' : '') + e.riskDelta + ' · observed sample ' + e.observedSample + (e.persisted ? ' · 📌 recorded' : '') + '</div>' });
    const actions = ui.el('div', { className: 'aaa-form', style: { display: 'flex', gap: '8px', flexWrap: 'wrap' } });
    if ((e.supportingQuoteIds || []).length) actions.appendChild(ui.button({ label: 'Supporting quotes (' + e.supportingQuoteIds.length + ')', size: 'sm', variant: 'secondary', onClick: () => drawer(e) }));
    actions.appendChild(ui.button({ label: 'Mark reviewed', size: 'sm', variant: 'primary', onClick: async () => {
      const actor = (rbac() && rbac().label && rbac().label()) || 'owner';
      const res = await closure().markReviewed(e.predictionId, { actor: actor });
      if (!res.ok) await ui.confirm({ title: 'Not allowed', message: res.message || res.error, confirmLabel: 'OK' });
      await render(container);
    } }));
    c.appendChild(actions);
    return c;
  }

  function drawer(e) {
    const ui = U();
    const s = ui.sheet({ title: 'Supporting quotes', subtitle: (e.type || '') + ' · ' + e.segmentKey });
    document.body.appendChild(s.overlay);
    const Q = global.AAA_QUOTES;
    (e.supportingQuoteIds || []).forEach(async (id) => {
      let q = null; try { q = Q ? await Q.get(id) : null; } catch (_) {}
      s.body.appendChild(ui.el('div', { className: 'aaa-list-row', html: q
        ? '<strong>' + esc(q.customerName || id) + '</strong><div class="aaa-list-sub">' + esc(q.status) + (q.marginPct != null ? ' · ' + q.marginPct + '% margin' : '') + '</div>'
        : '<div class="aaa-list-sub">' + esc(id) + '</div>' }));
    });
    s.body.appendChild(ui.button({ label: 'Done', variant: 'ghost', full: true, onClick: () => s.close() }));
  }

  function open() {
    const ui = U();
    const sheet = ui.sheet({ title: 'Learning Feedback', subtitle: 'AAA Carpet — did our recommendations work?' });
    document.body.appendChild(sheet.overlay);
    render(sheet.body);
  }

  global.AAA_LEARNING_FEEDBACK_UI = { render: render, open: open, _state: state };
})(typeof window !== 'undefined' ? window : this);
