/*
 * AAA Escalation Policy — the one auditable place that decides what is "high-stakes".
 *
 * A single agent's recommendation is cheap and usually right. But some decisions
 * carry enough money, risk, or legal exposure that they should not reach the
 * operator without surviving the Internal Challenge Protocol (Critic → Risk →
 * Counterargument → Supervisor Review). This module makes that escalation rule
 * EXPLICIT and TRACEABLE instead of scattering thresholds through the codebase.
 *
 *   assess(context, proposal) → { highStakes, reasons[], stakesScore, value }   (pure, read-only)
 *   review(proposal, context) → routes a high-stakes proposal through the
 *                               Challenge Protocol; otherwise passes it through.
 *
 * Design principles (from the directive):
 *  - "Optimize causes, not symptoms": the trigger is the stakes of the decision,
 *    not the agent that made it — so any contributor's call can be escalated.
 *  - Frugal: assess() never spends a token; review() only calls the model when a
 *    real high-stakes signal fires AND the proxy is configured. Otherwise it
 *    degrades gracefully to the original proposal (never blocks the business).
 *  - Honest + auditable: every signal that fired is named in `reasons`, and the
 *    escalation is logged so the operator can see WHY it was challenged.
 *
 * Thresholds are config flags (no secrets, owner-overridable):
 *   escalationThresholdUsd   default 1500   — quote value at/above which to challenge
 *   escalationMaterialUsd    default 750    — "material money" floor for the low-confidence rule
 *   escalationDiscountPct    default 15     — discount % at/above which to challenge
 *   escalationMinConfidence  default 60     — below this, a material-money call is challenged
 */
