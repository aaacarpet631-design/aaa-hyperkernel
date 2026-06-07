/*
 * AAA Governed Learning Loop — owner-only proposal review.
 *
 * Lists improvement proposals the system discovered, each with its evidence,
 * confidence, risk score, affected systems, expected KPI impact, rollback path,
 * and links (outcome events, provenance trace, governance version, replay
 * simulation). The owner can simulate (Replay Sandbox), then approve (creates a
 * governance draft — still needs activation) or reject (retained as learning).
 * Nothing is applied here. Gated on MANAGE_GOVERNANCE (owner).
 */
;(function (global) {
  'use strict';

  function U() { return global.AAA_UI; }
  function E() { return global.AAA_PROPOSAL_ENGINE; }
  function rbac() { return global.AAA_RBAC; }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
  function actor() { return (rbac() && rbac().label && rbac().label()) || 'owner'; }
  const STATUS = { pending: '#F59E0B', approved: '#10B981', rejected: '#71717A' };

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
      container.appendChild(ui.el('div', { className: 'aaa-list-row', html: '<strong>🔒 Learning proposals are owner-only</strong><div class="aaa-list-sub">Signed in as ' + esc(rbac().label()) + '. Governing improvements is restricted to the owner.</div>' }));
      return;
    }
    if (!E()) { container.appendChild(empty('Proposal engine unavailable.')); return; }

    container.appendChild(ui.spinner('Loading proposals…'));
    let proposals;
    try { proposals = await E().list(); } catch (err) { container.innerHTML = ''; container.appendChild(ui.el('div', { className: 'aaa-list-row', html: '<strong>Could not load proposals</strong><div class="aaa-list-sub">' + esc((err && err.message) || err) + '</div>' })); return; }
    container.innerHTML = '';

    const pending = proposals.filter((p) => p.status === 'pending');
    container.appendChild(ui.el('section', { className: 'aaa-summary' }, [
      chip(pending.length, 'Pending', pending.length ? '#F59E0B' : '#10B981'),
      chip(proposals.filter((p) => p.status === 'approved').length, 'Approved', '#10B981'),
      chip(proposals.filter((p) => p.status === 'rejected').length, 'Rejected (learning)', '#71717A')
    ]));

    container.appendChild(ui.button({ label: 'Discover new proposals', icon: '🔁', variant: 'secondary', full: true, onClick: async () => { await E().generate(); await render(container); } }));

    container.appendChild(title('Proposals'));
    if (!proposals.length) container.appendChild(empty('No proposals yet. The system files them as durable patterns emerge.'));
    proposals.slice(0, 20).forEach((p) => {
      const row = ui.el('button', { className: 'aaa-list-row', attrs: { type: 'button', style: 'width:100%;text-align:left;cursor:pointer' }, html:
        '<strong style="color:' + (STATUS[p.status] || '#A1A1AA') + '">' + esc(p.title) + '</strong>' +
        '<div class="aaa-list-sub">' + esc(p.status) + ' · confidence ' + p.confidence + ' · risk ' + p.riskScore + ' · ' + esc(p.sourceKind) + '</div>' });
      row.addEventListener('click', () => openProposal(p.id));
      container.appendChild(row);
    });

    container.appendChild(ui.el('p', { className: 'aaa-voice-hint', text: 'The system proposes; you decide. Approving creates a governance draft you still activate — nothing reaches production automatically, and every rejection is kept as learning.' }));
  }

  function renderProposal(container, p) {
    const ui = U();
    container.innerHTML = '';
    if (!p) { container.appendChild(empty('Proposal not found.')); return; }
    container.appendChild(ui.el('div', { className: 'aaa-list-row', html: '<strong>' + esc(p.title) + '</strong><div class="aaa-list-sub">' + esc(p.status) + ' · ' + esc(p.sourceKind) + '</div>' }));
    container.appendChild(ui.el('section', { className: 'aaa-summary' }, [
      chip(p.confidence, 'Confidence', '#3B82F6'),
      chip(p.riskScore, 'Risk', p.riskScore >= 60 ? '#EF4444' : p.riskScore >= 35 ? '#F59E0B' : '#10B981'),
      chip((p.evidence && p.evidence.sample) || 0, 'Evidence', '#A1A1AA')
    ]));

    container.appendChild(title('What it proposes'));
    const ch = p.proposedChange || {};
    container.appendChild(ui.el('div', { className: 'aaa-list-row', html: '<div class="aaa-list-sub">Change governed <strong>' + esc(ch.artifactType) + '</strong> “' + esc(ch.name) + '” → ' + esc(JSON.stringify(ch.content)) + '</div>' }));
    container.appendChild(ui.el('div', { className: 'aaa-list-row', html:
      '<div class="aaa-list-sub">📈 ' + esc(p.expectedKpiImpact || '') + '</div>' +
      '<div class="aaa-list-sub">🧩 Affects: ' + esc((p.affectedSystems || []).join(', ')) + '</div>' +
      '<div class="aaa-list-sub">↩ Rollback: ' + esc(p.rollbackPath) + '</div>' }));

    container.appendChild(title('Evidence & links'));
    container.appendChild(ui.el('div', { className: 'aaa-list-row', html:
      '<div class="aaa-list-sub">' + esc(JSON.stringify(p.evidence || {})) + '</div>' +
      '<div class="aaa-list-sub">' + (p.links.outcomeEventIds || []).length + ' outcome event(s) · ' + (p.links.provenanceTraceIds || []).length + ' provenance trace · ' + (p.links.governanceVersionIds || []).length + ' governance version · ' + (p.links.replaySimulationId ? 'replay linked' : 'no replay yet') + '</div>' }));

    // Simulation result.
    if (p.simulation && p.simulation.available) {
      container.appendChild(title('Replay simulation (no production change)'));
      (p.simulation.kpis || []).filter((k) => k.changed).forEach((k) => container.appendChild(ui.el('div', { className: 'aaa-list-row', html: '<div class="aaa-list-sub">' + esc(k.label) + ': ' + esc(String(k.original)) + esc(k.unit || '') + ' → ' + esc(String(k.replayed)) + esc(k.unit || '') + '</div>' })));
      if (!(p.simulation.kpis || []).some((k) => k.changed)) container.appendChild(ui.el('div', { className: 'aaa-list-row', html: '<div class="aaa-list-sub">No KPI change in the replayed trace.</div>' }));
    }

    // Owner controls.
    if (p.status === 'pending') {
      container.appendChild(title('Your decision'));
      const actions = ui.el('div', { className: 'aaa-form', style: { display: 'flex', gap: '8px', flexWrap: 'wrap' } });
      actions.appendChild(ui.button({ label: 'Simulate', size: 'sm', variant: 'secondary', onClick: async () => { await E().simulate(p.id, { actor: actor() }); renderProposal(container, await E().get(p.id)); } }));
      actions.appendChild(ui.button({ label: 'Approve → governance', size: 'sm', variant: 'primary', onClick: async () => {
        const ok = await ui.confirm({ title: 'Approve this proposal?', message: 'This creates a governance draft you still activate in the Registry. Nothing changes in production yet.', confirmLabel: 'Approve' });
        if (!ok) return;
        const res = await E().approve(p.id, { actor: actor() });
        if (!res.ok) await ui.confirm({ title: 'Not approved', message: res.message || res.error, confirmLabel: 'OK' });
        else await ui.confirm({ title: 'Approved', message: res.note, confirmLabel: 'OK' });
        renderProposal(container, await E().get(p.id));
      } }));
      actions.appendChild(ui.button({ label: 'Reject', size: 'sm', variant: 'ghost', onClick: async () => { await E().reject(p.id, { actor: actor(), reason: 'Rejected by owner' }); renderProposal(container, await E().get(p.id)); } }));
      container.appendChild(actions);
    } else {
      container.appendChild(ui.el('div', { className: 'aaa-list-row', html: '<strong>Decision: ' + esc(p.status) + '</strong><div class="aaa-list-sub">by ' + esc(p.decisionBy || '') + (p.rejectionReason ? ' · ' + esc(p.rejectionReason) : '') + (p.links.governanceVersionIds && p.links.governanceVersionIds.length ? ' · governance draft created' : '') + '</div>' }));
    }
  }

  async function openProposal(id) { const ui = U(); const s = ui.sheet({ title: 'Learning proposal', subtitle: 'AAA Carpet — governed improvement' }); document.body.appendChild(s.overlay); renderProposal(s.body, await E().get(id)); }
  function open() { const ui = U(); const s = ui.sheet({ title: 'Learning Proposals', subtitle: 'AAA Carpet — governed learning loop' }); document.body.appendChild(s.overlay); render(s.body); }

  global.AAA_PROPOSAL_REVIEW_UI = { render: render, renderProposal: renderProposal, open: open };
})(typeof window !== 'undefined' ? window : this);
