/*
 * AAA Agent Evaluation Lab — owner-only agent scorecards.
 *
 * Ranks every recommendation-producing agent by ROI / value, and opens a
 * scorecard with accuracy (+ confidence interval), false-positive / false-
 * negative rates, adoption rate, revenue/margin influence, ROI, and impact
 * counters — each explained. Read-only. Gated on VIEW_FINANCIALS (owner).
 */
;(function (global) {
  'use strict';

  function U() { return global.AAA_UI; }
  function LAB() { return global.AAA_AGENT_EVAL; }
  function rbac() { return global.AAA_RBAC; }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
  function pctv(n) { return n == null ? '—' : n + '%'; }

  function chip(value, label, color) {
    return U().el('div', { className: 'aaa-chip' }, [
      U().el('span', { className: 'aaa-chip__value', text: String(value), style: { color: color || 'var(--muted)' } }),
      U().el('span', { className: 'aaa-chip__label', text: label }),
      U().el('div', { className: 'aaa-chip__bar', style: { background: color || 'var(--muted)', opacity: '0.85' } })
    ]);
  }
  function title(t) { return U().el('h2', { className: 'aaa-section-title', text: t }); }
  function empty(t) { return U().el('p', { className: 'aaa-empty', text: t }); }
  function accColor(a) { return a == null ? '#71717A' : a >= 75 ? '#10B981' : a >= 50 ? '#F59E0B' : '#EF4444'; }

  async function render(container) {
    const ui = U();
    container.innerHTML = '';
    if (rbac() && !rbac().can('VIEW_FINANCIALS')) {
      container.appendChild(ui.el('div', { className: 'aaa-list-row', html: '<strong>🔒 The Agent Evaluation Lab is owner-only</strong><div class="aaa-list-sub">Signed in as ' + esc(rbac().label()) + '.</div>' }));
      return;
    }
    if (!LAB()) { container.appendChild(empty('Agent Evaluation Lab unavailable.')); return; }

    container.appendChild(ui.spinner('Scoring agents…'));
    let cards;
    try { cards = await LAB().scorecards(); } catch (err) { container.innerHTML = ''; container.appendChild(ui.el('div', { className: 'aaa-list-row', html: '<strong>Could not load scorecards</strong><div class="aaa-list-sub">' + esc((err && err.message) || err) + '</div>' })); return; }
    container.innerHTML = '';

    container.appendChild(title('Agent scorecards'));
    if (!cards.length) container.appendChild(empty('No agent activity to score yet.'));
    cards.forEach((c) => {
      const row = ui.el('button', { className: 'aaa-list-row', attrs: { type: 'button', style: 'width:100%;text-align:left;cursor:pointer' }, html:
        '<strong style="color:' + accColor(c.accuracy) + '">' + esc(c.agent) + ' — ' + (c.roi != null ? c.roi + 'x ROI' : (c.accuracy != null ? c.accuracy + '% accuracy' : 'n/a')) + '</strong>' +
        '<div class="aaa-list-sub">accuracy ' + pctv(c.accuracy) + ' · adoption ' + pctv(c.adoptionRate) + ' · ' + c.decisions + ' decisions · value ' + (c.valueIndex == null ? '—' : c.valueIndex) + '</div>' });
      row.addEventListener('click', () => openCard(c.agent));
      container.appendChild(row);
    });

    container.appendChild(ui.button({ label: 'Snapshot evaluation', icon: '📸', variant: 'secondary', full: true, onClick: async () => { await LAB().evaluate(); await render(container); } }));
    container.appendChild(ui.el('p', { className: 'aaa-voice-hint', text: 'Every recommendation-producing agent is scored from real outcomes. ROI shows only when revenue is attributable — no fabricated value.' }));
  }

  function renderCard(container, c) {
    const ui = U();
    container.innerHTML = '';
    if (!c) { container.appendChild(empty('Scorecard not found.')); return; }
    container.appendChild(ui.el('div', { className: 'aaa-list-row', html: '<strong>' + esc(c.agent) + '</strong>' }));
    container.appendChild(ui.el('section', { className: 'aaa-summary' }, [
      chip(c.roi != null ? c.roi + 'x' : '—', 'ROI', c.roi != null ? '#10B981' : '#71717A'),
      chip(pctv(c.accuracy), 'Accuracy', accColor(c.accuracy)),
      chip(pctv(c.adoptionRate), 'Adoption', '#3B82F6'),
      chip(c.valueIndex == null ? '—' : c.valueIndex, 'Value index', '#8B5CF6')
    ]));

    container.appendChild(title('Quality'));
    container.appendChild(ui.el('div', { className: 'aaa-list-row', html:
      '<div class="aaa-list-sub">Accuracy ' + pctv(c.accuracy) + (c.accuracyCI ? ' (95% CI ' + c.accuracyCI.low + '–' + c.accuracyCI.high + '%)' : '') + ' · ' + c.closures.validated + '✓/' + c.closures.contradicted + '✗</div>' +
      '<div class="aaa-list-sub">False-positive ' + pctv(c.falsePositiveRate) + ' · false-negative ' + pctv(c.falseNegativeRate) + '</div>' +
      '<div class="aaa-list-sub">' + esc(c.explain.accuracy) + '</div>' }));

    container.appendChild(title('Value'));
    container.appendChild(ui.el('div', { className: 'aaa-list-row', html:
      '<div class="aaa-list-sub">Revenue influence: ' + (c.revenueInfluence == null ? 'n/a' : '$' + c.revenueInfluence.toLocaleString()) + ' · margin: ' + (c.marginInfluence == null ? 'n/a' : '$' + c.marginInfluence.toLocaleString()) + ' · cost $' + c.cost + '</div>' +
      '<div class="aaa-list-sub">' + esc(c.explain.roi) + '</div>' +
      '<div class="aaa-list-sub">Impact — customer: ' + (c.customerImpact == null ? '—' : c.customerImpact) + ' · review: ' + (c.reviewImpact == null ? '—' : c.reviewImpact) + ' · adoption: ' + esc(c.explain.adoption) + '</div>' }));
  }

  async function openCard(agent) { const ui = U(); const s = ui.sheet({ title: 'Scorecard', subtitle: agent }); document.body.appendChild(s.overlay); renderCard(s.body, await LAB().scorecard(agent)); }
  function open() { const ui = U(); const s = ui.sheet({ title: 'Agent Evaluation Lab', subtitle: 'AAA Carpet — agent scorecards' }); document.body.appendChild(s.overlay); render(s.body); }

  global.AAA_AGENT_EVAL_UI = { render: render, renderCard: renderCard, open: open };
})(typeof window !== 'undefined' ? window : this);
