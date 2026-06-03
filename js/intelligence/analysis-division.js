/*
 * AAA Analysis Division — the org chart + contracts for the intelligence layer.
 *
 * This is the configuration backbone the rest of js/intelligence/* drives. It
 * defines:
 *   - the 6 processing LAYERS every analysis must pass through,
 *   - the 6 specialized analysis TEAMS (revenue, pricing, customer, operations,
 *     marketing, ai) — each a real analyst persona with a domain charter,
 *   - the internal DEBATE roles (recommendation → critic → risk → supervisor),
 *   - the 5-member supervisor COUNCIL,
 *   - the JSON schemas that constrain every model output so memory can score it,
 *   - one shared funnel (runRole) over the real Claude proxy and one tolerant
 *     JSON parser.
 *
 * No behavior beyond the funnel lives here — the engines (debate, pipeline,
 * council, meetings, rankings, evolution) compose these pieces. Honest by
 * construction: runRole returns { ok:false, error:'AI_NOT_CONFIGURED' } when the
 * proxy is not configured; it never fabricates analysis.
 */
;(function (global) {
  'use strict';

  function data() { return global.AAA_DATA; }
  function cfg() { return global.AAA_CONFIG || {}; }

  // Workers analyze on Sonnet; supervisors/CEO synthesize on Opus.
  const WORKER = 'claude-sonnet-4-6';
  const EXEC = 'claude-opus-4-8';

  const COMPANY = 'AAA Carpet — a residential & commercial carpet cleaning, repair, stretching, ' +
    'installation, apartment-turn, and flooring company. Field crews run jobs on mobile; the office ' +
    'handles sales, scheduling, dispatch, and billing.';

  // ---- the six layers every analysis passes through ----------------------
  const LAYERS = [
    { n: 1, id: 'collection', name: 'Data Collection', purpose: 'Pull the real numbers from shared memory. No model. Deterministic.' },
    { n: 2, id: 'analysis', name: 'Analysis', purpose: 'A domain analyst reasons over the real data and proposes findings + a recommendation.' },
    { n: 3, id: 'validation', name: 'Validation', purpose: 'A critic challenges assumptions; a risk analyst surfaces what could go wrong.' },
    { n: 4, id: 'supervisor', name: 'Supervisor Review', purpose: 'A supervisor synthesizes one verdict with a calibrated confidence and gates acceptance.' },
    { n: 5, id: 'executive', name: 'Executive Intelligence', purpose: 'Accepted findings roll up into the executive command center.' },
    { n: 6, id: 'learning', name: 'Learning & Evolution', purpose: 'Everything is logged so outcomes can re-score it and analysts can be ranked & evolved.' }
  ];

  // ---- richer analysis contract (Layer 2 output) -------------------------
  const STRLIST = { type: 'array', items: { type: 'string' } };
  const ANALYSIS_SCHEMA = {
    type: 'object',
    properties: {
      summary: { type: 'string', description: 'One-paragraph read of the situation, grounded in the supplied numbers.' },
      findings: { type: 'array', items: { type: 'string' }, description: 'Concrete observations, each tied to a real number from the data.' },
      opportunities: STRLIST,
      risks: STRLIST,
      recommendation: { type: 'string', description: 'The single most important action to take now.' },
      confidence: { type: 'integer', description: '0-100 confidence in the recommendation given the evidence.' },
      forecast: { type: 'string', description: 'What you expect to happen next if nothing changes vs. if the recommendation is taken.' },
      metrics_cited: { type: 'array', items: { type: 'string' }, description: 'Which specific real numbers you used. Empty if the data was too thin.' }
    },
    required: ['summary', 'findings', 'opportunities', 'risks', 'recommendation', 'confidence', 'forecast', 'metrics_cited'],
    additionalProperties: false
  };

  // ---- debate contracts (Layer 3 / 4) -----------------------------------
  const CRITIC_SCHEMA = {
    type: 'object',
    properties: {
      critique: { type: 'string', description: 'The single strongest objection to the recommendation.' },
      weaknesses: STRLIST,
      assumptions_challenged: STRLIST,
      revised_recommendation: { type: 'string', description: 'A sharper version of the recommendation, or the original if it holds.' },
      confidence: { type: 'integer', description: '0-100 confidence in the revised recommendation.' }
    },
    required: ['critique', 'weaknesses', 'assumptions_challenged', 'revised_recommendation', 'confidence'],
    additionalProperties: false
  };

  const RISK_SCHEMA = {
    type: 'object',
    properties: {
      risks: { type: 'array', items: { type: 'string' }, description: 'What could go wrong, each concrete.' },
      severity: { type: 'string', enum: ['LOW', 'MEDIUM', 'HIGH'] },
      mitigations: STRLIST,
      blocking: { type: 'boolean', description: 'True only if a risk is severe enough to stop the recommendation outright.' }
    },
    required: ['risks', 'severity', 'mitigations', 'blocking'],
    additionalProperties: false
  };

  // Optional steelman stage (used by the Challenge Protocol path): argue the
  // strongest case for the OPPOSITE decision so the recommendation must beat a
  // real alternative, not a strawman.
  const COUNTER_SCHEMA = {
    type: 'object',
    properties: {
      alternative: { type: 'string', description: 'The strongest alternative decision — ideally the opposite of the recommendation.' },
      case_for: { type: 'string', description: 'The best honest argument for that alternative, grounded in the data.' },
      conditions: { type: 'array', items: { type: 'string' }, description: 'Conditions under which the alternative clearly beats the recommendation.' },
      strength: { type: 'integer', description: '0-100: how strong this counterargument is on the supplied evidence.' }
    },
    required: ['alternative', 'case_for', 'conditions', 'strength'],
    additionalProperties: false
  };

  const VERDICT_SCHEMA = {
    type: 'object',
    properties: {
      verdict: { type: 'string', enum: ['accept', 'revise', 'reject'] },
      final_recommendation: { type: 'string' },
      calibrated_confidence: { type: 'integer', description: '0-100, reflecting evidence strength AND the critic/risk challenge — not just agreement.' },
      rationale: { type: 'string' },
      conditions: { type: 'array', items: { type: 'string' }, description: 'Conditions that must hold for the recommendation to stay valid.' }
    },
    required: ['verdict', 'final_recommendation', 'calibrated_confidence', 'rationale', 'conditions'],
    additionalProperties: false
  };

  const VOTE_SCHEMA = {
    type: 'object',
    properties: {
      vote: { type: 'string', enum: ['approve', 'reject', 'revise'] },
      rationale: { type: 'string', description: 'Why, from this supervisor\'s domain perspective. 1-2 sentences.' },
      confidence: { type: 'integer', description: '0-100 confidence in this vote.' },
      key_concern: { type: 'string', description: 'The one thing this supervisor is most worried about.' }
    },
    required: ['vote', 'rationale', 'confidence', 'key_concern'],
    additionalProperties: false
  };

  function persona(role, charter, model) {
    return 'You are the ' + role + ' for ' + COMPANY + '\n' + charter +
      '\nGround EVERY claim in the JSON data you are given. If a number is missing, say so and lower your confidence — never invent figures. ' +
      'Be concise and operational; your reader is a busy owner, not an academic. Respond ONLY as JSON matching the required schema.';
  }

  // ---- the six specialized analysis teams --------------------------------
  // collector: the key on AAA_INTEL_COLLECTORS that produces this team's real data.
  const TEAMS = {
    revenue: {
      id: 'revenue', name: 'Revenue Intelligence', model: WORKER, collector: 'revenue',
      purpose: 'Understand revenue: trends, ticket sizes, seasonality, profitability, service performance.',
      tracks: ['revenue trends', 'ticket sizes', 'seasonality', 'profitability', 'service performance'],
      outputs: ['growth opportunities', 'revenue risks', 'forecasts'],
      system: persona('Revenue Intelligence Analyst',
        'You own the company\'s top line. Track revenue trends, average ticket size, seasonality, and which services earn the most. Surface growth opportunities and revenue risks, and forecast where revenue is heading.')
    },
    pricing: {
      id: 'pricing', name: 'Pricing Intelligence', model: WORKER, collector: 'pricing',
      purpose: 'Improve quote accuracy: win rates, loss reasons, service-type performance, margin.',
      tracks: ['win rates', 'loss reasons', 'service type performance', 'estimate accuracy', 'margin'],
      outputs: ['pricing recommendations', 'risk scoring', 'margin analysis'],
      system: persona('Pricing Intelligence Analyst',
        'You own quote accuracy and margin. Analyze win/loss rates, why quotes are lost, how each service type prices and performs, and how close estimates land to final amounts. Recommend pricing changes and score margin risk.')
    },
    customer: {
      id: 'customer', name: 'Customer Intelligence', model: WORKER, collector: 'customer',
      purpose: 'Understand customer behavior: objections, sentiment, repeat business, referrals.',
      tracks: ['objections', 'review sentiment', 'repeat customers', 'referrals'],
      outputs: ['retention strategies', 'trust improvements', 'conversion recommendations'],
      system: persona('Customer Intelligence Analyst',
        'You own customer behavior. Analyze objections, review sentiment, repeat customers, and referral sources. Recommend how to retain customers, build trust, and convert more leads.')
    },
    operations: {
      id: 'operations', name: 'Operations Intelligence', model: WORKER, collector: 'operations',
      purpose: 'Improve field execution: durations, productivity, callbacks, rework.',
      tracks: ['job durations', 'crew productivity', 'callbacks', 'mistakes', 'rework'],
      outputs: ['efficiency improvements', 'bottleneck detection', 'quality recommendations'],
      system: persona('Operations Intelligence Analyst',
        'You own field execution. Analyze job durations, crew productivity, callbacks, and rework. Detect bottlenecks and recommend efficiency and quality improvements.')
    },
    marketing: {
      id: 'marketing', name: 'Marketing Intelligence', model: WORKER, collector: 'marketing',
      purpose: 'Improve lead generation: channel ROI, conversion, lead quality.',
      tracks: ['channel performance', 'conversion rates', 'lead quality', 'SEO/GBP/Ads'],
      outputs: ['ranking opportunities', 'ad recommendations', 'content opportunities'],
      system: persona('Marketing Intelligence Analyst',
        'You own lead generation. Analyze close rate and volume per channel, conversion, and lead quality. Recommend where to focus spend and how to attract more profitable jobs. Be explicit that live ad-platform data is not yet wired in when it is absent.')
    },
    ai: {
      id: 'ai', name: 'AI Intelligence', model: EXEC, collector: 'ai',
      purpose: 'Audit all AI agents: hallucinations, bad recommendations, low-confidence and failure patterns.',
      tracks: ['low-confidence outputs', 'mis-calibration', 'failure patterns', 'per-agent track record'],
      outputs: ['prompt improvements', 'architecture improvements', 'retraining recommendations'],
      system: persona('AI Intelligence Auditor',
        'You audit the company\'s own AI agents. Using their real decision track record (confidence, calibration scores, win/loss), find over/under-confidence, failure patterns, and low-confidence hotspots. Recommend prompt, architecture, or retraining changes. You are the brake on bad AI, not its cheerleader.', EXEC)
    }
  };

  // ---- internal debate roles ---------------------------------------------
  const DEBATE = {
    recommendation: { id: 'recommendation', model: WORKER }, // filled per-team at runtime
    critic: {
      id: 'critic', model: WORKER,
      system: persona('Critic Analyst',
        'You are the loyal opposition. Given a recommendation and the real data behind it, find its single strongest weakness, challenge its assumptions, and propose a sharper version. Your job is accuracy, not agreement — but do not manufacture objections the data does not support.')
    },
    risk: {
      id: 'risk', model: WORKER,
      system: persona('Risk Analyst',
        'You surface what could go wrong with a recommendation: financial, operational, reputational, legal. Rate overall severity and propose mitigations. Mark blocking=true ONLY when a risk is severe enough that the action should not proceed as-is.')
    },
    counter: {
      id: 'counter', model: WORKER,
      system: persona('Counterargument Analyst',
        'You steelman the opposite decision. Build the strongest honest case AGAINST the recommendation and FOR a credible alternative. If, after a genuine effort, no real alternative beats the recommendation, say so and set strength low.')
    },
    supervisor: {
      id: 'supervisor', model: EXEC,
      system: persona('Review Supervisor',
        'You arbitrate a debate. You see the recommendation, the critic\'s challenge, and the risk assessment. Decide accept / revise / reject, write the final recommendation, and set a CALIBRATED confidence that reflects evidence strength and the severity of unresolved objections — not how many agents agreed.', EXEC)
    }
  };

  // ---- supervisor council (votes on major decisions) ---------------------
  const COUNCIL = [
    { id: 'revenue_supervisor', title: 'Revenue Supervisor', model: EXEC,
      system: persona('Revenue Supervisor', 'You vote on major decisions from the lens of revenue, growth, and ticket size. Approve only what grows profitable revenue durably.', EXEC) },
    { id: 'operations_supervisor', title: 'Operations Supervisor', model: EXEC,
      system: persona('Operations Supervisor', 'You vote from the lens of crew capacity, execution feasibility, and quality. Flag anything the field cannot deliver well.', EXEC) },
    { id: 'marketing_supervisor', title: 'Marketing Supervisor', model: EXEC,
      system: persona('Marketing Supervisor', 'You vote from the lens of lead generation, channel ROI, and brand. Approve what attracts better jobs at a sane cost.', EXEC) },
    { id: 'customer_supervisor', title: 'Customer Supervisor', model: EXEC,
      system: persona('Customer Supervisor', 'You vote from the lens of customer trust, retention, and satisfaction. Block anything that erodes long-term trust for a short-term gain.', EXEC) },
    { id: 'ai_supervisor', title: 'AI Supervisor', model: EXEC,
      system: persona('AI Supervisor', 'You vote from the lens of evidence quality and AI reliability. Reject decisions resting on thin data or mis-calibrated agent confidence.', EXEC) }
  ];

  // Tolerant JSON extraction shared by every engine: straight parse → strip
  // ```json fences → first balanced {...} block. Returns null if unrecoverable.
  function parseJson(text) {
    const s = String(text == null ? '' : text).trim();
    if (!s) return null;
    try { return JSON.parse(s); } catch (_) {}
    const fenced = s.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
    if (fenced !== s) { try { return JSON.parse(fenced); } catch (_) {} }
    const start = s.indexOf('{'); const end = s.lastIndexOf('}');
    if (start !== -1 && end > start) { try { return JSON.parse(s.slice(start, end + 1)); } catch (_) {} }
    return null;
  }

  const Division = {
    WORKER: WORKER, EXEC: EXEC, COMPANY: COMPANY,
    LAYERS: LAYERS, TEAMS: TEAMS, DEBATE: DEBATE, COUNCIL: COUNCIL,
    ANALYSIS_SCHEMA: ANALYSIS_SCHEMA, CRITIC_SCHEMA: CRITIC_SCHEMA,
    RISK_SCHEMA: RISK_SCHEMA, COUNTER_SCHEMA: COUNTER_SCHEMA,
    VERDICT_SCHEMA: VERDICT_SCHEMA, VOTE_SCHEMA: VOTE_SCHEMA,
    parseJson: parseJson,

    teamIds: function () { return Object.keys(TEAMS); },
    team: function (id) { return TEAMS[id] || null; },
    councilIds: function () { return COUNCIL.map(function (m) { return m.id; }); },

    /** The proxy must be live to run any model role. Pure reads never need this. */
    isReady: function () {
      return !!(data() && cfg().isProxyConfigured && cfg().isProxyConfigured());
    },

    /**
     * The single funnel every intelligence engine uses to call a model role.
     * @param {object} role    { id, model, system }
     * @param {string} prompt  the user prompt (data is embedded as JSON by callers)
     * @param {object} schema  json_schema to constrain output
     * @param {object} [opts]  { maxTokens, agent }
     * @returns {Promise<{ok:boolean, data?:object, raw?:string, error?:string}>}
     */
    runRole: async function (role, prompt, schema, opts) {
      if (!data()) return { ok: false, error: 'NO_DATA_LAYER' };
      if (!this.isReady()) return { ok: false, error: 'AI_NOT_CONFIGURED', role: role && role.id };
      opts = opts || {};
      const payload = {
        agent: opts.agent || (role && role.id) || 'analyst',
        model: (role && role.model) || WORKER,
        max_tokens: opts.maxTokens || 900,
        system: role && role.system,
        messages: [{ role: 'user', content: String(prompt || '') }]
      };
      if (schema) payload.output_config = { format: { type: 'json_schema', schema: schema } };
      const res = await data().callAgent(payload);
      if (!res || res.ok === false) return { ok: false, error: (res && res.error) || 'CALL_FAILED', role: role && role.id };
      const parsed = parseJson(res.text || '');
      if (!parsed) return { ok: false, error: 'BAD_OUTPUT', role: role && role.id, raw: res.text };
      return { ok: true, data: parsed, raw: res.text };
    }
  };

  global.AAA_ANALYSIS_DIVISION = Division;
})(typeof window !== 'undefined' ? window : this);
