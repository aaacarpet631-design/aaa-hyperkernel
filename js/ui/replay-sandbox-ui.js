/*
 * AAA Replay Sandbox — owner-only "what-if" panel.
 *
 * Pick a recorded provenance trace, choose a calibration version and/or a policy
 * version to swap in, and run a read-only replay: the panel shows the original
 * decision vs the replayed one, a KPI delta table (price / margin / risk /
 * follow-up / review / booking / confidence), and links back to the provenance
 * trace and the governance versions involved. Nothing here changes a quote, job,
 * customer, outcome, or price — every run is gateway-audited and write-free.
 */
;(function (global) {
  'use strict';

  function U() { return global.AAA_UI; }
  function engine() { return global.AAA_REPLAY_SANDBOX; }
  function provenance() { return global.AAA_PROVENANCE; }
  function rbac() { return global.AAA_RBAC; }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
  function arr(v) { return Array.isArray(v) ? v : []; }
  function actor() { return (rbac() && rbac().label && rbac().label()) || 'owner'; }

  function title(t) { return U().el('h2', { className: 'aaa-section-title', text: t }); }
  function empty(t) { return U().el('p', { className: 'aaa-empty', text: t }); }
  function fmt(v, unit) { if (v == null) return '—'; return (typeof v === 'number' ? v : esc(v)) + (unit || ''); }

  async function render(container) {
    const ui = U();
    container.innerHTML = '';
    if (rbac() && !rbac().can('MANAGE_GOVERNANCE')) {
      container.appendChild(ui.el('div', { className: 'aaa-list-row', html: '<strong>🔒 The Replay Sandbox is owner-only</strong><div class="aaa-list-sub">Signed in as ' + esc(rbac().label ? rbac().label() : '') + '. Simulating decisions over margins is restricted to the owner.</div>' }));
      return;
    }
    if (!engine() || !provenance()) { container.appendChild(empty('Replay Sandbox unavailable.')); return; }

    container.appendChild(ui.spinner('Loading the sandbox…'));
    let traces, versions;
    try {
      traces = await provenance().list();
      versions = await engine().listVersions('pricing_optimizer');
    } catch (err) {
      container.innerHTML = '';
      container.appendChild(ui.el('div', { className: 'aaa-list-row', html: '<strong>Could not load the sandbox</strong><div class="aaa-list-sub">' + esc((err && err.message) || err) + '</div>' }));
      return;
    }
    container.innerHTML = '';

    container.appendChild(title('Replay Sandbox'));
    container.appendChild(ui.el('p', { className: 'aaa-voice-hint', text: 'Re-decide a past recommendation under different governed versions. Read-only — it changes no quote, job, customer, or price, and every run is audited.' }));

    container.appendChild(title('Pick a trace to replay'));
    if (!traces.length) container.appendChild(empty('No recorded traces yet. Record a provenance trace first, then replay it here.'));
    traces.slice(0, 10).forEach((tr) => {
      const row = ui.el('div', { className: 'aaa-list-row', html:
        '<strong>' + esc(tr.subjectLabel || tr.subjectType) + '</strong><div class="aaa-list-sub">' + esc(tr.subjectType) + ' · ' + esc(tr.agent || '') +
        (tr.summary && tr.summary.confidence != null ? ' · confidence ' + tr.summary.confidence : '') + '</div>' });
      row.appendChild(ui.button({ label: 'Replay', size: 'sm', variant: 'primary', onClick: () => openScenario(tr, versions) }));
      container.appendChild(row);
    });
  }

  /** Scenario builder: choose the versions to swap in, then run. */
  function openScenario(trace, versions) {
    const ui = U();
    const sheet = ui.sheet({ title: 'Replay: ' + (trace.subjectLabel || trace.subjectType), subtitle: 'Choose governed versions, then run' });
    document.body.appendChild(sheet.overlay);
    const scenario = { calibrationVersionId: null, policyVersionId: null };
    renderScenario(sheet.body, trace, versions, scenario);
  }

  function renderScenario(body, trace, versions, scenario) {
    const ui = U();
    body.innerHTML = '';
    body.appendChild(ui.el('div', { className: 'aaa-list-row', html: '<strong>' + esc(trace.subjectLabel || trace.subjectType) + '</strong><div class="aaa-list-sub">in force: calibration ' + (trace.calibrationVersion ? 'v' + trace.calibrationVersion.version : '—') + ' · prompt ' + (trace.promptVersion != null ? 'v' + trace.promptVersion : '—') + ' · model ' + esc(trace.modelVersion || '—') + '</div>' }));

    body.appendChild(title('Swap in a calibration version'));
    if (!arr(versions.calibration).length) body.appendChild(empty('No calibration versions to choose.'));
    arr(versions.calibration).forEach((v) => {
      const sel = scenario.calibrationVersionId === v.id;
      const row = ui.el('div', { className: 'aaa-list-row', html: '<strong>' + (sel ? '✓ ' : '') + 'calibration v' + v.version + (v.active ? ' (active)' : '') + '</strong><div class="aaa-list-sub">confidence bias ' + signed(v.confidenceBias) + ' · risk bias ' + signed(v.riskBias) + '</div>' });
      row.appendChild(ui.button({ label: sel ? 'Selected' : 'Choose', size: 'sm', variant: sel ? 'secondary' : 'ghost', onClick: () => { scenario.calibrationVersionId = sel ? null : v.id; renderScenario(body, trace, versions, scenario); } }));
      body.appendChild(row);
    });

    body.appendChild(title('Swap in a policy version'));
    if (!arr(versions.policy).length) body.appendChild(empty('No policy versions to choose.'));
    arr(versions.policy).forEach((v) => {
      const sel = scenario.policyVersionId === v.id;
      const row = ui.el('div', { className: 'aaa-list-row', html: '<strong>' + (sel ? '✓ ' : '') + esc(v.name) + ' v' + v.version + ' · ' + esc(v.status) + '</strong>' });
      row.appendChild(ui.button({ label: sel ? 'Selected' : 'Choose', size: 'sm', variant: sel ? 'secondary' : 'ghost', onClick: () => { scenario.policyVersionId = sel ? null : v.id; renderScenario(body, trace, versions, scenario); } }));
      body.appendChild(row);
    });

    body.appendChild(ui.button({ label: 'Run replay', icon: '⏵', variant: 'primary', full: true, onClick: async () => {
      const res = await engine().replay({ traceId: trace.id, actor: actor(), scenario: { calibrationVersionId: scenario.calibrationVersionId, policyVersionId: scenario.policyVersionId } });
      if (!res.ok) { await ui.confirm({ title: 'Could not replay', message: res.message || res.error, confirmLabel: 'OK' }); return; }
      renderResult(body, res);
    } }));
  }

  /** The before/after comparison: decision, KPI deltas, and the links. */
  function renderResult(container, res) {
    const ui = U();
    container.innerHTML = '';
    if (!res || !res.ok) { container.appendChild(empty('No replay result.')); return; }

    container.appendChild(ui.el('div', { className: 'aaa-list-row', html: '<strong>' + esc((res.trace && res.trace.subjectLabel) || res.subjectType) + '</strong><div class="aaa-list-sub">' + (res.anyChange ? 'The chosen versions would change the outcome.' : 'No change under the chosen versions.') + '</div>' }));

    // Original vs replayed recommendation.
    container.appendChild(title('Original vs replayed'));
    const o = res.original || {}, r = res.replayed || {};
    container.appendChild(ui.el('div', { className: 'aaa-list-row', html:
      '<strong>Recommendation</strong><div class="aaa-list-sub">original: ' + decisionStr(o) + '</div><div class="aaa-list-sub">replayed: ' + decisionStr(r) + '</div>' }));

    // KPI delta table.
    container.appendChild(title('KPI impact'));
    arr(res.kpis).forEach((k) => {
      const color = k.changed ? (typeof k.delta === 'number' && k.delta < 0 ? '#EF4444' : '#10B981') : 'var(--muted)';
      container.appendChild(ui.el('div', { className: 'aaa-list-row', html:
        '<strong>' + esc(k.label) + '</strong>' +
        '<div class="aaa-list-sub">original ' + fmt(k.original, k.unit) + ' → <span style="color:' + color + '">replayed ' + fmt(k.replayed, k.unit) + '</span>' +
        (typeof k.delta === 'number' ? ' (' + signed(k.delta) + (k.unit || '') + ')' : '') + ' · ' + esc(k.affectedBy) + '</div>' }));
    });

    // Links back to provenance + governance.
    container.appendChild(title('Provenance & governance'));
    container.appendChild(ui.el('div', { className: 'aaa-list-row', html: '<div class="aaa-list-sub">Trace: ' + esc((res.links && res.links.provenanceTraceId) || '—') +
      ' · governance versions: ' + (arr(res.links && res.links.governanceVersionIds).length || 0) +
      ' · calibration versions: ' + (arr(res.links && res.links.calibrationVersionIds).length || 0) + '</div>' }));
    const link = res.links || {};
    if (provenance() && link.provenanceTraceId && global.AAA_PROVENANCE_UI && global.AAA_PROVENANCE_UI.renderTrace) {
      container.appendChild(ui.button({ label: 'Open provenance trace', size: 'sm', variant: 'secondary', onClick: async () => {
        const tr = await provenance().get(link.provenanceTraceId);
        const s = ui.sheet({ title: 'Provenance', subtitle: 'origin of this decision' });
        document.body.appendChild(s.overlay); global.AAA_PROVENANCE_UI.renderTrace(s.body, tr);
      } }));
    }
    container.appendChild(ui.el('p', { className: 'aaa-voice-hint', text: 'Replay only — no quote, job, customer, outcome, or price was changed. This run is recorded in the audit log.' }));
  }

  function decisionStr(snap) {
    const parts = [];
    if (snap.decision) parts.push('decision ' + esc(snap.decision));
    if (snap.confidence != null) parts.push('confidence ' + snap.confidence);
    if (snap.risk != null) parts.push('risk ' + snap.risk);
    if (snap.bookingLikelihood != null) parts.push('booking ' + snap.bookingLikelihood + '%');
    return parts.length ? parts.join(' · ') : '—';
  }
  function signed(n) { return (Number(n) > 0 ? '+' : '') + Number(n || 0); }

  function open() {
    const ui = U();
    const sheet = ui.sheet({ title: 'Replay Sandbox', subtitle: 'AAA Carpet — what-if simulation, zero writes' });
    document.body.appendChild(sheet.overlay);
    render(sheet.body);
  }

  global.AAA_REPLAY_SANDBOX_UI = { render: render, renderResult: renderResult, renderScenario: renderScenario, open: open };
})(typeof window !== 'undefined' ? window : this);
