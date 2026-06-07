/*
 * AAA Vector Memory — office-only semantic recall console.
 *
 * Search the company's knowledge by MEANING (not exact words) and see the most
 * similar records with a similarity score. Read-only; results are permission-
 * filtered (financial/legal memory by role). Gated on VIEW_ALL_JOBS (owner +
 * manager); financial matches remain owner-only via the search's own tiering.
 */
;(function (global) {
  'use strict';

  function U() { return global.AAA_UI; }
  function VM() { return global.AAA_VECTOR_MEMORY; }
  function rbac() { return global.AAA_RBAC; }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
  function canUse() { const r = rbac(); return !r || r.can('VIEW_ALL_JOBS'); }

  const SAMPLES = ['carpet steam cleaning', 'pet stain repair', 'apartment turn move-out', 'upholstery sofa cleaning'];

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
    if (rbac() && !canUse()) {
      container.appendChild(ui.el('div', { className: 'aaa-list-row', html: '<strong>🔒 Semantic memory is office-only</strong><div class="aaa-list-sub">Signed in as ' + esc(rbac().label()) + '. Financial matches stay owner-only.</div>' }));
      return;
    }
    if (!VM()) { container.appendChild(empty('Vector Memory unavailable.')); return; }

    container.appendChild(ui.spinner('Indexing semantic memory…'));
    let stats;
    try { await VM().index(); stats = await VM().stats(); }
    catch (err) { container.innerHTML = ''; container.appendChild(ui.el('div', { className: 'aaa-list-row', html: '<strong>Could not load semantic memory</strong><div class="aaa-list-sub">' + esc((err && err.message) || err) + '</div>' })); return; }
    container.innerHTML = '';

    container.appendChild(ui.el('section', { className: 'aaa-summary' }, [
      chip(stats.vectors, 'Memories', '#3B82F6'),
      chip(stats.dim, 'Dimensions', '#8B5CF6'),
      chip(stats.embedder === 'local-deterministic' ? 'local' : 'model', 'Embedder', '#10B981')
    ]));

    container.appendChild(title('Search by meaning'));
    const results = ui.el('div', {});
    if (ui.prompt) container.appendChild(ui.button({ label: 'Semantic search…', icon: '🔎', variant: 'primary', full: true, onClick: async () => { const q = await ui.prompt({ title: 'Semantic search', message: 'Describe what you’re looking for:' }); if (q) await runQuery(results, q); } }));
    const samples = ui.el('div', { className: 'aaa-form', style: { display: 'flex', gap: '8px', flexWrap: 'wrap' } });
    SAMPLES.forEach((s) => samples.appendChild(ui.button({ label: s, size: 'sm', variant: 'secondary', onClick: () => runQuery(results, s) })));
    container.appendChild(samples);

    container.appendChild(title('Results'));
    container.appendChild(results);
    results.appendChild(empty('Run a search to see the most similar records.'));

    container.appendChild(ui.el('p', { className: 'aaa-voice-hint', text: 'Finds records by meaning, not exact words — fully on-device and deterministic. Read-only; results respect your role.' }));
  }

  /** Render ranked semantic results for a query (also used by tests). */
  async function runQuery(container, query) {
    const ui = U();
    container.innerHTML = '';
    let hits;
    try { hits = await VM().search(query, {}); } catch (_) { hits = []; }
    container.appendChild(ui.el('div', { className: 'aaa-list-row', html: '<strong>“' + esc(query) + '”</strong><div class="aaa-list-sub">' + hits.length + ' match(es) by meaning</div>' }));
    if (!hits.length) { container.appendChild(empty('No semantically related records.')); return; }
    hits.forEach((h) => container.appendChild(ui.el('div', { className: 'aaa-list-row', html:
      '<strong>' + esc(h.kind || 'record') + ' · ' + esc(h.sourceCollection || '') + '</strong>' +
      '<div class="aaa-list-sub">' + esc(h.sourceId || h.nodeId) + ' · similarity ' + h.score + '</div>' })));
  }

  function open() {
    const ui = U();
    const sheet = ui.sheet({ title: 'Semantic Memory', subtitle: 'AAA Carpet — recall by meaning' });
    document.body.appendChild(sheet.overlay);
    render(sheet.body);
  }

  global.AAA_VECTOR_MEMORY_UI = { render: render, runQuery: runQuery, open: open };
})(typeof window !== 'undefined' ? window : this);
