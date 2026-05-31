/*
 * AAA Challenge UI — make the Internal Challenge Protocol visible.
 *
 * Read-only executive view over REAL shared-memory data: every time a
 * high-stakes decision was routed through the Challenge Protocol (Critic →
 * Risk → Counterargument → Supervisor Review), this surfaces what happened —
 * the verdict, how confidence moved, why it was escalated, and the full
 * deliberation transcript on demand.
 *
 * Data sources (no fabrication — empty states say so honestly):
 *   agent_logs[agent='challenge_protocol']  → the full transcript per challenge
 *   agent_logs[agent='escalation']          → why a decision was escalated (reasons)
 *
 * Rendered inline in the Command Center via renderSection(body); also openable
 * standalone via open(). Uses the shared AAA_UI kit.
 */
;(function (global) {
  'use strict';

  function U() { return global.AAA_UI; }
  function data() { return global.AAA_DATA; }

  const VERDICT = {
    approve: { label: 'Approved', color: '#10B981' },
    approve_with_changes: { label: 'Approved w/ changes', color: '#F59E0B' },
    reject: { label: 'Rejected', color: '#EF4444' }
  };
  const SEV = { low: '#10B981', medium: '#F59E0B', high: '#EF4444', critical: '#EF4444' };

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function fmtDate(ms) {
    if (!ms) return '';
    const d = new Date(ms);
    return isNaN(d.getTime()) ? '' : d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  }
  function verdictOf(v) { return VERDICT[v] || { label: v || 'reviewed', color: '#A1A1AA' }; }

  // Pull the challenge transcripts + an escalation-reason index (joined by jobId).
  async function load(limit) {
    if (!data()) return { challenges: [], reasonsByJob: {} };
    const logs = await data().list('agent_logs');
    const challenges = logs
      .filter((l) => l && l.agent === 'challenge_protocol' && l.context && l.context.transcript)
      .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
      .slice(0, limit || 12);
    const reasonsByJob = {};
    logs.filter((l) => l && l.agent === 'escalation' && l.context && l.context.jobId)
      .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0)) // latest wins
      .forEach((l) => { reasonsByJob[l.context.jobId] = l.context.reasons || []; });
    return { challenges: challenges, reasonsByJob: reasonsByJob };
  }

  function sectionTitle(t) { return U().el('h2', { className: 'aaa-section-title', text: t }); }
  function note(t) { return U().el('p', { className: 'aaa-empty', text: t }); }
  function row(html) { return U().el('div', { className: 'aaa-list-row', html: html }); }
  function sub(html) { return U().el('div', { className: 'aaa-list-sub', html: html }); }

  // Append a titled bullet list if the array has content.
  function listInto(container, title, arr) {
    if (!Array.isArray(arr) || !arr.length) return;
    container.appendChild(U().el('div', { className: 'aaa-list-sub', html: '<strong>' + esc(title) + '</strong>' }));
    arr.forEach((x) => container.appendChild(sub('• ' + esc(typeof x === 'string' ? x : JSON.stringify(x)))));
  }

  // Confidence movement string, e.g. "72 → 58 (-14)".
  function confMove(t) {
    const pc = t.proposal && t.proposal.confidence;
    const fc = t.review && t.review.confidence;
    if (pc == null && fc == null) return '';
    const base = (pc == null ? '—' : pc) + ' → ' + (fc == null ? '—' : fc);
    if (pc != null && fc != null) {
      const d = fc - pc;
      return base + ' (' + (d > 0 ? '+' : '') + d + ')';
    }
    return base;
  }

  // The full deliberation, stage by stage.
  function openTranscript(t, reasons) {
    const ui = U();
    const v = verdictOf(t.review && t.review.verdict);
    const s = ui.sheet({ title: 'Deliberation', subtitle: v.label + ' · confidence ' + confMove(t) });
    document.body.appendChild(s.overlay);
    const b = s.body;

    // Proposal
    b.appendChild(sectionTitle('Proposal'));
    const p = t.proposal || {};
    b.appendChild(row('<strong>' + esc(p.recommendation || '') + '</strong>' +
      '<div class="aaa-list-sub">from ' + esc(p.agent || 'proposer') + ' · stated confidence ' + (p.confidence != null ? p.confidence : '—') + '</div>' +
      (p.rationale ? '<div class="aaa-list-sub">' + esc(p.rationale) + '</div>' : '')));

    // Why challenged
    if (Array.isArray(reasons) && reasons.length) {
      b.appendChild(sectionTitle('Why this was challenged'));
      const wrap = ui.el('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '0.4rem', margin: '0.25rem 0' } });
      reasons.forEach((r) => wrap.appendChild(ui.statusBadge(r.signal || 'signal', '#818CF8')));
      b.appendChild(wrap);
      reasons.forEach((r) => { if (r.detail) b.appendChild(sub('• ' + esc(r.detail))); });
    }

    // Critic
    b.appendChild(sectionTitle('Critic'));
    if (t.critic && !t.critic.error) {
      const c = t.critic;
      const head = ui.el('div', { className: 'aaa-list-row' });
      head.innerHTML = '<strong>' + esc(c.strongest_objection || 'No decisive objection') + '</strong>';
      if (c.severity) head.appendChild(ui.statusBadge('severity: ' + c.severity, SEV[c.severity] || '#A1A1AA'));
      if (typeof c.confidence_delta === 'number') head.appendChild(sub('argues confidence ' + (c.confidence_delta >= 0 ? '+' : '') + c.confidence_delta));
      b.appendChild(head);
      listInto(b, 'Weak assumptions', c.assumptions);
      listInto(b, 'Evidence gaps', c.gaps);
    } else { b.appendChild(note('Critic stage unavailable' + (t.critic && t.critic.error ? ' (' + esc(t.critic.error) + ')' : '') + '.')); }

    // Risk
    b.appendChild(sectionTitle('Risk'));
    if (t.risk && !t.risk.error) {
      const r = t.risk;
      const head = ui.el('div', { className: 'aaa-list-row' });
      head.innerHTML = '<strong>Worst case: ' + esc(r.worst_case || '—') + '</strong>';
      if (r.risk_level) head.appendChild(ui.statusBadge('risk: ' + r.risk_level, SEV[r.risk_level] || '#A1A1AA'));
      b.appendChild(head);
      (Array.isArray(r.risks) ? r.risks : []).forEach((x) => b.appendChild(sub('• ' + esc(x.risk || '') + ' — likelihood ' + esc(x.likelihood || '?') + ', impact ' + esc(x.impact || '?'))));
      listInto(b, 'Mitigations', r.mitigations);
    } else { b.appendChild(note('Risk stage unavailable' + (t.risk && t.risk.error ? ' (' + esc(t.risk.error) + ')' : '') + '.')); }

    // Counterargument
    b.appendChild(sectionTitle('Counterargument'));
    if (t.counter && !t.counter.error) {
      const c = t.counter;
      const head = ui.el('div', { className: 'aaa-list-row' });
      head.innerHTML = '<strong>' + esc(c.alternative || '—') + '</strong>' + (c.case_for ? '<div class="aaa-list-sub">' + esc(c.case_for) + '</div>' : '');
      if (typeof c.strength === 'number') head.appendChild(ui.statusBadge('strength: ' + c.strength, c.strength >= 60 ? '#EF4444' : c.strength >= 30 ? '#F59E0B' : '#10B981'));
      b.appendChild(head);
      listInto(b, 'When the alternative wins', c.conditions);
    } else { b.appendChild(note('Counterargument stage unavailable' + (t.counter && t.counter.error ? ' (' + esc(t.counter.error) + ')' : '') + '.')); }

    // Final ruling
    b.appendChild(sectionTitle('Supervisor — final ruling'));
    const rv = t.review || {};
    const head = ui.el('div', { className: 'aaa-list-row' });
    head.innerHTML = '<strong>' + esc(rv.recommendation || '') + '</strong>';
    head.appendChild(ui.statusBadge(v.label, v.color));
    head.appendChild(sub('confidence ' + confMove(t) + (rv.changed ? ' · revised from the proposal' : ' · upheld')));
    if (rv.rationale) head.appendChild(sub(esc(rv.rationale)));
    if (rv.changed && rv.what_changed) head.appendChild(sub('<strong>What changed:</strong> ' + esc(rv.what_changed)));
    b.appendChild(head);
    listInto(b, 'Residual risks', rv.residual_risks);
    listInto(b, 'Next actions', rv.next_actions);

    b.appendChild(ui.button({ label: 'Done', variant: 'ghost', full: true, onClick: () => s.close() }));
  }

  /** Append the "Decision Challenges" section to a container (Command Center). */
  async function renderSection(body) {
    const ui = U();
    if (!ui || !data()) return;
    body.appendChild(sectionTitle('Decision Challenges'));
    const challengeReady = global.AAA_CHALLENGE && global.AAA_CHALLENGE.isReady && global.AAA_CHALLENGE.isReady();
    const { challenges, reasonsByJob } = await load(12);

    if (!challenges.length) {
      body.appendChild(note(challengeReady
        ? 'No high-stakes decisions have been challenged yet. High-value, severe, legal, deep-discount, or low-confidence calls are routed through the Critic → Risk → Counterargument → Supervisor review automatically.'
        : 'Connect the AI proxy to enable the Challenge Protocol. High-stakes decisions will then be reviewed adversarially before they reach you.'));
      return;
    }

    challenges.forEach((m) => {
      const t = m.context.transcript;
      const v = verdictOf((t.review && t.review.verdict) || m.context.verdict);
      const reasons = (m.context.jobId && reasonsByJob[m.context.jobId]) || [];
      const r = ui.el('div', { className: 'aaa-list-row' });
      r.innerHTML = '<strong>' + esc((t.review && t.review.recommendation) || (t.proposal && t.proposal.recommendation) || 'Decision') + '</strong>';
      r.appendChild(ui.statusBadge(v.label, v.color));
      r.appendChild(sub('from ' + esc((t.proposal && t.proposal.agent) || 'proposer') + ' · confidence ' + confMove(t) + (t.review && t.review.changed ? ' · revised' : '')));
      if (reasons.length) r.appendChild(sub('triggered by: ' + reasons.map((x) => esc(x.signal)).join(', ')));
      r.appendChild(sub(esc(fmtDate(m.createdAt))));
      r.appendChild(ui.button({ label: 'View deliberation', size: 'sm', variant: 'ghost', onClick: () => openTranscript(t, reasons) }));
      body.appendChild(r);
    });
  }

  /** Standalone sheet (not required by Command Center, but handy). */
  async function open() {
    const ui = U();
    const s = ui.sheet({ title: 'Decision Challenges', subtitle: 'Adversarial review of high-stakes decisions' });
    document.body.appendChild(s.overlay);
    s.body.appendChild(ui.spinner('Loading challenges…'));
    const tmp = ui.el('div', {});
    await renderSection(tmp);
    s.body.innerHTML = '';
    while (tmp.firstChild) s.body.appendChild(tmp.firstChild);
  }

  global.AAA_CHALLENGE_UI = { renderSection: renderSection, open: open, openTranscript: openTranscript };
})(typeof window !== 'undefined' ? window : this);
