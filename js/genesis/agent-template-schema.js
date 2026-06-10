/*
 * AAA Agent Template Schema — the DNA contract every ephemeral agent must match.
 *
 * The Genesis Council's equivalent of a Zod schema, realized natively: a
 * deterministic, zero-dependency validator over the ephemeral-agent spec. A
 * spec that fails validation is never spawned — no fake success, no partial
 * agents. The schema also carries the kernel's hard SAFETY baseline: the ten
 * forbidden actions no ephemeral agent may ever perform, and the protected
 * collections no ephemeral agent may ever write. Validation REJECTS any spec
 * that tries to drop a baseline rule or claim a protected write.
 *
 * Agent classes (the strict hierarchy):
 *   A Kernel    — permanent, immutable physics (governance, provenance, graph)
 *   B Council   — persistent domain managers (scheduling, accounting, …)
 *   C Specialist— ephemeral, single-task, spawned on demand, then terminated
 *   D Swarm     — massively parallel disposable instances (map-reduce)
 *
 * Pure and deterministic: no I/O, no clock, no randomness.
 */
;(function (global) {
  'use strict';

  // The four classes of agents. Genesis spawns only C and D.
  const AGENT_CLASSES = {
    A: 'Kernel — permanent, immutable physics engines',
    B: 'Council — persistent domain managers',
    C: 'Specialist — ephemeral single-task agents',
    D: 'Swarm — massively parallel disposable instances'
  };

  // Safety rules: actions NO ephemeral agent may ever perform. Every generated
  // spec must list all of these in forbiddenActions — dropping one is invalid.
  const BASELINE_FORBIDDEN = [
    'contact_customers_without_approval',
    'change_prices_without_governance',
    'issue_refunds_without_approval',
    'delete_records',
    'modify_payroll',
    'alter_legal_contracts',
    'bypass_event_bus',
    'bypass_knowledge_graph',
    'bypass_decision_logging',
    'spawn_agent_without_council_approval'
  ];

  // Collections an ephemeral agent may NEVER claim in allowedWrites.
  const PROTECTED_WRITES = [
    'payroll', 'legal_contracts', 'contracts', 'rate_card', 'prices',
    'refunds', 'governance_audit', 'event_log', 'agent_registry',
    'capability_signatures', 'genesis_runs', 'forged_tools', 'tool_invocations'
  ];

  const RISK_LEVELS = ['low', 'medium', 'high'];

  // Required spec fields and their shallow type checks (the "Zod" of the kernel).
  const FIELDS = {
    agentId: 'string',
    name: 'string',
    council: 'string',
    klass: 'string',                 // 'C' | 'D' — genesis never mints A/B
    action: 'string',
    targetEntity: 'string',
    context: 'string',
    triggerEvent: 'string',
    allowedReads: 'array',
    allowedWrites: 'array',
    forbiddenActions: 'array',
    tools: 'array',
    maxRuntimeMs: 'number',
    maxCostUsd: 'number',
    riskLevel: 'string',
    approvalRequired: 'boolean',
    expectedOutputSchema: 'object',
    rollbackPlan: 'string',
    terminationCondition: 'string'
  };

  function typeOf(v) { return Array.isArray(v) ? 'array' : (v === null ? 'null' : typeof v); }

  // Minimal deterministic object-schema validator, shared with output checks.
  function validateAgainst(payload, schema) {
    const issues = [];
    const s = schema || {};
    const p = payload || {};
    if (typeOf(p) !== 'object') return { ok: false, issues: ['payload must be an object'] };
    (s.required || []).forEach((k) => { if (p[k] === undefined || p[k] === null) issues.push('missing required: ' + k); });
    const props = s.properties || {};
    Object.keys(props).forEach((k) => {
      if (p[k] === undefined || p[k] === null) return;
      const spec = props[k];
      if (spec.type && typeOf(p[k]) !== spec.type) issues.push(k + ' must be ' + spec.type);
      if (spec.enum && spec.enum.indexOf(p[k]) === -1) issues.push(k + ' must be one of ' + spec.enum.join('/'));
    });
    return { ok: issues.length === 0, issues: issues };
  }

  const Template = {
    AGENT_CLASSES: AGENT_CLASSES,
    BASELINE_FORBIDDEN: BASELINE_FORBIDDEN.slice(),
    PROTECTED_WRITES: PROTECTED_WRITES.slice(),
    RISK_LEVELS: RISK_LEVELS.slice(),
    FIELDS: Object.keys(FIELDS),

    /** Validate an arbitrary payload against a {required, properties} schema. */
    validateAgainst: validateAgainst,

    /**
     * Validate a full ephemeral-agent spec. Returns { ok } or { ok:false, issues }.
     * Enforces field presence/types, the safety baseline, protected writes,
     * positive budgets, and that genesis only mints class C or D.
     */
    validate(spec) {
      const issues = [];
      const s = spec || {};
      Object.keys(FIELDS).forEach((k) => {
        if (s[k] === undefined || s[k] === null) { issues.push('missing required: ' + k); return; }
        if (typeOf(s[k]) !== FIELDS[k]) issues.push(k + ' must be ' + FIELDS[k]);
      });
      if (issues.length) return { ok: false, issues: issues };

      if (s.klass !== 'C' && s.klass !== 'D') issues.push('klass must be C or D — genesis never mints kernel/council agents');
      if (RISK_LEVELS.indexOf(s.riskLevel) === -1) issues.push('riskLevel must be one of ' + RISK_LEVELS.join('/'));
      if (!(s.maxRuntimeMs > 0)) issues.push('maxRuntimeMs must be > 0');
      if (!(s.maxCostUsd >= 0)) issues.push('maxCostUsd must be >= 0');
      if (!/^[a-z0-9][a-z0-9-]*-agent$/.test(s.name)) issues.push('name must be a kebab-case slug ending in -agent');

      // Safety baseline: every forbidden rule must be present, verbatim.
      BASELINE_FORBIDDEN.forEach((rule) => {
        if (s.forbiddenActions.indexOf(rule) === -1) issues.push('forbiddenActions must include baseline: ' + rule);
      });
      // Protected collections can never be written.
      s.allowedWrites.forEach((w) => {
        if (PROTECTED_WRITES.indexOf(String(w)) !== -1) issues.push('allowedWrites may not include protected collection: ' + w);
      });
      // Output contract must itself be a usable schema.
      const out = s.expectedOutputSchema;
      if (!out || typeOf(out) !== 'object' || !Array.isArray(out.required) || !out.required.length) {
        issues.push('expectedOutputSchema must declare at least one required field');
      }
      return { ok: issues.length === 0, issues: issues };
    }
  };

  global.AAA_AGENT_TEMPLATE = Template;
})(typeof window !== 'undefined' ? window : this);
