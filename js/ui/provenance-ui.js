/*
 * AAA Provenance Graph — owner-only "where did this come from?" viewer.
 *
 * For any advisory artifact the system surfaces, the owner can trace it to its
 * origin: the source quotes, the outcomes learned from, the prediction(s) and
 * closure(s), and the governed versions (calibration / prompt / model) in force.
 *
 * It lists the live pricing recommendations + council meetings, lets the owner
 * "Trace to origin" (which builds + records an immutable trace), and renders the
 * ordered node chain. It reads only — it changes no price, quote, or record.
 */
;(function (global) {
  'use strict';

  function U() { return global.AAA_UI; }
  function builder() { return global.AAA_PROVENANCE_BUILDER; }
  function store() { return global.AAA_PROVENANCE; }
  function optimizer() { return global.AAA_PRICING_OPTIMIZER; }
  function council() { return global.AAA_AGENT_COUNCIL; }
  function rbac() { return global.AAA_RBAC; }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

  const NODE = {
    subject: { icon: '🎯', color: '#3B82F6' }, model: { icon: '🤖', color: '#8B5CF6' },
    prompt: { icon: '📝', color: '#8B5CF6' }, calibration: { icon: '🎚️', color: '#0EA5E9' },
    evidence: { icon: '🧾', color: '#10B981' }, quote: { icon: '📄', color: '#F59E0B' },
    prediction: { icon: '🔮', color: '#A855F7' }, closure: { icon: '✔️', color: '#22C55E' }
  };

  function title(t) { return U().el('h2', { className: 'aaa-section-title', text: t }); }
  function empty(t) { return U().el('p', { className: 'aaa-empty', text: t }); }

  async function render(container) {
    const ui = U();
    container.innerHTML = '';
    if (rbac() && !rbac().can('VIEW_FINANCIALS')) {
      container.appendChild(ui.el('div', { className: 'aaa-list-row', html: '<strong>🔒 Provenance is owner-only</strong><div class="aaa-list-sub">Signed in as ' + esc(rbac().label ? rbac().label() : '') + '. Traces expose margins and win rates, so they are restricted to the owner.</div>' }));
      return;
    }
    if (!builder() || !store()) { container.appendChild(empty('Provenance unavailable.')); return; }

    container.appendChild(ui.spinner('Loading provenance…'));
    let recs = [], sessions = [], traces = [];
    try {
      if (optimizer() && optimizer().analyze) { const a = await optimizer().analyze(); recs = (a && a.recommendations) || []; }
      if (council() && council().list) sessions = await council().list();
      traces = await store().list();
    } catch (err) {
      container.innerHTML = '';
      container.appendChild(ui.el('div', { className: 'aaa-list-row', html: '<strong>Could not load provenance</strong><div class="aaa-list-sub">' + esc((err && err.message) || err) + '</div>' }));
      return;
    }
    container.innerHTML = '';

    container.appendChild(title('Trace to origin'));
    container.appendChild(ui.el('p', { className: 'aaa-voice-hint', text: 'Every recommendation can be traced to the quotes, outcomes, predictions, and governed versions behind it. Tracing records an immutable snapshot.' }));

    // Live pricing recommendations.
    if (!recs.length) container.appendChild(empty('No pricing recommendations to trace yet.'));
    recs.slice(0, 8).forEach((r) => {
      const row = ui.el('div', { className: 'aaa-list-row', html: '<strong>' + esc(r.title) + '</strong><div class="aaa-list-sub">confidence ' + (r.adjustedConfidence != null ? r.adjustedConfidence : r.confidence) + ' · risk ' + r.risk + ' · ' + arr(r.supportingQuoteIds).length + ' source quotes</div>' });
      row.appendChild(ui.button({ label: 'Trace to origin', size: 'sm', variant: 'primary', onClick: () => trace('pricing_recommendation', r) }));
      container.appendChild(row);
    });

    // Council meetings.
    if (sessions.length) {
      container.appendChild(title('Council meetings'));
      sessions.slice(0, 6).forEach((s) => {
        const row = ui.el('div', { className: 'aaa-list-row', html: '<strong>' + esc(s.customerName || s.quoteId || s.id) + '</strong><div class="aaa-list-sub">' + esc(s.decision) + ' · confidence ' + s.decisionConfidence + ' · disagreement ' + s.disagreement + '%</div>' });
        row.appendChild(ui.button({ label: 'Trace to origin', size: 'sm', variant: 'ghost', onClick: () => trace('council_session', s) }));
        container.appendChild(row);
      });
    }

    // Recorded traces.
    container.appendChild(title('Recorded traces (' + traces.length + ')'));
    if (!traces.length) container.appendChild(empty('No traces recorded yet. Trace a recommendation above.'));
    traces.slice(0, 12).forEach((tr) => {
      const row = ui.el('button', { className: 'aaa-list-row', attrs: { type: 'button', style: 'width:100%;text-align:left;cursor:pointer' }, html:
        '<strong>' + esc(tr.subjectLabel || tr.subjectType) + '</strong><div class="aaa-list-sub">' + esc(tr.subjectType) + ' · ' + arr(tr.sourceQuotes).length + ' quotes · ' + arr(tr.predictionIds).length + ' predictions · ' + arr(tr.closureIds).length + ' closures</div>' });
      row.addEventListener('click', () => openTrace(tr));
      container.appendChild(row);
    });
  }

  /** Build + record a trace, then open it. */
  async function trace(subjectType, payload) {
    const ui = U();
    const res = await builder().buildAndRecord(subjectType, payload);
    if (!res.ok) { await ui.confirm({ title: 'Could not trace', message: res.error, confirmLabel: 'OK' }); return; }
    openTrace(res.record);
  }

  /** Render a single trace: the governed versions, evidence, and source chain. */
  function renderTrace(container, g) {
    const ui = U();
    container.innerHTML = '';
    if (!g) { container.appendChild(empty('Trace not found.')); return; }

    container.appendChild(ui.el('div', { className: 'aaa-list-row', html: '<strong>' + esc(g.subjectLabel || g.subjectType) + '</strong><div class="aaa-list-sub">' + esc(g.subjectType) + (g.agent ? ' · ' + esc(g.agent) : '') + '</div>' }));

    // Governed versions in force.
    container.appendChild(title('Governed versions'));
    container.appendChild(ui.el('div', { className: 'aaa-list-row', html: '<div class="aaa-list-sub">Model: ' + esc(g.modelVersion || '—') + ' · Prompt: ' + esc(g.promptVersion != null ? 'v' + g.promptVersion : '—') + ' · Calibration: ' + (g.calibrationVersion ? 'v' + esc(g.calibrationVersion.version) + ' (' + esc(g.calibrationVersion.agent) + ', bias ' + esc(g.calibrationVersion.confidenceBias) + ')' : '— none active') + '</div>' }));

    // The node chain.
    container.appendChild(title('Where this came from'));
    arr(g.nodes).forEach((n) => {
      const d = NODE[n.type] || { icon: '•', color: 'var(--muted)' };
      container.appendChild(ui.el('div', { className: 'aaa-list-row', html:
        '<strong style="color:' + d.color + '">' + d.icon + ' ' + esc(n.label) + '</strong>' + (n.detail ? '<div class="aaa-list-sub">' + esc(n.detail) + '</div>' : '') }));
    });

    // Evidence quotes/predictions/closures counts.
    container.appendChild(ui.el('div', { className: 'aaa-list-row', html: '<div class="aaa-list-sub">' + arr(g.sourceQuotes).length + ' source quotes · ' + arr(g.outcomeIds).length + ' resolved outcomes · ' + arr(g.predictionIds).length + ' predictions · ' + arr(g.closureIds).length + ' closures</div>' }));
  }

  function openTrace(g) {
    const ui = U();
    const sheet = ui.sheet({ title: 'Provenance', subtitle: 'AAA Carpet — where this came from' });
    document.body.appendChild(sheet.overlay);
    renderTrace(sheet.body, g);
  }

  function open() {
    const ui = U();
    const sheet = ui.sheet({ title: 'Provenance Graph', subtitle: 'AAA Carpet — trace any recommendation to its origin' });
    document.body.appendChild(sheet.overlay);
    render(sheet.body);
  }

  function arr(v) { return Array.isArray(v) ? v : []; }

  global.AAA_PROVENANCE_UI = { render: render, renderTrace: renderTrace, open: open };
})(typeof window !== 'undefined' ? window : this);
