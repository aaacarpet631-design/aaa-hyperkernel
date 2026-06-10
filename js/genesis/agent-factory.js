/*
 * AAA Agent Factory — splices a DNA genome into an ephemeral agent spec.
 *
 * Spawning formula:  Action + Entity + Context/Event  =  Ephemeral Agent
 *
 *   verify + invoice + over $10,000  → large-invoice-verification-agent
 *   detect + damage  + bleach stains → bleach-damage-vision-agent
 *   calculate + margin + holiday OT  → holiday-margin-calculator-agent
 *   translate + review + korean      → korean-review-translation-agent
 *
 * The factory is deterministic: the same need always yields the same name,
 * council, least-privilege read/write sets, risk level, output contract, and
 * safety baseline. Every spec is validated against AAA_AGENT_TEMPLATE before
 * it leaves the factory — an invalid genome is never returned, only the
 * validation failure (no fake success).
 */
;(function (global) {
  'use strict';

  function ids() { return global.AAA_ID_FACTORY; }
  function template() { return global.AAA_AGENT_TEMPLATE; }

  function slugTokens(v) { return String(v == null ? '' : v).toLowerCase().match(/[a-z0-9]+/g) || []; }

  // Action → the noun used in the agent's name. detect defers to the DOMAIN
  // (detect+vision → "vision"), matching the canonical examples.
  const ACTION_NOUN = {
    detect: null, verify: 'verification', calculate: 'calculator', translate: 'translation',
    analyze: 'analysis', predict: 'prediction', schedule: 'scheduler', optimize: 'optimizer',
    audit: 'auditor', generate: 'generator', learn: 'learner', calibrate: 'calibrator'
  };

  // Context head aliases so well-known contexts read like a human named them.
  const CONTEXT_ALIAS = { 'over 10000': 'large', 'over 10 000': 'large', 'over 10k': 'large' };

  // Domain → owning council (the department the temp reports to).
  const COUNCILS = {
    vision: 'operations_intelligence', operations: 'operations_intelligence', routing: 'operations_intelligence',
    inventory: 'operations_intelligence', finance: 'business', language: 'business', legal: 'security'
  };

  // Least-privilege defaults: what each entity's specialist may read…
  const READS = {
    damage: ['photos', 'jobs', 'customers'],
    invoice: ['invoices', 'jobs', 'customers'],
    margin: ['quotes', 'jobs'],
    review: ['review_requests', 'jobs'],
    quote: ['quotes', 'jobs', 'customers'],
    job: ['jobs', 'customers']
  };
  // …and the single fact collection each action+entity pair may write.
  const WRITES = {
    'detect|damage': ['damage_assessments'],
    'verify|invoice': ['invoice_verifications'],
    'calculate|margin': ['margin_calculations'],
    'translate|review': ['review_translations']
  };

  // Output contracts (validated by the runtime before any fact is written).
  const OUTPUT_SCHEMAS = {
    'detect|damage': {
      required: ['assessment', 'indicates', 'confidence'],
      properties: {
        assessment: { type: 'string' },
        indicates: { type: 'string' },
        severity: { type: 'string', enum: ['minor', 'moderate', 'severe'] },
        confidence: { type: 'number' },
        recommendation: { type: 'string' }
      }
    },
    'verify|invoice': { required: ['verdict', 'confidence'], properties: { verdict: { type: 'string', enum: ['verified', 'flagged'] }, confidence: { type: 'number' }, reasons: { type: 'array' } } },
    'translate|review': { required: ['translation', 'confidence'], properties: { translation: { type: 'string' }, confidence: { type: 'number' } } }
  };
  const DEFAULT_OUTPUT = { required: ['result', 'confidence'], properties: { result: { type: 'string' }, confidence: { type: 'number' } } };

  // Money-bearing entities raise risk; a large-amount context raises it again.
  const MONEY_ENTITIES = ['invoice', 'payment', 'margin', 'refund'];

  function pairKey(action, entity) { return String(action) + '|' + String(entity); }

  const Factory = {
    /** Deterministic agent name from the spawning formula. */
    nameFor(action, entity, context, domain) {
      const ctxNorm = slugTokens(context).join(' ');
      const head = CONTEXT_ALIAS[ctxNorm] || slugTokens(context)[0] || 'general';
      const noun = ACTION_NOUN[action] === null ? (domain || 'detection') : (ACTION_NOUN[action] || action);
      return [head, slugTokens(entity)[0] || 'entity', noun, 'agent'].join('-');
    },

    /**
     * Splice a full ephemeral-agent spec from a need
     * ({action, entity, context, domain, triggerEvent}). Returns
     * { ok, spec } or { ok:false, issues } — never an invalid genome.
     */
    splice(need) {
      const n = need || {};
      const t = template();
      if (!t) return { ok: false, error: 'TEMPLATE_MISSING' };
      const action = String(n.action || '').toLowerCase();
      const entity = String(n.entity || '').toLowerCase();
      const context = String(n.context || 'general');
      const domain = n.domain ? String(n.domain).toLowerCase() : null;
      const pair = pairKey(action, entity);

      const money = MONEY_ENTITIES.indexOf(entity) !== -1;
      const large = /\b(over|above)\b/.test(context) || /10000|10k/.test(context);
      const riskLevel = money ? (large ? 'high' : 'medium') : 'low';

      const spec = {
        agentId: ids() ? ids().createId('eph') : 'eph_' + Date.now(),
        name: this.nameFor(action, entity, context, domain),
        council: COUNCILS[domain] || 'operations_intelligence',
        klass: 'C',
        action: action,
        targetEntity: entity,
        context: context,
        triggerEvent: String(n.triggerEvent || ''),
        allowedReads: (READS[entity] || ['jobs']).slice(),
        allowedWrites: (WRITES[pair] || [action + '_' + entity + '_results']).concat(['graph_facts']),
        forbiddenActions: t.BASELINE_FORBIDDEN.slice(),
        tools: ['read_store', 'write_facts', 'decision_log'].concat(domain === 'vision' ? ['vision'] : []),
        maxRuntimeMs: 15000,
        maxCostUsd: 0.25,
        riskLevel: riskLevel,
        approvalRequired: riskLevel === 'high',
        expectedOutputSchema: OUTPUT_SCHEMAS[pair] || DEFAULT_OUTPUT,
        rollbackPlan: 'All writes are additive facts; rollback marks this run rolled_back and tombstones its graph_facts (retracted:true). No source record is ever mutated.',
        terminationCondition: 'single_task_complete'
      };

      const v = t.validate(spec);
      return v.ok ? { ok: true, spec: spec } : { ok: false, issues: v.issues };
    }
  };

  global.AAA_AGENT_FACTORY = Factory;
})(typeof window !== 'undefined' ? window : this);
