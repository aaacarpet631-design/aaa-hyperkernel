/*
 * AAA Legal War Room — the executive legal command center (read-only).
 *
 * One screen over REAL legal data: company risk by category, active risks,
 * compliance status, contract pipeline, payment disputes, documentation gaps,
 * incident reviews, escalated attorney reviews, and the legal audit trail. Every
 * section has an honest empty state, and a permanent banner makes the non-advice
 * doctrine impossible to miss.
 *
 * Opened from the Command Center (gated on VIEW_LEGAL). Uses the AAA_UI kit.
 */
;(function (global) {
  'use strict';

  function U() { return global.AAA_UI; }
  function legal() { return global.AAA_LEGAL_STORE; }
  function risk() { return global.AAA_LEGAL_RISK; }
  function division() { return global.AAA_LEGAL; }
  function gateway() { return global.AAA_RUNTIME_GATEWAY; }
  function contractsApi() { return global.AAA_CONTRACTS; }

  const LEGAL_ACTIONS = ['ADD_LEGAL_RECORD', 'FILE_INCIDENT', 'PREPARE_LEGAL_REVIEW', 'RESOLVE_LEGAL_REVIEW'];
  const SEV_COLOR = { low: '#10B981', medium: '#F59E0B', high: '#EF4444', critical: '#B91C1C' };

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
  function fmtDate(v) { const d = new Date(typeof v === 'number' ? v : Date.parse(v)); return isNaN(d.getTime()) ? '' : d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }); }
  function st(t) { return U().el('h2', { className: 'aaa-section-title', text: t }); }
  function note(t) { return U().el('p', { className: 'aaa-empty', text: t }); }
  function row(html) { return U().el('div', { className: 'aaa-list-row', html: html }); }
  function kv(k, v, color) {
    return U().el('div', { className: 'vision-row' }, [
      U().el('span', { className: 'vision-row__k', text: k }),
      U().el('span', { className: 'vision-row__v', text: v, style: color ? { color: color } : null })
    ]);
  }
  function disclaimerBanner() {
    return U().el('div', { className: 'aaa-list-row', style: { borderColor: '#F59E0B', background: 'rgba(245,158,11,0.10)' }, html:
      '<strong>⚖️ Not legal advice.</strong>' +
      '<div class="aaa-list-sub">This is risk-intelligence and documentation support. It does not practice law, represent the company, or guarantee outcomes. For legal questions, consult a licensed attorney.</div>' });
  }

  function dim(days) {
    if (days == null) return '';
    if (days < 0) return Math.abs(days) + 'd overdue';
    return 'due in ' + days + 'd';
  }

  async function renderInto(body) {
    const ui = U();
    body.innerHTML = '';
    body.appendChild(ui.spinner('Scanning legal posture…'));

    const cr = risk() ? await risk().companyRisk() : null;
    const records = legal() ? await legal().list() : [];
    const incidents = records.filter((r) => r.type === 'incident');
    const reviews = records.filter((r) => r.type === 'legal_review');
    const payments = records.filter((r) => (r.type === 'collection' || r.type === 'lien'));
    let contracts = [];
    try { if (contractsApi() && contractsApi().list) contracts = await contractsApi().list(); } catch (_) {}
    let audit = [];
    try { if (gateway() && gateway().recentAudit) audit = (await gateway().recentAudit(120)).filter((e) => LEGAL_ACTIONS.indexOf(e.action) !== -1); } catch (_) {}

    body.innerHTML = '';
    body.appendChild(disclaimerBanner());

    // ---- 1. Risk Overview ----
    body.appendChild(st('Risk Overview'));
    if (cr) {
      body.appendChild(kv('Overall legal risk', cr.risk_score + ' / 100  ·  ' + cr.severity.toUpperCase(), SEV_COLOR[cr.severity]));
      const cats = cr.categories || {};
      [['contract', 'Contract'], ['payment', 'Payment'], ['compliance', 'Compliance'], ['employment', 'Employment'], ['documentation', 'Documentation'], ['reputation', 'Reputation']]
        .forEach(([k, label]) => { const s = cats[k] || 0; body.appendChild(kv(label, String(s), SEV_COLOR[risk().severityOf(s)])); });
      if (cr.escalation_required) body.appendChild(row('<strong style="color:#B91C1C">Escalation recommended</strong><div class="aaa-list-sub">High legal risk — prepare a fact package and obtain human attorney review.</div>'));
      if (Array.isArray(cr.mitigation_actions) && cr.mitigation_actions.length) {
        body.appendChild(ui.el('h2', { className: 'aaa-section-title', text: 'Recommended mitigations' }));
        cr.mitigation_actions.forEach((m) => body.appendChild(U().el('div', { className: 'aaa-list-sub', text: '• ' + m })));
      }
      body.appendChild(U().el('p', { className: 'aaa-empty', text: 'Scanned ' + cr.scanned + ' job(s). Risk is driven by the worst real exposure, not an average.' }));
    } else { body.appendChild(note('Risk engine unavailable.')); }

    // ---- 2. Active Risks ----
    body.appendChild(st('Active Risks'));
    const active = (cr && cr.activeRisks) || [];
    if (!active.length) body.appendChild(note('No active legal risks detected from current data.'));
    active.slice(0, 25).forEach((a) => body.appendChild(ui.el('div', { className: 'aaa-list-row' }, [
      ui.el('div', { html: '<strong>' + esc(a.category.toUpperCase()) + '</strong>' }),
      ui.statusBadge(a.severity, SEV_COLOR[a.severity] || '#A1A1AA'),
      ui.el('div', { className: 'aaa-list-sub', text: a.detail + (a.customer ? ' — ' + a.customer : '') })
    ])));

    // ---- 3. Compliance Status ----
    body.appendChild(st('Compliance Status'));
    const comp = cr && cr.compliance;
    if (!comp || !comp.total) body.appendChild(note('No compliance obligations tracked yet. Add compliance_event records (license, insurance, filings) with due dates.'));
    else {
      body.appendChild(kv('Obligations tracked', String(comp.total)));
      body.appendChild(kv('Overdue', String(comp.overdue), comp.overdue ? '#EF4444' : '#10B981'));
      body.appendChild(kv('Due within 30d', String(comp.dueSoon), comp.dueSoon ? '#F59E0B' : '#10B981'));
      comp.obligations.slice(0, 15).forEach((o) => body.appendChild(row(
        '<strong>' + esc(o.title) + '</strong>' +
        '<div class="aaa-list-sub">' + esc((o.data && o.data.authority) || 'obligation') + ' · ' +
        (o.dueInMs != null ? esc(dim(Math.round(o.dueInMs / 86400000))) : 'no due date') +
        (o.overdue ? ' · ⚠️ overdue' : o.dueSoon ? ' · due soon' : '') + '</div>')));
    }

    // ---- 4. Contract Pipeline ----
    body.appendChild(st('Contract Pipeline'));
    if (!contracts.length) body.appendChild(note('No contracts yet.'));
    else {
      const by = { draft: 0, signed: 0, void: 0 };
      contracts.forEach((c) => { by[c.status] = (by[c.status] || 0) + 1; });
      body.appendChild(kv('Draft (unsigned)', String(by.draft || 0), by.draft ? '#F59E0B' : '#A1A1AA'));
      body.appendChild(kv('Signed', String(by.signed || 0), '#10B981'));
      if (by.void) body.appendChild(kv('Void', String(by.void)));
      contracts.filter((c) => c.status === 'draft').slice(0, 10).forEach((c) => body.appendChild(row(
        '<strong>Unsigned: ' + esc(c.title || c.jobId || c.id) + '</strong>' +
        '<div class="aaa-list-sub">$' + (c.total != null ? c.total : '—') + ' · created ' + esc(fmtDate(c.createdAt)) + '</div>')));
    }

    // ---- 5. Payment Disputes ----
    body.appendChild(st('Payment Disputes & Protection'));
    if (!payments.length) body.appendChild(note('No collection or lien records.'));
    payments.slice(0, 15).forEach((p) => body.appendChild(row(
      '<strong>' + esc(p.type === 'lien' ? 'Lien' : 'Collection') + ': ' + esc(p.title) + '</strong>' +
      '<div class="aaa-list-sub">status ' + esc(p.status) + (p.riskSeverity ? ' · ' + esc(p.riskSeverity) : '') + ' · ' + esc(fmtDate(p.createdAt)) + '</div>')));

    // ---- 6. Documentation Gaps ----
    body.appendChild(st('Documentation Gaps'));
    const gaps = (cr && cr.documentationGaps) || [];
    if (!gaps.length) body.appendChild(note('No documentation gaps detected.'));
    gaps.slice(0, 20).forEach((g) => body.appendChild(row('<strong>' + esc(g.customer || g.jobId || 'Job') + '</strong><div class="aaa-list-sub">' + esc(g.detail) + '</div>')));

    // ---- 7. Incident Reviews ----
    body.appendChild(st('Incident Reviews'));
    if (!incidents.length) body.appendChild(note('No incidents filed. Crew can file an incident from the field.'));
    incidents.slice(0, 15).forEach((i) => body.appendChild(row(
      '<strong>' + esc(i.title) + '</strong>' +
      '<div class="aaa-list-sub">status ' + esc(i.status) + ' · v' + i.version + ' · ' + esc(fmtDate(i.createdAt)) + '</div>' +
      (i.summary ? '<div class="aaa-list-sub">' + esc(i.summary) + '</div>' : ''))));

    // ---- 8. Escalated Legal Reviews ----
    body.appendChild(st('Escalated Legal Reviews'));
    if (!reviews.length) body.appendChild(note('No matters escalated for attorney review.'));
    reviews.slice(0, 15).forEach((r) => body.appendChild(row(
      '<strong>' + esc(r.title) + '</strong>' +
      '<div class="aaa-list-sub">status ' + esc(r.status) + (r.riskSeverity ? ' · ' + esc(r.riskSeverity) : '') + ' · ' + esc(fmtDate(r.createdAt)) + '</div>' +
      '<div class="aaa-list-sub">Fact package prepared for human attorney review — not legal advice.</div>')));

    // ---- 9. Audit Activity (legal) ----
    body.appendChild(st('Legal Audit Activity'));
    if (!audit.length) body.appendChild(note('No legal audit entries yet. Every legal record write is audited here.'));
    audit.slice(0, 25).forEach((e) => body.appendChild(row(
      '<strong style="color:' + ({ allowed: '#10B981', denied: '#EF4444', error: '#F59E0B' }[e.decision] || '#A1A1AA') + '">' + esc(String(e.decision).toUpperCase()) + ' · ' + esc(e.action) + '</strong>' +
      '<div class="aaa-list-sub">' + esc(e.origin) + (e.actor ? ' · ' + esc(String(e.actor)) : '') + (e.role ? ' (' + esc(e.role) + ')' : '') + ' · ' + esc(fmtDate(e.at)) + '</div>')));

    // ---- The Legal Division (org) ----
    if (division() && division().teams) {
      body.appendChild(st('Legal Intelligence Division'));
      const teams = division().teams();
      Object.keys(teams).forEach((team) => {
        body.appendChild(ui.el('div', { className: 'aaa-list-sub', html: '<strong>' + esc(team) + '</strong>' }));
        body.appendChild(U().el('div', { className: 'aaa-list-sub', text: teams[team].map((a) => a.title).join(' · ') }));
      });
      body.appendChild(U().el('p', { className: 'aaa-empty', text: division().isReady && division().isReady() ? 'Advisors online — they recommend, humans approve.' : 'Connect the AI proxy to bring legal advisors online.' }));
    }

    body.appendChild(disclaimerBanner());
  }

  async function open() {
    if (global.AAA_RBAC && !global.AAA_RBAC.can('VIEW_LEGAL')) {
      const ui = U();
      const s = ui.sheet({ title: 'Legal War Room', size: 'sm' });
      document.body.appendChild(s.overlay);
      s.body.appendChild(ui.el('p', { className: 'aaa-dialog__message', text: 'Your role cannot view the Legal War Room.' }));
      return;
    }
    const ui = U();
    const s = ui.sheet({ title: 'Legal War Room', subtitle: 'Risk · compliance · contracts · evidence — advisory only' });
    document.body.appendChild(s.overlay);
    await renderInto(s.body);
  }

  global.AAA_LEGAL_WAR_ROOM = { open: open, render: renderInto };
})(typeof window !== 'undefined' ? window : this);