;(function (global) {
  'use strict';

  function cfg() { return global.AAA_CONFIG || { flag: function (_k, d) { return d; } }; }
  function data() { return global.AAA_DATA; }
  function challenge() { return global.AAA_CHALLENGE; }

  // Words that mark a decision as touching legal / contract / safety exposure.
  // Conservative on purpose: a false positive only costs one extra review.
  const EXPOSURE_TERMS = [
    'contract', 'lien', 'insurance', 'liabilit', 'legal', 'lawsuit', 'dispute',
    'refund', 'chargeback', 'license', 'permit', 'hazard', 'mold', 'asbestos',
    'injury', 'damage claim', 'warranty', 'breach', 'penalty'
  ];

  const SEVERE = ['high', 'severe', 'critical'];

  /** Midpoint of a quote like "$200-$400" / "$250" → number, or null. Mirrors supervisor.js. */
  function quoteMidpoint(range) {
    if (range == null) return null;
    const nums = String(range).replace(/,/g, '').match(/\d+(?:\.\d+)?/g);
    if (!nums || !nums.length) return null;
    const vals = nums.map(Number);
    return vals.reduce((a, b) => a + b, 0) / vals.length;
  }

  /** Largest estimated value across a job's estimates (by quote midpoint). */
  function maxEstimateValue(estimates) {
    if (!Array.isArray(estimates)) return null;
    let max = null;
    estimates.forEach((e) => {
      const m = quoteMidpoint(e && e.estimatedQuoteRange);
      if (m != null && (max == null || m > max)) max = m;
    });
    return max;
  }

  function hasSevereEstimate(estimates) {
    return Array.isArray(estimates) && estimates.some((e) => e && SEVERE.indexOf(String(e.severity || '').toLowerCase()) !== -1);
  }

  function mentionsExposure(text) {
    const s = String(text || '').toLowerCase();
    if (!s) return null;
    for (const term of EXPOSURE_TERMS) { if (s.indexOf(term) !== -1) return term; }
    return null;
  }

  const Escalation = {
    /**
     * Decide whether a decision is high-stakes. Pure and read-only — no model
     * calls, no writes. Considers the context (value, severity, exposure,
     * discount) and, when supplied, the proposal's own confidence.
     * @returns { highStakes, reasons:[{signal,detail}], stakesScore, value }
     */
    assess(context, proposal) {
      const ctx = context || {};
      const thresholdUsd = +cfg().flag('escalationThresholdUsd', 1500);
      const materialUsd = +cfg().flag('escalationMaterialUsd', 750);
      const discountPct = +cfg().flag('escalationDiscountPct', 15);
      const minConfidence = +cfg().flag('escalationMinConfidence', 60);

      const reasons = [];
      const value = maxEstimateValue(ctx.estimates);

      if (value != null && value >= thresholdUsd) {
        reasons.push({ signal: 'high_value', detail: 'Estimated value ~$' + Math.round(value) + ' ≥ $' + thresholdUsd });
      }
      if (hasSevereEstimate(ctx.estimates)) {
        reasons.push({ signal: 'severe_condition', detail: 'An estimate is flagged high/severe.' });
      }

      // Legal / contract / safety exposure in the notes or the recommendation itself.
      const exposure = mentionsExposure(ctx.notes) ||
        mentionsExposure(proposal && (proposal.recommendation || proposal.rationale));
      if (exposure) {
        reasons.push({ signal: 'exposure', detail: 'Mentions "' + exposure + '" — legal/contract/safety exposure.' });
      }

      // Discounts above the threshold are classic high-stakes margin decisions.
      const disc = ctx.discountPct != null ? +ctx.discountPct : null;
      if (disc != null && disc >= discountPct) {
        reasons.push({ signal: 'deep_discount', detail: 'Discount ' + disc + '% ≥ ' + discountPct + '%' });
      }

      // Material money + low confidence = exactly when a second look pays off.
      const conf = proposal && proposal.confidence != null ? +proposal.confidence : null;
      if (conf != null && conf < minConfidence && value != null && value >= materialUsd) {
        reasons.push({ signal: 'low_confidence_material', detail: 'Confidence ' + conf + ' < ' + minConfidence + ' on ~$' + Math.round(value) + ' of work.' });
      }

      return {
        highStakes: reasons.length > 0,
        reasons: reasons,
        stakesScore: reasons.length,
        value: value
      };
    },

    /**
     * Route a proposal through the Challenge Protocol IFF it is high-stakes and
     * the protocol is ready; otherwise return the proposal untouched. Normalizes
     * both runAgent (flat) and runMeeting ({decision}) proposal shapes.
     * @returns { ok, escalated, assessment, ... }  (challenge result when escalated)
     */
    async review(proposal, context) {
      const norm = this._normalize(proposal);
      const assessment = this.assess(context, norm);

      if (!norm || !norm.recommendation) {
        return { ok: true, escalated: false, assessment: assessment, proposal: proposal, note: 'NO_RECOMMENDATION' };
      }
      if (!assessment.highStakes) {
        return { ok: true, escalated: false, assessment: assessment, proposal: proposal };
      }
      const ch = challenge();
      if (!ch || !ch.isReady || !ch.isReady()) {
        // High-stakes but we can't challenge — surface that honestly, do not block.
        return { ok: true, escalated: false, assessment: assessment, proposal: proposal, note: 'CHALLENGE_NOT_READY' };
      }

      const result = await ch.challenge(norm, context);
      if (!result || result.ok === false) {
        // Challenge failed — fall back to the original proposal rather than nothing.
        return { ok: true, escalated: false, assessment: assessment, proposal: proposal, note: (result && result.error) || 'CHALLENGE_FAILED' };
      }
      this._logEscalation(context, assessment, result);
      return Object.assign({ escalated: true, assessment: assessment }, result);
    },

    /** Coerce runAgent (flat) / runMeeting ({decision}) results into a proposal. */
    _normalize(proposal) {
      if (!proposal) return null;
      const d = proposal.decision && typeof proposal.decision === 'object' ? proposal.decision : proposal;
      const rec = d.recommendation;
      if (!rec) return null;
      return {
        recommendation: rec,
        rationale: d.rationale || '',
        confidence: d.confidence != null ? d.confidence : null,
        agent: proposal.agent || proposal.proposer || (proposal.decision ? 'meeting' : 'proposer')
      };
    },

    _logEscalation(context, assessment, result) {
      try {
        if (data() && data().logAgent) {
          data().logAgent('escalation', 'High-stakes decision challenged: ' + (result.verdict || 'reviewed'), {
            jobId: (context && context.jobId) || null,
            reasons: assessment.reasons,
            verdict: result.verdict,
            changed: result.changed,
            proposalConfidence: result.proposalConfidence,
            finalConfidence: result.confidence
          });
        }
      } catch (_) {}
    }
  };

  global.AAA_ESCALATION = Escalation;
})(typeof window !== 'undefined' ? window : this);
