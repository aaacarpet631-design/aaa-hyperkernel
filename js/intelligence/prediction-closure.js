/*
 * AAA Prediction Closure / Learning Feedback — closes the loop.
 *
 * Each Pricing Optimizer prediction captured a segment, a target metric, an
 * expected direction, and a BASELINE value at prediction time. This engine
 * measures the OBSERVED metric from quotes resolved AFTER the prediction and
 * scores whether the recommendation's direction was validated, contradicted, or
 * inconclusive — then derives a confidence/risk calibration signal for the
 * Supervisor (stored, never auto-applied).
 *
 * Stores append-only `learning_feedback` records (closures + owner reviews) — it
 * NEVER mutates quotes, prices, margins, predictions, or recommendations. It
 * does not rewrite prompts or apply tunings. Owner-only (financial). Every field
 * read is null-tolerant so malformed/outlier data cannot throw.
 */
;(function (global) {
  'use strict';

  const FEEDBACK = 'learning_feedback';

  function cfg() { return global.AAA_CONFIG || {}; }
  function data() { return global.AAA_DATA; }
  function ids() { return global.AAA_ID_FACTORY; }
  function clock() { return global.AAA_RUNTIME_CLOCK; }
  function gateway() { return global.AAA_RUNTIME_GATEWAY; }
  function quotes() { return global.AAA_QUOTES; }
  function learn() { return global.AAA_OUTCOME_LEARNING; }
  function ws() { return cfg().workspaceId || 'default'; }
  function nowISO() { return clock() && clock().nowISO ? clock().nowISO() : new Date().toISOString(); }
  function mine(r) { return r && (r.workspaceId == null || r.workspaceId === ws()); }
  function num(v) { const n = Number(v); return isFinite(n) ? n : 0; }
  function round(n) { return Math.round(n * 100) / 100; }
  function mean(a) { return a.length ? a.reduce((x, y) => x + y, 0) / a.length : null; }
  function isWon(q) { return q && q.status === 'won'; }
  function isResolved(q) { return q && (q.status === 'won' || q.status === 'lost'); }

  function bands() { return (learn() && learn().BANDS) || {}; }
  function priceBand(v) { const f = bands().priceBand; return f ? f(v) : 'unknown'; }
  function riskBand(v) { const f = bands().riskBand; return f ? f(v) : 'unknown'; }
  function serviceKey(q) { const s = Array.isArray(q && q.serviceType) ? q.serviceType.filter(Boolean) : []; return s.length ? s.slice().sort().join(' + ') : 'unspecified'; }

  function T() {
    const f = (k, d) => (cfg().flag ? cfg().flag(k, d) : d);
    return { minObserved: num(f('closeMinObserved', 3)), winThreshold: num(f('closeWinThreshold', 0.1)), marginThreshold: num(f('closeMarginThreshold', 5)), strongWinRate: num(f('optStrongWinRate', 0.6)) };
  }

  function inSegment(q, dim, key) {
    switch (dim) {
      case 'priceBand': return priceBand(q.customerTotal) === key;
      case 'serviceType': return serviceKey(q) === key;
      case 'zip': return (q.zip || 'unknown') === key;
      case 'leadSource': return (q.leadSource || 'unknown') === key;
      case 'riskHigh': return riskBand(q.risk) === 'high';
      default: return true; // 'all' | 'marginAll'
    }
  }
  function metricOf(list, metric) {
    if (!list.length) return null;
    if (metric === 'avgMarginPct') { const m = list.filter(isWon).map((q) => q.marginPct).filter((n) => n != null && isFinite(n)); return m.length ? Math.round(mean(m)) : null; }
    return round(list.filter(isWon).length / list.length); // winRate
  }

  const Engine = {
    FEEDBACK: FEEDBACK,

    /** Live evaluation of every prediction (read-only). */
    async evaluate() {
      const th = T();
      const decisions = (await data().list('agent_decisions')).filter((d) => mine(d) && d.kind === 'pricing_prediction');
      const allQuotes = quotes() ? await quotes().list() : [];
      const resolved = allQuotes.filter(isResolved);
      const closedSet = await this._closedPredictionIds();

      return decisions.map((p) => {
        const created = Date.parse(p.createdAt || '');
        const dim = p.segmentDim || 'all';
        const observedList = resolved.filter((q) => {
          const r = Date.parse(q.resolvedAt || '');
          return isFinite(r) && (!isFinite(created) || r > created) && inSegment(q, dim, p.segment);
        });
        const observed = metricOf(observedList, p.metric || 'winRate');
        const observedSample = observedList.length;
        const verdict = scoreClosure(p, observed, observedSample, th);
        return {
          predictionId: p.id, recommendationId: p.recommendationId || null, type: p.recommendationType || null,
          segmentDim: dim, segmentKey: p.segment, metric: p.metric || 'winRate', expectedDirection: p.expectedDirection || 'up',
          baseline: p.baseline != null ? p.baseline : null, baselineSample: p.baselineSample || 0,
          observed: observed, observedSample: observedSample,
          status: verdict.status, score: verdict.score,
          confidenceDelta: verdict.confidenceDelta, riskDelta: verdict.riskDelta,
          explanation: verdict.explanation, expectedKpiImpact: p.expectedKpiImpact || null,
          supportingQuoteIds: observedList.map((q) => q.quoteId || q.id).slice(0, 50),
          persisted: closedSet[p.id] || false,
          createdAt: p.createdAt
        };
      }).sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
    },

    /**
     * Persist append-only closure records for predictions that have newly reached
     * a CONCLUSIVE state (validated/contradicted). Idempotent: never re-writes an
     * already-closed prediction. Inconclusive ones are left for later data.
     */
    async close(opts) {
      const o = opts || {};
      const evals = await this.evaluate();
      const closedSet = await this._closedPredictionIds();
      const written = [];
      for (const e of evals) {
        if (e.status === 'inconclusive' || closedSet[e.predictionId]) continue;
        const rec = {
          id: ids() ? ids().createId('lf') : 'lf_' + Date.now() + '_' + e.predictionId,
          kind: 'closure', workspaceId: ws(),
          recommendationId: e.recommendationId, predictionId: e.predictionId, type: e.type,
          segmentDim: e.segmentDim, segmentKey: e.segmentKey, metric: e.metric, expectedDirection: e.expectedDirection,
          baseline: e.baseline, baselineSample: e.baselineSample, observed: e.observed, observedSample: e.observedSample,
          status: e.status, score: e.score, confidenceDelta: e.confidenceDelta, riskDelta: e.riskDelta,
          explanation: e.explanation, agent: 'pricing_optimizer', createdAt: nowISO()
        };
        await append(rec);
        written.push(rec);
      }
      return { ok: true, closed: written.length, records: written };
    },

    /** Append-only list of persisted feedback records. */
    async list() { return (await data().list(FEEDBACK)).filter(mine).sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || ''))); },
    async closures() { return (await this.list()).filter((r) => r.kind === 'closure'); },

    /**
     * Supervisor calibration SIGNAL (stored, not applied). Aggregates closures
     * per agent into a suggested confidence bias + a validation trend. Never
     * rewrites a prompt or installs a tuning automatically.
     */
    async calibrationSummary() {
      const closures = await this.closures();
      const byAgent = {};
      closures.forEach((c) => {
        const a = c.agent || 'pricing_optimizer';
        const p = byAgent[a] || (byAgent[a] = { agent: a, total: 0, validated: 0, contradicted: 0, confidenceDeltaSum: 0, riskDeltaSum: 0 });
        p.total++; if (c.status === 'validated') p.validated++; if (c.status === 'contradicted') p.contradicted++;
        p.confidenceDeltaSum += num(c.confidenceDelta); p.riskDeltaSum += num(c.riskDelta);
      });
      const agents = Object.keys(byAgent).map((k) => {
        const p = byAgent[k]; const conclusive = p.validated + p.contradicted;
        return {
          agent: k, closures: p.total, validated: p.validated, contradicted: p.contradicted,
          validationRate: conclusive ? round(p.validated / conclusive) : null,
          suggestedConfidenceBias: conclusive ? clamp(Math.round((p.validated / conclusive - 0.5) * 20), -10, 10) : 0,
          netConfidenceSignal: p.confidenceDeltaSum, netRiskSignal: p.riskDeltaSum,
          applied: false   // signals are advisory; calibration is never auto-applied
        };
      });
      return { ok: true, agents: agents, note: 'Advisory only — confidence/risk signals are stored, never auto-applied. A person decides whether to retune.' };
    },

    /** Owner acknowledges a closure — append-only review record, gateway-audited. */
    async markReviewed(predictionId, opts) {
      const o = opts || {};
      const gw = gateway();
      if (!gw) return { ok: false, error: 'NO_GATEWAY' };
      const res = await gw.run({
        action: 'REVIEW_LEARNING', origin: o.origin === 'ai' ? 'ai' : 'human', actor: o.actor || null,
        target: { type: 'learning_feedback', id: predictionId }, detail: { note: o.note || null },
        mutate: async () => {
          const rec = { id: ids() ? ids().createId('lf') : 'lf_' + Date.now(), kind: 'review', workspaceId: ws(), predictionId: predictionId, reviewedBy: o.actor || null, note: o.note || null, createdAt: nowISO() };
          await append(rec); return rec;
        }
      });
      if (!res.ok) return res;
      return { ok: true, record: res.result, auditId: res.auditId };
    },

    async _closedPredictionIds() {
      const map = {};
      (await this.closures()).forEach((c) => { if (c.predictionId) map[c.predictionId] = true; });
      return map;
    }
  };

  function scoreClosure(p, observed, observedSample, th) {
    const baseline = p.baseline;
    const dir = p.expectedDirection || 'up';
    if (observed == null || observedSample < th.minObserved) {
      return { status: 'inconclusive', score: 0, confidenceDelta: 0, riskDelta: 0,
        explanation: 'Not enough new outcomes in this segment yet (' + observedSample + ' since the prediction) to judge.' };
    }
    const thr = (p.metric === 'avgMarginPct') ? th.marginThreshold : th.winThreshold;
    if (dir === 'maintain_high') {
      if (observed >= th.strongWinRate) return res('validated', '+', 'Segment stayed strong (' + fmt(p.metric, observed) + ') after the call to lean in.');
      if (baseline != null && observed < baseline - 0.15) return res('contradicted', '-', 'Segment weakened to ' + fmt(p.metric, observed) + ' from ' + fmt(p.metric, baseline) + '.');
      return res('inconclusive', '0', 'Segment held around ' + fmt(p.metric, observed) + ' — no clear shift.');
    }
    if (baseline == null) return res('inconclusive', '0', 'No baseline captured to compare against.');
    const delta = observed - baseline;
    if (delta >= thr) return res('validated', '+', fmt(p.metric, observed) + ' vs baseline ' + fmt(p.metric, baseline) + ' — moved as recommended.');
    if (delta <= -thr) return res('contradicted', '-', fmt(p.metric, observed) + ' vs baseline ' + fmt(p.metric, baseline) + ' — moved against the recommendation.');
    return res('inconclusive', '0', fmt(p.metric, observed) + ' vs baseline ' + fmt(p.metric, baseline) + ' — within noise.');
    function res(status, sign, explanation) {
      const score = status === 'validated' ? 1 : status === 'contradicted' ? -1 : 0;
      const confidenceDelta = status === 'validated' ? 10 : status === 'contradicted' ? -10 : 0;
      const riskDelta = status === 'validated' ? -5 : status === 'contradicted' ? 10 : 0;
      return { status: status, score: score, confidenceDelta: confidenceDelta, riskDelta: riskDelta, explanation: explanation };
    }
  }
  function fmt(metric, v) { if (v == null) return '—'; return metric === 'avgMarginPct' ? Math.round(v) + '%' : Math.round(v * 100) + '% win'; }
  function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }
  async function append(rec) {
    await data().put(FEEDBACK, rec.id, rec);
    try { if (data().cloudReady && data().cloudReady() && global.AAA_CLOUD) global.AAA_CLOUD.upsertEntity(FEEDBACK, rec.id, rec); } catch (_) {}
  }

  global.AAA_PREDICTION_CLOSURE = Engine;
})(typeof window !== 'undefined' ? window : this);
