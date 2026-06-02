/*
 * AAA Agent Scorecards — performance measurement per agent, computed from the
 * Agent Outcome Registry, persisted, and (when a line is crossed) escalated.
 *
 * Pure metric math is exported for tests. Recompute persists the scorecard,
 * audits material score changes (score_changed), and raises governance breach
 * escalations for low accuracy / override spikes / broken calibration / ROI
 * drops. It NEVER changes an agent — measurement only.
 */
;(function (global) {
  'use strict';

  function data() { return global.AAA_DATA; }
  function ledger() { return global.AAA_AUDIT_LEDGER; }
  function cfg() { return global.AAA_CONFIG || {}; }
  function clock() { return global.AAA_RUNTIME_CLOCK; }
  function esc() { return global.AAA_GOVERNANCE_ESCALATION; }
  function outcomes() { return global.AAA_AGENT_OUTCOMES; }
  function now() { return clock() && clock().now ? clock().now() : Date.now(); }

  const CARDS = 'gov_agent_scorecards';

  function flag(k, d) { return cfg().flag ? cfg().flag(k, d) : d; }
  function thresholds() {
    return {
      minAccuracy: +flag('govMinAccuracy', 0.6),
      maxOverrideRate: +flag('govMaxOverrideRate', 0.3),
      minCalibration: +flag('govMinCalibration', 0.5),
      roiDropPct: +flag('govRoiDropPct', 0.25),
      minSample: +flag('govMinSample', 5),
      driftDelta: +flag('govDriftDelta', 0.15),
      driftWindowMs: +flag('govDriftWindowMs', 30 * 24 * 60 * 60 * 1000)
    };
  }

  function mean(a) { return a.length ? a.reduce(function (x, y) { return x + y; }, 0) / a.length : null; }
  function round(n, p) { if (n == null) return null; const f = Math.pow(10, p == null ? 3 : p); return Math.round(n * f) / f; }

  // ---- pure metric computation (exported) -----------------------------------

  /**
   * Compute a scorecard from one agent's decisions. Metrics are null (unknown)
   * when the sample is too thin — a new agent is unproven, never falsely "bad".
   * Positive/negative framing for FP/FN uses a 0.5 confidence threshold over
   * resolved binary outcomes (successful=1, unsuccessful=0).
   */
  function computeScorecard(agentType, decisions) {
    const list = Array.isArray(decisions) ? decisions : [];
    const considered = list.filter(function (d) { return d.outcomeStatus !== 'pending' && d.outcomeStatus !== 'abandoned'; });
    const successful = list.filter(function (d) { return d.outcomeStatus === 'successful'; });
    const unsuccessful = list.filter(function (d) { return d.outcomeStatus === 'unsuccessful'; });
    const overridden = list.filter(function (d) { return d.outcomeStatus === 'overridden'; });
    const binary = successful.concat(unsuccessful); // resolved with a clear right/wrong
    const conf = list.map(function (d) { return d.confidence; }).filter(function (c) { return c != null; });

    // ROI / revenue from outcome values (successful add, unsuccessful subtract).
    const val = function (d) { return d.outcome && d.outcome.value != null ? +d.outcome.value : 0; };
    const revenueInfluenced = successful.reduce(function (s, d) { return s + val(d); }, 0);
    const lossInfluenced = unsuccessful.reduce(function (s, d) { return s + val(d); }, 0);

    // FP/FN over the binary set using a 0.5 confidence threshold.
    let tp = 0, fp = 0, tn = 0, fn = 0;
    binary.forEach(function (d) {
      const predPos = (d.confidence == null ? 0.5 : d.confidence) >= 0.5;
      const actualPos = d.outcomeStatus === 'successful';
      if (predPos && actualPos) tp++;
      else if (predPos && !actualPos) fp++;
      else if (!predPos && actualPos) fn++;
      else tn++;
    });

    // Brier-based calibration over binary outcomes: 1 best … 0 worst.
    const calib = binary.length
      ? 1 - mean(binary.map(function (d) { const p = d.confidence == null ? 0.5 : d.confidence; const a = d.outcomeStatus === 'successful' ? 1 : 0; return (p - a) * (p - a); }))
      : null;

    return {
      agentType: agentType,
      samples: { total: list.length, considered: considered.length, resolved: binary.length, successful: successful.length, unsuccessful: unsuccessful.length, overridden: overridden.length },
      accuracy: binary.length ? round(successful.length / binary.length) : null,
      successRate: considered.length ? round(successful.length / considered.length) : null,
      overrideRate: considered.length ? round(overridden.length / considered.length) : null,
      averageConfidence: conf.length ? round(mean(conf)) : null,
      confidenceCalibration: round(calib),
      revenueInfluenced: round(revenueInfluenced, 2),
      roiImpact: round(revenueInfluenced - lossInfluenced, 2),
      falsePositiveRate: (fp + tn) ? round(fp / (fp + tn)) : null,
      falseNegativeRate: (fn + tp) ? round(fn / (fn + tp)) : null,
      computedAt: now()
    };
  }

  /** Accuracy drift: recent window vs prior window. Returns {drifting, recent, prior} or null. */
  function computeDrift(decisions, atNow, windowMs, minSample, delta) {
    const binary = (decisions || []).filter(function (d) { return d.outcomeStatus === 'successful' || d.outcomeStatus === 'unsuccessful'; });
    const cut = atNow - windowMs;
    const recent = binary.filter(function (d) { return (d.updatedAt || d.timestamp || 0) >= cut; });
    const prior = binary.filter(function (d) { return (d.updatedAt || d.timestamp || 0) < cut; });
    if (recent.length < minSample || prior.length < minSample) return null;
    const acc = function (set) { return set.filter(function (d) { return d.outcomeStatus === 'successful'; }).length / set.length; };
    const recentAcc = acc(recent), priorAcc = acc(prior);
    return { drifting: (priorAcc - recentAcc) >= delta, recent: round(recentAcc), prior: round(priorAcc), drop: round(priorAcc - recentAcc) };
  }

  /** Which thresholds a scorecard breaches (pure). Honors minSample. */
  function detectBreaches(card, prev, th) {
    const out = [];
    if (!card || card.samples.considered < th.minSample) return out;
    if (card.accuracy != null && card.accuracy < th.minAccuracy) {
      out.push({ metric: 'accuracy', value: card.accuracy, threshold: th.minAccuracy, severity: card.accuracy < th.minAccuracy / 2 ? 'critical' : 'high', detail: 'Accuracy below threshold.' });
    }
    if (card.overrideRate != null && card.overrideRate > th.maxOverrideRate) {
      out.push({ metric: 'overrideRate', value: card.overrideRate, threshold: th.maxOverrideRate, severity: 'high', detail: 'Override rate spiking.' });
    }
    if (card.confidenceCalibration != null && card.confidenceCalibration < th.minCalibration) {
      out.push({ metric: 'confidenceCalibration', value: card.confidenceCalibration, threshold: th.minCalibration, severity: 'high', detail: 'Confidence calibration broken.' });
    }
    if (prev && prev.roiImpact != null && card.roiImpact != null && prev.roiImpact > 0) {
      const drop = (prev.roiImpact - card.roiImpact) / Math.abs(prev.roiImpact);
      if (drop >= th.roiDropPct) out.push({ metric: 'roiImpact', value: card.roiImpact, threshold: round(prev.roiImpact * (1 - th.roiDropPct), 2), severity: 'high', detail: 'ROI dropped ' + Math.round(drop * 100) + '% vs prior.' });
    }
    return out;
  }

  // Did any headline metric move materially since the last scorecard?
  function materiallyChanged(prev, card) {
    if (!prev) return true;
    const keys = ['accuracy', 'successRate', 'overrideRate', 'confidenceCalibration', 'roiImpact', 'falsePositiveRate', 'falseNegativeRate'];
    return keys.some(function (k) {
      const a = prev[k], b = card[k];
      if (a == null && b == null) return false;
      if (a == null || b == null) return true;
      return Math.abs(a - b) >= (k === 'roiImpact' ? 0.01 : 0.02);
    });
  }

  async function audit(type, payload) {
    try { if (ledger() && ledger().append) return await ledger().append(type, payload); } catch (_) {}
    return null;
  }

  function recommendFor(metric) {
    return ({
      accuracy: 'Sample failed cases; review/retrain the agent prompt and decision rules.',
      overrideRate: 'Humans frequently overrule this agent — review its prompt or guardrail threshold.',
      confidenceCalibration: 'Confidence is miscalibrated — recalibrate or down-weight its stated confidence.',
      roiImpact: 'ROI is falling — pause auto-actions and review this agent before relying on it.'
    })[metric] || 'Review this agent against recent outcomes.';
  }

  const Scorecards = {
    CARDS: CARDS,
    // pure
    computeScorecard: computeScorecard,
    computeDrift: computeDrift,
    detectBreaches: detectBreaches,
    materiallyChanged: materiallyChanged,
    thresholds: thresholds,

    async get(agentType) { return (data() && data().get) ? data().get(CARDS, agentType) : null; },
    async list() { return (data() && data().list) ? data().list(CARDS) : []; },

    /**
     * Recompute one agent's scorecard from its decisions: persist it, audit a
     * material change, and raise breach escalations. Returns
     * { ok, scorecard, changed, breaches, escalations }.
     */
    async recompute(agentType) {
      if (!outcomes()) return { ok: false, error: 'NO_REGISTRY' };
      const th = thresholds();
      const decisions = await outcomes().decisionsForAgent(agentType);
      const prev = await this.get(agentType);
      const card = computeScorecard(agentType, decisions);
      const drift = computeDrift(decisions, now(), th.driftWindowMs, th.minSample, th.driftDelta);
      card.drift = drift;

      const changed = materiallyChanged(prev, card);
      if (data() && data().put) await data().put(CARDS, agentType, card);
      if (changed) {
        await audit('score_changed', { agentType: agentType, previous: prev ? pick(prev) : null, current: pick(card), at: card.computedAt });
      }

      // Breach escalations (drop ROI uses the previous card as the baseline).
      const breaches = detectBreaches(card, prev, th);
      if (drift && drift.drifting) breaches.push({ metric: 'accuracyDrift', value: drift.recent, threshold: drift.prior, severity: 'high', detail: 'Accuracy drifting down (' + drift.prior + ' → ' + drift.recent + ').' });
      const escalations = [];
      if (esc() && esc().escalateBreach) {
        for (const b of breaches) {
          try {
            const r = await esc().escalateBreach({
              kind: 'agent_' + b.metric, domain: 'agent', category: agentType,
              metric: b.metric, value: b.value, threshold: b.threshold, severity: b.severity,
              detail: b.detail, recommendedAction: recommendFor(b.metric),
              affectedCaseIds: decisions.filter(function (d) { return d.outcomeStatus === 'unsuccessful' || d.outcomeStatus === 'overridden'; }).map(function (d) { return d.decisionId; }).slice(0, 25)
            });
            if (r && r.escalation) escalations.push(r.escalation);
          } catch (_) { /* escalation is additive */ }
        }
      }
      return { ok: true, scorecard: card, changed: changed, breaches: breaches, escalations: escalations };
    },

    /** Recompute scorecards for every agent type seen in the registry. */
    async recomputeAll() {
      if (!outcomes()) return { ok: false, error: 'NO_REGISTRY' };
      const types = (await outcomes().listDecisions()).map(function (d) { return d.agentType; }).filter(function (v, i, a) { return v && a.indexOf(v) === i; });
      const cards = [];
      for (const tpe of types) cards.push((await this.recompute(tpe)).scorecard);
      return { ok: true, scorecards: cards };
    },

    /** Dashboard groupings: top/worst/drifting/excessive-overrides/needs-retraining. */
    async insights() {
      const th = thresholds();
      const cards = (await this.list()).filter(function (c) { return c.samples && c.samples.considered >= th.minSample; });
      const byRate = cards.slice().sort(function (a, b) { return (b.successRate || 0) - (a.successRate || 0); });
      return {
        top: byRate.slice(0, 5),
        worst: byRate.slice().reverse().slice(0, 5),
        drifting: cards.filter(function (c) { return c.drift && c.drift.drifting; }),
        excessiveOverrides: cards.filter(function (c) { return c.overrideRate != null && c.overrideRate > th.maxOverrideRate; }),
        needingRetraining: cards.filter(function (c) { return (c.accuracy != null && c.accuracy < th.minAccuracy) || (c.confidenceCalibration != null && c.confidenceCalibration < th.minCalibration); })
      };
    }
  };

  // Compact headline metrics for the audit diff.
  function pick(c) {
    return { accuracy: c.accuracy, successRate: c.successRate, overrideRate: c.overrideRate, confidenceCalibration: c.confidenceCalibration, roiImpact: c.roiImpact, falsePositiveRate: c.falsePositiveRate, falseNegativeRate: c.falseNegativeRate };
  }

  global.AAA_AGENT_SCORECARDS = Scorecards;
})(typeof window !== 'undefined' ? window : this);
