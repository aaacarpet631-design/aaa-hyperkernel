/*
 * AAA Governance Learning UI — the human-controlled learning command center.
 *
 * Renders the training queue (with filters), supervisor recommendations
 * (recommendation-only, with human actions), the improvement-task ledger, and a
 * lightweight per-agent performance timeline. It only presents + dispatches to
 * AAA_GOVERNANCE_LEARNING — it never changes a prompt, price, or send.
 */
;(function (global) {
  'use strict';

  function U() { return global.AAA_UI; }
  function L() { return global.AAA_GOVERNANCE_LEARNING; }
  function SC() { return global.AAA_AGENT_SCORECARDS; }
  function rbac() { return global.AAA_RBAC; }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>]/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]); }); }
  function pct(n) { return n == null ? '—' : Math.round(n * 100) + '%'; }
  function fmtDate(ms) { if (!ms) return ''; const d = new Date(ms); return isNaN(d.getTime()) ? '' : d.toLocaleDateString(); }

  // Tiny unicode sparkline — lightweight, no chart library.
  const SPARK = '▁▂▃▄▅▆▇█';
  function sparkline(values) {
    const v = (values || []).filter(function (x) { return x != null; });
    if (!v.length) return '—';
    const min = Math.min.apply(null, v), max = Math.max.apply(null, v), span = (max - min) || 1;
    return v.map(function (x) { return SPARK[Math.min(SPARK.length - 1, Math.round(((x - min) / span) * (SPARK.length - 1)))]; }).join('');
  }

  function canAct() { return !!(rbac() && rbac().can && rbac().can('OVERRIDE_AI_DECISION')); }

  function field(label, node) { const ui = U(); const w = ui.el('div', { style: { margin: '0 0 8px' } }); w.appendChild(ui.el('label', { className: 'aaa-field-label', text: label })); w.appendChild(node); return w; }
  function select(options, value) { const ui = U(); const s = ui.el('select', { className: 'aaa-input' }); options.forEach(function (o) { const opt = ui.el('option', { text: o[1], attrs: { value: o[0] } }); if (o[0] === value) opt.setAttribute('selected', 'selected'); s.appendChild(opt); }); return s; }

  const UI = {
    async open() {
      const ui = U(); if (!ui || !L()) return;
      const s = ui.sheet({ title: 'Learning Command Center', subtitle: 'Human-governed — no automatic changes' });
      document.body.appendChild(s.overlay);
      this._sheet = s;
      this._filter = {};
      await this.render();
    },

    async render() {
      const ui = U(); const s = this._sheet; if (!s) return;
      const self = this;
      s.body.innerHTML = '';
      s.body.appendChild(ui.spinner('Loading governance learning…'));
      const cases = await L().trainingCases(this._filter);
      const recs = await L().openRecommendations();
      const tasks = await L().tasks();
      const insights = SC() ? await SC().insights() : null;
      s.body.innerHTML = '';

      // ---- filters + training queue ----
      s.body.appendChild(ui.el('h2', { className: 'aaa-section-title', text: 'Training Queue' }));
      const agentTypes = [['', 'All agents']].concat(uniq(cases.concat(await L().trainingCases({})).map(function (c) { return c.agentType; })).map(function (a) { return [a, a]; }));
      const fA = select(agentTypes, this._filter.agentType || '');
      const fO = select([['', 'All outcomes'], ['unsuccessful', 'unsuccessful'], ['overridden', 'overridden'], ['abandoned', 'abandoned'], ['refund', 'refund'], ['complaint', 'complaint'], ['chargeback', 'chargeback']], this._filter.outcomeType || '');
      const fS = select([['', 'Any severity'], ['high', 'high'], ['medium', 'medium'], ['low', 'low']], this._filter.severity || '');
      const fT = select([['', 'Any status'], ['pending_review', 'pending review'], ['reviewed', 'reviewed']], this._filter.status || '');
      const apply = function () { self._filter = { agentType: fA.value || undefined, outcomeType: fO.value || undefined, severity: fS.value || undefined, status: fT.value || undefined }; self.render(); };
      [fA, fO, fS, fT].forEach(function (n) { n.addEventListener('change', apply); });
      const row = ui.el('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px' } });
      row.appendChild(field('Agent', fA)); row.appendChild(field('Outcome', fO));
      row.appendChild(field('Severity', fS)); row.appendChild(field('Status', fT));
      s.body.appendChild(row);

      if (!cases.length) s.body.appendChild(ui.el('p', { className: 'aaa-empty', text: 'No training cases match.' }));
      cases.slice(0, 50).forEach((c) => {
        const sev = L().severityOf(c);
        const r = ui.el('div', { className: 'aaa-list-row' });
        r.innerHTML = '<strong>' + esc(c.agentType) + '</strong> · ' + esc((c.outcome && c.outcome.result) || c.finalResult) + ' · <span style="opacity:.7">' + esc(sev) + '</span>' +
          '<div class="aaa-list-sub">' + esc(truncate(c.decision && c.decision.recommendation, 80)) + '</div>' +
          '<div class="aaa-list-sub">conf ' + pct(c.decision && c.decision.confidence) + (c.overrideReason ? ' · override: ' + esc(truncate(c.overrideReason, 60)) : '') + (c.humanCorrection ? ' · correction: ' + esc(truncate(c.humanCorrection, 60)) : '') + ' · ' + esc(fmtDate(c.createdAt)) + ' · ' + esc(c.status || 'pending_review') + '</div>';
        if (c.status !== 'reviewed') {
          r.appendChild(ui.button({ label: 'Mark reviewed', variant: 'ghost', size: 'sm', onClick: async () => { await L().markReviewed(c.id, {}); this.render(); } }));
        }
        s.body.appendChild(r);
      });
      const exportBtn = ui.button({ label: '⬇ Export filtered as JSONL (PII-stripped)', variant: 'secondary', full: true, onClick: async () => {
        const res = await L().exportTrainingSamples(this._filter, {});
        downloadText('training-samples.jsonl', res.jsonl);
      } });
      s.body.appendChild(exportBtn);

      // ---- supervisor recommendations ----
      s.body.appendChild(ui.el('h2', { className: 'aaa-section-title', text: 'Supervisor Recommendations' }));
      s.body.appendChild(ui.el('p', { className: 'aaa-empty', text: 'Recommendation-only — accepting creates a task; no prompt is changed automatically.' }));
      const refreshBtn = ui.button({ label: 'Analyze agents', variant: 'ghost', size: 'sm', onClick: async () => { await L().recommendations(); this.render(); } });
      s.body.appendChild(refreshBtn);
      if (!recs.length) s.body.appendChild(ui.el('p', { className: 'aaa-empty', text: 'No open recommendations. Run "Analyze agents".' }));
      recs.forEach((rec) => {
        const r = ui.el('div', { className: 'aaa-list-row' });
        r.innerHTML = '<strong>' + esc(rec.agentType) + '</strong> · ' + esc(rec.type) + ' <span style="opacity:.7">[' + esc(rec.riskLevel || rec.severity) + ', conf ' + pct(rec.confidence) + ']</span>' +
          '<div class="aaa-list-sub">' + esc(rec.issue || rec.reason) + '</div>' +
          '<div class="aaa-list-sub">→ ' + esc(rec.suggestedAction) + '</div>' +
          (rec.expectedKpiImpact ? '<div class="aaa-list-sub">KPI: ' + esc(rec.expectedKpiImpact) + '</div>' : '');
        if (canAct()) {
          r.appendChild(ui.button({ label: 'Accept → task', variant: 'primary', size: 'sm', onClick: async () => { await L().acceptRecommendation(rec.id, {}); this.render(); } }));
          r.appendChild(ui.button({ label: 'Reject', variant: 'ghost', size: 'sm', onClick: async () => { await L().rejectRecommendation(rec.id, { reason: 'reviewed' }); this.render(); } }));
        } else {
          r.appendChild(ui.el('p', { className: 'aaa-empty', text: 'Only an Admin (Owner) can accept/reject.' }));
        }
        s.body.appendChild(r);
      });

      // ---- improvement tasks ----
      s.body.appendChild(ui.el('h2', { className: 'aaa-section-title', text: 'Improvement Tasks' }));
      if (!tasks.length) s.body.appendChild(ui.el('p', { className: 'aaa-empty', text: 'No tasks yet.' }));
      tasks.forEach((tk) => {
        const r = ui.el('div', { className: 'aaa-list-row' });
        r.innerHTML = '<strong>' + esc(tk.agentId) + '</strong> · ' + esc(tk.priority) + ' · <span style="opacity:.7">' + esc(tk.status) + '</span>' +
          '<div class="aaa-list-sub">' + esc(tk.issue) + '</div><div class="aaa-list-sub">→ ' + esc(tk.recommendedChange) + '</div>';
        if (canAct() && tk.status !== 'implemented' && tk.status !== 'rejected') {
          ['in_progress', 'implemented', 'rejected'].forEach(function (st) {
            r.appendChild(ui.button({ label: st.replace('_', ' '), variant: 'ghost', size: 'sm', onClick: async function () { await L().updateTaskStatus(tk.taskId, st, {}); self.render(); } }));
          });
          if (global.AAA_PROMPT_PIPELINE) r.appendChild(ui.button({ label: '+ Prompt proposal', variant: 'ghost', size: 'sm', onClick: function () { self._newProposal(tk); } }));
        }
        s.body.appendChild(r);
      });

      // ---- prompt change proposals (human-approved pipeline) ----
      if (global.AAA_PROMPT_PIPELINE) {
        const proposals = await global.AAA_PROMPT_PIPELINE.list();
        s.body.appendChild(ui.el('h2', { className: 'aaa-section-title', text: 'Prompt Change Proposals' }));
        s.body.appendChild(ui.el('p', { className: 'aaa-empty', text: 'Reviewed, human-approved changes only — never auto-applied.' }));
        if (!proposals.length) s.body.appendChild(ui.el('p', { className: 'aaa-empty', text: 'No proposals yet.' }));
        proposals.slice().sort(function (a, b) { return (b.createdAt || 0) - (a.createdAt || 0); }).forEach((p) => {
          const r = ui.el('div', { className: 'aaa-list-row' });
          r.innerHTML = '<strong>' + esc(p.agentId) + '</strong> · <span style="opacity:.7">' + esc(p.status) + '</span> · risk ' + esc(p.riskLevel) +
            '<div class="aaa-list-sub">' + esc(truncate(p.reason, 90)) + '</div>';
          r.appendChild(ui.button({ label: 'Review diff', variant: 'secondary', size: 'sm', onClick: function () { self._proposalDrawer(p.proposalId); } }));
          s.body.appendChild(r);
        });
      }

      // ---- performance timeline ----
      s.body.appendChild(ui.el('h2', { className: 'aaa-section-title', text: 'Agent Performance Timeline' }));
      const agents = insights ? uniq(insights.top.concat(insights.worst).concat(insights.insufficientData).map(function (c) { return c.agentType; })) : [];
      if (!agents.length) s.body.appendChild(ui.el('p', { className: 'aaa-empty', text: 'No scored agents yet.' }));
      for (const a of agents) {
        const hist = SC() ? await SC().timeline(a) : [];
        const card = SC() ? await SC().get(a) : null;
        const insufficient = card && card.dataQuality && !card.dataQuality.sufficient;
        const r = ui.el('div', { className: 'aaa-list-row' });
        r.innerHTML = '<strong>' + esc(a) + '</strong>' + (insufficient ? ' <span style="opacity:.7">(insufficient data)</span>' : '') +
          '<div class="aaa-list-sub">acc ' + sparkline(hist.map(function (h) { return h.accuracy; })) + ' ' + pct(card && card.accuracy) +
          ' · success ' + pct(card && card.successRate) + ' · override ' + pct(card && card.overrideRate) +
          ' · calib ' + pct(card && card.confidenceCalibration) + ' · ROI ' + (card && card.roiImpact != null ? '$' + card.roiImpact : '—') + '</div>' +
          (card && card.samples ? '<div class="aaa-list-sub">missing outcomes: ' + (card.samples.pending || 0) + '</div>' : '');
        s.body.appendChild(r);
      }

      // ---- governed prompt registry ----
      if (global.AAA_PROMPT_REGISTRY) {
        const entries = await global.AAA_PROMPT_REGISTRY.list();
        s.body.appendChild(ui.el('h2', { className: 'aaa-section-title', text: 'Prompt Registry' }));
        if (!entries.length) s.body.appendChild(ui.el('p', { className: 'aaa-empty', text: 'No governed prompt versions yet — agents use their built-in prompts.' }));
        entries.forEach((e) => {
          const r = ui.el('div', { className: 'aaa-list-row' });
          r.innerHTML = '<strong>' + esc(e.agentId) + '</strong> · v' + e.currentVersion + ' · <span style="opacity:.7">' + esc(e.status) + '</span>' +
            '<div class="aaa-list-sub">' + (e.versions || []).length + ' version(s) · ' + esc(e.name || 'system') + '</div>';
          r.appendChild(ui.button({ label: 'History / rollback', variant: 'secondary', size: 'sm', onClick: function () { self._registryDrawer(e.agentId); } }));
          s.body.appendChild(r);
        });
      }

      s.body.appendChild(ui.button({ label: 'Done', variant: 'ghost', full: true, onClick: function () { s.close(); } }));
    },

    // Active version, full history, diffs, rollback (Admin), and audit refs.
    async _registryDrawer(agentId) {
      const ui = U(); const self = this; const R = global.AAA_PROMPT_REGISTRY;
      const s = ui.sheet({ title: 'Prompt Registry — ' + agentId, subtitle: 'Versioned · hash-verified · reversible' });
      document.body.appendChild(s.overlay);
      const e = await R.entry(agentId); const verify = await R.verify(agentId);
      s.body.innerHTML = '';
      if (!e) { s.body.appendChild(ui.el('p', { className: 'aaa-empty', text: 'No registry entry.' })); return; }
      s.body.appendChild(ui.el('div', { className: 'aaa-list-sub', html: '<strong>Production:</strong> v' + e.currentVersion + (e.stagingVersion ? ' · <strong>Staging:</strong> v' + e.stagingVersion : '') + ' · <strong>Integrity:</strong> ' + (verify.ok ? '✅ verified' : '⛔ ' + esc(verify.reason)) }));
      if (e.stagingVersion && canAct()) {
        s.body.appendChild(ui.button({ label: '⬆ Promote staging v' + e.stagingVersion + ' → production', variant: 'primary', full: true, onClick: async function () { await R.promote(agentId, {}); s.close(); self._registryDrawer(agentId); } }));
      }
      const history = await R.history(agentId);
      history.slice().reverse().forEach((v) => {
        const r = ui.el('div', { className: 'aaa-list-row' });
        r.innerHTML = '<strong>v' + v.version + '</strong> · ' + esc(v.status) + (v.rollbackOf ? ' (rollback of v' + v.rollbackOf + ')' : '') +
          '<div class="aaa-list-sub" style="white-space:pre-wrap;opacity:.85">' + esc(truncate(v.text, 200)) + '</div>' +
          '<div class="aaa-list-sub">checksum ' + esc((v.checksum || '').slice(0, 10)) + '… · audit ' + esc(v.auditRef || '—') + '</div>';
        if (canAct() && v.version !== e.currentVersion) {
          r.appendChild(ui.button({ label: 'Roll back to v' + v.version, variant: 'ghost', size: 'sm', onClick: async function () { await R.rollback(agentId, v.version, { reason: 'manual rollback from UI' }); s.close(); self._registryDrawer(agentId); } }));
        }
        s.body.appendChild(r);
      });
      s.body.appendChild(ui.button({ label: '⬇ Export history (PII-stripped)', variant: 'ghost', size: 'sm', onClick: async function () { const r = await R.export(agentId, {}); downloadText('prompt-registry-' + agentId + '.json', JSON.stringify(r.json, null, 2)); } }));
      s.body.appendChild(ui.button({ label: 'Close', variant: 'ghost', full: true, onClick: function () { s.close(); } }));
    },

    // Create a prompt-change proposal from an accepted improvement task.
    _newProposal(task) {
      const ui = U(); const self = this; const P = global.AAA_PROMPT_PIPELINE;
      const s = ui.sheet({ title: 'New Prompt Proposal', subtitle: task.agentId + ' · ' + truncate(task.issue, 40) });
      document.body.appendChild(s.overlay);
      s.body.appendChild(ui.el('p', { className: 'aaa-list-sub', text: 'Recommended change: ' + truncate(task.recommendedChange, 160) }));
      const change = ui.el('textarea', { className: 'aaa-input aaa-textarea', attrs: { placeholder: 'Write the exact proposed prompt/process change…' } });
      change.value = task.recommendedChange || '';
      const kpi = ui.el('input', { className: 'aaa-input', attrs: { placeholder: 'Expected KPI impact (optional)' } });
      const rollback = ui.el('input', { className: 'aaa-input', attrs: { placeholder: 'Rollback notes (optional at draft)' } });
      s.body.appendChild(field('Proposed change', change));
      s.body.appendChild(field('Expected KPI impact', kpi));
      s.body.appendChild(field('Rollback notes', rollback));
      s.body.appendChild(ui.button({ label: 'Create draft', variant: 'primary', full: true, onClick: async function () {
        await P.createProposal({ taskId: task.taskId, agentId: task.agentId, proposedChange: change.value, reason: task.issue, evidenceCases: task.sourceTrainingCases || [], expectedKpiImpact: kpi.value || null, rollbackNotes: rollback.value || null });
        s.close(); self.render();
      } }));
    },

    // Diff review + human-approval workflow for one proposal.
    async _proposalDrawer(proposalId) {
      const ui = U(); const self = this; const P = global.AAA_PROMPT_PIPELINE;
      const s = ui.sheet({ title: 'Prompt Change Review', subtitle: 'Human-approved — no auto-apply' });
      document.body.appendChild(s.overlay);
      const p = await P.get(proposalId);
      s.body.innerHTML = '';
      if (!p) { s.body.appendChild(ui.el('p', { className: 'aaa-empty', text: 'Proposal not found.' })); return; }
      const row = function (k, v) { return ui.el('div', { className: 'aaa-list-sub', html: '<strong>' + esc(k) + ':</strong> ' + esc(v == null || v === '' ? '—' : v) }); };
      s.body.appendChild(row('Agent', p.agentId));
      s.body.appendChild(row('Status', p.status));
      s.body.appendChild(row('Risk', p.riskLevel));
      s.body.appendChild(row('Reason', p.reason));
      s.body.appendChild(row('Expected KPI impact', p.expectedKpiImpact));
      s.body.appendChild(ui.el('label', { className: 'aaa-field-label', text: 'Current (registry version)' }));
      s.body.appendChild(ui.el('div', { className: 'aaa-input aaa-textarea', style: { whiteSpace: 'pre-wrap', opacity: '0.8' }, text: p.currentPrompt || '(no prompt registry — current version unknown)' }));
      s.body.appendChild(ui.el('label', { className: 'aaa-field-label', text: 'Proposed change' }));
      s.body.appendChild(ui.el('div', { className: 'aaa-input aaa-textarea', style: { whiteSpace: 'pre-wrap' }, text: p.proposedChange || '' }));
      s.body.appendChild(row('Evidence cases', (p.evidenceCases || []).length + ' training case(s)'));
      s.body.appendChild(ui.button({ label: '⬇ Export evidence (PII-stripped)', variant: 'ghost', size: 'sm', onClick: async function () { const r = await P.exportEvidence(proposalId, {}); downloadText('proposal-evidence.jsonl', r.jsonl); } }));
      if (p.implementationPatch) s.body.appendChild(row('Implementation patch', 'Manual — no safe registry; apply and record version.'));
      const msg = ui.el('p', { className: 'aaa-dialog__message' });

      const refresh = function () { s.close(); self._proposalDrawer(proposalId); };
      if (p.status === 'draft') s.body.appendChild(ui.button({ label: 'Submit for approval', variant: 'primary', full: true, onClick: async function () { await P.submit(proposalId, {}); refresh(); } }));

      if (p.status === 'submitted') {
        if (!canAct()) { s.body.appendChild(ui.el('p', { className: 'aaa-empty', text: 'Only an Admin (Owner) can approve.' })); }
        else {
          const note = ui.el('textarea', { className: 'aaa-input aaa-textarea', attrs: { placeholder: 'Approval note (required, ≥10 chars)' } });
          const rb = ui.el('input', { className: 'aaa-input', attrs: { placeholder: 'Rollback note (required)' } });
          const chkWrap = ui.el('label', { className: 'aaa-list-sub' }); const chk = ui.el('input', { attrs: { type: 'checkbox' } }); chkWrap.appendChild(chk); chkWrap.appendChild(document.createTextNode(' I confirm the test checklist passed'));
          s.body.appendChild(field('Approval note', note)); s.body.appendChild(field('Rollback note', rb)); s.body.appendChild(chkWrap);
          s.body.appendChild(ui.button({ label: 'Approve', variant: 'danger', full: true, onClick: async function () {
            const r = await P.approve(proposalId, { note: note.value, rollbackNote: rb.value, checklistConfirmed: chk.checked });
            if (!r.ok) { msg.textContent = 'Cannot approve: ' + r.error; return; } refresh();
          } }));
          s.body.appendChild(ui.button({ label: 'Reject', variant: 'ghost', full: true, onClick: async function () { await P.reject(proposalId, { reason: note.value || 'rejected' }); refresh(); } }));
        }
      }
      if (p.status === 'approved' && canAct()) s.body.appendChild(ui.button({ label: 'Implement (patch/apply)', variant: 'primary', full: true, onClick: async function () { await P.implement(proposalId, {}); refresh(); } }));
      if (p.status === 'implemented' && canAct()) s.body.appendChild(ui.button({ label: 'Roll back', variant: 'ghost', full: true, onClick: async function () { await P.rollback(proposalId, { reason: 'manual rollback' }); refresh(); } }));
      s.body.appendChild(msg);
      s.body.appendChild(ui.button({ label: 'Close', variant: 'ghost', full: true, onClick: function () { s.close(); } }));
    }
  };

  function uniq(a) { return a.filter(function (v, i, arr) { return v && arr.indexOf(v) === i; }); }
  function truncate(s, n) { s = String(s == null ? '' : s); return s.length > n ? s.slice(0, n) + '…' : s; }
  function downloadText(name, text) {
    try {
      const blob = new Blob([text], { type: 'application/jsonl' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click();
      setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 0);
    } catch (_) {}
  }

  global.AAA_GOVERNANCE_LEARNING_UI = UI;
})(typeof window !== 'undefined' ? window : this);
