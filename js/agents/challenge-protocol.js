/*
 * AAA Challenge Protocol — the adversarial review chain (Internal Challenge Protocol).
 *
 * There is now ONE adversarial-review core in this app: the Analysis Division's
 * debate engine (Recommendation -> Critic -> Risk -> [Counterargument] ->
 * Supervisor verdict). This module is a faithful FACADE over AAA_DEBATE so the
 * Challenge Protocol's long-standing public API keeps working unchanged while the
 * actual deliberation runs through the single, tested pipeline — the two systems
 * can no longer drift apart.
 *
 *   challenge(proposal, context)        — challenge an existing proposal
 *   deliberate(topic, context, opts)    — propose first (via Agent OS), then challenge
 *   isReady()                           — ready iff the proxy/debate engine is ready
 *   REVIEW_SCHEMA                       — the supervisor verdict schema
 *
 * The facade runs the debate with its optional steelman/counterargument stage
 * enabled (so nothing is lost versus the original chain), maps the debate verdict
 * back to the legacy vocabulary (accept -> approve, revise -> approve_with_changes,
 * reject -> reject), and reconstructs the legacy { proposal, critic, risk, counter,
 * review } transcript. The final decision is logged under the stable contributor id
 * 'challenge_reviewer' (via the debate engine's decisionAgent hook) so the existing
 * Supervisor scores it against real outcomes exactly as before.
 *
 * Design principle (unchanged): "Agreement is not the goal. Accuracy is the goal."
 * Honest by construction: gated on the proxy; with none configured every entry
 * point returns { ok:false, error:'AI_NOT_CONFIGURED' } rather than inventing a verdict.
 */
;(function (global) {
  'use strict';

  function data() { return global.AAA_DATA; }
  function cfg() { return global.AAA_CONFIG; }
  function debate() { return global.AAA_DEBATE; }
  function division() { return global.AAA_ANALYSIS_DIVISION; }
  function agentOS() { return global.AAA_AGENT_OS; }

  function isReady() {
    if (debate() && debate().isReady) return debate().isReady();
    const c = cfg();
    return !!(data() && c && c.isProxyConfigured && c.isProxyConfigured());
  }

  // debate verdict -> legacy challenge verdict
  function mapVerdict(v) {
    if (v === 'accept') return 'approve';
    if (v === 'reject') return 'reject';
    return 'approve_with_changes'; // 'revise'
  }

  function stageOutput(transcript, role) {
    const s = (transcript || []).find(function (t) { return t.role === role; });
    return s ? s.output : null;
  }

  // Reconstruct the legacy transcript shape from the debate transcript.
  function legacyTranscript(proposal, deb) {
    const t = deb.transcript || [];
    const sup = stageOutput(t, 'supervisor') || {};
    return {
      proposal: {
        recommendation: proposal.recommendation,
        rationale: proposal.rationale,
        confidence: proposal.confidence != null ? proposal.confidence : null,
        agent: proposal.agent || proposal.from || null
      },
      critic: stageOutput(t, 'critic') || { unavailable: true },
      risk: stageOutput(t, 'risk') || { unavailable: true },
      counter: stageOutput(t, 'counter') || { unavailable: true },
      review: {
        verdict: mapVerdict(deb.verdict),
        recommendation: deb.finalRecommendation,
        rationale: sup.rationale || '',
        confidence: deb.confidence,
        conditions: deb.conditions || []
      }
    };
  }

  const Challenge = {
    isReady: isReady,

    // Preserve the legacy export; the verdict schema now lives in the division.
    get REVIEW_SCHEMA() { return division() ? division().VERDICT_SCHEMA : null; },

    /**
     * Run the Challenge Protocol over an existing proposal, via AAA_DEBATE.
     * @param {object} proposal { recommendation, rationale, confidence, agent? }
     * @param {object} context  structured facts (job, customer, kpis, jobId?)
     * @returns final ruling + the full deliberation transcript, or an honest error.
     */
    async challenge(proposal, context) {
      if (!isReady()) return { ok: false, error: 'AI_NOT_CONFIGURED' };
      if (!proposal || !proposal.recommendation) return { ok: false, error: 'NO_PROPOSAL' };
      if (!debate() || !debate().run) return { ok: false, error: 'DEBATE_UNAVAILABLE' };

      const ctx = context || {};
      const deb = await debate().run({
        topic: 'Challenge this recommendation before it reaches the operator: ' + String(proposal.recommendation).slice(0, 200),
        context: ctx,
        recommendation: {
          recommendation: String(proposal.recommendation),
          rationale: proposal.rationale || '',
          confidence: proposal.confidence != null ? proposal.confidence : null
        },
        counterargument: true,
        meta: { decisionAgent: 'challenge_reviewer', jobId: ctx.jobId || null, source: 'challenge_protocol' }
      });
      if (!deb || deb.ok === false) return { ok: false, error: (deb && deb.error) || 'CHALLENGE_FAILED', raw: deb && deb.raw };

      const verdict = mapVerdict(deb.verdict);
      const finalRec = String(deb.finalRecommendation || proposal.recommendation);
      const changed = verdict !== 'approve' || finalRec !== String(proposal.recommendation);
      const sup = stageOutput(deb.transcript, 'supervisor') || {};
      const risk = stageOutput(deb.transcript, 'risk') || {};

      return {
        ok: true,
        verdict: verdict,
        changed: changed,
        what_changed: changed ? (sup.rationale || 'Revised after adversarial review.') : '',
        recommendation: finalRec,
        rationale: sup.rationale || '',
        confidence: deb.confidence != null ? deb.confidence : null,
        residual_risks: Array.isArray(risk.risks) ? risk.risks : (deb.conditions || []),
        next_actions: Array.isArray(deb.conditions) ? deb.conditions : [],
        proposalConfidence: proposal.confidence != null ? proposal.confidence : null,
        decisionId: deb.decisionId || null,
        debateId: deb.debateId || null,
        transcript: legacyTranscript(proposal, deb)
      };
    },

    /**
     * Convenience: produce a proposal first (via the Agent OS), then challenge it.
     * @param {string} topic    natural-language decision to make
     * @param {object} context  structured facts (jobId?, …)
     * @param {object} opts      { proposerId: 'ceo' | <agentId> | 'meeting', participants? }
     */
    async deliberate(topic, context, opts) {
      if (!isReady()) return { ok: false, error: 'AI_NOT_CONFIGURED' };
      const os = agentOS();
      if (!os) return { ok: false, error: 'AGENT_OS_MISSING' };
      const proposerId = (opts && opts.proposerId) || 'ceo';

      let proposal;
      if (proposerId === 'meeting') {
        const m = await os.runMeeting(topic, context, (opts && opts.participants) || null);
        if (!m.ok) return { ok: false, error: m.error || 'PROPOSAL_FAILED', detail: m };
        proposal = Object.assign({ agent: 'meeting' }, m.decision);
      } else {
        const a = await os.runAgent(proposerId, topic, context);
        if (!a.ok) return { ok: false, error: a.error || 'PROPOSAL_FAILED', detail: a };
        proposal = { recommendation: a.recommendation, rationale: a.rationale, confidence: a.confidence, agent: proposerId };
      }

      const result = await this.challenge(proposal, context);
      if (result.ok) result.proposer = proposerId;
      return result;
    }
  };

  global.AAA_CHALLENGE = Challenge;
})(typeof window !== 'undefined' ? window : this);
