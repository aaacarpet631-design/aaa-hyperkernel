/*
 * AAA Estimator — the field quoting screen for the AI Estimator agent.
 *
 * A tech adds rooms (length×width / linear ft / stairs), picks service(s), and
 * the agent prices a draft with a confidence + risk score. The customer-facing
 * RECEIPT (services + totals) is always shown; the INTERNAL cost breakdown
 * (labor/material/margin) is shown ONLY to margin-viewers (VIEW_MARGINS /
 * VIEW_FINANCIALS). Approving attaches the estimate to the selected job through
 * the gateway (human-only, audited) as a needs-review estimate — never final.
 */
;(function (global) {
  'use strict';

  function U() { return global.AAA_UI; }
  function estimator() { return global.AAA_ESTIMATOR; }
  function quote() { return global.AAA_MEASUREMENT_QUOTE; }
  function models() { return global.AAA_MEASUREMENT_MODELS; }
  function data() { return global.AAA_DATA; }
  function rbac() { return global.AAA_RBAC; }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
  function money(v) { const n = Number(v); return isFinite(n) ? '$' + n.toFixed(2) : '—'; }
  function canSeeMargins() { const r = rbac(); return !r || r.can('VIEW_MARGINS') || r.can('VIEW_FINANCIALS'); }
  function canQuote() { const r = rbac(); return !r || r.can('CREATE_QUOTE'); }

  // Module state for the in-progress estimate (rooms picked, services, result).
  const state = { rooms: [], services: [], jobId: null, jobName: null, customerName: null, lastEstimate: null };

  const SEV_COLOR = { high: '#EF4444', medium: '#F59E0B', low: '#10B981' };
  function title(t) { return U().el('h2', { className: 'aaa-section-title', text: t }); }
  function empty(t) { return U().el('p', { className: 'aaa-empty', text: t }); }
  function chip(value, label, color) {
    return U().el('div', { className: 'aaa-chip' }, [
      U().el('span', { className: 'aaa-chip__value', text: String(value), style: { color: color || 'var(--muted)' } }),
      U().el('span', { className: 'aaa-chip__label', text: label }),
      U().el('div', { className: 'aaa-chip__bar', style: { background: color || 'var(--muted)', opacity: '0.85' } })
    ]);
  }

  function render(container) {
    const ui = U();
    container.innerHTML = '';
    if (!canQuote()) {
      container.appendChild(ui.el('div', { className: 'aaa-list-row', html: '<strong>🔒 Quoting is restricted</strong><div class="aaa-list-sub">Your role cannot create quotes.</div>' }));
      return;
    }
    if (!estimator() || !quote()) { container.appendChild(empty('Estimator unavailable.')); return; }

    container.appendChild(ui.el('div', { className: 'aaa-list-row', html: '<strong>📐 AI Estimator</strong><div class="aaa-list-sub">Add rooms, pick services — the agent drafts a priced quote you review and approve.</div>' }));

    // Job context (optional; required to attach the estimate).
    container.appendChild(ui.button({ label: state.jobId ? ('Job: ' + (state.jobName || state.jobId)) : 'Attach to a job (optional)', icon: '🧰', variant: 'secondary', full: true, onClick: () => pickJob(container) }));

    // Rooms.
    container.appendChild(title('Rooms (' + state.rooms.length + ')'));
    if (!state.rooms.length) container.appendChild(empty('No rooms yet. Add at least one to estimate.'));
    state.rooms.forEach((s, idx) => {
      const row = ui.el('div', { className: 'aaa-list-row', html:
        '<strong>' + esc(s.roomName) + '</strong><div class="aaa-list-sub">' +
        [s.squareFeet ? s.squareFeet + ' ft²' : null, s.linearFeet ? s.linearFeet + ' linear ft' : null, s.stairsCount ? s.stairsCount + ' stairs' : null].filter(Boolean).join(' · ') + '</div>' });
      row.appendChild(ui.button({ label: 'Remove', size: 'sm', variant: 'ghost', onClick: () => { state.rooms.splice(idx, 1); state.lastEstimate = null; render(container); } }));
      container.appendChild(row);
    });
    container.appendChild(ui.button({ label: 'Add room', icon: '➕', variant: 'secondary', full: true, onClick: () => addRoom(container) }));

    // Services.
    container.appendChild(title('Services'));
    quote().serviceOptions().forEach((opt) => {
      const on = state.services.indexOf(opt.id) !== -1;
      container.appendChild(ui.button({ label: (on ? '☑ ' : '☐ ') + opt.label, size: 'sm', variant: on ? 'primary' : 'secondary', full: true,
        onClick: () => { const i = state.services.indexOf(opt.id); if (i === -1) state.services.push(opt.id); else state.services.splice(i, 1); state.lastEstimate = null; render(container); } }));
    });

    // Run.
    container.appendChild(ui.button({ label: 'Run AI estimate', icon: '✨', variant: 'primary', full: true, onClick: async () => {
      if (!state.rooms.length) return;
      const est = await estimator().recommend({ sessions: state.rooms, services: state.services.length ? state.services : null, jobId: state.jobId, customerName: state.customerName });
      state.lastEstimate = est;
      render(container);
    } }));

    if (state.lastEstimate) renderResult(container, state.lastEstimate, { canSeeMargins: canSeeMargins() });
  }

  // Render an estimate result. Exposed for testability.
  function renderResult(container, est, opts) {
    const ui = U();
    const o = opts || {};
    if (!est || !est.ok) { container.appendChild(empty(est && est.message ? est.message : 'Could not estimate — add a room and a service.')); return; }

    container.appendChild(title('Estimate'));
    container.appendChild(ui.el('section', { className: 'aaa-summary' }, [
      chip(est.confidence, 'Confidence', est.confidence >= 70 ? '#10B981' : '#F59E0B'),
      chip(est.risk, 'Risk', SEV_COLOR[est.severity] || '#A1A1AA'),
      chip(est.receipt.estimateRange, 'Range', '#3B82F6')
    ]));
    container.appendChild(ui.el('div', { className: 'aaa-list-row', html: '<div class="aaa-list-sub">🤖 ' + esc(est.reasoning) + '</div>' }));
    if (est.inferredServices) container.appendChild(ui.el('div', { className: 'aaa-list-row', html: '<div class="aaa-list-sub" style="color:#F59E0B">Service type was inferred — confirm it’s right.</div>' }));

    // Customer-facing receipt (always shown).
    container.appendChild(title('Customer Receipt'));
    (est.receipt.items || []).forEach((it) => container.appendChild(ui.el('div', { className: 'aaa-list-row', html: '<strong>' + esc(it.description) + '</strong><div class="aaa-list-sub">' + money(it.amount) + '</div>' })));
    container.appendChild(ui.el('div', { className: 'aaa-list-row', html: '<strong>Total: ' + money(est.receipt.total) + '</strong><div class="aaa-list-sub">' + esc(est.receipt.note) + '</div>' }));

    // Internal cost breakdown — margin-viewers only.
    if (o.canSeeMargins) {
      const q = est.quote;
      container.appendChild(title('Internal (cost — not shown to customer)'));
      container.appendChild(ui.el('section', { className: 'aaa-summary' }, [
        chip(money(q._laborTotal), 'Labor', '#F59E0B'),
        chip(money(q._materialTotal), 'Material', '#F59E0B'),
        chip(money(q.total - q._laborTotal - q._materialTotal), 'Gross', '#10B981')
      ]));
    }

    if (est.risks && est.risks.length) {
      container.appendChild(title('Risk factors'));
      est.risks.forEach((r) => container.appendChild(ui.el('div', { className: 'aaa-list-row', html: '<div class="aaa-list-sub">• ' + esc(r) + '</div>' })));
    }

    // Approve (human-gated) — only meaningful with a job selected.
    container.appendChild(ui.button({ label: state.jobId ? 'Approve & attach to job' : 'Select a job to attach', icon: '✅', variant: 'primary', full: true, onClick: async () => {
      if (!state.jobId) { pickJob(container); return; }
      const ok = await ui.confirm({ title: 'Attach estimate to job?', message: est.services.join(', ') + ' · ' + est.receipt.estimateRange + '. This adds a needs-review estimate to the job. It does not finalize the customer price.', confirmLabel: 'Attach' });
      if (!ok) return;
      const actor = (rbac() && rbac().label && rbac().label()) || 'owner';
      const res = await estimator().accept({ jobId: state.jobId, estimate: est, sessionIds: state.rooms.map((s) => s.id), actor: actor });
      await ui.confirm({ title: res.ok ? 'Attached' : 'Could not attach', message: res.ok ? (res.entries.length + ' estimate line(s) added for review.') : (res.message || res.error), confirmLabel: 'OK' });
    } }));
    container.appendChild(ui.el('p', { className: 'aaa-voice-hint', text: 'Draft only. The AI never finalizes a price — a person approves every estimate.' }));
  }

  // ---- sub-flows (use document; not exercised by the render tests) --------
  function addRoom(container) {
    const ui = U();
    const s = ui.sheet({ title: 'Add room', size: 'sm' });
    document.body.appendChild(s.overlay);
    const name = ui.el('input', { className: 'aaa-input', attrs: { type: 'text', placeholder: 'Room name (e.g. Living Room)' } });
    const len = ui.el('input', { className: 'aaa-input', attrs: { type: 'number', step: '0.1', inputmode: 'decimal', placeholder: 'Length (ft)' } });
    const wid = ui.el('input', { className: 'aaa-input', attrs: { type: 'number', step: '0.1', inputmode: 'decimal', placeholder: 'Width (ft)' } });
    const lin = ui.el('input', { className: 'aaa-input', attrs: { type: 'number', step: '0.1', inputmode: 'decimal', placeholder: 'Linear ft (repairs/seams)' } });
    const stairs = ui.el('input', { className: 'aaa-input', attrs: { type: 'number', step: '1', inputmode: 'numeric', placeholder: 'Stairs count' } });
    s.body.appendChild(ui.el('div', { className: 'aaa-form' }, [name, len, wid, lin, stairs]));
    s.body.appendChild(ui.button({ label: 'Add', variant: 'primary', full: true, onClick: () => {
      const sess = models().newSession({ roomName: name.value || 'Room', length: len.value || null, width: wid.value || null, linearFeet: lin.value || null, stairsCount: stairs.value || 0, source: 'manual' });
      const v = models().validateSession(sess, { existing: state.rooms });
      if (!v.ok) { s.body.appendChild(ui.el('p', { className: 'aaa-empty', text: v.errors.join(' ') })); return; }
      state.rooms.push(sess); state.lastEstimate = null; s.close(); render(container);
    } }));
    s.body.appendChild(ui.button({ label: 'Cancel', variant: 'ghost', full: true, onClick: () => s.close() }));
  }

  async function pickJob(container) {
    const ui = U();
    const s = ui.sheet({ title: 'Attach to job', size: 'sm' });
    document.body.appendChild(s.overlay);
    let jobs = [];
    try { jobs = (await data().listJobs()).filter((j) => j.currentState !== 'CLOSED'); } catch (_) {}
    if (state.jobId) s.body.appendChild(ui.button({ label: 'Clear job', variant: 'ghost', full: true, onClick: () => { state.jobId = null; state.jobName = null; state.customerName = null; s.close(); render(container); } }));
    if (!jobs.length) s.body.appendChild(empty('No active jobs.'));
    jobs.forEach((j) => s.body.appendChild(ui.button({ label: j.customerName || j.id, variant: state.jobId === j.id ? 'primary' : 'secondary', full: true, onClick: () => {
      state.jobId = j.id; state.jobName = j.customerName || j.id; state.customerName = j.customerName || null; s.close(); render(container);
    } })));
    s.body.appendChild(ui.button({ label: 'Cancel', variant: 'ghost', full: true, onClick: () => s.close() }));
  }

  function open() {
    const ui = U();
    const sheet = ui.sheet({ title: 'AI Estimator', subtitle: 'AAA Carpet — field quoting' });
    document.body.appendChild(sheet.overlay);
    render(sheet.body);
  }

  global.AAA_ESTIMATOR_UI = { render: render, renderResult: renderResult, open: open, _state: state };
})(typeof window !== 'undefined' ? window : this);
