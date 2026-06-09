/*
 * AAA Model Governance — owner-only panel for the NVIDIA Model Adapter Layer.
 *
 * Lists the registered external models (Nemotron Base / Instruct / Reward) with
 * their governance status, the owner-confirmed modelId (and a "verify" flag when
 * unconfirmed), enablement toggle, and operational metrics (last call, error rate,
 * average latency, usage by agent). The owner can provision a model into the
 * Governance Registry, enable/disable it, and open its provenance / audit trail.
 * Read-only over the business; every control routes through the gateway/registry.
 * Gated on MANAGE_GOVERNANCE (owner).
 */
;(function (global) {
  'use strict';

  function U() { return global.AAA_UI; }
  function R() { return global.AAA_GOVERNED_MODEL_ROUTER; }
  function REG() { return global.AAA_MODEL_REGISTRY; }
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
      container.appendChild(ui.el('div', { className: 'aaa-list-row', html: '<strong>🔒 Model Governance is owner-only</strong><div class="aaa-list-sub">Signed in as ' + esc(rbac().label()) + '. Models are intelligence engines — the owner stays the authority.</div>' }));
      return;
    }
    if (!R() || !REG()) { container.appendChild(empty('Model adapter layer unavailable.')); return; }

    container.appendChild(ui.spinner('Loading model governance…'));
    let rows;
    try {
      rows = [];
      for (const m of REG().list()) rows.push({ meta: m, status: await R().status(m.key), cand: REG().providerCandidates(m.key) });
    } catch (err) { container.innerHTML = ''; container.appendChild(ui.el('div', { className: 'aaa-list-row', html: '<strong>Could not load model governance</strong><div class="aaa-list-sub">' + esc((err && err.message) || err) + '</div>' })); return; }
    container.innerHTML = '';

    const live = rows.filter((r) => r.status.governed && r.status.enabled).length;
    container.appendChild(ui.el('section', { className: 'aaa-summary' }, [
      chip(live, 'Live models', live ? '#10B981' : '#71717A'),
      chip(rows.length, 'Registered', '#3B82F6'),
      chip('NVIDIA', 'Provider', '#76B900')
    ]));

    container.appendChild(title('NVIDIA Nemotron models'));
    rows.forEach((r) => {
      const st = r.status, m = r.meta;
      const state = !st.governed ? 'not governed' : (st.enabled ? 'LIVE' : 'governed · disabled');
      const stateColor = st.governed && st.enabled ? '#10B981' : st.governed ? '#F59E0B' : '#71717A';
      const mid = st.modelId || r.cand.modelId;
      const verifyNote = st.governed ? (st.verifiedId ? '' : ' · ⚠ verify id') : ' · ⚠ unverified id';
      const metrics = st.metrics || {};
      const row = ui.el('div', { className: 'aaa-list-row', html:
        '<strong style="color:' + stateColor + '">' + esc(m.label) + ' — ' + esc(state) + '</strong>' +
        '<div class="aaa-list-sub">' + esc(m.variant) + ' · risk ' + esc(m.riskTier) + ' · ' + esc(mid) + verifyNote + (m.customerFacing === false ? ' · not customer-facing' : '') + '</div>' +
        '<div class="aaa-list-sub">calls ' + (metrics.calls || 0) + ' · errors ' + (metrics.errorRate == null ? '—' : metrics.errorRate + '%') + ' · avg ' + (metrics.avgLatencyMs == null ? '—' : metrics.avgLatencyMs + 'ms') + ' · last ' + (metrics.lastAt ? esc(metrics.lastAt) : 'never') + '</div>' +
        '<div class="aaa-list-sub">tasks: ' + esc(m.allowedTasks.join(', ')) + '</div>' });

      // Controls.
      if (!st.governed) {
        row.appendChild(ui.button({ label: 'Provision → Governance', size: 'sm', variant: 'secondary', onClick: async () => {
          const res = await R().provision(m.key, { actor: actor() });
          await ui.confirm({ title: res.ok ? 'Provisioned' : 'Not provisioned', message: res.ok ? res.note : (res.message || res.error), confirmLabel: 'OK' });
          await render(container);
        } }));
      } else {
        row.appendChild(ui.button({ label: st.enabled ? 'Disable' : 'Enable', size: 'sm', variant: st.enabled ? 'ghost' : 'primary', onClick: async () => {
          const res = await R().setEnabled(m.key, !st.enabled, { actor: actor() });
          if (!res.ok) await ui.confirm({ title: 'Not changed', message: res.message || res.error, confirmLabel: 'OK' });
          await render(container);
        } }));
      }
      if (Object.keys(metrics.byAgent || {}).length) row.appendChild(ui.el('div', { className: 'aaa-list-sub', html: 'by agent: ' + esc(Object.keys(metrics.byAgent).map((a) => a + ' (' + metrics.byAgent[a] + ')').join(', ')) }));
      container.appendChild(row);
    });

    container.appendChild(ui.el('p', { className: 'aaa-voice-hint', text: 'NVIDIA models are intelligence engines, not authority engines. Every call is governed, audited, and provenance-linked; output is advisory — you decide. No model acts on pricing, messaging, privacy, accounting, or calibration.' }));
  }

  function open() {
    const ui = U();
    const sheet = ui.sheet({ title: 'Model Governance', subtitle: 'AAA Carpet — NVIDIA Nemotron adapter layer' });
    document.body.appendChild(sheet.overlay);
    render(sheet.body);
  }

  global.AAA_MODEL_GOVERNANCE_UI = { render: render, open: open };
})(typeof window !== 'undefined' ? window : this);
