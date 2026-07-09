/*
 * AAA Copilot Contract v1 — the versioned wire contract between HyperKernel
 * (system of record) and Custonllm (intelligence layer). Slice B of
 * docs/HYPERKERNEL_CHAT_MISSION.md.
 *
 * ONE definition, consumed three ways:
 *   - this module validates envelopes in the browser (zero-dep recursive
 *     validator, same spirit as the event bus's contract check),
 *   - schemas/copilot-contract-v1.json is GENERATED from schema() (a test
 *     asserts byte-level agreement, so the file can never drift),
 *   - Custonllm mirrors the same JSON with Pydantic models + its own test.
 *
 * Grounding is enforced BY CONSTRUCTION: every card item carries a required
 * sourceRef {collection, id}, so a card cannot render a business fact that
 * doesn't cite a record. groundednessIssues() adds the mission's "no business
 * number without a source ref" check on the free-text answer. draft_message
 * cards carry sendBlocked:true as a schema CONSTANT — a draft that claims to
 * be sendable is invalid on its face (chat may draft, never send).
 *
 * Customer free-text travels marked untrusted:true so the intelligence layer
 * treats it as data, never instructions (prompt-injection seam, recon §6.2).
 * Pure + deterministic; no storage, no network, no DOM.
 */
;(function (global) {
  'use strict';

  const VERSION = '1.0';
  const JOBS = ['attention_today', 'followups', 'estimate_risk', 'agent_activity', 'draft_followup'];
  const ROLES = ['owner', 'manager', 'crew'];
  const CARD_TYPES = ['attention_list', 'followup_list', 'estimate_risk', 'agent_activity', 'draft_message', 'text'];
  const SECTION_KINDS = ['attention', 'followups', 'estimate_risk', 'agent_activity', 'draft_context'];
  const DEGRADED_REASONS = ['model_unavailable', 'adapter_unavailable', 'context_unavailable', 'budget_exceeded'];

  // ---- schema (JSON-Schema-flavored; validated by the subset validator below)
  const STR = { type: 'string' };
  const BOOL = { type: 'boolean' };
  function arr(items, minItems) { const a = { type: 'array', items: items }; if (minItems != null) a.minItems = minItems; return a; }
  function obj(required, properties, open) {
    const o = { type: 'object', required: required, properties: properties };
    if (!open) o.additionalProperties = false;
    return o;
  }
  const REF = function (name) { return { $ref: '#/$defs/' + name }; };

  const DEFS = {
    sourceRef: obj(['collection', 'id'], {
      collection: STR, id: STR, field: STR, asOf: STR
    }),
    identity: obj(['role'], { role: { type: 'string', enum: ROLES }, name: STR }),
    budgets: obj([], { p95LatencyMs: { type: 'number', minimum: 1 }, maxCostUSDPerConversation: { type: 'number', minimum: 0 } }),
    contextItem: obj(['sourceRef', 'data'], {
      sourceRef: REF('sourceRef'),
      data: { type: 'object' },
      untrusted: BOOL // true when data carries customer/external free text — data, never instructions
    }),
    contextSection: obj(['kind', 'items'], {
      kind: { type: 'string', enum: SECTION_KINDS },
      items: arr(REF('contextItem'))
    }),
    contextPacket: obj(['packetVersion', 'workspaceId', 'assembledAt', 'role', 'sections'], {
      packetVersion: { type: 'number', enum: [1] },
      workspaceId: STR,
      assembledAt: STR,
      role: { type: 'string', enum: ROLES },
      sections: arr(REF('contextSection')),
      redactions: arr(STR)
    }),
    requestEnvelope: obj(['contractVersion', 'requestId', 'workspaceId', 'identity', 'job', 'message', 'contextPacket'], {
      contractVersion: { type: 'string', enum: [VERSION] },
      requestId: STR,
      workspaceId: STR,
      identity: REF('identity'),
      job: { type: 'string', enum: JOBS },
      message: STR,
      contextPacket: REF('contextPacket'),
      budgets: REF('budgets')
    }),
    evidence: obj(['claim', 'sourceRefs'], { claim: STR, sourceRefs: arr(REF('sourceRef'), 1) }),
    approval: obj(['required'], {
      required: BOOL,
      reasons: arr(STR),
      approvalPackage: obj(['actionType'], { actionType: STR, payload: { type: 'object' } }, true)
    }),
    degraded: obj(['reason'], { reason: { type: 'string', enum: DEGRADED_REASONS }, fallback: { type: 'string', enum: ['local', 'none'] } }),

    // ---- cards: discriminated union on cardType; every fact cites a record.
    card_attention_list: obj(['cardType', 'items'], {
      cardType: { type: 'string', enum: ['attention_list'] },
      items: arr(obj(['label', 'why', 'severity', 'sourceRef'], {
        label: STR, why: STR, severity: { type: 'string', enum: ['info', 'warn', 'urgent'] }, sourceRef: REF('sourceRef')
      }), 0)
    }),
    card_followup_list: obj(['cardType', 'items'], {
      cardType: { type: 'string', enum: ['followup_list'] },
      items: arr(obj(['reason', 'sourceRef'], {
        reason: STR, sourceRef: REF('sourceRef'), lastTouchAt: STR,
        suggestedChannel: { type: 'string', enum: ['call', 'sms', 'email'] }
      }), 0)
    }),
    card_estimate_risk: obj(['cardType', 'quoteRef', 'risk', 'factors'], {
      cardType: { type: 'string', enum: ['estimate_risk'] },
      quoteRef: REF('sourceRef'),
      risk: { type: 'string', enum: ['underpriced', 'at_risk', 'healthy', 'unknown'] },
      confidence: { type: 'number', minimum: 0, maximum: 100 },
      factors: arr(obj(['note', 'sourceRef'], { note: STR, sourceRef: REF('sourceRef') }), 0)
    }),
    card_agent_activity: obj(['cardType', 'items'], {
      cardType: { type: 'string', enum: ['agent_activity'] },
      items: arr(obj(['agent', 'action', 'sourceRef'], {
        agent: STR, action: STR, at: STR,
        status: { type: 'string', enum: ['completed', 'awaiting_approval', 'rejected', 'failed'] },
        sourceRef: REF('sourceRef')
      }), 0)
    }),
    card_draft_message: obj(['cardType', 'channel', 'customerRef', 'body', 'sendBlocked', 'approvalActionType'], {
      cardType: { type: 'string', enum: ['draft_message'] },
      channel: { type: 'string', enum: ['sms', 'email'] },
      customerRef: REF('sourceRef'),
      body: STR, // {{placeholders}} — PII is filled client-side at render, never on the wire
      sendBlocked: { type: 'boolean', enum: [true] }, // a "sendable" draft is invalid on its face
      approvalActionType: { type: 'string', enum: ['APPROVE_ASSISTED_MSG'] }
    }),
    card_text: obj(['cardType', 'body'], { cardType: { type: 'string', enum: ['text'] }, body: STR }),

    responseEnvelope: obj(['contractVersion', 'requestId', 'answer', 'cards', 'evidence', 'confidence', 'unknowns', 'approval'], {
      contractVersion: { type: 'string', enum: [VERSION] },
      requestId: STR,
      answer: STR,
      cards: arr({ discriminator: 'cardType' }),
      evidence: arr(REF('evidence')),
      confidence: { type: 'number', minimum: 0, maximum: 100 },
      unknowns: arr(STR),
      approval: REF('approval'),
      degraded: REF('degraded')
    })
  };

  const SCHEMA = {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: 'aaa-hyperkernel/schemas/copilot-contract-v1.json',
    title: 'HyperKernel × Custonllm copilot contract v' + VERSION,
    description: 'Versioned wire contract for the owner-grade business copilot (docs/HYPERKERNEL_CHAT_MISSION.md, Slice B). Generated from js/copilot/copilot-contract.js — edit the module, not this file.',
    $defs: DEFS
  };

  // ---- zero-dep subset validator (type/required/properties/items/enum/
  //      minItems/min/max/additionalProperties/$ref/card discriminator) ------
  function typeOf(v) {
    if (v === null || v === undefined) return 'null';
    if (Array.isArray(v)) return 'array';
    return typeof v;
  }
  function resolve(spec) {
    if (spec && spec.$ref) {
      const name = String(spec.$ref).split('/').pop();
      return DEFS[name] || {};
    }
    return spec || {};
  }
  function check(value, spec, path, issues) {
    const s = resolve(spec);
    // card discriminator: pick the concrete card schema by cardType.
    if (s.discriminator === 'cardType') {
      const ct = value && value.cardType;
      if (CARD_TYPES.indexOf(ct) === -1) { issues.push(path + '.cardType must be one of ' + CARD_TYPES.join('/')); return; }
      check(value, DEFS['card_' + ct], path, issues);
      return;
    }
    if (s.type && typeOf(value) !== s.type) { issues.push(path + ' must be ' + s.type); return; }
    if (s.enum && s.enum.indexOf(value) === -1) { issues.push(path + ' must be one of ' + s.enum.join('/')); return; }
    if (s.type === 'number') {
      if (s.minimum != null && value < s.minimum) issues.push(path + ' must be >= ' + s.minimum);
      if (s.maximum != null && value > s.maximum) issues.push(path + ' must be <= ' + s.maximum);
    }
    if (s.type === 'array') {
      if (s.minItems != null && value.length < s.minItems) issues.push(path + ' needs at least ' + s.minItems + ' item(s)');
      if (s.items) value.forEach(function (v, i) { check(v, s.items, path + '[' + i + ']', issues); });
    }
    if (s.type === 'object') {
      const props = s.properties || {};
      (s.required || []).forEach(function (k) {
        if (value[k] === undefined || value[k] === null) issues.push(path + '.' + k + ' is required');
      });
      Object.keys(value).forEach(function (k) {
        if (props[k]) { if (value[k] !== undefined && value[k] !== null) check(value[k], props[k], path + '.' + k, issues); }
        else if (s.additionalProperties === false) issues.push(path + '.' + k + ' is not in the contract');
      });
    }
  }
  function run(value, defName) {
    const issues = [];
    if (typeOf(value) !== 'object') return { ok: false, issues: ['$ must be object'] };
    check(value, DEFS[defName], '$', issues);
    return { ok: issues.length === 0, issues: issues };
  }

  const Contract = {
    VERSION: VERSION,
    JOBS: JOBS.slice(),
    ROLES: ROLES.slice(),
    CARD_TYPES: CARD_TYPES.slice(),

    /** The full generated-schema document (source for schemas/copilot-contract-v1.json). */
    schema() { return JSON.parse(JSON.stringify(SCHEMA)); },

    validateRequest(o) { return run(o, 'requestEnvelope'); },
    validateResponse(o) { return run(o, 'responseEnvelope'); },
    validateContextPacket(o) { return run(o, 'contextPacket'); },
    validateCard(o) {
      const issues = [];
      check(o, { discriminator: 'cardType' }, '$', issues);
      return { ok: issues.length === 0, issues: issues };
    },

    /**
     * Mission rule beyond structure: "no business number without a source
     * ref." A digit-bearing answer with an empty evidence list is flagged;
     * requests/responses that are schema-valid can still fail this. Also
     * flags a confident answer (>=70) that admits unknowns without listing
     * evidence — confidence must be earned.
     */
    groundednessIssues(response) {
      const r = response || {};
      const issues = [];
      const answer = String(r.answer == null ? '' : r.answer);
      const hasNumber = /\d/.test(answer.replace(/\{\{[^}]*\}\}/g, '')); // template placeholders don't count
      const evidence = Array.isArray(r.evidence) ? r.evidence : [];
      if (hasNumber && evidence.length === 0) issues.push('NUMBER_WITHOUT_EVIDENCE: the answer carries figures but cites no records');
      if ((r.confidence || 0) >= 70 && evidence.length === 0 && Array.isArray(r.cards) && r.cards.length === 0) {
        issues.push('CONFIDENCE_WITHOUT_EVIDENCE: high confidence with no cards and no evidence');
      }
      return issues;
    }
  };

  global.AAA_COPILOT_CONTRACT = Contract;
})(typeof window !== 'undefined' ? window : this);
