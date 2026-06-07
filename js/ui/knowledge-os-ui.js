/*
 * AAA Knowledge Operating System — owner/office knowledge console.
 *
 * Ask questions about the business ("last 10 apartment turns", "what closes best
 * for pet damage", "which neighborhoods produce the highest margins") and get a
 * deterministic answer with cited evidence, plus a permission-aware search over
 * the knowledge fabric. Read-only; every ask is audited. Gated on VIEW_ALL_JOBS
 * (owner + manager); financial answers are still owner-gated by the engine.
 */
;(function (global) {
  'use strict';

  function U() { return global.AAA_UI; }
  function K() { return global.AAA_KNOWLEDGE; }
  function rbac() { return global.AAA_RBAC; }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
  function canUse() { const r = rbac(); return !r || r.can('VIEW_ALL_JOBS'); }

  const SUGGESTED = [
    'last 10 apartment turns',
    'what repair method closes best for pet damage',
    'which neighborhoods produce the highest margins',
    'which review requests generate the highest response rate'
  ];

  function title(t) { return U().el('h2', { className: 'aaa-section-title', text: t }); }
  function empty(t) { return U().el('p', { className: 'aaa-empty', text: t }); }

  async function render(container) {
    const ui = U();
    container.innerHTML = '';
    if (rbac() && !canUse()) {
      container.appendChild(ui.el('div', { className: 'aaa-list-row', html: '<strong>🔒 The Knowledge OS is office-only</strong><div class="aaa-list-sub">Signed in as ' + esc(rbac().label()) + '. Financial answers remain owner-only.</div>' }));
      return;
    }
    if (!K()) { container.appendChild(empty('Knowledge OS unavailable.')); return; }

    container.appendChild(ui.spinner('Indexing knowledge…'));
    let recent;
    try { await K().index(); recent = await K().queries(6); }
    catch (err) { container.innerHTML = ''; container.appendChild(ui.el('div', { className: 'aaa-list-row', html: '<strong>Could not load knowledge</strong><div class="aaa-list-sub">' + esc((err && err.message) || err) + '</div>' })); return; }
    container.innerHTML = '';

    container.appendChild(title('Ask about the business'));
    const answer = ui.el('div', {});
    SUGGESTED.forEach((s) => {
      const row = ui.el('div', { className: 'aaa-list-row', html: '<div class="aaa-list-sub">💬 ' + esc(s) + '</div>' });
      row.appendChild(ui.button({ label: 'Ask', size: 'sm', variant: 'secondary', onClick: async () => { renderAnswer(answer, await K().ask(s)); } }));
      container.appendChild(row);
    });
    container.appendChild(title('Answer'));
    container.appendChild(answer);
    answer.appendChild(empty('Pick a question above.'));

    if (recent.length) {
      container.appendChild(title('Recent questions (audited)'));
      recent.forEach((qr) => container.appendChild(ui.el('div', { className: 'aaa-list-row', html: '<div class="aaa-list-sub">' + esc(qr.question) + ' · ' + esc(qr.intent) + ' · ' + qr.sample + ' result(s)</div>' })));
    }

    container.appendChild(ui.el('p', { className: 'aaa-voice-hint', text: 'Answers are computed from your own records and cite their evidence — no guessing. Every question is logged, and financial answers are owner-only.' }));
  }

  /** Render a single answer with its evidence (also used by tests). */
  function renderAnswer(container, res) {
    const ui = U();
    container.innerHTML = '';
    if (!res) { container.appendChild(empty('No answer.')); return; }
    if (res.ok === false) { container.appendChild(ui.el('div', { className: 'aaa-list-row', html: '<strong>🔒 ' + esc(res.answer || res.error) + '</strong>' })); return; }
    container.appendChild(ui.el('div', { className: 'aaa-list-row', html: '<strong>' + esc(res.answer) + '</strong><div class="aaa-list-sub">intent: ' + esc(res.intent) + ' · ' + (res.sample || 0) + ' record(s)</div>' }));
    if (res.data && res.data.ranked) res.data.ranked.slice(0, 5).forEach((x) => container.appendChild(ui.el('div', { className: 'aaa-list-row', html: '<div class="aaa-list-sub">' + esc(JSON.stringify(x)) + '</div>' })));
    if ((res.evidence || []).length) { container.appendChild(ui.el('div', { className: 'aaa-list-row', html: '<div class="aaa-list-sub">Evidence: ' + (res.evidence || []).length + ' source record(s)</div>' })); }
  }

  function open() {
    const ui = U();
    const sheet = ui.sheet({ title: 'Knowledge OS', subtitle: 'AAA Carpet — ask about your business' });
    document.body.appendChild(sheet.overlay);
    render(sheet.body);
  }

  global.AAA_KNOWLEDGE_OS_UI = { render: render, renderAnswer: renderAnswer, open: open };
})(typeof window !== 'undefined' ? window : this);
