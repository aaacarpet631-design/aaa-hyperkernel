/*
 * AAA Learning Fabric — owner-only shared-memory + recommendations view.
 *
 * Surfaces what the business has learned from every won/lost job: the strongest
 * segments (service, neighborhood margin, lead source), the ideal follow-up
 * window, and a "recall" explorer that, for a chosen segment, shows what memory
 * says and an explainable forward recommendation. Advisory — nothing is applied.
 * Gated on VIEW_FINANCIALS (owner).
 */
;(function (global) {
  'use strict';

  function U() { return global.AAA_UI; }
  function F() { return global.AAA_LEARNING_FABRIC; }
  function rbac() { return global.AAA_RBAC; }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
  function actor() { return (rbac() && rbac().label && rbac().label()) || 'owner'; }

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
      container.appendChild(ui.el('div', { className: 'aaa-list-row', html: '<strong>🔒 The Learning Fabric is owner-only</strong><div class="aaa-list-sub">Signed in as ' + esc(rbac().label()) + '. It exposes margins + win rates, so it is owner-only.</div>' }));
      return;
    }
    if (!F()) { container.appendChild(empty('Learning Fabric unavailable.')); return; }

    container.appendChild(ui.spinner('Recalling what we’ve learned…'));
    let ins;
    try { ins = await F().refresh(); } catch (err) { container.innerHTML = ''; container.appendChild(ui.el('div', { className: 'aaa-list-row', html: '<strong>Could not load the learning fabric</strong><div class="aaa-list-sub">' + esc((err && err.message) || err) + '</div>' })); return; }
    container.innerHTML = '';

    container.appendChild(ui.el('section', { className: 'aaa-summary' }, [
      chip(ins.memorySize, 'Jobs remembered', '#3B82F6'),
      chip(ins.idealFollowUpDays == null ? '—' : ins.idealFollowUpDays + 'd', 'Ideal follow-up', '#8B5CF6'),
      chip(ins.bestService ? ins.bestService.winRate + '%' : '—', 'Best segment', '#10B981')
    ]));

    container.appendChild(title('What the business has learned'));
    const learned = [];
    if (ins.bestService) learned.push('Best-closing service: <strong>' + esc(ins.bestService.key) + '</strong> at ' + ins.bestService.winRate + '% (' + ins.bestService.sample + ' jobs)');
    if (ins.bestMarginNeighborhood) learned.push('Best-margin neighborhood: <strong>' + esc(ins.bestMarginNeighborhood.key) + '</strong> at ' + ins.bestMarginNeighborhood.avgMargin + '% margin');
    if (ins.bestLeadSource) learned.push('Best lead source: <strong>' + esc(ins.bestLeadSource.key) + '</strong> at ' + ins.bestLeadSource.winRate + '% close');
    if (ins.idealFollowUpDays != null) learned.push('Ideal follow-up window: <strong>' + ins.idealFollowUpDays + ' day(s)</strong> (wins close that fast)');
    if (!learned.length) container.appendChild(empty('Not enough resolved jobs yet — the fabric learns as outcomes accrue.'));
    learned.forEach((h) => container.appendChild(ui.el('div', { className: 'aaa-list-row', html: '<div class="aaa-list-sub">' + h + '</div>' })));

    // Segment leaderboards.
    if ((ins.services || []).length) { container.appendChild(title('Segments by close rate')); ins.services.forEach((s) => container.appendChild(ui.el('div', { className: 'aaa-list-row', html: '<strong>' + esc(s.key) + '</strong><div class="aaa-list-sub">' + s.winRate + '% close · ' + s.sample + ' jobs</div>' }))); }
    if ((ins.neighborhoods || []).length) { container.appendChild(title('Neighborhoods by margin')); ins.neighborhoods.forEach((n) => container.appendChild(ui.el('div', { className: 'aaa-list-row', html: '<strong>' + esc(n.key) + '</strong><div class="aaa-list-sub">' + n.avgMargin + '% margin · ' + n.sample + ' jobs</div>' }))); }

    container.appendChild(ui.el('p', { className: 'aaa-voice-hint', text: 'Learned entirely from your jobs — no rules are hardcoded. As outcomes accrue, the recommendations sharpen. Nothing is applied automatically.' }));
  }

  /** Render a recall + recommendation for a context (used by the explorer/tests). */
  async function renderRecall(container, context) {
    const ui = U();
    container.innerHTML = '';
    const rec = await F().recommendFor(context || {});
    container.appendChild(ui.el('div', { className: 'aaa-list-row', html: '<strong>Recommendation</strong><div class="aaa-list-sub">' + esc(rec.recommendation) + '</div>' }));
    (rec.tips || []).forEach((tip) => container.appendChild(ui.el('div', { className: 'aaa-list-row', html: '<div class="aaa-list-sub">💡 ' + esc(tip) + '</div>' })));
    container.appendChild(ui.el('div', { className: 'aaa-list-row', html: '<div class="aaa-list-sub">Confidence ' + rec.confidence + ' · based on ' + esc(rec.basis) + (rec.evidence && rec.evidence.winRate != null ? ' · ' + rec.evidence.winRate + '% close' : '') + '</div>' }));
  }

  function open() {
    const ui = U();
    const sheet = ui.sheet({ title: 'Learning Fabric', subtitle: 'AAA Carpet — shared memory & recommendations' });
    document.body.appendChild(sheet.overlay);
    render(sheet.body);
  }

  global.AAA_LEARNING_FABRIC_UI = { render: render, renderRecall: renderRecall, open: open };
})(typeof window !== 'undefined' ? window : this);
