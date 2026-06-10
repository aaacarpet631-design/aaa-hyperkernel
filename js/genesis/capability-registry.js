/*
 * AAA Capability Registry — the Agent DNA Registry and the "do we already have
 * someone for this?" answer.
 *
 * Holds the five DNA vectors (capabilities, domains, entities, contexts,
 * classes) plus the SIGNATURE map: action+entity[+context] → the registered
 * agent that handles it. Permanent agents (class A/B — the existing AAA_AGENTS
 * org chart) are seeded as static signatures; promoted ephemeral agents are
 * added at runtime and persisted to `capability_signatures` so a promotion
 * survives reload.
 *
 * Core principle: static agents are permanent employees; ephemeral agents are
 * temporary specialists. The supervisor-orchestrator must use a permanent
 * agent when the capability already exists — canHandle() is that check, and
 * it is deterministic and fail-honest (no fuzzy matches: an unknown need
 * returns null, which is precisely what fires the Gap Detector).
 */
;(function (global) {
  'use strict';

  const SIGNATURES = 'capability_signatures';

  function cfg() { return global.AAA_CONFIG || {}; }
  function data() { return global.AAA_DATA; }
  function ids() { return global.AAA_ID_FACTORY; }
  function clock() { return global.AAA_RUNTIME_CLOCK; }
  function ws() { return cfg().workspaceId || 'default'; }
  function nowISO() { return clock() && clock().nowISO ? clock().nowISO() : new Date().toISOString(); }
  function mine(r) { return r && (r.workspaceId == null || r.workspaceId === ws()); }
  function slug(v) { return String(v == null ? '' : v).toLowerCase().trim().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, ''); }

  // ---- the five DNA vectors -------------------------------------------------
  const CAPABILITIES = ['detect', 'analyze', 'predict', 'verify', 'schedule', 'optimize', 'audit', 'generate', 'learn', 'calibrate', 'calculate', 'translate'];
  const DOMAINS = ['vision', 'finance', 'operations', 'routing', 'inventory', 'legal', 'language'];
  const ENTITIES = ['customer', 'job', 'invoice', 'quote', 'photo', 'damage', 'margin', 'review', 'carpetroll', 'fillpiece', 'equipment', 'payment', 'lead'];
  const CONTEXTS = ['category3water', 'napdirectionsync', 'offlinesyncqueue']; // open vector — any slug is a valid context
  // Classes live in AAA_AGENT_TEMPLATE.AGENT_CLASSES.

  // Permanent (class B) signatures seeded from the existing org chart: the
  // capabilities the company already employs. action|entity → agent role id.
  const PERMANENT = {
    'analyze|quote': { agentId: 'estimator', klass: 'B' },
    'optimize|quote': { agentId: 'pricing_optimizer', klass: 'B' },
    'calculate|margin': { agentId: 'finance', klass: 'B' },
    'verify|payment': { agentId: 'finance', klass: 'B' },
    'schedule|job': { agentId: 'operations', klass: 'B' },
    'generate|review': { agentId: 'review_engine', klass: 'B' },
    'audit|decision': { agentId: 'supervisor', klass: 'A' }
  };

  function key(action, entity, context) {
    const base = slug(action) + '|' + slug(entity);
    return context ? base + '|' + slug(context) : base;
  }

  const Registry = {
    SIGNATURES: SIGNATURES,
    CAPABILITIES: CAPABILITIES.slice(),
    DOMAINS: DOMAINS.slice(),
    ENTITIES: ENTITIES.slice(),
    CONTEXTS: CONTEXTS.slice(),
    key: key,

    /** All signatures: permanent seeds + persisted (promoted) ones. */
    async signatures() {
      const dyn = data() ? (await data().list(SIGNATURES)).filter(mine) : [];
      const out = Object.keys(PERMANENT).map((k) => Object.assign({ signature: k, permanent: true }, PERMANENT[k]));
      dyn.forEach((r) => out.push(r));
      return out;
    },

    /**
     * Can a registered agent already handle this need? Tries the exact
     * action|entity|context signature first, then the broader action|entity.
     * Returns { agentId, klass, signature } or null — null fires the gap.
     */
    async canHandle(action, entity, context) {
      const exact = key(action, entity, context);
      const broad = key(action, entity);
      const dyn = data() ? (await data().list(SIGNATURES)).filter(mine) : [];
      const hitDyn = dyn.find((r) => r.signature === exact) || dyn.find((r) => r.signature === broad);
      if (hitDyn) return { agentId: hitDyn.agentId, klass: hitDyn.klass || 'C', signature: hitDyn.signature, permanent: !!hitDyn.permanent };
      const hit = PERMANENT[exact] || PERMANENT[broad];
      return hit ? { agentId: hit.agentId, klass: hit.klass, signature: PERMANENT[exact] ? exact : broad, permanent: true } : null;
    },

    /**
     * Register a signature for a (promoted) agent. Persisted, workspace-scoped.
     * Refuses to shadow a permanent seed — permanent employees are not replaced
     * by temps.
     */
    async register(action, entity, context, agentId, klass) {
      const sig = key(action, entity, context);
      if (PERMANENT[sig]) return { ok: false, error: 'PERMANENT_EXISTS', signature: sig };
      const id = ids() ? ids().createId('cap') : 'cap_' + Date.now();
      const rec = { id: id, workspaceId: ws(), signature: sig, agentId: agentId, klass: klass || 'C', permanent: true, promotedAt: nowISO() };
      await data().put(SIGNATURES, id, rec);
      return { ok: true, record: rec };
    }
  };

  global.AAA_CAPABILITY_REGISTRY = Registry;
})(typeof window !== 'undefined' ? window : this);
