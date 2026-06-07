/*
 * AAA Outcome Intelligence — owner-only agent scoreboard + learning view.
 *
 * Shows outcome metrics (conversion, margin, response time), the agent
 * scoreboard (accuracy + evidence per agent), and extracted learning patterns
 * (segments that close/earn better). Advisory only — patterns are surfaced, not
 * applied. Gated on VIEW_FINANCIALS (owner). One button refreshes (ingest +
 * score + extract) on demand.
 */
;(function (global) {
  'use strict';

  function U() { return global.AAA_UI; }
  function OI() { return global.AAA_OUTCOME_INTELLIGENCE; }
  function rbac() { return global.AAA_RBAC; }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
  function color(acc) { return acc == null ? '#71717A' : acc >= 75 ? '#10B981' : acc >= 50 ? '#F59E0B' : '#EF4444'; }

  function chip(value, label, c) {
    return U().el('div', { className: 'aaa-chip' }, [
      U().el('span', { className: 'aaa-chip__value', text: String(value), style: { color: c || 'var(--muted)' } }),
      U().el('span', { className: 'aaa-chip__label', text: label }),
      U().el('div', { className: 'aaa-chip__bar', style: { background: c || 'var(--muted)', opacity: '0.85' } })
    ]);
  }
  function title(t) { return U().el('h2', { className: 'aaa-section-title', text: t }); }
  function empty(t) { return U().el('p', { className: 'aaa-empty', text: t }); }

  async function render(container) {
    const ui = U();
    container.innerHTML = '';
    if (rbac() && !rbac().can('VIEW_FINANCIALS')) {
      container.appendChild(ui.el('div', { className: 'aaa-list-row', html: '<strong>🔒 Outcome Intelligence is owner-only</strong><div class="aaa-list-sub">Signed in as ' + esc(rbac().label()) + '. It exposes margins + conversion, so it is owner-only.</div>' }));
      return;
    }
    if (!OI()) { container.appendChild(empty('Outcome Intelligence unavailable.')); return; }

    container.appendChild(ui.spinner('Scoring agents…'));
    let m, board, patterns;
    try { m = await OI().metrics(); board = await OI().scoreboard(); patterns = await OI().patterns(); }
    catch (err) { container.innerHTML = ''; container.appendChild(ui.el('div', { className: 'aaa-list-row', html: '<strong>Could not load outcome intelligence</strong><div class="aaa-list-sub">' + esc((err && err.message) || err) + '</div>' })); return; }
    container.innerHTML = '';

    container.appendChild(ui.el('section', { className: 'aaa-summary' }, [
      chip(m.conversion == null ? '—' : m.conversion + '%', 'Conversion', '#3B82F6'),
      chip(m.avgMargin == null ? '—' : m.avgMargin + '%', 'Avg margin', '#10B981'),
      chip(m.avgResponseDays == null ? '—' : m.avgResponseDays + 'd', 'Response', '#8B5CF6'),
      chip(m.totalEvents, 'Outcomes', '#A1A1AA')
    ]));

    container.appendChild(ui.button({ label: 'Refresh intelligence', icon: '🧠', variant: 'secondary', full: true, onClick: async () => { await OI().refresh(); await render(container); } }));

    // Agent scoreboard.
    container.appendChild(title('Agent scoreboard'));
    if (!board.length) container.appendChild(empty('No agent scores yet — refresh once a few predictions have closed.'));
    board.forEach((a) => container.appendChild(ui.el('div', { className: 'aaa-list-row', html:
      '<strong style="color:' + color(a.accuracy) + '">' + esc(a.agent) + ' — ' + (a.accuracy == null ? 'n/a' : a.accuracy + '% accuracy') + '</strong>' +
      '<div class="aaa-list-sub">' + (a.sample ? a.sample + ' scored · ' : '') + (a.validated != null ? a.validated + '✓/' + a.contradicted + '✗ · ' : '') + a.decisions + ' decisions · confidence ' + (a.confidence || 0) + '%</div>' })));

    // Learning patterns.
    container.appendChild(title('Learning patterns'));
    if (!patterns.length) container.appendChild(empty('No patterns yet.'));
    patterns.slice(0, 12).forEach((p) => container.appendChild(ui.el('div', { className: 'aaa-list-row', html:
      '<strong>' + esc(p.dimension) + ': ' + esc(p.key) + '</strong><div class="aaa-list-sub">' + esc(p.metric) + ' ' + p.value + (p.metric === 'winRate' ? '% close' : '% margin') + ' · ' + p.sample + ' samples · confidence ' + p.confidence + '%</div>' })));

    container.appendChild(ui.el('p', { className: 'aaa-voice-hint', text: 'The system scores its own agents and surfaces what is working. Patterns are evidence for you — nothing is applied automatically.' }));
  }

  function open() {
    const ui = U();
    const sheet = ui.sheet({ title: 'Outcome Intelligence', subtitle: 'AAA Carpet — agent scores & learning' });
    document.body.appendChild(sheet.overlay);
    render(sheet.body);
  }

  global.AAA_OUTCOME_INTELLIGENCE_UI = { render: render, open: open };
})(typeof window !== 'undefined' ? window : this);
