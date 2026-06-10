/*
 * AAA Layout UI — a field-friendly view of a layout plan.
 *
 * Pure renderModel() (DOM-free, testable) → cut-list card, material-summary
 * card, waste %, warnings, a simple roll strip-map, and the review state. When
 * a plan needsReview it surfaces an "Estimator Review Required" badge — the plan
 * is never presented as a finalized quote. mount() renders only when a DOM exists.
 */
;(function (global) {
  'use strict';

  function optimizer() { return global.AAA_SEAM_LAYOUT_OPTIMIZER; }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]); }); }

  const UI = {
    /** Pure render model for a layout plan. */
    renderModel(plan) {
      const p = plan || {};
      const insufficient = p.status === 'insufficient_data';
      return {
        title: 'Carpet Layout',
        reviewRequired: !!p.needsReview,
        reviewBadge: p.needsReview ? 'Estimator Review Required' : 'Draft',
        nap: p.globalNapDirection || 'UNKNOWN',
        materialSummary: insufficient ? { status: 'insufficient_data' } : {
          rollWidthFt: p.rollWidthFt, linearFeet: p.totalLinearFeetOrdered, squareYards: p.totalSquareYards, wastePercentage: p.calculatedWastePercentage, confidence: p.confidence, risk: p.risk
        },
        cutList: (p.cuts || []).map(function (c) { return { label: c.label, dimensions: c.dimensions, rollSpan: c.sourceRollStartFt + '–' + c.sourceRollEndFt + 'ft', fills: (c.subCuts || []).map(function (s) { return { widthFt: s.widthFt, lengthFt: s.lengthFt, harvested: !!s.harvestedFromCutId, rotated: !!s.rotated }; }), risks: c.riskFlags || [] }; }),
        stripMap: (p.cuts || []).map(function (c) { return { label: c.label, start: c.sourceRollStartFt, end: c.sourceRollEndFt }; }),
        warnings: p.warnings || [],
        assumptions: p.assumptions || []
      };
    },

    /** Compact HTML (safe) for the layout cards. */
    html(plan) {
      const m = this.renderModel(plan);
      if (m.materialSummary.status === 'insufficient_data') {
        return '<div class="ly-card"><h3>' + esc(m.title) + '</h3><div class="ly-missing">insufficient_data — capture room geometry first.</div>' + (m.reviewRequired ? '<div class="ly-review">⚖️ ' + esc(m.reviewBadge) + '</div>' : '') + '</div>';
      }
      const s = m.materialSummary;
      return '<div class="ly-card"><h3>' + esc(m.title) + ' · nap ' + esc(m.nap) + '</h3>' +
        '<div class="ly-summary">' + esc(s.linearFeet) + ' lin ft (12ft roll) · ' + esc(s.squareYards) + ' yd² · waste ' + esc(s.wastePercentage) + '% · risk ' + esc(s.risk) + '</div>' +
        '<ul class="ly-cuts">' + m.cutList.map(function (c) { return '<li>' + esc(c.label) + ': ' + esc(c.dimensions) + ' (roll ' + esc(c.rollSpan) + ')' + (c.fills.length ? ' + ' + c.fills.map(function (f) { return f.widthFt + 'ft fill' + (f.harvested ? ' (harvested)' : ''); }).join(', ') : '') + (c.risks.length ? ' ⚠ ' + esc(c.risks.join(',')) : '') + '</li>'; }).join('') + '</ul>' +
        (m.warnings.length ? '<div class="ly-warn">' + m.warnings.map(esc).join('<br>') + '</div>' : '') +
        (m.reviewRequired ? '<div class="ly-review">⚖️ ' + esc(m.reviewBadge) + '</div>' : '') + '</div>';
    },

    /** Optimize a session and mount the view (DOM-guarded). */
    async mount(el, opts) {
      if (typeof document === 'undefined') return { mounted: false, reason: 'no_dom' };
      const plan = optimizer() ? await optimizer().optimize(opts || {}) : null;
      const root = el || document.body;
      const div = document.createElement('div'); div.className = 'ly-root'; div.innerHTML = this.html(plan || {});
      root.appendChild(div);
      return { mounted: true, plan: plan };
    }
  };

  global.AAA_LAYOUT_UI = UI;
})(typeof window !== 'undefined' ? window : this);
