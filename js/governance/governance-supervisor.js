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
    const recs = [];
    if (card.accuracy != null && card.accuracy < th.minAccuracy) {
      recs.push({ type: 'review_prompt', severity: 'high', metric: 'accuracy', value: card.accuracy, reason: 'Accuracy ' + card.accuracy + ' < ' + th.minAccuracy, suggestedAction: 'Sample failed cases and revise the agent prompt/decision rules.' });
    }
    if (card.confidenceCalibration != null && card.confidenceCalibration < th.minCalibration) {
      recs.push({ type: 'recalibrate_confidence', severity: 'medium', metric: 'confidenceCalibration', value: card.confidenceCalibration, reason: 'Calibration ' + card.confidenceCalibration + ' < ' + th.minCalibration, suggestedAction: 'Down-weight or recalibrate the agent stated confidence.' });
    }
    if (card.overrideRate != null && card.overrideRate > th.maxOverrideRate) {
      recs.push({ type: 'review_guardrail', severity: 'high', metric: 'overrideRate', value: card.overrideRate, reason: 'Override rate ' + card.overrideRate + ' > ' + th.maxOverrideRate, suggestedAction: 'Humans overrule this agent often — review its prompt or the guardrail threshold.' });
    }
    if (card.roiImpact != null && card.roiImpact < 0) {
      recs.push({ type: 'pause_and_review', severity: 'critical', metric: 'roiImpact', value: card.roiImpact, reason: 'Negative ROI impact (' + card.roiImpact + ')', suggestedAction: 'Pause any auto-actions from this agent and review before relying on it.' });
    }
    if (card.drift && card.drift.drifting) {
      recs.push({ type: 'investigate_drift', severity: 'high', metric: 'accuracyDrift', value: card.drift.recent, reason: 'Accuracy drifting (' + card.drift.prior + ' → ' + card.drift.recent + ')', suggestedAction: 'Investigate what changed; consider re-grounding or retraining.' });
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

      for (const rec of recs) {
        const entry = {
          id: (global.AAA_ID_FACTORY && global.AAA_ID_FACTORY.createId) ? global.AAA_ID_FACTORY.createId('rec') : ('rec_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6)),
          agentType: agentType, type: rec.type, severity: rec.severity, metric: rec.metric, value: rec.value,
          reason: rec.reason, suggestedAction: rec.suggestedAction,
          status: 'proposed', autonomous: false, createdAt: now()
        };
        if (data() && data().put) await data().put(RECS, entry.id, entry);
        await audit('retraining_recommendation', { agentType: agentType, type: rec.type, metric: rec.metric, value: rec.value, severity: rec.severity, reason: rec.reason, suggestedAction: rec.suggestedAction, autonomous: false, at: entry.createdAt });
      }
      return { ok: true, agentType: agentType, scorecard: card, recommendations: recs };
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
