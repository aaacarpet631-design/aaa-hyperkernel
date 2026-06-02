/*
 * AAA Agent OS — orchestration.
 *
 * Runs agents through the real Claude proxy (AAA_DATA.callAgent), enforces the
 * shared decision schema, and writes every decision to shared memory
 * (agent_decisions) so the Supervisor can score it later. Meetings fan out to
 * the relevant sub-agents and let the CEO synthesize one decision.
 *
 * Honest by construction: when the proxy is not configured, calls return
 * { ok:false, error:'AI_NOT_CONFIGURED' } — never fabricated output.
 */
;(function (global) {
  'use strict';

  function data() { return global.AAA_DATA; }
  function registry() { return global.AAA_AGENTS; }
  function router() { return global.AAA_MODEL_ROUTER; }
  function gate() { return global.AAA_ACTION_GATE; }

  function buildUserPrompt(task, context) {
    return (
      'TASK:\n' + String(task || 'Assess the situation and recommend an action.') +
      '\n\nCONTEXT (JSON):\n' + JSON.stringify(context || {}, null, 2) +
      '\n\nReturn your decision as JSON matching the required schema.'
    );
  }

  // Tolerant JSON extraction: models sometimes wrap the object in ```json
  // fences or add a sentence of preamble even under output_config. Try a
  // straight parse first, then strip code fences, then fall back to the first
  // balanced {...} block. Returns null only when no object is recoverable.
  function extractJson(text) {
    const s = String(text == null ? '' : text).trim();
    if (!s) return null;
    try { return JSON.parse(s); } catch (_) {}
    const fenced = s.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
    if (fenced !== s) { try { return JSON.parse(fenced); } catch (_) {} }
    const start = s.indexOf('{');
    const end = s.lastIndexOf('}');
    if (start !== -1 && end > start) {
      try { return JSON.parse(s.slice(start, end + 1)); } catch (_) {}
    }
    return null;
  }

  function parseDecision(text) {
    const d = extractJson(text);
    if (!d || typeof d !== 'object') return null;
    return {
      recommendation: String(d.recommendation || ''),
      rationale: String(d.rationale || ''),
      confidence: Number.isFinite(+d.confidence) ? Math.max(0, Math.min(100, Math.round(+d.confidence))) : null,
      risks: Array.isArray(d.risks) ? d.risks : [],
      next_actions: Array.isArray(d.next_actions) ? d.next_actions : []
    };
  }

  const AgentOS = {
    isReady() {
      const cfg = global.AAA_CONFIG;
      return !!(data() && registry() && cfg && cfg.isProxyConfigured && cfg.isProxyConfigured());
    },

    /**
     * Run a single agent on a task. Returns the parsed decision and logs it.
     * @param {string} roleId  e.g. 'sales'
     * @param {string} task    natural-language task
     * @param {object} context structured facts (job, customer, kpis…)
     * @param {object} [opts]  { taskKind } to route by task (Opus/Sonnet/Haiku);
     *                         omit to keep the agent's declared model.
     */
    async runAgent(roleId, task, context, opts) {
      const reg = registry();
      if (!reg) return { ok: false, error: 'REGISTRY_MISSING' };
      const agent = reg.get(roleId);
      if (!agent) return { ok: false, error: 'UNKNOWN_AGENT', roleId: roleId };
      if (!this.isReady()) return { ok: false, error: 'AI_NOT_CONFIGURED', roleId: roleId };

      // Task-aware model routing (adds the Haiku tier for cheap task kinds);
      // with no taskKind this returns the agent's declared model unchanged.
      const routed = router() ? router().forAgent(agent.model, opts && opts.taskKind) : { model: agent.model, reason: 'no router' };

      const res = await data().callAgent({
        agent: roleId,
        model: routed.model,
        max_tokens: 700,
        system: agent.system,
        output_config: { format: { type: 'json_schema', schema: reg.DECISION_SCHEMA } },
        messages: [{ role: 'user', content: buildUserPrompt(task, context) }]
      });
      if (!res || res.ok === false) return { ok: false, error: (res && res.error) || 'CALL_FAILED', roleId: roleId };

      const decision = parseDecision(res.text || '');
      if (!decision) return { ok: false, error: 'BAD_OUTPUT', roleId: roleId, raw: res.text };

      // Record which model actually ran (and why) for cost/audit transparency.
      decision.model = routed.model;
      decision.routing = { model: routed.model, tier: routed.tier, reason: routed.reason };

      // Flag any recommended next_action that is destructive / external /
      // spend-bearing so the operator sees it needs approval before execution.
      if (gate() && decision.next_actions && decision.next_actions.length) {
        const review = gate().review(decision.next_actions);
        if (review.blocked) decision.actionReview = review;
      }

      // Apply the Self-Improvement confidence bias (learned from this agent's
      // real track record). The raw value is preserved for transparency; the
      // adjusted value is what the Supervisor will score next time.
      const bias = (reg.confidenceBias ? reg.confidenceBias(roleId) : 0) || 0;
      if (bias && decision.confidence != null) {
        decision.rawConfidence = decision.confidence;
        decision.confidence = Math.max(0, Math.min(100, Math.round(decision.confidence + bias)));
        decision.confidenceBias = bias;
      }

      // Persist to shared memory for the Supervisor + learning loop.
      let logged = null;
      try {
        logged = await data().logDecision({
          agent: roleId,
          jobId: context && context.jobId ? context.jobId : null,
          decision: decision.recommendation,
          rationale: decision.rationale,
          confidence: decision.confidence,
          rawConfidence: decision.rawConfidence != null ? decision.rawConfidence : decision.confidence,
          confidenceBias: bias || 0,
          inputs: { task: task, context: context || {} }
        });
      } catch (_) {}

      return Object.assign({ ok: true, agent: roleId, decisionId: logged && logged.id }, decision);
    },

    /**
     * Run an agent meeting: the given participants weigh in (real model calls,
     * in parallel), then the CEO synthesizes one decision with a confidence.
     * The transcript is logged to agent_logs and the final call to
     * agent_decisions.
     */
    async runMeeting(topic, context, participantIds) {
      const reg = registry();
      if (!reg) return { ok: false, error: 'REGISTRY_MISSING' };
      if (!this.isReady()) return { ok: false, error: 'AI_NOT_CONFIGURED' };

      const participants = (participantIds && participantIds.length ? participantIds : reg.subAgents())
        .filter((id) => id !== 'ceo' && reg.get(id));

      const results = await Promise.all(participants.map((id) => this.runAgent(id, topic, context)));
      const opinions = results
        .filter((r) => r && r.ok)
        .map((r) => ({ agent: r.agent, title: reg.get(r.agent).title, recommendation: r.recommendation, rationale: r.rationale, confidence: r.confidence }));

      if (opinions.length === 0) {
        return { ok: false, error: 'NO_OPINIONS', detail: results.map((r) => r && r.error) };
      }

      // CEO synthesis over the collected opinions.
      const ceo = reg.get('ceo');
      const synthRes = await data().callAgent({
        agent: 'ceo',
        model: ceo.model,
        max_tokens: 800,
        system: ceo.system,
        output_config: { format: { type: 'json_schema', schema: reg.DECISION_SCHEMA } },
        messages: [{ role: 'user', content:
          'MEETING TOPIC:\n' + topic +
          '\n\nTEAM INPUT (JSON):\n' + JSON.stringify(opinions, null, 2) +
          '\n\nCONTEXT (JSON):\n' + JSON.stringify(context || {}, null, 2) +
          '\n\nResolve conflicts and make the final decision. Your confidence should reflect agreement and evidence. Return JSON per schema.' }]
      });
      if (!synthRes || synthRes.ok === false) return { ok: false, error: (synthRes && synthRes.error) || 'SYNTHESIS_FAILED', opinions: opinions };
      const decision = parseDecision(synthRes.text || '');
      if (!decision) return { ok: false, error: 'BAD_SYNTHESIS', opinions: opinions, raw: synthRes.text };

      // Log the meeting transcript + the final decision.
      try { await data().logAgent('meeting', topic, { participants: participants, opinions: opinions, decision: decision }); } catch (_) {}
      let logged = null;
      try {
        logged = await data().logDecision({
          agent: 'ceo',
          jobId: context && context.jobId ? context.jobId : null,
          decision: decision.recommendation,
          rationale: decision.rationale,
          confidence: decision.confidence,
          inputs: { topic: topic, opinions: opinions, context: context || {} }
        });
      } catch (_) {}

      return { ok: true, topic: topic, opinions: opinions, decisionId: logged && logged.id, decision: decision };
    }
  };

  global.AAA_AGENT_OS = AgentOS;
})(typeof window !== 'undefined' ? window : this);
