/*
 * AAA Visual Evidence — the surface that makes the moat visible.
 *
 * Per job, it shows what the eyes of the business have recorded: the captured
 * images as structured evidence (category, confidence, recommendation, the
 * estimate range that was predicted), then the part that compounds — "jobs like
 * this" pulled from the Visual Memory network with their REAL outcomes (close
 * rate, average final price, average labor hours), and how accurate past visual
 * estimates have proven against reality.
 *
 * Pure read model + DOM-guarded mount, mirroring the deck/inbox modules. Every
 * number comes from AAA_VISUAL_MEMORY — nothing is fabricated; thin/empty data
 * degrades to an honest empty state, never a made-up figure. PII never appears
 * in the "similar jobs" panel (the store returns minimized samples by design).
 */
;(function (global) {
  'use strict';

  function vm() { return global.AAA_VISUAL_MEMORY; }
  function UI() { return global.AAA_UI; }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]); }); }
  function money(n) { return n == null ? '—' : '$' + Math.round(Number(n)).toLocaleString('en-US'); }
  function pct(n) { return n == null ? '—' : Math.round(Number(n)) + '%'; }
  function conf(n) { return n == null ? null : Math.round(Number(n) * 100) + '%'; }

  function range(a) {
    if (!a) return null;
    if (a.estimateLowUSD != null && a.estimateHighUSD != null) return money(a.estimateLowUSD) + '–' + money(a.estimateHighUSD);
    return null;
  }

  const View = {
    /** Pure read model for a job's visual evidence (DOM-free, testable). */
    async renderModel(opts) {
      const o = opts || {};
      const store = vm();
      if (!store || !store.list) return { ok: false, jobId: o.jobId || null, captured: { rows: [], empty: true, emptyLabel: 'Visual memory not loaded.' }, similar: null, accuracy: null };

      let records = [];
      try { records = (await store.list({ jobId: o.jobId })) || []; } catch (_) { records = []; }

      const rows = records.map(function (r) {
        const a = r.analysis || {};
        return {
          id: r.id, capturedAt: r.capturedAt, source: r.source,
          category: a.category || 'Uncategorized',
          recommendation: a.recommendation || null,
          confidence: conf(a.confidenceScore),
          estimate: range(a),
          hasOutcome: !!r.outcome
        };
      });

      // Evidence-driven "jobs like this": anchor on the most recent record.
      let similar = null;
      if (records.length) {
        try { similar = await store.findSimilar(records[0].id); } catch (_) { similar = null; }
      }

      let accuracy = null;
      if (store.predictionAccuracy) { try { accuracy = await store.predictionAccuracy(); } catch (_) { accuracy = null; } }

      return {
        ok: true, jobId: o.jobId || null,
        captured: { rows: rows, empty: rows.length === 0, emptyLabel: 'No photos captured for this job yet — use Vision Estimate to add one.' },
        similar: similar && similar.ok && similar.count ? {
          matchedOn: similar.matchedOn, count: similar.count,
          closeRatePct: similar.outcomes.closeRatePct, avgFinalAmountUSD: similar.outcomes.avgFinalAmountUSD,
          avgLaborHours: similar.outcomes.avgLaborHours, withOutcome: similar.outcomes.withOutcome
        } : null,
        accuracy: accuracy && accuracy.ok && accuracy.sample ? accuracy : null
      };
    },

    /** Render into a DOM element (DOM-guarded). */
    async mount(el, opts) {
      if (typeof document === 'undefined') return { mounted: false, reason: 'no_dom' };
      const root = el || document.body;
      const m = await this.renderModel(opts);
      const wrap = document.createElement('div'); wrap.className = 've-root';

      const capturedHtml = m.captured.empty
        ? '<div class="ve-empty">' + esc(m.captured.emptyLabel) + '</div>'
        : m.captured.rows.map(function (r) {
            return '<div class="ve-ev">' +
              '<div class="ve-ev__top"><span class="ve-ev__cat">' + esc(r.category) + '</span>' +
                (r.confidence ? '<span class="ve-ev__conf">' + esc(r.confidence) + ' confidence</span>' : '<span class="ve-ev__conf ve-ev__conf--dim">confidence —</span>') + '</div>' +
              (r.recommendation ? '<div class="ve-ev__rec">' + esc(r.recommendation) + '</div>' : '') +
              (r.estimate ? '<div class="ve-ev__est">Predicted ' + esc(r.estimate) + '</div>' : '') +
              '</div>';
          }).join('');

      const similarHtml = m.similar
        ? '<div class="ve-panel">' +
            '<div class="ve-panel__head">' + esc(m.similar.count) + ' jobs like this <span class="ve-panel__on">(by ' + esc(m.similar.matchedOn) + ')</span></div>' +
            '<div class="ve-stats">' +
              '<div class="ve-stat"><span class="ve-stat__v">' + esc(money(m.similar.avgFinalAmountUSD)) + '</span><span class="ve-stat__l">avg final</span></div>' +
              '<div class="ve-stat"><span class="ve-stat__v">' + esc(pct(m.similar.closeRatePct)) + '</span><span class="ve-stat__l">close rate</span></div>' +
              '<div class="ve-stat"><span class="ve-stat__v">' + esc(m.similar.avgLaborHours == null ? '—' : m.similar.avgLaborHours + 'h') + '</span><span class="ve-stat__l">avg labor</span></div>' +
            '</div>' +
            '<div class="ve-note">From ' + esc(m.similar.withOutcome) + ' completed job(s) with recorded outcomes.</div>' +
          '</div>'
        : '<div class="ve-empty">No comparable jobs with recorded outcomes yet — this builds as work closes.</div>';

      const accuracyHtml = m.accuracy
        ? '<div class="ve-acc">Visual estimates landed in range ' + esc(pct(m.accuracy.withinRangePct)) +
            ' of the time · avg miss ' + esc(money(m.accuracy.avgAbsErrorUSD)) + ' <span class="ve-panel__on">(' + esc(m.accuracy.sample) + ' scored)</span></div>'
        : '';

      wrap.innerHTML =
        '<h3 class="ve-sec">Captured Evidence</h3>' + capturedHtml +
        '<h3 class="ve-sec">Evidence from Similar Jobs</h3>' + similarHtml +
        accuracyHtml;

      root.appendChild(wrap);
      return { mounted: true };
    },

    /** Open the evidence view in a bottom sheet (appends its own overlay). */
    async open(opts) {
      if (typeof document === 'undefined') return { opened: false, reason: 'no_dom' };
      const kit = UI();
      if (!kit || !kit.sheet) return { opened: false, reason: 'no_ui_kit' };
      const s = kit.sheet({ title: 'Visual Evidence', subtitle: 'AAA Carpet — what the photos know' });
      document.body.appendChild(s.overlay);
      await this.mount(s.body, opts);
      return { opened: true, sheet: s };
    }
  };

  global.AAA_VISUAL_EVIDENCE_UI = View;
})(typeof window !== 'undefined' ? window : this);
