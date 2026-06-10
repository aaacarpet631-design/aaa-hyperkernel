/*
 * AAA Event Taxonomy — the 25 highest-value business events as one canonical,
 * classified, contract-validated catalog (Phase-1 deliverable; see HYPERKERNEL.md
 * §1–2).
 *
 * The Event Bus (aaa-event-bus.js) seeds a handful of contracts for its own unit
 * test. This module is the FULL business taxonomy layered on top of it via the
 * public define() API — it never edits the bus seeds, so the bus's committed
 * AsyncAPI artifact and test stay stable. Each event carries five orthogonal
 * classification axes so generic machinery (routing, governance, learning,
 * dashboards) can reason about an event it has never seen:
 *
 *   domain     the noun (lead, quote, job, ...)
 *   stage      where in the value chain (acquisition→sales→delivery→billing→
 *              retention→growth, plus cross-cutting ops/intelligence/governance)
 *   primitive  which first-class primitive it most changes (Entity/Relationship/
 *              Event/Decision/Memory — the five, closed set)
 *   reversible whether automation may produce it unattended (drives the action gate)
 *   risk       low|medium|high (drives escalation; high → always a governance record)
 *
 * Deterministic, null-tolerant, zero-dependency. Auto-registers into AAA_EVENT_BUS
 * on load when the bus is present (idempotent: define() replaces by type).
 */
