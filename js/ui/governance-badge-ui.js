/*
 * AAA Governance Badge — a small "Measured by Governance" indicator + detail
 * drawer for agent-generated outputs. Deliberately unobtrusive: callers opt in
 * by placing badge(decisionId) on an agent output (it returns null if there is
 * no decision or no UI kit, so it never clutters or breaks a screen).
 *
 * The drawer shows the decision id, agent, confidence, status, any attached
 * outcome/override, and the audit reference — read-only governance visibility.
 */
;(function (global) {
  'use strict';

  function ui() { return global.AAA_UI; }
  function reg() { return global.AAA_AGENT_OUTCOMES; }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>]/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]); }); }

  async function openDrawer(decisionId) {
    const U = ui();
    if (!U) return;
    const s = U.sheet({ title: 'Measured by Governance', subtitle: 'Agent decision & outcome' });
    document.body.appendChild(s.overlay);
    const dec = (reg() && reg().getDecision) ? await reg().getDecision(decisionId) : null;
    s.body.innerHTML = '';
    if (!dec) { s.body.appendChild(U.el('p', { className: 'aaa-empty', text: 'No governance record found for this output.' })); s.body.appendChild(U.button({ label: 'Done', variant: 'ghost', full: true, onClick: function () { s.close(); } })); return; }
    const row = function (k, v) { return U.el('div', { className: 'aaa-list-sub', html: '<strong>' + esc(k) + ':</strong> ' + esc(v == null || v === '' ? '—' : v) }); };
    s.body.appendChild(row('Decision ID', dec.decisionId));
    s.body.appendChild(row('Agent', dec.agentId + ' (' + dec.agentType + ')'));
    if (dec.agentVersion) s.body.appendChild(row('Agent version', dec.agentVersion));
    s.body.appendChild(row('Confidence', dec.confidence == null ? '—' : Math.round(dec.confidence * 100) + '%'));
    s.body.appendChild(row('Status', dec.outcomeStatus));
    s.body.appendChild(row('Source module', dec.sourceModule));
    if (dec.outcome) s.body.appendChild(row('Attached outcome', dec.outcome.result + (dec.outcome.value != null ? ' ($' + dec.outcome.value + ')' : '')));
    if (dec.override) s.body.appendChild(row('Override', dec.override.reason || 'overridden'));
    s.body.appendChild(row('Audit ref', dec.decisionId));
    s.body.appendChild(U.el('p', { className: 'aaa-empty', text: 'Governance measures this agent against real outcomes. It does not change the output.', style: { fontSize: '11px', marginTop: '8px' } }));
    s.body.appendChild(U.button({ label: 'Done', variant: 'ghost', full: true, onClick: function () { s.close(); } }));
  }

  const Badge = {
    /** Returns a small clickable chip node, or null if not applicable. */
    badge: function (decisionId) {
      const U = ui();
      if (!U || !decisionId) return null;
      const chip = U.el('button', {
        text: '🛡 Measured by Governance',
        attrs: { type: 'button', 'aria-label': 'View governance measurement' },
        style: { display: 'inline-flex', alignItems: 'center', gap: '4px', fontSize: '11px', color: '#2563EB', background: 'rgba(37,99,235,0.08)', border: '1px solid rgba(37,99,235,0.25)', borderRadius: '999px', padding: '2px 8px', cursor: 'pointer', marginTop: '6px' }
      });
      chip.addEventListener('click', function () { openDrawer(decisionId); });
      return chip;
    },
    open: openDrawer
  };

  global.AAA_GOV_BADGE = Badge;
})(typeof window !== 'undefined' ? window : this);
