/*
 * AAA Agent Registry — the AI org chart.
 *
 * Defines the CEO → sub-agent hierarchy plus the Supervisor. Each agent is a
 * real persona (role, who it reports to, model, system prompt). The shared
 * DECISION_SCHEMA constrains every agent's output so the orchestrator can parse
 * and the Supervisor can score it. No behavior here — just configuration the
 * orchestrator drives through the real Claude proxy.
 */
;(function (global) {
  'use strict';

  // Workers run on Sonnet (cheaper, fast); CEO/Supervisor synthesize on Opus.
  const WORKER = 'claude-sonnet-4-6';
  const EXEC = 'claude-opus-4-8';

  // Every agent returns this shape (enforced via output_config json_schema).
  const DECISION_SCHEMA = {
    type: 'object',
    properties: {
      recommendation: { type: 'string', description: 'The concrete recommended action or answer.' },
      rationale: { type: 'string', description: 'Why, grounded in the provided context. 1-3 sentences.' },
      confidence: { type: 'integer', description: '0-100 confidence in this recommendation.' },
      risks: { type: 'array', items: { type: 'string' }, description: 'Key risks or unknowns.' },
      next_actions: { type: 'array', items: { type: 'string' }, description: 'Specific next steps.' }
    },
    required: ['recommendation', 'rationale', 'confidence', 'risks', 'next_actions'],
    additionalProperties: false
  };

  const COMPANY = 'AAA Carpet — a residential & commercial carpet cleaning, repair, and flooring company. Field technicians run jobs on mobile; the office handles sales, scheduling, and billing.';

  function agent(id, title, reportsTo, model, charter) {
    return {
      id: id, title: title, reportsTo: reportsTo, model: model,
      system: 'You are the ' + title + ' agent for ' + COMPANY + '\n' + charter +
        '\nGround every answer in the JSON context you are given. If data is missing, say so in your rationale and lower your confidence. Be concise and operational — your reader is a busy operator, not an analyst. Respond ONLY as JSON matching the required schema.'
    };
  }

  const AGENTS = {
    ceo: agent('ceo', 'CEO', null, EXEC,
      'You set strategy and make the final call. You weigh the sub-agents\' inputs, resolve conflicts, and decide what the company should do. Optimize for profitable, sustainable growth and customer trust.'),
    sales: agent('sales', 'Sales', 'ceo', WORKER,
      'You qualify leads, judge deal value and close probability, and recommend pricing/positioning to win profitable work.'),
    operations: agent('operations', 'Operations', 'ceo', WORKER,
      'You own scheduling, crew capacity, routing, and job execution feasibility. You flag conflicts and resource constraints.'),
    marketing: agent('marketing', 'Marketing', 'ceo', WORKER,
      'You own lead generation and channel ROI (Google Ads, referrals, reviews). You recommend where to spend and how to attract better jobs.'),
    accounting: agent('accounting', 'Accounting', 'ceo', WORKER,
      'You own margins, pricing floors, cash flow, and cost control. You sanity-check that recommended work is actually profitable.'),
    customer_success: agent('customer_success', 'Customer Success', 'ceo', WORKER,
      'You own retention, satisfaction, review generation, and repeat business. You recommend follow-ups and recovery actions.'),
    kpi: agent('kpi', 'KPI', 'ceo', WORKER,
      'You translate raw data into the few numbers that matter and call out trends, anomalies, and targets at risk.'),
    data_scientist: agent('data_scientist', 'Data Scientist', 'ceo', WORKER,
      'You find patterns in jobs/estimates/outcomes, quantify uncertainty, and recommend what to measure or test next.'),
    compliance: agent('compliance', 'Compliance', 'ceo', WORKER,
      'You flag legal, safety, contract, licensing, and data-privacy risks. You are the brake, not the gas.'),
    supervisor: agent('supervisor', 'Supervisor', 'ceo', EXEC,
      'You audit the other agents. You synthesize their inputs into one decision with a calibrated confidence, and after outcomes are known you score whether their recommendations were right so the team improves.')
  };

  // Custom agents created by the Prompt Architect (registered at runtime).
  const CUSTOM = {};

  global.AAA_AGENTS = {
    DECISION_SCHEMA: DECISION_SCHEMA,
    all: AGENTS,
    get: function (id) { return AGENTS[id] || CUSTOM[id] || null; },
    ids: function () { return Object.keys(AGENTS); },
    subAgents: function () { return ['sales', 'operations', 'marketing', 'accounting', 'customer_success', 'kpi', 'data_scientist', 'compliance']; },
    /** Register a saved custom-agent record so the orchestrator can run it. */
    registerCustom: function (rec) {
      if (!rec || !rec.id) return;
      const spec = rec.spec || {};
      CUSTOM[rec.id] = {
        id: rec.id, title: rec.title || spec.name || rec.id, reportsTo: 'ceo',
        model: spec.model || WORKER, system: spec.systemPrompt || ('You are the ' + (spec.name || rec.id) + ' agent for ' + COMPANY),
        custom: true, spec: spec
      };
    },
    customIds: function () { return Object.keys(CUSTOM); }
  };
})(typeof window !== 'undefined' ? window : this);
