/*
 * AAA Owner Copilot — owner-only morning briefing.
 *
 * "What requires my attention today?" answered at a glance: a headline, the top
 * priorities (each opening the module that owns the decision), and the full
 * briefing (revenue, open quotes, follow-ups, jobs at risk, cash-flow alerts,
 * KPI changes, recommendations, decisions awaiting approval, learning proposals,
 * critical issues). Read-only — it surfaces, it never acts. Gated on
 * VIEW_FINANCIALS (owner).
 */
;(function (global) {
  'use strict';

  function U() { return global.AAA_UI; }
  function CP() { return global.AAA_OWNER_COPILOT; }
  function rbac() { return global.AAA_RBAC; }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
  function money(n) { return n == null ? '—' : '$' + Number(n).toLocaleString(); }
  const KCOLOR = { incident: '#EF4444', executive: '#F59E0B', proposal: '#F59E0B', cash: '#F59E0B', followup: '#3B82F6', council: '#3B82F6', risk: '#F59E0B', pricing: '#8B5CF6' };

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
      container.appendChild(ui.el('div', { className: 'aaa-list-row', html: '<strong>🔒 The Owner Copilot is owner-only</strong><div class="aaa-list-sub">Signed in as ' + esc(rbac().label()) + '.</div>' }));
      return;
    }
    if (!CP()) { container.appendChild(empty('Owner Copilot unavailable.')); return; }

    container.appendChild(ui.spinner('Preparing your briefing…'));
    let b;
    try { b = await CP().briefing(); } catch (err) { container.innerHTML = ''; container.appendChild(ui.el('div', { className: 'aaa-list-row', html: '<strong>Could not load the briefing</strong><div class="aaa-list-sub">' + esc((err && err.message) || err) + '</div>' })); return; }
    container.innerHTML = '';

    // Headline.
    container.appendChild(ui.el('div', { className: 'aaa-list-row', html: '<strong>☀ Good morning — ' + esc(b.date) + '</strong><div class="aaa-list-sub">' + esc(b.headline) + '</div>' }));
    const s = b.sections;
    container.appendChild(ui.el('section', { className: 'aaa-summary' }, [
      chip(b.attentionItems, 'Need you', b.attentionItems ? '#F59E0B' : '#10B981'),
      chip(money(s.revenueYesterday.count), 'Rev. yesterday', '#3B82F6'),
      chip(money(s.revenueThisMonth.count), 'Rev. MTD', '#10B981'),
      chip(s.criticalIssues.count, 'Critical', s.criticalIssues.count ? '#EF4444' : '#10B981')
    ]));

    // Top priorities — the answer to "what needs me today?".
    container.appendChild(title('What needs you today'));
    if (!b.priorities.length) container.appendChild(empty('Nothing — you’re clear. ✅'));
    b.priorities.forEach((p) => {
      const row = ui.el('div', { className: 'aaa-list-row', html: '<strong style="color:' + (KCOLOR[p.kind] || 'var(--muted)') + '">' + esc(p.label) + '</strong><div class="aaa-list-sub">' + esc(p.kind) + '</div>' });
      if (p.open && global[p.open] && global[p.open].open) row.appendChild(ui.button({ label: 'Open', size: 'sm', variant: 'secondary', onClick: () => global[p.open].open() }));
      container.appendChild(row);
    });

    // The full briefing.
    container.appendChild(title('Full briefing'));
    sectionRow(container, '💼 Open quotes', s.openQuotes);
    sectionRow(container, '⏰ Follow-ups due', s.followUpsDue);
    sectionRow(container, '⚠ Jobs at risk', s.jobsAtRisk);
    sectionRow(container, '💸 Cash-flow alerts', s.cashFlowAlerts);
    sectionRow(container, '📊 KPI changes', s.kpiChanges);
    sectionRow(container, '💲 Agent recommendations', s.agentRecommendations);
    sectionRow(container, '⚖️ Council decisions awaiting approval', s.councilDecisions);
    sectionRow(container, '🔁 Learning proposals to review', s.learningProposals);
    sectionRow(container, '🚨 Critical operational issues', s.criticalIssues);

    container.appendChild(ui.el('p', { className: 'aaa-voice-hint', text: esc(b.note) }));
  }

  function sectionRow(container, label, sec) {
    const ui = U();
    container.appendChild(ui.el('div', { className: 'aaa-list-row', html:
      '<strong>' + label + ': ' + (sec.count || 0) + '</strong>' +
      (sec.items && sec.items.length ? '<div class="aaa-list-sub">' + esc(sec.items.map((x) => x.customer || x.title || x.kind || x.kpi || x.id || JSON.stringify(x)).slice(0, 5).join(', ')) + '</div>' : '') +
      '<div class="aaa-list-sub">' + esc(sec.explain) + '</div>' }));
  }

  function open() {
    const ui = U();
    const sheet = ui.sheet({ title: 'Owner Copilot', subtitle: 'AAA Carpet — your daily briefing' });
    document.body.appendChild(sheet.overlay);
    render(sheet.body);
  }

  global.AAA_OWNER_COPILOT_UI = { render: render, open: open };
})(typeof window !== 'undefined' ? window : this);
