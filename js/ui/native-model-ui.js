/*
 * AAA Native Model — owner-only model lab.
 *
 * Train HyperKernel's own win-probability model on your jobs, inspect its honest
 * metrics + learned feature weights, run an explainable prediction sandbox, and
 * promote a candidate into the Governance Registry (where you still activate it —
 * two keys). Read-only over the business; the model changes nothing on its own.
 * Gated on MANAGE_GOVERNANCE (owner).
 */
;(function (global) {
  'use strict';

  function U() { return global.AAA_UI; }
  function M() { return global.AAA_MODEL; }
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
    if (rbac() && !rbac().can('MANAGE_GOVERNANCE')) {
      container.appendChild(ui.el('div', { className: 'aaa-list-row', html: '<strong>🔒 The Model Lab is owner-only</strong><div class="aaa-list-sub">Signed in as ' + esc(rbac().label()) + '. Training + promoting the model is restricted to the owner.</div>' }));
      return;
    }
    if (!M()) { container.appendChild(empty('Native Model unavailable.')); return; }

    container.appendChild(ui.spinner('Loading the model lab…'));
    let candidates, active;
    try { candidates = await M().candidates(); active = await M().activeModel(); }
    catch (err) { container.innerHTML = ''; container.appendChild(ui.el('div', { className: 'aaa-list-row', html: '<strong>Could not load the model lab</strong><div class="aaa-list-sub">' + esc((err && err.message) || err) + '</div>' })); return; }
    container.innerHTML = '';

    const latest = candidates[0] || null;
    container.appendChild(ui.el('section', { className: 'aaa-summary' }, [
      chip(active ? 'LIVE' : 'none', 'Active model', active ? '#10B981' : '#71717A'),
      chip(latest && latest.metrics.holdoutAccuracy != null ? latest.metrics.holdoutAccuracy + '%' : '—', 'Holdout acc.', '#3B82F6'),
      chip(candidates.length, 'Candidates', '#8B5CF6')
    ]));

    container.appendChild(ui.button({ label: 'Train a new model on current data', icon: '🧠', variant: 'primary', full: true, onClick: async () => {
      const res = await M().train({ actor: actor() });
      if (!res.ok) await ui.confirm({ title: 'Not trained', message: res.error === 'INSUFFICIENT_DATA' ? ('Need at least ' + res.need + ' resolved quotes (have ' + res.have + ').') : res.error, confirmLabel: 'OK' });
      await render(container);
    } }));

    // Latest candidate: metrics + learned weights.
    if (latest) {
      container.appendChild(title('Latest candidate'));
      container.appendChild(ui.el('div', { className: 'aaa-list-row', html:
        '<div class="aaa-list-sub">Train acc ' + latest.metrics.trainAccuracy + '% · holdout acc ' + (latest.metrics.holdoutAccuracy == null ? '—' : latest.metrics.holdoutAccuracy + '%') + ' · log-loss ' + (latest.metrics.holdoutLogLoss == null ? '—' : latest.metrics.holdoutLogLoss) + '</div>' +
        '<div class="aaa-list-sub">Trained on ' + latest.metrics.trainSample + ', held out ' + latest.metrics.holdoutSample + ' · base win rate ' + Math.round((latest.metrics.baseRate || 0) * 100) + '%</div>' }));
      container.appendChild(title('Learned weights (odds multiplier)'));
      M().weightTable(latest.model).forEach((w) => container.appendChild(ui.el('div', { className: 'aaa-list-row', html: '<strong>' + esc(w.feature) + '</strong><div class="aaa-list-sub">×' + w.oddsMultiplier + ' per unit ' + (w.weight >= 0 ? '(raises win odds)' : '(lowers win odds)') + '</div>' })));

      if (latest.status !== 'promoted') container.appendChild(ui.button({ label: 'Promote → Governance Registry', icon: '⬆', variant: 'secondary', full: true, onClick: async () => {
        const ok = await ui.confirm({ title: 'Promote this model?', message: 'Files it as a governance draft. You still activate it in the Registry — nothing goes live automatically.', confirmLabel: 'Promote' });
        if (!ok) return;
        const res = await M().promote(latest.id, { actor: actor() });
        await ui.confirm({ title: res.ok ? 'Promoted' : 'Not promoted', message: res.ok ? res.note : (res.message || res.error), confirmLabel: 'OK' });
        await render(container);
      } }));
    }

    // Prediction sandbox (uses active model, or previews the latest candidate).
    container.appendChild(title('Prediction sandbox'));
    container.appendChild(ui.button({ label: 'Predict a sample quote', icon: '🔮', variant: 'ghost', full: true, onClick: async () => {
      const sample = { customerTotal: 1200, marginPct: 30, serviceType: ['carpet'], zip: '90210', leadSource: 'referral' };
      const res = await M().predict(sample, { preview: true });
      renderPrediction(predBox, res, sample);
    } }));
    const predBox = ui.el('div', {});
    container.appendChild(predBox);
    predBox.appendChild(empty('Run a prediction to see the win probability + reasons.'));

    container.appendChild(ui.el('p', { className: 'aaa-voice-hint', text: 'HyperKernel’s own model, trained on your jobs — every prediction explains itself, and a new model only goes live when you activate it in governance.' }));
  }

  /** Render a single prediction with its reasons (also used by tests). */
  function renderPrediction(container, res, sample) {
    const ui = U();
    container.innerHTML = '';
    if (!res || res.ok === false) { container.appendChild(ui.el('div', { className: 'aaa-list-row', html: '<div class="aaa-list-sub">' + esc((res && (res.message || res.error)) || 'No model yet — train one first.') + '</div>' })); return; }
    container.appendChild(ui.el('div', { className: 'aaa-list-row', html: '<strong>Win probability: ' + res.winProbability + '%</strong><div class="aaa-list-sub">source: ' + esc(res.source) + (sample ? ' · sample $' + sample.customerTotal + ' @ ' + sample.marginPct + '%' : '') + '</div>' }));
    (res.reasons || []).forEach((r) => container.appendChild(ui.el('div', { className: 'aaa-list-row', html: '<div class="aaa-list-sub">' + (r.effect === 'raises' ? '▲' : '▼') + ' ' + esc(r.text) + '</div>' })));
  }

  function open() {
    const ui = U();
    const sheet = ui.sheet({ title: 'Native Model Lab', subtitle: 'AAA Carpet — train your own brain' });
    document.body.appendChild(sheet.overlay);
    render(sheet.body);
  }

  global.AAA_MODEL_UI = { render: render, renderPrediction: renderPrediction, open: open };
})(typeof window !== 'undefined' ? window : this);
