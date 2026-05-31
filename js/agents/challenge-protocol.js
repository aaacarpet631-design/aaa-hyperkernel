/*
 * AAA Challenge Protocol — the adversarial review chain (Internal Challenge Protocol).
 *
 * The Agent OS produces recommendations by fanning out sub-agents and letting
 * the CEO SYNTHESIZE one decision. Synthesis optimizes for coherence and
 * agreement. This module adds the missing half: before a recommendation reaches
 * the human, it must SURVIVE a structured attack.
 *
 *   Proposal → Critic → Risk → Counterargument → Supervisor Review → Final
 *
 * Each stage is a real model call through the same proxy seam (AAA_DATA.callAgent),
 * constrained by a JSON schema, and never fabricated: with no proxy configured the
 * whole chain returns { ok:false, error:'AI_NOT_CONFIGURED' } rather than inventing
 * a verdict. The full deliberation transcript is written to agent_logs, and the
 * FINAL decision is logged to agent_decisions under a stable contributor id
 * ('challenge_reviewer') so the existing Supervisor scores it against the real
 * outcome and Self-Improvement tunes it — the challenger earns its influence the
 * same way every other agent does.
 *
 * Design principle (from the directive): "Agreement is not the goal. Accuracy is
 * the goal." The reviewer is instructed to revise or reject when the critic or the
 * counterargument exposes a genuine flaw, and its confidence must reflect the
 * objections that survive — not the comfort of consensus.
 */
