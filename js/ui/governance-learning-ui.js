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
        }
        s.body.appendChild(r);
      });

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

      s.body.appendChild(ui.button({ label: 'Done', variant: 'ghost', full: true, onClick: function () { s.close(); } }));
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