;(function (global) {
  'use strict';

  function bus() { return global.AAA_EVENT_BUS; }

  // ---- schema shorthands ----------------------------------------------------
  var STR = { type: 'string' };
  var NUM = { type: 'number' };
  function obj(required, properties) { return { type: 'object', required: required || [], properties: properties || {} }; }

  // ---- the canonical 25 -----------------------------------------------------
  // version defaults to 1; description doubles as the AsyncAPI channel summary.
  var TAXONOMY = [
    // ── acquisition ────────────────────────────────────────────────────────
    { type: 'lead.captured', domain: 'lead', stage: 'acquisition', primitive: 'Entity', reversible: true, risk: 'low',
      description: 'A new lead entered the funnel.', schema: obj(['leadId'], { leadId: STR, source: STR, channel: STR }) },
    { type: 'lead.qualified', domain: 'lead', stage: 'acquisition', primitive: 'Decision', reversible: true, risk: 'low',
      description: 'A lead was judged worth pursuing.', schema: obj(['leadId'], { leadId: STR, score: NUM }) },
    { type: 'lead.disqualified', domain: 'lead', stage: 'acquisition', primitive: 'Decision', reversible: true, risk: 'low',
      description: 'A lead was rejected; the reason is training data.', schema: obj(['leadId'], { leadId: STR, reason: STR }) },

    // ── sales (estimate lifecycle = the core prediction loop) ───────────────
    { type: 'quote.created', domain: 'quote', stage: 'sales', primitive: 'Decision', reversible: true, risk: 'low',
      description: 'An estimate (a price + win prediction) was created.', schema: obj(['quoteId'], { quoteId: STR, customerId: STR, total: NUM }) },
    { type: 'quote.sent', domain: 'quote', stage: 'sales', primitive: 'Event', reversible: false, risk: 'medium',
      description: 'An estimate was sent to the customer.', schema: obj(['quoteId'], { quoteId: STR, channel: { type: 'string', enum: ['sms', 'email', 'portal', 'print'] } }) },
    { type: 'quote.viewed', domain: 'quote', stage: 'sales', primitive: 'Event', reversible: true, risk: 'low',
      description: 'The customer opened the estimate (engagement signal).', schema: obj(['quoteId'], { quoteId: STR, at: STR }) },
    { type: 'quote.accepted', domain: 'quote', stage: 'sales', primitive: 'Memory', reversible: false, risk: 'low',
      description: 'WON — the estimate prediction resolved positive.', schema: obj(['quoteId'], { quoteId: STR, total: NUM }) },
    { type: 'quote.rejected', domain: 'quote', stage: 'sales', primitive: 'Memory', reversible: false, risk: 'low',
      description: 'LOST — the estimate prediction resolved negative; reason is the lesson.', schema: obj(['quoteId'], { quoteId: STR, reason: STR }) },
    { type: 'quote.expired', domain: 'quote', stage: 'sales', primitive: 'Memory', reversible: false, risk: 'low',
      description: 'EXPIRED — silent loss; a follow-up learning signal.', schema: obj(['quoteId'], { quoteId: STR }) },

    // ── delivery ────────────────────────────────────────────────────────────
    { type: 'job.scheduled', domain: 'job', stage: 'delivery', primitive: 'Relationship', reversible: true, risk: 'low',
      description: 'Capacity (crew + time) was committed to a job.', schema: obj(['jobId'], { jobId: STR, scheduledFor: STR }) },
    { type: 'job.dispatched', domain: 'job', stage: 'delivery', primitive: 'Relationship', reversible: false, risk: 'medium',
      description: 'Crew + vehicle were committed to the field for a job.', schema: obj(['jobId'], { jobId: STR, crewId: STR, vehicleId: STR }) },
    { type: 'job.completed', domain: 'job', stage: 'delivery', primitive: 'Event', reversible: false, risk: 'low',
      description: 'Work was completed; cost is now knowable.', schema: obj(['jobId'], { jobId: STR }) },
    { type: 'job.closed', domain: 'job', stage: 'delivery', primitive: 'Memory', reversible: false, risk: 'low',
      description: 'The engagement closed with a final outcome.', schema: obj(['jobId'], { jobId: STR, outcome: STR }) },

    // ── ops (cross-cutting capacity) ─────────────────────────────────────────
    { type: 'crew.assigned', domain: 'crew', stage: 'ops', primitive: 'Relationship', reversible: true, risk: 'low',
      description: 'Labor (and a vehicle) were linked to a job.', schema: obj(['jobId', 'crewId'], { jobId: STR, crewId: STR, vehicleId: STR }) },

    // ── billing ──────────────────────────────────────────────────────────────
    { type: 'invoice.issued', domain: 'invoice', stage: 'billing', primitive: 'Entity', reversible: false, risk: 'high',
      description: 'Revenue was recognized; the AR clock started.', schema: obj(['invoiceId'], { invoiceId: STR, jobId: STR, amount: NUM }) },
    { type: 'payment.received', domain: 'payment', stage: 'billing', primitive: 'Memory', reversible: false, risk: 'high',
      description: 'Cash arrived — the outcome that pays the bills.', schema: obj(['paymentId'], { paymentId: STR, invoiceId: STR, amount: NUM }) },
    { type: 'payment.failed', domain: 'payment', stage: 'billing', primitive: 'Event', reversible: true, risk: 'high',
      description: 'A payment attempt failed; collections risk signal.', schema: obj(['invoiceId'], { invoiceId: STR, reason: STR }) },

    // ── retention ─────────────────────────────────────────────────────────────
    { type: 'review.requested', domain: 'review', stage: 'retention', primitive: 'Decision', reversible: true, risk: 'medium',
      description: 'A review request was raised (reputation flywheel input).', schema: obj(['jobId'], { jobId: STR, channel: STR }) },
    { type: 'review.received', domain: 'review', stage: 'retention', primitive: 'Memory', reversible: false, risk: 'low',
      description: 'A review arrived (CSAT / reputation outcome).', schema: obj(['jobId'], { jobId: STR, rating: NUM }) },

    // ── growth ────────────────────────────────────────────────────────────────
    { type: 'referral.created', domain: 'referral', stage: 'growth', primitive: 'Relationship', reversible: true, risk: 'low',
      description: 'A customer referred new demand (lowest-CAC).', schema: obj(['referrerId'], { referrerId: STR, leadId: STR }) },
    { type: 'campaign.launched', domain: 'campaign', stage: 'growth', primitive: 'Entity', reversible: false, risk: 'medium',
      description: 'Marketing spend started; attribution anchor.', schema: obj(['campaignId'], { campaignId: STR, channel: STR, budget: NUM }) },

    // ── intelligence / governance (kernel events) ────────────────────────────
    { type: 'recommendation.created', domain: 'recommendation', stage: 'intelligence', primitive: 'Decision', reversible: true, risk: 'medium',
      description: 'An AI advisory was surfaced to a human.', schema: obj(['id'], { id: STR, agent: STR, confidence: NUM }) },
    { type: 'recommendation.validated', domain: 'recommendation', stage: 'intelligence', primitive: 'Memory', reversible: false, risk: 'low',
      description: 'An advisory was proven right or wrong.', schema: obj(['id'], { id: STR, verdict: { type: 'string', enum: ['validated', 'invalidated'] } }) },
    { type: 'decision.recorded', domain: 'decision', stage: 'governance', primitive: 'Decision', reversible: false, risk: 'high',
      description: 'A governed action was taken or held (emits a governance record).', schema: obj(['id'], { id: STR, actor: STR, action: STR }) },
    { type: 'outcome.recorded', domain: 'outcome', stage: 'governance', primitive: 'Memory', reversible: false, risk: 'low',
      description: 'A ground-truth label arrived; scores everything upstream.', schema: obj(['id'], { id: STR, entityType: STR, entityId: STR, result: STR }) }
  ];

  function index() {
    var byType = {};
    TAXONOMY.forEach(function (e) { byType[e.type] = e; });
    return byType;
  }

  function uniq(values) {
    var seen = {}, out = [];
    values.forEach(function (v) { if (!seen[v]) { seen[v] = 1; out.push(v); } });
    return out.sort();
  }

  var Taxonomy = {
    /** The full classified catalog (array of event definitions). */
    catalog: function () { return TAXONOMY.slice(); },
    /** One event definition by type, or null. */
    get: function (type) { return index()[type] || null; },
    /** Event definitions filtered by a classification axis. */
    byDomain: function (domain) { return TAXONOMY.filter(function (e) { return e.domain === domain; }); },
    byStage: function (stage) { return TAXONOMY.filter(function (e) { return e.stage === stage; }); },
    byPrimitive: function (primitive) { return TAXONOMY.filter(function (e) { return e.primitive === primitive; }); },
    byRisk: function (risk) { return TAXONOMY.filter(function (e) { return e.risk === risk; }); },

    /** The distinct values present on each axis (sorted) — for dashboards/tests. */
    domains: function () { return uniq(TAXONOMY.map(function (e) { return e.domain; })); },
    stages: function () { return uniq(TAXONOMY.map(function (e) { return e.stage; })); },
    primitives: function () { return uniq(TAXONOMY.map(function (e) { return e.primitive; })); },

    /**
     * Deterministic manifest: a stable, diffable summary of the taxonomy. The
     * committed schemas/event-taxonomy.json is generated from this, and a test
     * asserts the live taxonomy matches it (no silent drift).
     */
    manifest: function () {
      var events = TAXONOMY.slice().sort(function (a, b) { return a.type < b.type ? -1 : a.type > b.type ? 1 : 0; })
        .map(function (e) {
          return {
            type: e.type, version: e.version || 1, domain: e.domain, stage: e.stage,
            primitive: e.primitive, reversible: !!e.reversible, risk: e.risk, description: e.description
          };
        });
      var byStage = {}; this.stages().forEach(function (s) { byStage[s] = 0; });
      var byPrimitive = {}; this.primitives().forEach(function (p) { byPrimitive[p] = 0; });
      events.forEach(function (e) { byStage[e.stage]++; byPrimitive[e.primitive]++; });
      return {
        title: 'AAA HyperKernel — 25 highest-value business events',
        count: events.length,
        domains: this.domains(),
        stages: this.stages(),
        primitives: this.primitives(),
        byStage: byStage,
        byPrimitive: byPrimitive,
        events: events
      };
    },

    /**
     * Register every event as a contract on the Event Bus via its public
     * define() API. Idempotent. Returns {ok, registered} or {ok:false} when the
     * bus is absent. Validation/logging/hash-chain all come from the bus — this
     * module only contributes the catalog.
     */
    register: function () {
      var b = bus();
      if (!b || typeof b.define !== 'function') return { ok: false, error: 'EVENT_BUS_MISSING', registered: 0 };
      var n = 0;
      TAXONOMY.forEach(function (e) {
        b.define(e.type, { version: e.version || 1, description: e.description, schema: e.schema });
        n++;
      });
      return { ok: true, registered: n };
    }
  };

  // Auto-register into the bus when present (no-op under tests that don't load it).
  try { Taxonomy.register(); } catch (_) {}

  global.AAA_EVENT_TAXONOMY = Taxonomy;
})(typeof window !== 'undefined' ? window : this);
