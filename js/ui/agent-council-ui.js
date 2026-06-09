/*
 * AAA Supervisor Council — owner-only deliberation dashboard.
 *
 * A leaderboard of the agents, a "convene on a quote" action, and the visible
 * meeting: each seat's stance + confidence + concern, the confidence-weighted
 * tally, the disagreement score, and the council's advisory decision — which the
 * owner accepts or overrides (audited). The council never acts on its own.
 */
;(function (global) {
  'use strict';

  function U() { return global.AAA_UI; }
  function council() { return global.AAA_AGENT_COUNCIL; }
  function quotes() { return global.AAA_QUOTES; }
  function rbac() { return global.AAA_RBAC; }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

  const STANCE = { approve: { icon: '✅', color: '#10B981' }, revise: { icon: '🟠', color: '#F59E0B' }, reject: { icon: '⛔', color: '#EF4444' }, abstain: { icon: '➖', color: '#71717A' }, no_quorum: { icon: '❔', color: '#A1A1AA' } };

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
      container.appendChild(ui.el('div', { className: 'aaa-list-row', html: '<strong>🔒 The Council is owner-only</strong><div class="aaa-list-sub">Signed in as ' + esc(rbac().label()) + '. It deliberates over margins, so it is restricted to the owner.</div>' }));
      return;
    }
    if (!council()) { container.appendChild(empty('Council unavailable.')); return; }

    container.appendChild(ui.spinner('Gathering the council…'));
    let board, sessions, quoteList;
    try {
      board = await council().leaderboard();
      sessions = await council().list();
      quoteList = quotes() ? (await quotes().list()).filter((q) => ['ready', 'reviewed', 'sent', 'follow_up_due'].indexOf(q.status) !== -1).slice(0, 8) : [];
    } catch (err) { container.innerHTML = ''; container.appendChild(ui.el('div', { className: 'aaa-list-row', html: '<strong>Could not load the council</strong><div class="aaa-list-sub">' + esc((err && err.message) || err) + '</div>' })); return; }
    container.innerHTML = '';

    // Leaderboard.
    container.appendChild(title('Agent Leaderboard'));
    board.forEach((a) => container.appendChild(ui.el('div', { className: 'aaa-list-row', html:
      '<strong>' + esc(a.title) + '</strong><div class="aaa-list-sub">' +
      'accuracy ' + (a.accuracyPct != null ? a.accuracyPct + '%' : '—') + ' · ' + a.decisions + ' scored decisions · ' + a.councilVotes + ' council votes' +
      (a.avgCouncilConfidence != null ? ' · avg conf ' + a.avgCouncilConfidence : '') + '</div>' })));

    // Convene.
    container.appendChild(title('Convene on a quote'));
    if (!quoteList.length) container.appendChild(empty('No quotes awaiting a council review.'));
    quoteList.forEach((q) => {
      const row = ui.el('div', { className: 'aaa-list-row', html: '<strong>' + esc(q.customerName || q.id) + '</strong><div class="aaa-list-sub">' + esc(q.status) + (q.marginPct != null ? ' · margin ' + q.marginPct + '%' : '') + (q.risk != null ? ' · risk ' + q.risk : '') + '</div>' });
      row.appendChild(ui.button({ label: 'Convene council', size: 'sm', variant: 'primary', onClick: async () => {
        const res = await council().conveneOnQuote(q.id);
        if (res.ok) openMeeting(res.session.id); else await ui.confirm({ title: 'Could not convene', message: res.error, confirmLabel: 'OK' });
        await render(container);
      } }));
      container.appendChild(row);
    });

    // Recent sessions.
    container.appendChild(title('Recent Meetings (' + sessions.length + ')'));
    if (!sessions.length) container.appendChild(empty('No council meetings yet. Convene one above.'));
    sessions.slice(0, 10).forEach((s) => {
      const st = STANCE[s.decision] || STANCE.abstain;
      const row = ui.el('button', { className: 'aaa-list-row', attrs: { type: 'button', style: 'width:100%;text-align:left;cursor:pointer' }, html:
        '<strong style="color:' + st.color + '">' + st.icon + ' ' + esc(s.decision) + ' · ' + esc(s.customerName || s.quoteId) + '</strong>' +
        '<div class="aaa-list-sub">confidence ' + s.decisionConfidence + ' · disagreement ' + s.disagreement + '% · ' + esc(s.status) + (s.overridden ? ' · owner overrode → ' + esc(s.ownerDecision) : '') + '</div>' });
      row.addEventListener('click', () => openMeeting(s.id));
      container.appendChild(row);
    });

    container.appendChild(ui.el('p', { className: 'aaa-voice-hint', text: 'The council recommends; you decide. It changes no price, quote, or customer record — every decision is yours and audited.' }));
  }

  /** The visible meeting: every seat's position + the tally + owner controls. */
  function renderMeeting(container, s) {
    const ui = U();
    container.innerHTML = '';
    if (!s) { container.appendChild(empty('Meeting not found.')); return; }
    const dst = STANCE[s.decision] || STANCE.abstain;

    container.appendChild(ui.el('div', { className: 'aaa-list-row', html: '<strong>' + esc(s.customerName || s.quoteId) + '</strong><div class="aaa-list-sub">Council decision: <span style="color:' + dst.color + '">' + dst.icon + ' ' + esc(s.decision) + '</span></div>' }));
    container.appendChild(ui.el('section', { className: 'aaa-summary' }, [
      chip(s.decisionConfidence, 'Confidence', '#3B82F6'),
      chip(s.disagreement + '%', 'Disagreement', s.disagreement >= 50 ? '#EF4444' : s.disagreement >= 25 ? '#F59E0B' : '#10B981'),
      chip(s.votingCount, 'Voting', '#A1A1AA')
    ]));

    container.appendChild(title('Around the table'));
    (s.positions || []).forEach((p) => {
      const st = STANCE[p.stance] || STANCE.abstain;
      container.appendChild(ui.el('div', { className: 'aaa-list-row', html:
        '<strong style="color:' + st.color + '">' + st.icon + ' ' + esc(p.title) + ' — ' + esc(p.stance) + '</strong>' +
        '<div class="aaa-list-sub">confidence ' + p.confidence + (p.trackScore != null ? ' · track ' + Math.round(p.trackScore * 100) + '%' : '') + (p.concern ? ' · ⚠ ' + esc(p.concern) : '') + '</div>' }));
    });
    container.appendChild(ui.el('div', { className: 'aaa-list-row', html: '<div class="aaa-list-sub">Weighted tally — approve ' + s.tally.approve + ' · revise ' + s.tally.revise + ' · reject ' + s.tally.reject + '</div>' }));

    // Owner controls.
    if (s.status !== 'reviewed') {
      container.appendChild(title('Your decision'));
      const actor = (rbac() && rbac().label && rbac().label()) || 'owner';
      const actions = ui.el('div', { className: 'aaa-form', style: { display: 'flex', gap: '8px', flexWrap: 'wrap' } });
      actions.appendChild(ui.button({ label: 'Accept (' + s.decision + ')', size: 'sm', variant: 'primary', onClick: () => act(s.id, s.decision, container) }));
      ['approve', 'revise', 'reject'].filter((d) => d !== s.decision).forEach((d) => actions.appendChild(ui.button({ label: 'Override → ' + d, size: 'sm', variant: 'ghost', onClick: () => act(s.id, d, container) })));
      container.appendChild(actions);
    } else {
      container.appendChild(ui.el('div', { className: 'aaa-list-row', html: '<strong>Owner decision: ' + esc(s.ownerDecision) + (s.overridden ? ' (overrode the council)' : '') + '</strong><div class="aaa-list-sub">by ' + esc(s.approvedBy || '') + '</div>' }));
    }
  }

  async function act(sessionId, decision, dashContainer) {
    const ui = U();
    const actor = (rbac() && rbac().label && rbac().label()) || 'owner';
    const res = await council().act(sessionId, { actor: actor, decision: decision });
    if (!res.ok) { await ui.confirm({ title: 'Not recorded', message: res.message || res.error, confirmLabel: 'OK' }); }
    const fresh = await council().get(sessionId); renderMeeting(dashContainer, fresh);
  }

  async function openMeeting(id) {
    const ui = U();
    const sheet = ui.sheet({ title: 'Council Meeting', subtitle: 'AAA Carpet — agent deliberation' });
    document.body.appendChild(sheet.overlay);
    const s = await council().get(id);
    renderMeeting(sheet.body, s);
  }

  function open() {
    const ui = U();
    const sheet = ui.sheet({ title: 'Supervisor Council', subtitle: 'AAA Carpet — agents deliberate, you decide' });
    document.body.appendChild(sheet.overlay);
    render(sheet.body);
  }

  global.AAA_AGENT_COUNCIL_UI = { render: render, renderMeeting: renderMeeting, open: open };
})(typeof window !== 'undefined' ? window : this);
