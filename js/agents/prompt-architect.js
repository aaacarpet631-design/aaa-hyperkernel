/*
 * AAA Prompt Architect — turn plain English into a real, runnable agent.
 *
 * "I want an agent that follows up on leads" → a structured spec (system
 * prompt, goals, constraints, memory rules, escalation, success/failure
 * metrics, integrations, workflow) PLUS analysis scores (health, complexity,
 * business value, automation potential, risk, cost, ROI). The spec is produced
 * by Claude through the proxy (gated; never fabricated), saved to shared memory
 * with versioning, and registered so the existing agent OS can run it and the
 * Supervisor can score it against outcomes.
 */
;(function (global) {
  'use strict';

  function data() { return global.AAA_DATA; }
  function cfg() { return global.AAA_CONFIG || {}; }
  function ids() { return global.AAA_ID_FACTORY; }
  function clock() { return global.AAA_RUNTIME_CLOCK; }

  // Tolerant JSON extraction: handle ```json fences or a sentence of preamble.
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

  const LEVEL = { type: 'string', enum: ['LOW', 'MEDIUM', 'HIGH'] };
  const STRLIST = { type: 'array', items: { type: 'string' } };

  const SPEC_SCHEMA = {
    type: 'object',
    properties: {
      name: { type: 'string' },
      mission: { type: 'string' },
      role: { type: 'string' },
      systemPrompt: { type: 'string', description: 'A directly-usable system prompt for this agent.' },
      goals: STRLIST, constraints: STRLIST, memoryRules: STRLIST, escalationRules: STRLIST,
      successMetrics: STRLIST, failureMetrics: STRLIST,
      integrations: STRLIST, workflow: { type: 'array', items: { type: 'string' }, description: 'Ordered workflow steps.' },
      trigger: {
        type: 'object',
        description: 'When this agent should auto-run. Use "none" if it should only run on demand.',
        properties: {
          event: { type: 'string', enum: ['none', 'job.created', 'estimate.added', 'job.closed'] },
          delayHours: { type: 'integer', description: 'Intended delay after the event (0 = immediately).' },
          task: { type: 'string', description: 'What the agent should do when triggered.' }
        },
        required: ['event', 'delayHours', 'task'],
        additionalProperties: false
      },
      analysis: {
        type: 'object',
        properties: {
          healthScore: { type: 'integer', description: '0-100 overall prompt health.' },
          complexity: LEVEL, businessValue: LEVEL, automationPotential: LEVEL, risk: LEVEL,
          tokenCostEstimate: { type: 'string' }, expectedRoi: { type: 'string' }
        },
        required: ['healthScore', 'complexity', 'businessValue', 'automationPotential', 'risk', 'tokenCostEstimate', 'expectedRoi'],
        additionalProperties: false
      }
    },
    required: ['name', 'mission', 'role', 'systemPrompt', 'goals', 'constraints', 'memoryRules', 'escalationRules', 'successMetrics', 'failureMetrics', 'integrations', 'workflow', 'trigger', 'analysis'],
    additionalProperties: false
  };

  const ARCHITECT_SYSTEM =
    'You are an AI Systems Architect for AAA Carpet — a carpet cleaning, repair, stretching, installation, apartment-turn, and flooring company. ' +
    'Given a plain-English request, design a production-ready AI agent specification the company can actually run. ' +
    'The systemPrompt you write must be directly usable as that agent\'s instructions. Ground goals, constraints, metrics, and workflow in AAA Carpet\'s real operations (jobs, estimates, scheduling, dispatch, follow-up, reviews, marketing). ' +
    'Pick integrations only from what exists or is realistic: shared memory (jobs/customers/estimates/outcomes), SMS, Email, Google Business reviews, QuickBooks, Calendar, Google Ads. ' +
    'Require human review for anything customer-facing, financial, or irreversible (put it in escalationRules). ' +
    'In "trigger", propose when the agent should auto-run from these events: job.created, estimate.added, job.closed (or "none" for on-demand only), with a sensible delayHours and the task to perform. ' +
    'Be honest in analysis scores — do not inflate. Respond ONLY as JSON matching the schema.';

  function slug(name) {
    return 'custom_' + String(name || 'agent').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40);
  }

  async function cloudUpsert(rec) {
    try {
      if (data().cloudReady && data().cloudReady() && global.AAA_CLOUD) {
        await global.AAA_CLOUD.upsertEntity('custom_agents', rec.id, rec);
      }
    } catch (_) {}
  }

  const Architect = {
    isReady() { return !!(data() && cfg().isProxyConfigured && cfg().isProxyConfigured()); },

    /** Generate a full agent spec + analysis from a plain-English description. */
    async design(description) {
      if (!this.isReady()) return { ok: false, error: 'AI_NOT_CONFIGURED' };
      if (!description || !String(description).trim()) return { ok: false, error: 'EMPTY' };
      const res = await data().callAgent({
        agent: 'prompt_architect', model: 'claude-opus-4-8', max_tokens: 1600,
        system: ARCHITECT_SYSTEM,
        output_config: { format: { type: 'json_schema', schema: SPEC_SCHEMA } },
        messages: [{ role: 'user', content: 'Design an AI agent for this request:\n\n' + String(description).trim() }]
      });
      if (!res || res.ok === false) return { ok: false, error: (res && res.error) || 'CALL_FAILED' };
      const spec = extractJson(res.text);
      return spec ? { ok: true, spec: spec } : { ok: false, error: 'BAD_OUTPUT', raw: res.text };
    },

    /** Save (or version-bump) a spec as a runnable agent in shared memory. */
    async saveAgent(spec, opts) {
      if (!data() || !spec) return { ok: false, error: 'INVALID' };
      const id = (opts && opts.id) || slug(spec.name);
      const existing = await data().get('custom_agents', id);
      const now = clock() ? clock().now() : Date.now();
      const version = existing ? (existing.version || 1) + 1 : 1;
      const history = existing
        ? (existing.history || []).concat([{ version: existing.version, spec: existing.spec, at: existing.updatedAt }])
        : [];
      const rec = {
        id: id, title: spec.name, version: version, spec: spec,
        trigger: spec.trigger || { event: 'none', delayHours: 0, task: '' },
        triggerEnabled: existing ? !!existing.triggerEnabled : false,
        createdAt: existing ? existing.createdAt : now, updatedAt: now, history: history
      };
      await data().put('custom_agents', id, rec);
      await cloudUpsert(rec);
      this._register(rec);
      try { if (data().logAgent) data().logAgent('prompt_architect', 'Created/updated agent "' + spec.name + '" (v' + version + ')', { id: id }); } catch (_) {}
      return { ok: true, agent: rec };
    },

    _register(rec) {
      if (global.AAA_AGENTS && global.AAA_AGENTS.registerCustom) global.AAA_AGENTS.registerCustom(rec);
    },

    /** Turn a saved agent's auto-run trigger on/off. */
    async setTriggerEnabled(id, enabled) {
      const rec = await this.get(id);
      if (!rec) return { ok: false, error: 'NOT_FOUND' };
      rec.triggerEnabled = !!enabled;
      rec.updatedAt = clock() ? clock().now() : Date.now();
      await data().put('custom_agents', id, rec);
      await cloudUpsert(rec);
      this._register(rec);
      return { ok: true, agent: rec };
    },

    async list() { return data() ? data().list('custom_agents') : []; },
    async get(id) { return data() ? data().get('custom_agents', id) : null; },
    async versions(id) { const r = await this.get(id); return r ? [{ version: r.version, spec: r.spec, at: r.updatedAt }].concat(r.history || []) : []; },

    /** Roll a saved agent back to a prior version (creates a new version). */
    async rollback(id, version) {
      const r = await this.get(id);
      if (!r) return { ok: false, error: 'NOT_FOUND' };
      const target = (r.history || []).find((h) => h.version === version) || (r.version === version ? r : null);
      if (!target) return { ok: false, error: 'VERSION_NOT_FOUND' };
      return this.saveAgent(target.spec, { id: id });
    },

    /** Load saved agents into the registry on boot so they're runnable. */
    async loadSaved() {
      try {
        const all = await this.list();
        all.forEach((rec) => this._register(rec));
        return all.length;
      } catch (_) { return 0; }
    }
  };

  global.AAA_PROMPT_ARCHITECT = Architect;
})(typeof window !== 'undefined' ? window : this);
