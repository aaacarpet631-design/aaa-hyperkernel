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

  function buildUserPrompt(task, context) {
    return (
      'TASK:\n' + String(task || 'Assess the situation and recommend an action.') +
      '\n\nCONTEXT (JSON):\n' + JSON.stringify(context || {}, null, 2) +
      '\n\nReturn your decision as JSON matching the required schema.'
    );
  }

  function parseDecision(text) {
    try {
      const d = JSON.parse(text);
      return {
        recommendation: String(d.recommendation || ''),
        rationale: String(d.rationale || ''),
        confidence: Number.isFinite(+d.confidence) ? Math.max(0, Math.min(100, Math.round(+d.confidence))) : null,
        risks: Array.isArray(d.risks) ? d.risks : [],
        next_actions: Array.isArray(d.next_actions) ? d.next_actions : []
      };
    } catch (_) {
      return null;
    }
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
     */
    async runAgent(roleId, task, context) {
      const reg = registry();
      if (!reg) return { ok: false, error: 'REGISTRY_MISSING' };
      const agent = reg.get(roleId);
      if (!agent) return { ok: false, error: 'UNKNOWN_AGENT', roleId: roleId };
      if (!this.isReady()) return { ok: false, error: 'AI_NOT_CONFIGURED', roleId: roleId };

      const res = await data().callAgent({
        agent: roleId,
        model: agent.model,
        max_tokens: 700,
        system: agent.system,
        output_config: { format: { type: 'json_schema', schema: reg.DECISION_SCHEMA } },
        messages: [{ role: 'user', content: buildUserPrompt(task, context) }]
      });
      if (!res || res.ok === false) return { ok: false, error: (res && res.error) || 'CALL_FAILED', roleId: roleId };

      const decision = parseDecision(res.text || '');
      if (!decision) return { ok: false, error: 'BAD_OUTPUT', roleId: roleId, raw: res.text };

      // Persist to shared memory for the Supervisor + learning loop.
      let logged = null;
      try {
        logged = await data().logDecision({
          agent: roleId,
          jobId: context && context.jobId ? context.jobId : null,
          decision: decision.recommendation,
          rationale: decision.rationale,
          confidence: decision.confidence,
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
