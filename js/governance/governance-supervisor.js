/*
 * AAA Governance Supervisor — FOUNDATION ONLY.
 *
 * This is the seam where future supervisor agents will analyze agent scorecards
 * and recommend changes (e.g. prompt tweaks, confidence recalibration). Phase 1
 * builds the interfaces and a transparent heuristic recommender — it produces
 * RECOMMENDATIONS that are logged to the immutable ledger and queued for a human.
 *
 * Hard guarantee: NO autonomous retraining or prompt modification. applyChange()
 * is intentionally disabled; analyzers may only return recommendations.
 */
;(function (global) {
  'use strict';

  function ledger() { return global.AAA_AUDIT_LEDGER; }
  function cards() { return global.AAA_AGENT_SCORECARDS; }
  function data() { return global.AAA_DATA; }
  function clock() { return global.AAA_RUNTIME_CLOCK; }
  function now() { return clock() && clock().now ? clock().now() : Date.now(); }

  const RECS = 'gov_retraining_recommendations';

  async function audit(type, payload) {
    try { if (ledger() && ledger().append) return await ledger().append(type, payload); } catch (_) {}
    return null;
  }

  // Transparent baseline analyzer: turns a scorecard into recommendations.
  function baseAnalyzer(card, th) {
    if (!card || !card.samples || card.samples.considered < th.minSample) return [];
    // Recommendation confidence rises with sample size (transparent, bounded).
    const n = card.samples ? card.samples.considered : 0;
    const conf = Math.round((n / (n + 5)) * 100) / 100;
    const ev = function (metric, value, threshold) { return { metric: metric, value: value, threshold: threshold, samples: n }; };
    const mk = function (r) { return Object.assign({ riskLevel: r.severity, confidence: conf, evidence: ev(r.metric, r.value, r.threshold) }, r); };

    const recs = [];
    if (card.accuracy != null && card.accuracy < th.minAccuracy) {
      recs.push(mk({ type: 'review_prompt', severity: 'high', metric: 'accuracy', value: card.accuracy, threshold: th.minAccuracy, reason: 'Accuracy ' + card.accuracy + ' < ' + th.minAccuracy, suggestedAction: 'Sample failed cases and revise the agent prompt/decision rules.', expectedKpiImpact: 'Higher win/accuracy rate; fewer bad recommendations.' }));
    }
    if (card.confidenceCalibration != null && card.confidenceCalibration < th.minCalibration) {
      recs.push(mk({ type: 'recalibrate_confidence', severity: 'medium', metric: 'confidenceCalibration', value: card.confidenceCalibration, threshold: th.minCalibration, reason: 'Calibration ' + card.confidenceCalibration + ' < ' + th.minCalibration, suggestedAction: 'Down-weight or recalibrate the agent stated confidence.', expectedKpiImpact: 'More trustworthy confidence; better routing/escalation decisions.' }));
    }
    if (card.overrideRate != null && card.overrideRate > th.maxOverrideRate) {
      recs.push(mk({ type: 'review_guardrail', severity: 'high', metric: 'overrideRate', value: card.overrideRate, threshold: th.maxOverrideRate, reason: 'Override rate ' + card.overrideRate + ' > ' + th.maxOverrideRate, suggestedAction: 'Humans overrule this agent often — review its prompt or the guardrail threshold.', expectedKpiImpact: 'Fewer human overrides; less wasted review time.' }));
    }
    if (card.roiImpact != null && card.roiImpact < 0) {
      recs.push(mk({ type: 'pause_and_review', severity: 'critical', metric: 'roiImpact', value: card.roiImpact, threshold: 0, reason: 'Negative ROI impact (' + card.roiImpact + ')', suggestedAction: 'Pause any auto-actions from this agent and review before relying on it.', expectedKpiImpact: 'Stops ROI bleed; protects revenue.' }));
    }
    if (card.drift && card.drift.drifting) {
      recs.push(mk({ type: 'investigate_drift', severity: 'high', metric: 'accuracyDrift', value: card.drift.recent, threshold: card.drift.prior, reason: 'Accuracy drifting (' + card.drift.prior + ' → ' + card.drift.recent + ')', suggestedAction: 'Investigate what changed; consider re-grounding or retraining.', expectedKpiImpact: 'Recovers lost accuracy; catches regressions early.' }));
    }
    return recs;
  }

  const Supervisor = {
    // Future supervisor agents register analyzers here (read-only contributors).
    analyzers: [],
    registerAnalyzer(fn) { if (typeof fn === 'function') this.analyzers.push(fn); return this; },

    /**
     * Analyze an agent's scorecard and produce retraining RECOMMENDATIONS.
     * Read-only: persists recommendations to a queue and audits each one. Does
     * not change the agent. Returns { ok, agentType, scorecard, recommendations }.
     */
    async review(agentType) {
      if (!cards()) return { ok: false, error: 'NO_SCORECARDS' };
      const th = cards().thresholds();
      const card = await cards().get(agentType);
      if (!card) return { ok: false, error: 'NO_SCORECARD', agentType: agentType };

      let recs = baseAnalyzer(card, th);
      // Future supervisor agents contribute; failures are isolated.
      for (const fn of this.analyzers) {
        try { const extra = await fn(card, th); if (Array.isArray(extra)) recs = recs.concat(extra); } catch (_) {}
      }

      const stored = [];
      for (const rec of recs) {
        const entry = {
          id: (global.AAA_ID_FACTORY && global.AAA_ID_FACTORY.createId) ? global.AAA_ID_FACTORY.createId('rec') : ('rec_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6)),
          agentType: agentType, type: rec.type, severity: rec.severity, metric: rec.metric, value: rec.value,
          issue: rec.reason, reason: rec.reason, suggestedAction: rec.suggestedAction,
          evidence: rec.evidence || null, expectedKpiImpact: rec.expectedKpiImpact || null,
          riskLevel: rec.riskLevel || rec.severity, confidence: rec.confidence != null ? rec.confidence : null,
          status: 'proposed', autonomous: false, createdAt: now()
        };
        if (data() && data().put) await data().put(RECS, entry.id, entry);
        await audit('retraining_recommendation', { recId: entry.id, agentType: agentType, type: rec.type, metric: rec.metric, value: rec.value, severity: rec.severity, riskLevel: entry.riskLevel, confidence: entry.confidence, evidence: entry.evidence, expectedKpiImpact: entry.expectedKpiImpact, reason: rec.reason, suggestedAction: rec.suggestedAction, autonomous: false, at: entry.createdAt });
        rec.id = entry.id;
        stored.push(entry);
      }
      return { ok: true, agentType: agentType, scorecard: card, recommendations: recs, stored: stored };
    },

    async recommendations() { return (data() && data().list) ? data().list(RECS) : []; },

    /**
     * HOOK (disabled): where a future, human-approved supervisor could apply a
     * change. Phase 1 forbids autonomous modification — always refuses.
     */
    async applyChange() { return { ok: false, error: 'AUTONOMOUS_CHANGES_DISABLED' }; }
  };

  global.AAA_GOVERNANCE_SUPERVISOR = Supervisor;
})(typeof window !== 'undefined' ? window : this);