;(function (global) {
  'use strict';

  const WORKER = 'claude-sonnet-4-6';   // critic / risk / counter — fast, cheap
  const EXEC = 'claude-opus-4-8';       // supervisor review — final call

  function data() { return global.AAA_DATA; }
  function registry() { return global.AAA_AGENTS; }
  function agentOS() { return global.AAA_AGENT_OS; }

  function isReady() {
    const cfg = global.AAA_CONFIG;
    return !!(data() && cfg && cfg.isProxyConfigured && cfg.isProxyConfigured());
  }

  // Tolerant JSON extraction — models occasionally wrap output in ```json fences
  // or a sentence of preamble even under output_config. Mirrors agent-os.js.
  function extractJson(text) {
    const s = String(text == null ? '' : text).trim();
    if (!s) return null;
    try { return JSON.parse(s); } catch (_) {}
    const fenced = s.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
    if (fenced !== s) { try { return JSON.parse(fenced); } catch (_) {} }
    const start = s.indexOf('{'); const end = s.lastIndexOf('}');
    if (start !== -1 && end > start) { try { return JSON.parse(s.slice(start, end + 1)); } catch (_) {} }
    return null;
  }

  function clampInt(n, lo, hi) {
    const v = Math.round(Number(n));
    if (!Number.isFinite(v)) return null;
    return Math.max(lo, Math.min(hi, v));
  }

  // ---- stage schemas -------------------------------------------------------

  const CRITIQUE_SCHEMA = {
    type: 'object',
    properties: {
      assumptions: { type: 'array', items: { type: 'string' }, description: 'Unstated or weak assumptions the proposal depends on.' },
      gaps: { type: 'array', items: { type: 'string' }, description: 'Missing evidence or data that would change the call.' },
      strongest_objection: { type: 'string', description: 'The single most damaging flaw in the proposal.' },
      severity: { type: 'string', enum: ['low', 'medium', 'high'], description: 'How damaging the strongest objection is.' },
      confidence_delta: { type: 'integer', description: 'Signed adjustment (-40..40) you argue the proposal\'s confidence deserves given these flaws. Negative if it is overstated.' }
    },
    required: ['assumptions', 'gaps', 'strongest_objection', 'severity', 'confidence_delta'],
    additionalProperties: false
  };

  const RISK_SCHEMA = {
    type: 'object',
    properties: {
      risks: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            risk: { type: 'string' },
            likelihood: { type: 'string', enum: ['low', 'medium', 'high'] },
            impact: { type: 'string', enum: ['low', 'medium', 'high'] }
          },
          required: ['risk', 'likelihood', 'impact'],
          additionalProperties: false
        }
      },
      worst_case: { type: 'string', description: 'The realistic worst outcome if this proposal is executed.' },
      mitigations: { type: 'array', items: { type: 'string' }, description: 'Concrete steps that would reduce the downside.' },
      risk_level: { type: 'string', enum: ['low', 'medium', 'high', 'critical'], description: 'Overall residual risk if executed as-is.' }
    },
    required: ['risks', 'worst_case', 'mitigations', 'risk_level'],
    additionalProperties: false
  };

  const COUNTER_SCHEMA = {
    type: 'object',
    properties: {
      alternative: { type: 'string', description: 'The strongest alternative decision — ideally the opposite of the proposal.' },
      case_for: { type: 'string', description: 'The best honest argument for the alternative.' },
      conditions: { type: 'array', items: { type: 'string' }, description: 'Conditions under which the alternative clearly beats the proposal.' },
      strength: { type: 'integer', description: '0-100: how strong this counterargument is on the supplied evidence.' }
    },
    required: ['alternative', 'case_for', 'conditions', 'strength'],
    additionalProperties: false
  };

  const REVIEW_SCHEMA = {
    type: 'object',
    properties: {
      verdict: { type: 'string', enum: ['approve', 'approve_with_changes', 'reject'], description: 'Your ruling on the proposal after the challenge.' },
      recommendation: { type: 'string', description: 'The FINAL recommended action after weighing the challenge. May differ from the proposal.' },
      rationale: { type: 'string', description: 'Why this is the final call, citing which objections survived and which did not. 1-3 sentences.' },
      confidence: { type: 'integer', description: '0-100 calibrated confidence in the FINAL recommendation, reflecting the objections that survived.' },
      changed: { type: 'boolean', description: 'True if the final recommendation differs materially from the proposal.' },
      what_changed: { type: 'string', description: 'If changed, what and why; otherwise empty.' },
      residual_risks: { type: 'array', items: { type: 'string' }, description: 'Risks that remain even in the final recommendation.' },
      next_actions: { type: 'array', items: { type: 'string' }, description: 'Specific next steps.' }
    },
    required: ['verdict', 'recommendation', 'rationale', 'confidence', 'changed', 'what_changed', 'residual_risks', 'next_actions'],
    additionalProperties: false
  };

  // ---- stage personas ------------------------------------------------------

  const COMPANY = 'AAA Carpet — a residential & commercial carpet cleaning, repair, and flooring company.';
  const GROUND = '\nGround every claim ONLY in the proposal and the JSON context provided. Do not invent facts. ' +
    'If the evidence is thin, say so explicitly. Be concise and operational. Respond ONLY as JSON matching the required schema.';

  const CRITIC_SYS = 'You are the Critic in an adversarial review for ' + COMPANY + ' ' +
    'Your job is to find what is WRONG with the proposal: unstated assumptions, weak reasoning, missing evidence, and where it would fail. ' +
    'You are not here to agree. Attack the proposal as hard as the evidence honestly allows, but do not manufacture flaws that the context does not support.' + GROUND;

  const RISK_SYS = 'You are the Risk officer in an adversarial review for ' + COMPANY + ' ' +
    'You catalog what could go wrong if this proposal is executed: financial, operational, legal/compliance, safety, customer-trust, and reputational downside. ' +
    'You are the brake, not the gas. Quantify likelihood and impact honestly; do not inflate risks the context does not support.' + GROUND;

  const COUNTER_SYS = 'You are the Counterargument agent in an adversarial review for ' + COMPANY + ' ' +
    'Steelman the opposite decision. Build the strongest honest case AGAINST the proposal and FOR a credible alternative. ' +
    'If, after a genuine effort, no real alternative beats the proposal, say so and set strength low.' + GROUND;

  const REVIEW_SYS = 'You are the Supervisor delivering the FINAL ruling in an adversarial review for ' + COMPANY + ' ' +
    'You receive a proposal plus a Critic analysis, a Risk analysis, and a Counterargument. Agreement is NOT your goal — accuracy is. ' +
    'Approve only what survives the attack. If the Critic or Counterargument exposes a real flaw, revise the recommendation (approve_with_changes) ' +
    'or reject it. Your confidence must reflect the objections that SURVIVED your review, not the comfort of consensus — an approval over serious ' +
    'unresolved risk should carry low confidence. Be specific and operational.' + GROUND;

  // Run one stage: a real proxy call, schema-constrained, tolerantly parsed.
  async function stage(name, system, model, userContent, schema) {
    const res = await data().callAgent({
      agent: 'challenge_' + name, model: model, max_tokens: 800,
      system: system,
      output_config: { format: { type: 'json_schema', schema: schema } },
      messages: [{ role: 'user', content: userContent }]
    });
    if (!res || res.ok === false) return { ok: false, error: (res && res.error) || 'CALL_FAILED', stage: name };
    const parsed = extractJson(res.text || '');
    if (!parsed || typeof parsed !== 'object') return { ok: false, error: 'BAD_OUTPUT', stage: name, raw: res.text };
    return { ok: true, stage: name, data: parsed };
  }

  function proposalBlock(proposal, context) {
    return 'PROPOSAL (JSON):\n' + JSON.stringify({
      recommendation: proposal.recommendation,
      rationale: proposal.rationale,
      statedConfidence: proposal.confidence,
      from: proposal.agent || proposal.from || 'unknown'
    }, null, 2) + '\n\nCONTEXT (JSON):\n' + JSON.stringify(context || {}, null, 2);
  }

  const Challenge = {
    isReady: isReady,

    REVIEW_SCHEMA: REVIEW_SCHEMA,

    /**
     * Run the full Challenge Protocol over an existing proposal.
     * @param {object} proposal { recommendation, rationale, confidence, agent? }
     * @param {object} context  structured facts (job, customer, kpis, jobId?)
     * @returns final ruling + the full deliberation transcript, or an honest error.
     */
    async challenge(proposal, context) {
      if (!isReady()) return { ok: false, error: 'AI_NOT_CONFIGURED' };
      if (!proposal || !proposal.recommendation) return { ok: false, error: 'NO_PROPOSAL' };

      const block = proposalBlock(proposal, context);

      // 1-3) Critic, Risk, and Counterargument attack the proposal in parallel —
      // they are independent lenses, so there is no reason to serialize them.
      const [critic, risk, counter] = await Promise.all([
        stage('critic', CRITIC_SYS, WORKER, block + '\n\nProduce your critique per the schema.', CRITIQUE_SCHEMA),
        stage('risk', RISK_SYS, WORKER, block + '\n\nProduce your risk analysis per the schema.', RISK_SCHEMA),
        stage('counter', COUNTER_SYS, WORKER, block + '\n\nProduce your counterargument per the schema.', COUNTER_SCHEMA)
      ]);

      // The chain is only meaningful if the proposal was actually attacked. If
      // every challenger failed (e.g. proxy hiccup), refuse rather than rubber-stamp.
      const attacks = [critic, risk, counter].filter((s) => s.ok);
      if (attacks.length === 0) {
        return { ok: false, error: 'CHALLENGE_FAILED', detail: [critic, risk, counter].map((s) => s.error) };
      }

      // 4) Supervisor Review — the final, calibrated ruling over proposal + attacks.
      const reviewInput = block +
        '\n\nCRITIC ANALYSIS (JSON):\n' + JSON.stringify(critic.ok ? critic.data : { unavailable: critic.error }, null, 2) +
        '\n\nRISK ANALYSIS (JSON):\n' + JSON.stringify(risk.ok ? risk.data : { unavailable: risk.error }, null, 2) +
        '\n\nCOUNTERARGUMENT (JSON):\n' + JSON.stringify(counter.ok ? counter.data : { unavailable: counter.error }, null, 2) +
        '\n\nDeliver the FINAL ruling per the schema. Approve only what survives. Your confidence must reflect surviving objections.';

      const review = await stage('reviewer', REVIEW_SYS, EXEC, reviewInput, REVIEW_SCHEMA);
      if (!review.ok) return { ok: false, error: review.error, raw: review.raw, transcript: { critic, risk, counter } };

      const r = review.data;
      const verdict = ['approve', 'approve_with_changes', 'reject'].indexOf(r.verdict) !== -1 ? r.verdict : 'approve_with_changes';
      const finalConfidence = clampInt(r.confidence, 0, 100);

      const transcript = {
        proposal: { recommendation: proposal.recommendation, rationale: proposal.rationale, confidence: proposal.confidence, agent: proposal.agent || proposal.from || null },
        critic: critic.ok ? critic.data : { error: critic.error },
        risk: risk.ok ? risk.data : { error: risk.error },
        counter: counter.ok ? counter.data : { error: counter.error },
        review: r
      };

      // Persist the deliberation transcript for traceability.
      try { await data().logAgent('challenge_protocol', String(proposal.recommendation).slice(0, 120), { verdict: verdict, transcript: transcript, jobId: (context && context.jobId) || null }); } catch (_) {}

      // Log the FINAL decision into shared memory under a stable contributor id,
      // so the Supervisor scores it against the real outcome later and
      // Self-Improvement can tune the protocol from its own track record.
      let decisionId = null;
      try {
        const logged = await data().logDecision({
          agent: 'challenge_reviewer',
          jobId: (context && context.jobId) || null,
          decision: r.recommendation,
          rationale: r.rationale,
          confidence: finalConfidence,
          via: 'challenge_protocol',
          verdict: verdict,
          changed: !!r.changed,
          inputs: { proposal: transcript.proposal, context: context || {} }
        });
        decisionId = logged && logged.id;
      } catch (_) {}

      return {
        ok: true,
        verdict: verdict,
        changed: !!r.changed,
        what_changed: String(r.what_changed || ''),
        recommendation: String(r.recommendation || ''),
        rationale: String(r.rationale || ''),
        confidence: finalConfidence,
        residual_risks: Array.isArray(r.residual_risks) ? r.residual_risks : [],
        next_actions: Array.isArray(r.next_actions) ? r.next_actions : [],
        proposalConfidence: proposal.confidence != null ? proposal.confidence : null,
        decisionId: decisionId,
        transcript: transcript
      };
    },

    /**
     * Convenience: produce a proposal first (via the Agent OS), then challenge it.
     * @param {string} topic    natural-language decision to make
     * @param {object} context  structured facts (jobId?, …)
     * @param {object} opts      { proposerId: 'ceo' | <agentId> | 'meeting' }
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
