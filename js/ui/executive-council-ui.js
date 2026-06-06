/*
 * AAA Executive Council — owner-only high-impact decision review.
 *
 * Submit a high-impact proposal (price change / ad spend / hire / large quote),
 * see the five executive seats deliberate (CEO + Finance/Risk/Sales/Operations),
 * the surfaced objections, the confidence + risk score, and the CEO's advisory
 * recommendation — then accept or override (audited). The council never acts on
 * its own. Gated on VIEW_FINANCIALS (owner).
 */
;(function (global) {
  'use strict';

  function U() { return global.AAA_UI; }
  function C() { return global.AAA_EXECUTIVE_COUNCIL; }
  function rbac() { return global.AAA_RBAC; }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
  function actor() { return (rbac() && rbac().label && rbac().label()) || 'owner'; }
  const STANCE = { support: '#10B981', caution: '#F59E0B', oppose: '#EF4444' };
  const DECISION = { approve: '#10B981', revise: '#F59E0B', reject: '#EF4444' };

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
    if (rbac() && !rbac().can('VIEW_FINANCIALS')) {
      container.appendChild(ui.el('div', { className: 'aaa-list-row', html: '<strong>🔒 The Executive Council is owner-only</strong><div class="aaa-list-sub">Signed in as ' + esc(rbac().label()) + '. It reviews money decisions, so it is owner-only.</div>' }));
      return;
    }
    if (!C()) { container.appendChild(empty('Executive Council unavailable.')); return; }

    container.appendChild(ui.spinner('Loading the executive council…'));
    let reviews;
    try { reviews = await C().list(); } catch (err) { container.innerHTML = ''; container.appendChild(ui.el('div', { className: 'aaa-list-row', html: '<strong>Could not load the council</strong><div class="aaa-list-sub">' + esc((err && err.message) || err) + '</div>' })); return; }
    container.innerHTML = '';

    container.appendChild(title('Submit a high-impact decision'));
    const types = (C().TYPES || []);
    const form = ui.el('div', { className: 'aaa-form', style: { display: 'flex', gap: '8px', flexWrap: 'wrap' } });
    types.slice(0, 7).forEach((ty) => form.appendChild(ui.button({ label: ty.replace(/_/g, ' '), size: 'sm', variant: 'secondary', onClick: async () => {
      const res = await C().submit({ type: ty, title: ty.replace(/_/g, ' '), amount: null, detail: ty === 'price_change' ? { direction: 'down' } : {} }, { actor: actor() });
      if (res.ok) openReview(res.review.id); else await ui.confirm({ title: 'Could not submit', message: res.error, confirmLabel: 'OK' });
      await render(container);
    } })));
    container.appendChild(form);

    container.appendChild(title('Reviews (' + reviews.length + ')'));
    if (!reviews.length) container.appendChild(empty('No executive reviews yet. Submit a decision above.'));
    reviews.slice(0, 12).forEach((r) => {
      const row = ui.el('button', { className: 'aaa-list-row', attrs: { type: 'button', style: 'width:100%;text-align:left;cursor:pointer' }, html:
        '<strong style="color:' + (DECISION[r.decision] || '#A1A1AA') + '">' + esc(r.decision) + ' · ' + esc(r.title) + '</strong>' +
        '<div class="aaa-list-sub">confidence ' + r.confidence + ' · risk ' + r.riskScore + ' · ' + (r.objections ? r.objections.length : 0) + ' objection(s) · ' + esc(r.status) + (r.overridden ? ' · owner overrode' : '') + '</div>' });
      row.addEventListener('click', () => openReview(r.id));
      container.appendChild(row);
    });

    container.appendChild(ui.el('p', { className: 'aaa-voice-hint', text: 'The council advises; you decide. It changes no price, budget, or record — every decision is yours and audited.' }));
  }

  function renderReview(container, r) {
    const ui = U();
    container.innerHTML = '';
    if (!r) { container.appendChild(empty('Review not found.')); return; }
    container.appendChild(ui.el('div', { className: 'aaa-list-row', html: '<strong>' + esc(r.title) + '</strong><div class="aaa-list-sub">CEO recommendation: <span style="color:' + (DECISION[r.decision] || '#A1A1AA') + '">' + esc(r.decision) + '</span></div>' }));
    container.appendChild(ui.el('section', { className: 'aaa-summary' }, [
      chip(r.confidence, 'Confidence', '#3B82F6'),
      chip(r.riskScore, 'Risk', r.riskScore >= 60 ? '#EF4444' : r.riskScore >= 35 ? '#F59E0B' : '#10B981'),
      chip(r.objections ? r.objections.length : 0, 'Objections', (r.objections && r.objections.length) ? '#F59E0B' : '#10B981')
    ]));

    container.appendChild(title('Around the table'));
    (r.positions || []).forEach((p) => container.appendChild(ui.el('div', { className: 'aaa-list-row', html:
      '<strong style="color:' + (STANCE[p.stance] || '#A1A1AA') + '">' + esc(p.seat) + ' — ' + esc(p.stance) + ' (' + p.confidence + ')</strong>' +
      '<div class="aaa-list-sub">' + esc(p.rationale || '') + (p.objection ? ' · ⚠ ' + esc(p.objection) : '') + '</div>' })));

    if (r.objections && r.objections.length) {
      container.appendChild(title('Objections to resolve'));
      r.objections.forEach((o) => container.appendChild(ui.el('div', { className: 'aaa-list-row', html: '<strong>' + esc(o.seat) + '</strong><div class="aaa-list-sub">' + esc(o.objection) + '</div>' })));
    }

    if (r.status !== 'reviewed') {
      container.appendChild(title('Your decision'));
      const actions = ui.el('div', { className: 'aaa-form', style: { display: 'flex', gap: '8px', flexWrap: 'wrap' } });
      actions.appendChild(ui.button({ label: 'Accept (' + r.decision + ')', size: 'sm', variant: 'primary', onClick: () => act(r.id, r.decision, container) }));
      ['approve', 'revise', 'reject'].filter((d) => d !== r.decision).forEach((d) => actions.appendChild(ui.button({ label: 'Override → ' + d, size: 'sm', variant: 'ghost', onClick: () => act(r.id, d, container) })));
      container.appendChild(actions);
    } else {
      container.appendChild(ui.el('div', { className: 'aaa-list-row', html: '<strong>Owner decision: ' + esc(r.ownerDecision) + (r.overridden ? ' (overrode the council)' : '') + '</strong><div class="aaa-list-sub">by ' + esc(r.approvedBy || '') + '</div>' }));
    }
  }

  async function act(id, decision, container) {
    const ui = U();
    const res = await C().act(id, { actor: actor(), decision: decision });
    if (!res.ok) await ui.confirm({ title: 'Not recorded', message: res.message || res.error, confirmLabel: 'OK' });
    renderReview(container, await C().get(id));
  }
  async function openReview(id) { const ui = U(); const s = ui.sheet({ title: 'Executive Review', subtitle: 'AAA Carpet — C-suite deliberation' }); document.body.appendChild(s.overlay); renderReview(s.body, await C().get(id)); }

  function open() { const ui = U(); const s = ui.sheet({ title: 'Executive Council', subtitle: 'AAA Carpet — high-impact decision review' }); document.body.appendChild(s.overlay); render(s.body); }

  global.AAA_EXECUTIVE_COUNCIL_UI = { render: render, renderReview: renderReview, open: open };
})(typeof window !== 'undefined' ? window : this);
