/*
 * AAA Supervisor Evidence Card — 30-second human approval of a pricing decision.
 *
 * Renders one resolved pricing decision (from AAA_PRICING_RESOLVER) as a single
 * scannable card so a supervisor can decide fast and on the record:
 *   1. Recommended price          5. Decision confidence
 *   2. Margin floor               6. Flags (UNPROFITABLE_TO_WIN, CONTRADICTORY_SIGNAL,
 *   3. Anchor price                  LOW_CONFIDENCE, FLOOR_CLAMPED, …)
 *   4. Winning / lost comp band   7. Approval-required status
 *                                 8. Ledger citation / decision id
 *   9. Actions: Accept · Adjust within allowed range · Send back for rescope · Decline
 *
 * HARD RULE: no action may approve below the margin floor. The Adjust input is
 * bounded to [floor, allowedHigh] and the actual enforcement lives in
 * AAA_PRICING_RESOLVER.recordApproval() (tested pure logic) — the UI is only a
 * presenter; it never prices or sends. Every action writes to the ledger.
 */
;(function (global) {
  'use strict';

  function U() { return global.AAA_UI; }
  function R() { return global.AAA_PRICING_RESOLVER; }
  function rbac() { return global.AAA_RBAC; }
  function actor() { return (rbac() && rbac().label && rbac().label()) || 'supervisor'; }

  function money(n) {
    const v = Number(n);
    if (!isFinite(v)) return '—';
    return '$' + Math.round(v).toLocaleString('en-US');
  }
  function pct(n) { return (n == null || !isFinite(Number(n))) ? '—' : Math.round(Number(n) * 100) + '%'; }

  const CONF_COLOR = { high: '#10B981', medium: '#F59E0B', low: '#EF4444' };
  // The four headline flags get strong colours; everything else is a neutral note.
  const FLAG_COLOR = {
    UNPROFITABLE_TO_WIN: '#EF4444', CONTRADICTORY_SIGNAL: '#EF4444',
    LOW_CONFIDENCE: '#F59E0B', FLOOR_CLAMPED: '#F59E0B'
  };
  const FLAG_LABEL = {
    UNPROFITABLE_TO_WIN: 'Unprofitable to win', CONTRADICTORY_SIGNAL: 'Contradictory signal',
    LOW_CONFIDENCE: 'Low confidence', FLOOR_CLAMPED: 'Floor clamped',
    THIN_DATA: 'Thin data', LARGE_DEVIATION: 'Large deviation from anchor',
    PRICEBOOK_BELOW_FLOOR: 'Price book below floor', FLOOR_BELOW_COST: 'Floor below cost'
  };

  function chip(value, label, color) {
    return U().el('div', { className: 'aaa-chip' }, [
      U().el('span', { className: 'aaa-chip__value', text: String(value), style: { color: color || 'var(--muted)' } }),
      U().el('span', { className: 'aaa-chip__label', text: label }),
      U().el('div', { className: 'aaa-chip__bar', style: { background: color || 'var(--muted)', opacity: '0.85' } })
    ]);
  }
  function title(s) { return U().el('h2', { className: 'aaa-section-title', text: s }); }

  function bandText(b) { return b && b.low != null ? money(b.low) + '–' + money(b.high) : 'none'; }

  /**
   * Render the evidence card. `decision` is a resolved decision (compute()/resolve()).
   * opts: { actor, onResolved(result) }. Returns the container.
   */
  function renderCard(container, decision, opts) {
    const ui = U();
    opts = opts || {};
    container.innerHTML = '';
    if (!decision || decision.ok === false) {
      container.appendChild(ui.el('div', { className: 'aaa-list-row', html: '<strong>No pricing decision to review</strong><div class="aaa-list-sub">' + ((decision && decision.error) || 'The resolver returned nothing.') + '</div>' }));
      return container;
    }
    const ev = decision.evidence || {};
    const sig = ev.signal || {};
    const floor = ev.marginFloor;
    const anchorPrice = ev.anchor && (ev.anchor.price != null ? ev.anchor.price : ev.anchor.effective);
    const conf = decision.confidenceLevel || 'medium';

    // 1 — headline recommended price + approval-required banner (7).
    container.appendChild(ui.el('div', { className: 'aaa-list-row', html:
      '<strong style="font-size:1.5em">' + money(decision.recommended) + '</strong>' +
      '<div class="aaa-list-sub">Recommended price · feasible ' + money(decision.feasibleRange.low) + '–' + money(decision.feasibleRange.high) + '</div>' }));
    container.appendChild(ui.statusBadge('⚠ Approval required before any quote is sent', '#F59E0B'));

    // 2,3,5 — floor / anchor / confidence at a glance.
    container.appendChild(ui.el('section', { className: 'aaa-summary' }, [
      chip(money(floor), 'Margin floor', '#EF4444'),
      chip(money(anchorPrice), 'Anchor (price book)', '#3B82F6'),
      chip(pct(decision.decisionConfidence) + ' · ' + conf, 'Confidence', CONF_COLOR[conf] || '#A1A1AA')
    ]));

    // 4 — winning / lost comp band.
    container.appendChild(ui.el('div', { className: 'aaa-list-row', html:
      '<div class="aaa-list-sub">🟢 Winning comps: <strong>' + bandText(sig.winningBand) + '</strong> (' + (sig.won || 0) + ' won)</div>' +
      '<div class="aaa-list-sub">🔴 Losing comps: <strong>' + bandText(sig.lostBand) + '</strong> (' + (sig.lost || 0) + ' lost)' +
      (sig.winRate != null ? ' · win rate ' + pct(sig.winRate) : '') + (sig.n != null ? ' · n=' + sig.n : '') + '</div>' }));

    // 6 — flags (the four headline ones first, then any others).
    const flags = decision.escalationFlags || [];
    if (flags.length) {
      const order = ['UNPROFITABLE_TO_WIN', 'CONTRADICTORY_SIGNAL', 'LOW_CONFIDENCE', 'FLOOR_CLAMPED'];
      const sorted = order.filter((f) => flags.indexOf(f) !== -1).concat(flags.filter((f) => order.indexOf(f) === -1));
      const wrap = ui.el('div', { className: 'aaa-form', style: { display: 'flex', gap: '6px', flexWrap: 'wrap' } });
      sorted.forEach((f) => wrap.appendChild(ui.statusBadge((FLAG_LABEL[f] || f), FLAG_COLOR[f] || '#A1A1AA')));
      container.appendChild(title('Flags'));
      container.appendChild(wrap);
    }

    // 8 — ledger citation / decision id.
    container.appendChild(ui.el('div', { className: 'aaa-list-row', html:
      '<div class="aaa-list-sub">🧾 Decision <code>' + (decision.decisionId || '(unrecorded)') + '</code>' +
      (decision.ledgerRef ? ' · ledger <code>' + decision.ledgerRef + '</code>' : ' · not yet on ledger') + '</div>' }));

    // 9 — actions.
    container.appendChild(title('Your decision'));
    const status = ui.el('div', { className: 'aaa-list-sub', style: { minHeight: '1em' } });
    const actions = ui.el('div', { className: 'aaa-form', style: { display: 'flex', gap: '8px', flexWrap: 'wrap' } });

    function done(res) {
      if (res && res.ok) {
        status.textContent = res.approved
          ? '✓ ' + res.action + ' recorded at ' + money(res.approvedPrice) + ' (ledger ' + (res.ledgerRef || 'pending') + ')'
          : '✓ ' + res.action + ' recorded (no price approved)';
      } else {
        status.textContent = '✕ ' + (res && res.error === 'BELOW_MARGIN_FLOOR' ? 'Refused: cannot approve below the margin floor (' + money(floor) + ')' : (res && res.error) || 'Action failed');
      }
      if (opts.onResolved) opts.onResolved(res);
    }

    actions.appendChild(ui.button({ label: 'Accept ' + money(decision.recommended), variant: 'success', size: 'sm', onClick: async () => {
      done(await submit(decision, 'accept', {}, opts));
    } }));

    // Adjust within the allowed range — bounded input, floor-enforced on submit.
    actions.appendChild(ui.button({ label: 'Adjust within range', variant: 'secondary', size: 'sm', onClick: () => {
      if (container.querySelector && container.querySelector('.aaa-adjust-panel')) return;
      const input = ui.el('input', { className: 'aaa-input', attrs: { type: 'number', inputmode: 'decimal', min: String(floor), max: String(decision.feasibleRange.high), step: '1', value: String(decision.recommended) } });
      const panel = ui.el('div', { className: 'aaa-adjust-panel aaa-list-row' }, [
        ui.el('div', { className: 'aaa-list-sub', text: 'Allowed range ' + money(floor) + '–' + money(decision.feasibleRange.high) + ' · cannot go below the floor' }),
        input,
        ui.button({ label: 'Apply adjusted price', variant: 'primary', size: 'sm', onClick: async () => {
          done(await submit(decision, 'adjust', { price: input.value }, opts));
        } })
      ]);
      container.appendChild(panel);
    } }));

    actions.appendChild(ui.button({ label: 'Send back for rescope', variant: 'ghost', size: 'sm', onClick: async () => {
      const r = await ui.confirm({ title: 'Send back for rescope?', message: 'Route this back to be re-scoped. No price is approved.', requireReason: true, reasonLabel: 'What needs to change?', confirmLabel: 'Send back' });
      if (!r) return;
      done(await submit(decision, 'rescope', { reason: r.reason }, opts));
    } }));

    actions.appendChild(ui.button({ label: 'Decline', variant: 'danger', size: 'sm', onClick: async () => {
      const r = await ui.confirm({ title: 'Decline this job?', message: 'Record a decision not to pursue at any approvable price.', requireReason: true, reasonLabel: 'Reason for declining', danger: true, confirmLabel: 'Decline' });
      if (!r) return;
      done(await submit(decision, 'decline', { reason: r.reason }, opts));
    } }));

    container.appendChild(actions);
    container.appendChild(status);
    container.appendChild(ui.el('p', { className: 'aaa-voice-hint', text: 'You decide; nothing is sent here. Every choice is written to the immutable ledger, and no action can approve below the margin floor.' }));
    return container;
  }

  /**
   * Relay a supervisor action to the resolver's floor-enforcing approval layer.
   * Exposed for direct invocation (and tests). Returns the recordApproval result.
   */
  function submit(decision, action, extra, opts) {
    extra = extra || {}; opts = opts || {};
    if (!R() || !R().recordApproval) return Promise.resolve({ ok: false, error: 'RESOLVER_UNAVAILABLE' });
    return R().recordApproval(decision, { action: action, price: extra.price, reason: extra.reason, actor: opts.actor || actor() });
  }

  function open(decision, opts) {
    const ui = U();
    const s = ui.sheet({ title: 'Pricing approval', subtitle: 'AAA Carpet — supervisor evidence card' });
    document.body.appendChild(s.overlay);
    renderCard(s.body, decision, opts);
    return s;
  }

  global.AAA_SUPERVISOR_CARD_UI = { renderCard: renderCard, submit: submit, open: open };
})(typeof window !== 'undefined' ? window : this);
