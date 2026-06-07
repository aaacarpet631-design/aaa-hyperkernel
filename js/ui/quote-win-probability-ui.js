/*
 * AAA Quote Win Probability — the Native Model, in the quote flow.
 *
 * Renders a governed, explainable win-probability panel inside the quote detail
 * view: it asks the ACTIVE governed model (AAA_MODEL) to score this quote and
 * shows the win % + the per-feature reasons. Purely advisory + read-only — it
 * informs the owner, it never prices, sends, or changes the quote. If no model
 * has been trained + activated yet, it nudges the owner to the Model Lab.
 * Owner-only (win probability is margin-derived).
 */
;(function (global) {
  'use strict';

  function U() { return global.AAA_UI; }
  function model() { return global.AAA_MODEL; }
  function rbac() { return global.AAA_RBAC; }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
  function color(p) { return p == null ? '#71717A' : p >= 60 ? '#10B981' : p >= 40 ? '#F59E0B' : '#EF4444'; }

  function chip(value, label, c) {
    return U().el('div', { className: 'aaa-chip' }, [
      U().el('span', { className: 'aaa-chip__value', text: String(value), style: { color: c || 'var(--muted)' } }),
      U().el('span', { className: 'aaa-chip__label', text: label }),
      U().el('div', { className: 'aaa-chip__bar', style: { background: c || 'var(--muted)', opacity: '0.85' } })
    ]);
  }

  /** Render the win-probability panel for a quote into `container`. */
  async function renderInto(container, quote) {
    const ui = U();
    if (!ui || !container) return;
    container.innerHTML = '';
    if (!model() || !model().predict) return;                 // model not loaded → no panel
    if (rbac() && !rbac().can('VIEW_FINANCIALS')) return;      // owner-only

    let res;
    try { res = await model().predict(quote || {}); }
    catch (_) { return; }

    if (!res || res.ok === false) {
      if (res && res.error === 'NO_ACTIVE_MODEL') {
        const row = ui.el('div', { className: 'aaa-list-row', html: '<strong>🧠 Win prediction</strong><div class="aaa-list-sub">No governed win model is live yet. Train + activate one to see a predicted win probability here.</div>' });
        if (global.AAA_MODEL_UI && global.AAA_MODEL_UI.open) row.appendChild(ui.button({ label: 'Open Model Lab', size: 'sm', variant: 'ghost', onClick: () => global.AAA_MODEL_UI.open() }));
        container.appendChild(row);
      }
      return;
    }

    container.appendChild(ui.el('h2', { className: 'aaa-section-title', text: 'Predicted win probability (governed model)' }));
    container.appendChild(ui.el('section', { className: 'aaa-summary' }, [
      chip(res.winProbability + '%', 'Win likelihood', color(res.winProbability)),
      chip(res.confidence, 'Confidence', '#3B82F6'),
      chip(res.source === 'active' ? 'live' : esc(res.source), 'Model', '#8B5CF6')
    ]));
    (res.reasons || []).slice(0, 4).forEach((r) => container.appendChild(ui.el('div', { className: 'aaa-list-row', html:
      '<div class="aaa-list-sub">' + (r.effect === 'raises' ? '▲' : '▼') + ' ' + esc(r.text) + '</div>' })));
    container.appendChild(ui.el('p', { className: 'aaa-voice-hint', text: 'Advisory — from AAA’s own trained model. It informs your decision; it never prices, sends, or changes the quote.' }));
  }

  global.AAA_QUOTE_WIN_UI = { renderInto: renderInto };
})(typeof window !== 'undefined' ? window : this);
