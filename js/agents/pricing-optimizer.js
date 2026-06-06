/*
 * AAA Pricing Optimizer — a learning + recommendation layer, NOT an autopilot.
 *
 * It reads the Outcome Learning aggregates (won/lost quote history) and the
 * quote lifecycle, detects pricing/close-rate patterns, and emits recommendation
 * objects for a person to review. It has NO price-mutation path: it never edits
 * the rate card, never changes a quote price, never sends anything. Every
 * recommendation carries reviewRequired:true.
 *
 * Pipeline:
 *   analyze()                  → deterministic recommendations (stable ids),
 *                                each with a built-in Supervisor critique
 *                                (approve / reject / needs_more_data) and any
 *                                persisted human/prediction state overlaid.
 *   review(id, {decision})     → human marks a rec reviewed/rejected, routed
 *                                through the gateway (REVIEW_PRICING, audited).
 *   createPrediction(id)       → logs an agent_decisions "prediction" so the
 *                                Prediction Ledger can track expected vs actual,
 *                                and links recommendation.predictionId.
 *
 * Persisted human/supervisor/prediction state lives in the owner-only
 * `pricing_recommendations` collection; the analytical recommendations are
 * recomputed each time (stable ids) and that state is overlaid.
 */
;(function (global) {
  'use strict';

  const RECS = 'pricing_recommendations';

  function cfg() { return global.AAA_CONFIG || {}; }
  function data() { return global.AAA_DATA; }
  function ids() { return global.AAA_ID_FACTORY; }
  function clock() { return global.AAA_RUNTIME_CLOCK; }
  function gateway() { return global.AAA_RUNTIME_GATEWAY; }
  function learning() { return global.AAA_OUTCOME_LEARNING; }
  function ws() { return cfg().workspaceId || 'default'; }
  function nowISO() { return clock() && clock().nowISO ? clock().nowISO() : new Date().toISOString(); }
  function mine(r) { return r && (r.workspaceId == null || r.workspaceId === ws()); }
  function num(v) { const n = Number(v); return isFinite(n) ? n : 0; }
  function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }

  function T() {
    const f = (k, d) => (cfg().flag ? cfg().flag(k, d) : d);
    return {
      minSample: num(f('optMinSample', 3)),        // below this, "needs more data"
      thinMarginPct: num(f('optThinMarginPct', 15)),
      lowWinRate: num(f('optLowWinRate', 0.34)),    // segment win rate considered weak
      strongWinRate: num(f('optStrongWinRate', 0.6))
    };
  }

  const SPEC = {
    agentId: 'pricing_optimizer',
    agentType: 'intelligence.advisory',
    name: 'Pricing Optimizer',
    description: 'Learns from won/lost quotes and recommends pricing, follow-up, and close-rate improvements. Recommendation-only — it never changes a price.',
    allowedActions: ['read_quote_outcomes', 'detect_patterns', 'recommend', 'log_prediction', 'log_decision'],
    blockedActions: ['change_price', 'edit_rate_card', 'modify_quote', 'send_to_customer', 'post_accounting', 'apply_changes_automatically'],
    inputs: ['won/lost quote aggregates (service/zip/lead source/price/margin/risk bands)', 'loss reasons', 'follow-up effectiveness'],
    outputs: ['recommendations { title, reasoning, confidence, risk, supportingQuoteIds, recommendedAction, expectedKpiImpact, reviewRequired:true, supervisorReview }'],
    confidenceModel: 'Scales with segment sample size and effect strength (deviation from the overall win rate / margin floor).',
    riskModel: 'Risk of ACTING on the recommendation: raising prices on a weak segment is riskier than focusing marketing on a strong one; small samples raise risk.',
    memoryReads: ['quotes (owner-only)'],
    memoryWrites: ['pricing_recommendations (review/supervisor/prediction state)', 'agent_decisions (prediction entries)'],
    auditEvents: ['REVIEW_PRICING (audit_log) when a person reviews/acts on a recommendation'],
    supervisorReview: 'Every recommendation is critiqued deterministically (approve / reject / needs_more_data) with risk flags + a confidence adjustment before a human sees it. The Supervisor never applies a change.',
    humanApprovalThreshold: 'Always. reviewRequired:true on every recommendation; nothing is applied automatically.',
    kpiImpact: ['close rate', 'gross margin', 'marketing ROI by lead source/zip', 'follow-up speed']
  };

  const Optimizer = {
    SPEC: SPEC, RECS: RECS,

    /** Deterministic analysis → recommendations (read-only). */
    async analyze() {
      if (!learning()) return { ok: false, error: 'NO_LEARNING_STORE' };
      const agg = await learning().aggregate();
      const th = T();
      const recs = [];

      // 1) Too many losses at a price band.
      agg.byPriceBand.forEach((b) => {
        if (b.key === 'unknown' || b.count < th.minSample) return;
        if (b.winRate != null && b.winRate < th.lowWinRate && agg.overall.winRate != null && b.winRate < agg.overall.winRate) {
          recs.push(mk('price_band_losses', b.key,
            'Low win rate in the ' + b.key + ' price band',
            'Only ' + pctStr(b.winRate) + ' of ' + b.count + ' quotes in the ' + b.key + ' band closed (company avg ' + pctStr(agg.overall.winRate) + '). Pricing or positioning in this band may be off.',
            confFromSample(b.count, Math.abs((agg.overall.winRate || 0) - b.winRate)), riskFor('raise_price', b.count),
            b.quoteIds, 'Review pricing/scope for ' + b.key + ' jobs and test a positioning change on the next few.',
            'Lift close rate in this band toward ' + pctStr(agg.overall.winRate)));
        }
      });

      // 2) Low-margin wins.
      if (agg.lowMarginWins.length >= 1) {
        const ids2 = agg.lowMarginWins.map((w) => w.quoteId);
        recs.push(mk('low_margin_wins', 'all',
          agg.lowMarginWins.length + ' low-margin win(s) (< ' + th.thinMarginPct + '%)',
          'These jobs were won but at thin margins. Recurrng thin margins suggest underpricing or rising costs in this work.',
          confFromSample(agg.lowMarginWins.length, 0.5), riskFor('raise_price', agg.lowMarginWins.length),
          ids2, 'Review costs and consider a price floor; verify estimates covered material/labor.',
          'Protect ~' + agg.lowMarginWins.length + ' jobs of margin'));
      }

      // 3) Strong service/zip combinations (tagged with their segment dimension).
      const strongRec = (g, dim) => {
        if (g.key === 'unknown' || g.key === 'unspecified' || g.count < th.minSample) return;
        if (g.winRate != null && g.winRate >= th.strongWinRate && (g.avgMarginPct == null || g.avgMarginPct >= th.thinMarginPct)) {
          recs.push(mk('strong_segment', g.key,
            'Strong segment: ' + g.key,
            g.key + ' closes at ' + pctStr(g.winRate) + ' over ' + g.count + ' quotes' + (g.avgMarginPct != null ? ' at ~' + g.avgMarginPct + '% margin' : '') + '. A reliable, profitable segment to lean into.',
            confFromSample(g.count, g.winRate - 0.5), riskFor('focus_marketing', g.count),
            g.quoteIds, 'Direct more marketing/lead spend toward ' + g.key + '.',
            'Grow volume in a proven segment', dim));
        }
      };
      agg.byServiceType.forEach((g) => strongRec(g, 'serviceType'));
      agg.byZip.forEach((g) => strongRec(g, 'zip'));

      // 4) Weak lead sources.
      agg.byLeadSource.forEach((g) => {
        if (g.key === 'unknown' || g.count < th.minSample) return;
        if (g.winRate != null && g.winRate < th.lowWinRate) {
          recs.push(mk('weak_lead_source', g.key,
            'Weak lead source: ' + g.key,
            g.key + ' converts at only ' + pctStr(g.winRate) + ' over ' + g.count + ' quotes. Spend here may be underperforming.',
            confFromSample(g.count, Math.abs((agg.overall.winRate || 0) - g.winRate)), riskFor('cut_spend', g.count),
            g.quoteIds, 'Qualify leads from ' + g.key + ' harder, or shift budget to stronger sources.',
            'Improve marketing ROI'));
        }
      });

      // 5) Follow-up delays hurting close rate.
      const fu = agg.followUp;
      if (fu.avgDaysToWin != null && fu.avgDaysToLoss != null && fu.avgDaysToLoss > fu.avgDaysToWin + 1) {
        recs.push(mk('followup_delay', 'all',
          'Follow-up delays may be hurting close rate',
          'Lost quotes took ~' + fu.avgDaysToLoss + ' days from send to resolution vs ~' + fu.avgDaysToWin + ' for wins. Slower follow-up correlates with losses here.',
          55, 15, [], 'Follow up on sent quotes within ' + Math.max(1, Math.round(fu.avgDaysToWin)) + ' day(s).',
          'Faster follow-up → higher close rate'));
      }
      if (fu.withFollowUp.winRate != null && fu.withoutFollowUp.winRate != null && fu.withFollowUp.winRate > fu.withoutFollowUp.winRate && fu.withoutFollowUp.count >= th.minSample) {
        recs.push(mk('followup_effective', 'all',
          'Following up clearly helps',
          'Quotes with a follow-up close at ' + pctStr(fu.withFollowUp.winRate) + ' vs ' + pctStr(fu.withoutFollowUp.winRate) + ' without. Make follow-up the default.',
          60, 10, [], 'Queue a follow-up on every sent quote.',
          'Lift close rate by following up'));
      }

      // 6) High-risk jobs needing review.
      if (agg.highRiskResolved.length >= th.minSample) {
        recs.push(mk('high_risk_jobs', 'all',
          agg.highRiskResolved.length + ' high-risk jobs to scope carefully',
          'A cluster of high-risk quotes resolved recently. High-risk jobs deserve a scope/price double-check before quoting.',
          confFromSample(agg.highRiskResolved.length, 0.4), 20,
          agg.highRiskResolved.map((q) => q.quoteId), 'Add a scope-review step before quoting high-risk jobs.',
          'Reduce margin surprises on risky jobs'));
      }

      // Overlay persisted human/supervisor/prediction state + attach supervisor critique.
      const persisted = await this._persistedMap();
      const enriched = recs.map((r) => {
        const p = persisted[r.id] || {};
        const review = this.supervisorReview(r);
        return Object.assign({}, r, {
          supervisorReview: review,
          adjustedConfidence: review.adjustedConfidence,
          status: p.status || 'open',
          reviewedBy: p.reviewedBy || null, reviewedAt: p.reviewedAt || null,
          supervisorNote: p.supervisorNote || review.note,
          predictionId: p.predictionId || null
        });
      });

      return {
        ok: true, generatedAt: nowISO(),
        summary: { winRate: agg.overall.winRate, resolved: agg.overall.resolved, avgMarginPct: agg.overall.avgMarginPct, recommendations: enriched.length },
        topLossReasons: agg.lossReasons.slice(0, 5),
        followUp: agg.followUp,
        recommendations: enriched.sort((a, b) => b.adjustedConfidence - a.adjustedConfidence)
      };
    },

    /**
     * Deterministic Supervisor critique of a recommendation. Approve / reject /
     * needs_more_data + risk flags + a confidence adjustment. NEVER applies a
     * change — it only annotates.
     */
    supervisorReview(rec) {
      const th = T();
      const flags = [];
      let adj = 0; let verdict = 'approve';
      const sample = (rec.supportingQuoteIds || []).length;
      if (sample > 0 && sample < th.minSample) { verdict = 'needs_more_data'; adj -= 20; flags.push('small sample (' + sample + ')'); }
      if (rec.risk >= 60) { flags.push('high action risk'); adj -= 10; if (verdict === 'approve') verdict = 'needs_more_data'; }
      if (rec.type === 'weak_lead_source' && sample < th.minSample + 2) { flags.push('cutting spend on a small sample is risky'); adj -= 5; }
      if (rec.confidence >= 70 && rec.risk < 40 && verdict === 'approve') flags.push('well-supported');
      const adjusted = clamp(Math.round(num(rec.confidence) + adj), 0, 100);
      const note = verdict === 'approve' ? 'Supervisor: reasonable to act on after a human review.'
        : verdict === 'needs_more_data' ? 'Supervisor: gather a few more outcomes before acting — sample/risk is borderline.'
        : 'Supervisor: do not act yet.';
      return { verdict: verdict, note: note, riskFlags: flags, confidenceAdjustment: adj, adjustedConfidence: adjusted };
    },

    /** Human review of a recommendation — audited (REVIEW_PRICING). Never changes a price. */
    async review(recId, opts) {
      const o = opts || {};
      const decision = o.decision === 'rejected' ? 'rejected' : 'reviewed';
      const gw = gateway();
      if (!gw) return { ok: false, error: 'NO_GATEWAY' };
      const res = await gw.run({
        action: 'REVIEW_PRICING', origin: o.origin === 'ai' ? 'ai' : 'human', actor: o.actor || null,
        target: { type: 'pricing_recommendation', id: recId }, detail: { decision: decision },
        mutate: async () => {
          const existing = (await this._get(recId)) || { id: recId, workspaceId: ws() };
          const rec = Object.assign({}, existing, { id: recId, workspaceId: ws(), status: decision, reviewedBy: o.actor || null, reviewedAt: nowISO(), supervisorNote: o.note || existing.supervisorNote || null, updatedAt: nowISO() });
          await put(rec);
          return rec;
        }
      });
      if (!res.ok) return res;          // AI-origin or RBAC denial (audited)
      return { ok: true, recommendation: res.result, auditId: res.auditId };
    },

    /**
     * Create a Prediction Ledger entry for a recommendation: an agent_decisions
     * record (so the ledger tracks expected vs actual) linked back to the rec.
     */
    async createPrediction(rec, opts) {
      const o = opts || {};
      if (!rec || !rec.id) return { ok: false, error: 'NO_REC' };
      const predId = ids() ? ids().createId('pred') : 'pred_' + Date.now();
      // Capture the segment's CURRENT metric as the baseline, so a later closure
      // can measure observed (post-prediction) movement against it.
      let baseline = { value: null, sample: 0 };
      try { if (learning()) baseline = baselineFor(await learning().aggregate(), rec); } catch (_) {}
      const decision = {
        id: predId, agent: SPEC.agentId, kind: 'pricing_prediction',
        recommendationId: rec.id, recommendationType: rec.type, segment: rec.segment,
        segmentDim: rec.segmentDim, metric: rec.metric, expectedDirection: rec.expectedDirection,
        baseline: baseline.value, baselineSample: baseline.sample,
        recommendation: rec.title, confidence: rec.adjustedConfidence != null ? rec.adjustedConfidence : rec.confidence,
        expectedKpiImpact: rec.expectedKpiImpact || null, jobId: null,
        workspaceId: ws(), createdAt: nowISO()
      };
      try {
        await data().put('agent_decisions', predId, decision);
        if (data().cloudReady && data().cloudReady() && global.AAA_CLOUD) await global.AAA_CLOUD.upsertEntity('agent_decisions', predId, decision);
      } catch (_) {}
      // Link rec → prediction (persist).
      const existing = (await this._get(rec.id)) || { id: rec.id, workspaceId: ws() };
      await put(Object.assign({}, existing, { id: rec.id, workspaceId: ws(), predictionId: predId, updatedAt: nowISO() }));
      return { ok: true, predictionId: predId, decision: decision };
    },

    // ---- internals ----
    async _get(id) { const r = await data().get(RECS, id); return mine(r) ? r : null; },
    async _persistedMap() {
      const all = (await data().list(RECS)).filter(mine);
      const map = {}; all.forEach((r) => { map[r.id] = r; }); return map;
    }
  };

  // ---- recommendation factory + scoring helpers ----
  // What KPI each recommendation type expects to move, and in which segment
  // dimension — so a later closure can measure baseline vs observed objectively.
  const TYPE_META = {
    price_band_losses:  { segmentDim: 'priceBand',  metric: 'winRate',      expectedDirection: 'up' },
    low_margin_wins:    { segmentDim: 'marginAll',  metric: 'avgMarginPct', expectedDirection: 'up' },
    strong_segment:     { segmentDim: 'serviceType', metric: 'winRate',     expectedDirection: 'maintain_high' },
    weak_lead_source:   { segmentDim: 'leadSource', metric: 'winRate',      expectedDirection: 'up' },
    followup_delay:     { segmentDim: 'all',        metric: 'winRate',      expectedDirection: 'up' },
    followup_effective: { segmentDim: 'all',        metric: 'winRate',      expectedDirection: 'up' },
    high_risk_jobs:     { segmentDim: 'riskHigh',   metric: 'avgMarginPct', expectedDirection: 'up' }
  };

  function mk(type, segment, title, reasoning, confidence, risk, supportingQuoteIds, recommendedAction, expectedKpiImpact, segmentDimOverride) {
    const meta = TYPE_META[type] || { segmentDim: 'all', metric: 'winRate', expectedDirection: 'up' };
    return {
      id: 'rec_' + type + '_' + slug(segment), type: type, segment: segment,
      segmentDim: segmentDimOverride || meta.segmentDim, metric: meta.metric, expectedDirection: meta.expectedDirection,
      title: title, reasoning: reasoning,
      confidence: clamp(Math.round(confidence), 0, 100), risk: clamp(Math.round(risk), 0, 100),
      supportingQuoteIds: (supportingQuoteIds || []).slice(0, 50),
      recommendedAction: recommendedAction, expectedKpiImpact: expectedKpiImpact,
      reviewRequired: true
    };
  }
  function confFromSample(n, effect) {
    // More samples + bigger effect → more confident, capped (never certain).
    const base = 30 + Math.min(40, n * 8) + Math.round(clamp(effect, 0, 1) * 25);
    return clamp(base, 20, 90);
  }
  function riskFor(action, n) {
    const small = n < 3 ? 20 : (n < 6 ? 10 : 0);
    const base = { raise_price: 35, cut_spend: 35, focus_marketing: 10 }[action] != null ? { raise_price: 35, cut_spend: 35, focus_marketing: 10 }[action] : 20;
    return clamp(base + small, 0, 100);
  }
  // Extract a recommendation's baseline metric from the current aggregate.
  function baselineFor(agg, rec) {
    const dim = rec.segmentDim, key = rec.segment, metric = rec.metric;
    if (dim === 'all' || dim === 'marginAll') {
      return { value: metric === 'winRate' ? (agg.overall ? agg.overall.winRate : null) : (agg.overall ? agg.overall.avgMarginPct : null), sample: agg.overall ? agg.overall.resolved : 0 };
    }
    const groups = dim === 'priceBand' ? agg.byPriceBand : dim === 'serviceType' ? agg.byServiceType : dim === 'zip' ? agg.byZip : dim === 'leadSource' ? agg.byLeadSource : dim === 'riskHigh' ? agg.byRiskBand : [];
    const g = (groups || []).find((x) => x.key === (dim === 'riskHigh' ? 'high' : key));
    if (!g) return { value: null, sample: 0 };
    return { value: metric === 'winRate' ? g.winRate : g.avgMarginPct, sample: g.count };
  }
  function pctStr(r) { return r == null ? '—' : Math.round(r * 100) + '%'; }
  function slug(s) { return String(s == null ? 'all' : s).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 40) || 'all'; }
  async function put(rec) {
    await data().put(RECS, rec.id, rec);
    try { if (data().cloudReady && data().cloudReady() && global.AAA_CLOUD) global.AAA_CLOUD.upsertEntity(RECS, rec.id, rec); } catch (_) {}
  }

  global.AAA_PRICING_OPTIMIZER = Optimizer;
})(typeof window !== 'undefined' ? window : this);
