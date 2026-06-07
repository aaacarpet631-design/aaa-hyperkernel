/*
 * AAA Pricing Optimizer — owner-only learning panel.
 *
 * Surfaces what the won/lost history teaches: win/loss trend, top loss reasons,
 * best service/zip segments, low-margin wins, follow-up warnings, and the
 * optimizer's recommendations (with a built-in Supervisor critique + confidence/
 * risk badges). Each recommendation has a supporting-quotes drawer and a human
 * "mark reviewed" action (audited). Nothing here changes a price.
 */
;(function (global) {
  'use strict';

  function U() { return global.AAA_UI; }
  function opt() { return global.AAA_PRICING_OPTIMIZER; }
  function learning() { return global.AAA_OUTCOME_LEARNING; }
  function rbac() { return global.AAA_RBAC; }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
  function money(v) { const n = Number(v); return isFinite(n) ? '$' + Math.round(n) : '—'; }
  function pct(r) { return r == null ? '—' : Math.round(r * 100) + '%'; }

  const VERDICT_COLOR = { approve: '#10B981', needs_more_data: '#F59E0B', reject: '#EF4444' };
  const state = { onlyActionable: false };

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
      container.appendChild(ui.el('div', { className: 'aaa-list-row', html: '<strong>🔒 Pricing Optimizer is owner-only</strong><div class="aaa-list-sub">Signed in as ' + esc(rbac().label()) + '. Pricing analysis shows margins, so it is restricted to the owner.</div>' }));
      return;
    }
    if (!opt() || !learning()) { container.appendChild(empty('Pricing Optimizer unavailable.')); return; }

    container.appendChild(ui.spinner('Learning from won/lost quotes…'));
    const a = await opt().analyze();
    const agg = await learning().aggregate();
    container.innerHTML = '';
    if (!a || !a.ok) { container.appendChild(empty('Not enough quote history to analyze yet.')); return; }

    // Win/loss trend summary.
    container.appendChild(ui.el('section', { className: 'aaa-summary' }, [
      chip(pct(a.summary.winRate), 'Win Rate', '#10B981'),
      chip(a.summary.resolved, 'Resolved', '#3B82F6'),
      chip(a.summary.avgMarginPct != null ? a.summary.avgMarginPct + '%' : '—', 'Avg Margin', '#F59E0B')
    ]));

    if (!a.summary.resolved) {
      container.appendChild(ui.el('div', { className: 'aaa-list-row', html: '<strong>Warming up</strong><div class="aaa-list-sub">Recommendations appear once a few quotes are marked won/lost.</div>' }));
      return;
    }

    // Top loss reasons.
    container.appendChild(title('Top loss reasons'));
    if (!a.topLossReasons.length) container.appendChild(empty('No losses recorded yet.'));
    a.topLossReasons.forEach((r) => container.appendChild(ui.el('div', { className: 'aaa-list-row', html: '<strong>' + esc(r.reason) + '</strong><div class="aaa-list-sub">' + r.count + ' loss(es)</div>' })));

    // Best segments.
    const strong = (agg.byServiceType || []).concat(agg.byZip || []).filter((g) => g.key !== 'unknown' && g.key !== 'unspecified' && g.winRate != null && g.winRate >= 0.6).slice(0, 5);
    container.appendChild(title('Best performing segments'));
    if (!strong.length) container.appendChild(empty('No standout segments yet.'));
    strong.forEach((g) => container.appendChild(ui.el('div', { className: 'aaa-list-row', html: '<strong>' + esc(g.key) + '</strong><div class="aaa-list-sub">' + pct(g.winRate) + ' win · ' + g.count + ' quotes' + (g.avgMarginPct != null ? ' · ' + g.avgMarginPct + '% margin' : '') + '</div>' })));

    // Low-margin wins warning.
    if ((agg.lowMarginWins || []).length) {
      container.appendChild(title('⚠️ Low-margin wins'));
      agg.lowMarginWins.slice(0, 6).forEach((w) => container.appendChild(ui.el('div', { className: 'aaa-list-row', html: '<strong>' + esc(w.customer || w.quoteId) + ' · ' + money(w.finalPrice) + '</strong><div class="aaa-list-sub">' + w.marginPct + '% margin · ' + esc(w.serviceType) + '</div>' })));
    }

    // Follow-up warning.
    const fu = a.followUp;
    if (fu && fu.avgDaysToWin != null && fu.avgDaysToLoss != null && fu.avgDaysToLoss > fu.avgDaysToWin + 1) {
      container.appendChild(ui.el('div', { className: 'aaa-list-row', html: '<strong>⏱ Follow-up delay warning</strong><div class="aaa-list-sub">Losses took ~' + fu.avgDaysToLoss + 'd vs ~' + fu.avgDaysToWin + 'd for wins. Follow up faster.</div>' }));
    }

    // Recommendations.
    container.appendChild(title('Recommendations (' + a.recommendations.length + ')'));
    container.appendChild(ui.button({ label: state.onlyActionable ? 'Showing: Supervisor-approved' : 'Showing: All', size: 'sm', variant: 'secondary', onClick: () => { state.onlyActionable = !state.onlyActionable; render(container); } }));
    let recs = a.recommendations;
    if (state.onlyActionable) recs = recs.filter((r) => r.supervisorReview.verdict === 'approve');
    if (!recs.length) container.appendChild(empty('No recommendations in this view.'));
    recs.forEach((r) => container.appendChild(recCard(r, container)));

    container.appendChild(ui.el('p', { className: 'aaa-voice-hint', text: 'Learning + recommendations only. The optimizer never changes a price — a person reviews and acts.' }));
  }

  function recCard(r, container) {
    const ui = U();
    const sev = r.risk >= 60 ? '#EF4444' : (r.risk >= 30 ? '#F59E0B' : '#10B981');
    const vColor = VERDICT_COLOR[r.supervisorReview.verdict] || '#A1A1AA';
    const card = ui.el('div', { className: 'aaa-list-row', html:
      '<strong>' + esc(r.title) + (r.status === 'reviewed' ? ' ✓' : (r.status === 'rejected' ? ' ✗' : '')) + '</strong>' +
      '<div class="aaa-list-sub">🤖 ' + esc(r.reasoning) + '</div>' +
      '<div class="aaa-list-sub">→ ' + esc(r.recommendedAction) + '</div>' +
      '<div class="aaa-list-sub">📈 ' + esc(r.expectedKpiImpact) + '</div>' +
      '<div class="aaa-list-sub"><span style="color:#3B82F6">conf ' + r.adjustedConfidence + '</span> · <span style="color:' + sev + '">risk ' + r.risk + '</span> · <span style="color:' + vColor + '">supervisor: ' + esc(r.supervisorReview.verdict) + '</span>' + (r.supervisorReview.riskFlags.length ? ' · ' + esc(r.supervisorReview.riskFlags.join(', ')) : '') + '</div>' +
      '<div class="aaa-list-sub" style="opacity:.8">🧭 ' + esc(r.supervisorNote || r.supervisorReview.note) + '</div>' +
      (r.reviewRequired ? '<div class="aaa-list-sub" style="opacity:.7">Review required — nothing applied automatically.</div>' : '') });

    const actions = ui.el('div', { className: 'aaa-form', style: { display: 'flex', gap: '8px', flexWrap: 'wrap' } });
    if ((r.supportingQuoteIds || []).length) actions.appendChild(ui.button({ label: 'Supporting quotes (' + r.supportingQuoteIds.length + ')', size: 'sm', variant: 'secondary', onClick: () => supportingDrawer(r) }));
    const actor = (rbac() && rbac().label && rbac().label()) || 'owner';
    if (r.status !== 'reviewed') actions.appendChild(ui.button({ label: 'Mark reviewed', size: 'sm', variant: 'primary', onClick: async () => { const res = await opt().review(r.id, { actor: actor, note: r.supervisorReview.note }); if (!res.ok) await ui.confirm({ title: 'Not allowed', message: res.message || res.error, confirmLabel: 'OK' }); await render(container); } }));
    if (r.status !== 'rejected') actions.appendChild(ui.button({ label: 'Reject', size: 'sm', variant: 'ghost', onClick: async () => { await opt().review(r.id, { actor: actor, decision: 'rejected' }); await render(container); } }));
    if (!r.predictionId) actions.appendChild(ui.button({ label: 'Track prediction', size: 'sm', variant: 'secondary', onClick: async () => { await opt().createPrediction(r, { actor: actor }); await render(container); } }));
    else actions.appendChild(ui.el('span', { className: 'aaa-list-sub', text: '🎯 tracked' }));
    card.appendChild(actions);
    return card;
  }

  function supportingDrawer(r) {
    const ui = U();
    const s = ui.sheet({ title: 'Supporting quotes', subtitle: r.title });
    document.body.appendChild(s.overlay);
    const Q = global.AAA_QUOTES;
    (r.supportingQuoteIds || []).forEach(async (id) => {
      let q = null; try { q = Q ? await Q.get(id) : null; } catch (_) {}
      s.body.appendChild(ui.el('div', { className: 'aaa-list-row', html: q
        ? '<strong>' + esc(q.customerName || id) + ' · ' + money(q.customerTotal) + '</strong><div class="aaa-list-sub">' + esc(q.status) + (q.marginPct != null ? ' · ' + q.marginPct + '% margin' : '') + '</div>'
        : '<div class="aaa-list-sub">' + esc(id) + '</div>' }));
    });
    s.body.appendChild(ui.button({ label: 'Done', variant: 'ghost', full: true, onClick: () => s.close() }));
  }

  function open() {
    const ui = U();
    const sheet = ui.sheet({ title: 'Pricing Optimizer', subtitle: 'AAA Carpet — learning from won/lost quotes' });
    document.body.appendChild(sheet.overlay);
    render(sheet.body);
  }

  global.AAA_PRICING_OPTIMIZER_UI = { render: render, open: open, _state: state };
})(typeof window !== 'undefined' ? window : this);
