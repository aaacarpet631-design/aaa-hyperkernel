/*
 * AAA Room Scan UI — a field-friendly scan panel.
 *
 * Pure renderModel() (DOM-free, testable): start scan, save room outline,
 * area/perimeter, confidence, conflict warning when the scan disagrees with the
 * laser/manual measurement, the moisture / anomaly flags (waiver/manager
 * badges), a needs-review badge, and an explicit "Review Layout" button. The
 * layout optimizer is run ONLY on that explicit tap — never on scan capture.
 * mount() renders only when a DOM exists.
 */
;(function (global) {
  'use strict';

  function engine() { return global.AAA_ROOM_SCAN_ENGINE; }
  function adapter() { return global.AAA_SCAN_TO_CAPTURE_ADAPTER; }
  function optimizer() { return global.AAA_SEAM_LAYOUT_OPTIMIZER; }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]); }); }

  const UI = {
    /** Pure render model for a captured/attached polygon. */
    renderModel(polygon) {
      const p = polygon || {};
      const moisture = (p.anomalies || []).filter(function (a) { return a.type === 'moisture_intrusion'; })[0] || null;
      return {
        title: 'Room Scan',
        area: p.areaSqFt != null ? p.areaSqFt + ' ft²' : 'insufficient_data',
        perimeter: p.perimeterFt != null ? p.perimeterFt + ' ft' : '—',
        confidence: p.confidence != null ? Math.round(p.confidence * 100) + '%' : '—',
        risk: p.risk || 'unknown',
        needsReview: !!p.needsReview,
        reviewBadge: p.needsReview ? 'Estimator Review Required' : 'Captured',
        conflict: (p.conflicts && p.conflicts[0]) || null,
        anomalies: (p.anomalies || []).map(function (a) { return { type: a.type, label: a.label, severity: a.severity, laborModifier: a.laborModifier, waiver: a.waiverRequired }; }),
        moistureWarning: moisture ? { severity: moisture.severity, waiver: moisture.waiverRequired, action: moisture.recommendedAction } : null,
        waiverRequired: !!p.waiverRequired,
        laborModifier: p.laborModifier != null ? p.laborModifier : 1,
        actions: ['Start scan', 'Save room outline', 'Review layout']
      };
    },

    html(polygon) {
      const m = this.renderModel(polygon);
      return '<div class="rs-card"><h3>' + esc(m.title) + '</h3>' +
        '<div class="rs-geo">Area ' + esc(m.area) + ' · Perimeter ' + esc(m.perimeter) + ' · confidence ' + esc(m.confidence) + ' · risk ' + esc(m.risk) + '</div>' +
        (m.moistureWarning ? '<div class="rs-moisture">💧 Moisture risk (' + esc(m.moistureWarning.severity) + ')' + (m.moistureWarning.waiver ? ' — waiver required' : '') + '</div>' : '') +
        (m.conflict ? '<div class="rs-conflict">⚠ Scan disagrees with laser/manual — both preserved.</div>' : '') +
        (m.anomalies.length ? '<div class="rs-anoms">' + m.anomalies.map(function (a) { return esc(a.label) + ' (' + esc(a.severity) + ', ×' + esc(a.laborModifier) + ')'; }).join('; ') + '</div>' : '') +
        (m.needsReview ? '<div class="rs-review">⚖️ ' + esc(m.reviewBadge) + '</div>' : '') +
        '<button class="rs-review-layout">Review Layout</button></div>';
    },

    /** Explicit layout build — the ONLY place the optimizer runs from scan UI. */
    async reviewLayout(sessionId, opts) {
      if (!optimizer()) return { ok: false, error: 'OPTIMIZER_UNAVAILABLE' };
      const plan = await optimizer().optimize(Object.assign({ sessionId: sessionId }, opts || {}));
      return { ok: true, plan: plan };
    },

    /** Capture + attach + render (DOM-guarded). */
    async mount(el, opts) {
      if (typeof document === 'undefined') return { mounted: false, reason: 'no_dom' };
      const o = opts || {};
      const cap = engine() ? await engine().capture(o) : null;
      let polygon = cap && cap.polygon;
      if (polygon && adapter() && o.sessionId) { const at = await adapter().attach(o.sessionId, polygon, { roomId: o.roomId }); if (at.ok) polygon = at.polygon; }
      const root = el || document.body;
      const div = document.createElement('div'); div.className = 'rs-root'; div.innerHTML = this.html(polygon || {});
      const btn = div.querySelector('.rs-review-layout'); const self = this;
      if (btn) btn.onclick = function () { self.reviewLayout(o.sessionId, o); };
      root.appendChild(div);
      return { mounted: true, polygon: polygon };
    }
  };

  global.AAA_ROOM_SCAN_UI = UI;
})(typeof window !== 'undefined' ? window : this);
