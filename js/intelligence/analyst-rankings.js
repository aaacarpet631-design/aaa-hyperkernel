/*
 * AAA Analyst Rankings — the meritocracy.
 *
 * Every analyst that has ever logged a decision is scored on six axes, computed
 * ONLY from real shared memory (decisions, their calibration scores, the linked
 * won/lost outcomes, and any self-improvement tunings):
 *
 *   Accuracy        — calibration (Brier) of its confidence vs. real outcomes
 *   Business Impact  — realized revenue on won deals it weighed in on (relative)
 *   Risk Detection   — did it correctly doubt the deals that went on to lose?
 *   Learning         — measured improvement in calibration over time
 *   Trust            — composite reliability, discounted for thin sample
 *   Overall          — weighted blend of whatever axes have enough data
 *
 * Honest by construction: an axis is null (not zero) when there isn't enough real
 * data for it, and it is then excluded from Overall — a new analyst is "unproven",
 * never falsely "bad". rescoreHistory() re-links outcomes to past decisions and
 * recomputes scores via the existing Supervisor, so rankings sharpen as outcomes
 * arrive. No model calls — this is deterministic.
 */
;(function (global) {
  'use strict';

  function data() { return global.AAA_DATA; }
  function ids() { return global.AAA_ID_FACTORY; }
  function clock() { return global.AAA_RUNTIME_CLOCK; }

  function newId(p) { return ids() ? ids().createId(p) : (p + '_' + Date.now()); }
  function now() { return clock() ? clock().now() : Date.now(); }
  function round(n, p) { if (n == null) return null; const f = Math.pow(10, p == null ? 0 : p); return Math.round(n * f) / f; }
  function mean(a) { return a.length ? a.reduce(function (x, y) { return x + y; }, 0) / a.length : null; }

  const MIN_FOR_LEARNING = 4;  // need this many scored decisions to measure a trend
  // Overall weighting across the axes that have data.
  const WEIGHTS = { accuracy: 0.35, businessImpact: 0.2, riskDetection: 0.2, learning: 0.1, trust: 0.15 };

  async function loadMaps() {
    const d = data();
    const decisions = await d.list('agent_decisions');
    const outcomes = await d.list('outcomes');
    const byJob = {}, byId = {};
    outcomes.forEach(function (o) { if (o.jobId) byJob[o.jobId] = o; byId[o.id] = o; });
    let tunings = [];
    try { tunings = await d.list('agent_tunings'); } catch (_) {}
    const tuneById = {}; tunings.forEach(function (t) { if (t && !t.reverted) tuneById[t.agentId] = t; });
    return { decisions: decisions, outByJob: byJob, outById: byId, tuneById: tuneById };
  }

  function outcomeFor(dec, maps) {
    return (dec.outcomeId && maps.outById[dec.outcomeId]) || (dec.jobId && maps.outByJob[dec.jobId]) || null;
  }

  const Rankings = {
    WEIGHTS: WEIGHTS,

    /**
     * Re-link outcomes to historical decisions and re-score via the Supervisor.
     * Realizes "when outcomes become available, re-score historical recommendations."
     * @returns {Promise<{ok, rescored, outcomes}>}
     */
    async rescoreHistory() {
      const d = data();
      if (!d) return { ok: false, error: 'NO_DATA_LAYER' };
      const sup = global.AAA_SUPERVISOR;
      if (!sup || !sup.scoreOutcome) return { ok: false, error: 'NO_SUPERVISOR' };
      const outcomes = await d.list('outcomes');
      let rescored = 0;
      for (const o of outcomes) {
        if (o.result !== 'won' && o.result !== 'lost') continue;
        const r = await sup.scoreOutcome(o);
        if (r && r.ok) rescored += r.scoredDecisions || 0;
      }
      return { ok: true, rescored: rescored, outcomes: outcomes.length };
    },

    /**
     * Compute the current ranking table from real memory. Pure read.
     * @returns {Promise<{ok, status, analysts:Array, sample}>}
     */
    async compute() {
      const d = data();
      if (!d) return { ok: false, error: 'NO_DATA_LAYER' };
      const maps = await loadMaps();
      const dec = maps.decisions;

      // Group decisions per analyst.
      const groups = {};
      dec.forEach(function (x) {
        const a = x.agent || 'unknown';
        (groups[a] = groups[a] || []).push(x);
      });

      // First pass: raw per-analyst metrics (impact needs a global max to normalize).
      const raw = {};
      Object.keys(groups).forEach(function (a) {
        const list = groups[a].slice().sort(function (p, q) { return (p.createdAt || 0) - (q.createdAt || 0); });
        const scored = list.filter(function (x) { return typeof x.score === 'number'; });

        // Accuracy = mean calibration score (0..1) → 0..100.
        const accuracy = scored.length ? round(mean(scored.map(function (x) { return x.score; })) * 100) : null;

        // Business impact = realized revenue on won outcomes this analyst weighed in on.
        let impact = 0, impactN = 0;
        list.forEach(function (x) {
          const o = outcomeFor(x, maps);
          if (o && o.result === 'won' && typeof o.finalAmount === 'number') { impact += o.finalAmount; impactN++; }
        });

        // Risk detection = on deals that LOST, did it correctly hold low confidence?
        const lostDecs = list.filter(function (x) { const o = outcomeFor(x, maps); return o && o.result === 'lost' && typeof x.confidence === 'number'; });
        const riskDetection = lostDecs.length ? round(mean(lostDecs.map(function (x) { return 100 - x.confidence; }))) : null;

        // Learning = improvement in calibration: mean(second half) - mean(first half).
        let learning = null;
        if (scored.length >= MIN_FOR_LEARNING) {
          const half = Math.floor(scored.length / 2);
          const first = mean(scored.slice(0, half).map(function (x) { return x.score; }));
          const second = mean(scored.slice(half).map(function (x) { return x.score; }));
          learning = round(Math.max(0, Math.min(100, 50 + (second - first) * 100)));
        }

        raw[a] = {
          analyst: a, decisions: list.length, scoredCount: scored.length,
          avgConfidence: round(mean(list.map(function (x) { return x.confidence; }).filter(function (n) { return typeof n === 'number'; })), 1),
          accuracy: accuracy, riskDetection: riskDetection, learning: learning,
          _rawImpact: impact, impactDeals: impactN,
          tuned: !!maps.tuneById[a]
        };
      });

      const maxImpact = Math.max.apply(null, Object.keys(raw).map(function (a) { return raw[a]._rawImpact; }).concat([0]));

      const analysts = Object.keys(raw).map(function (a) {
        const r = raw[a];
        const businessImpact = maxImpact > 0 && r.impactDeals > 0 ? round((r._rawImpact / maxImpact) * 100) : null;

        // Trust = reliability, discounted for thin sample. Built from accuracy &
        // risk detection, scaled by a confidence factor on how much we've seen.
        const depth = Math.min(1, r.scoredCount / 8); // full trust weight at 8+ scored
        const reliabilityParts = [r.accuracy, r.riskDetection].filter(function (n) { return n != null; });
        const reliability = reliabilityParts.length ? mean(reliabilityParts) : null;
        const trust = reliability != null ? round(reliability * (0.4 + 0.6 * depth)) : null;

        // Overall = weighted blend over whatever axes have data (re-normalized).
        const axes = { accuracy: r.accuracy, businessImpact: businessImpact, riskDetection: r.riskDetection, learning: r.learning, trust: trust };
        let num = 0, den = 0;
        Object.keys(WEIGHTS).forEach(function (k) { if (axes[k] != null) { num += axes[k] * WEIGHTS[k]; den += WEIGHTS[k]; } });
        const overall = den > 0 ? round(num / den) : null;

        const coverage = Object.keys(WEIGHTS).filter(function (k) { return axes[k] != null; }).length;
        return {
          analyst: a, decisions: r.decisions, scoredCount: r.scoredCount, avgConfidence: r.avgConfidence,
          accuracy: r.accuracy, businessImpact: businessImpact, businessImpactUsd: round(r._rawImpact),
          riskDetection: r.riskDetection, learning: r.learning, trust: trust, overall: overall,
          tuned: r.tuned,
          proven: r.scoredCount >= 3,
          coverage: coverage // how many of the 6 axes are real
        };
      }).sort(function (a, b) {
        // Proven analysts with an overall score first (desc); then by decisions.
        if (a.overall == null && b.overall == null) return b.decisions - a.decisions;
        if (a.overall == null) return 1;
        if (b.overall == null) return -1;
        return b.overall - a.overall;
      });

      const provenCount = analysts.filter(function (x) { return x.proven; }).length;
      return {
        ok: true,
        status: provenCount >= 1 ? 'ok' : 'warming_up',
        sample: { analysts: analysts.length, decisions: dec.length, proven: provenCount },
        analysts: analysts
      };
    },

    /**
     * Re-score history, recompute the table, and store a dated snapshot.
     * High performers float to the top; unproven analysts are flagged, not punished.
     */
    async refresh() {
      const re = await this.rescoreHistory(); // best-effort; ignore if no supervisor
      const table = await this.compute();
      if (!table.ok) return table;
      const snap = {
        id: newId('rank'), createdAt: now(),
        status: table.status, sample: table.sample,
        analysts: table.analysts, rescored: re && re.ok ? re.rescored : 0
      };
      try { await data().put('analyst_rankings', snap.id, snap); } catch (_) {}
      try { if (data().cloudReady && data().cloudReady() && global.AAA_CLOUD) await global.AAA_CLOUD.upsertEntity('analyst_rankings', snap.id, snap); } catch (_) {}
      return Object.assign({ ok: true }, table, { snapshotId: snap.id, rescored: snap.rescored });
    },

    async history() { return data() ? (await data().list('analyst_rankings')).slice().sort(function (a, b) { return (b.createdAt || 0) - (a.createdAt || 0); }) : []; }
  };

  global.AAA_RANKINGS = Rankings;
})(typeof window !== 'undefined' ? window : this);
