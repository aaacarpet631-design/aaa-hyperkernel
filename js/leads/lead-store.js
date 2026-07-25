/*
 * AAA Leads — lead pipeline management (Lead OS design, ported native).
 *
 * Ports the Lead OS MVP design (9-stage pipeline, follow-up touch templates,
 * won/lost outcomes) onto HyperKernel's local-first store. The FastAPI/SQLite
 * implementation was discarded; only the design is ported:
 *   - 9 stages + the valid-transition table from the MVP API design.
 *   - The '7_touch_standard' follow-up sequence, deduplicated: the original
 *     seed inserted 7 rows under one UNIQUE name; here it is ONE template set
 *     with 7 touches.
 *
 * Honest by construction: stage history is append-only, transitions are
 * validated against the ported table and rejected with specific error codes,
 * and follow-up templates are STATIC DRAFTS the owner reads and sends manually
 * — this module performs no sending of any kind, no SMS, no email, no network.
 * No PII is logged or put on the event bus (ids only).
 */
;(function (global) {
  'use strict';

  function data() { return global.AAA_DATA; }
  function ids() { return global.AAA_ID_FACTORY; }
  function clock() { return global.AAA_RUNTIME_CLOCK; }
  function events() { return global.AAA_EVENTS; }
  function now() { return clock() && clock().now ? clock().now() : Date.now(); }

  const COLLECTION = 'leads';

  // The 9 MVP pipeline stages (Lead OS mvp_database_schema.sql, kanban order).
  const STAGES = ['NEW_LEAD', 'CONTACTED', 'ESTIMATE_SENT', 'FOLLOWUP_ACTIVE',
    'JOB_SCHEDULED', 'JOB_COMPLETED', 'REVIEW_REQUESTED', 'WON', 'LOST'];

  // Valid next stages, ported from the Lead OS MVP API design (api_mvp.py).
  // (event_model.md carries a wider Phase-2 table with extra stages; the MVP
  // table is the one consistent with the 9-stage schema and is what we port.)
  const TRANSITIONS = {
    NEW_LEAD: ['CONTACTED', 'LOST'],
    CONTACTED: ['ESTIMATE_SENT', 'LOST', 'NEW_LEAD'],
    ESTIMATE_SENT: ['FOLLOWUP_ACTIVE', 'WON', 'LOST'],
    FOLLOWUP_ACTIVE: ['WON', 'LOST', 'ESTIMATE_SENT'],
    WON: ['JOB_SCHEDULED', 'LOST'],
    JOB_SCHEDULED: ['JOB_COMPLETED', 'WON'],
    JOB_COMPLETED: ['REVIEW_REQUESTED', 'WON'],
    REVIEW_REQUESTED: ['WON'],
    LOST: ['NEW_LEAD']
  };

  const SOURCES = ['website', 'referral', 'lsa', 'walk_in', 'google_ads', 'other'];
  // Sources that come from paid channels — a lead from these with no
  // attribution record is a measurement gap the reporting layer surfaces.
  const PAID_SOURCES = ['google_ads', 'lsa'];

  // '7_touch_standard' follow-up sequence, ported from the Lead OS seed data
  // and DEDUPLICATED (one set, 7 touches). Static drafts only — the owner
  // copies and sends manually. {{placeholders}} are kept verbatim.
  const FOLLOWUP_TEMPLATES = [{
    name: '7_touch_standard',
    serviceType: null,
    touches: [
      { touch: 1, dayOffset: 0, channel: 'sms', objective: 'Confirm receipt, offer help',
        sms: 'Hi {{customer_name}}, just sent your {{service_type}} estimate ({{estimate_total}}). Questions? Reply or call {{business_phone}}.',
        callScript: 'Confirm they received estimate. Ask: "Any questions on the estimate?" Note objections.' },
      { touch: 2, dayOffset: 1, channel: 'call_task', objective: 'Decision timeline',
        callScript: 'Call script: "Hi {{customer_name}}, following up on the estimate sent yesterday. What\'s your timeline for deciding? Any concerns I can address?"' },
      { touch: 3, dayOffset: 3, channel: 'email', objective: 'Value add - social proof',
        emailSubject: '{{customer_name}} - Carpet ideas & past projects',
        emailBody: '<p>Hi {{customer_name}},</p><p>Thought you\'d like to see some recent {{service_type}} projects similar to yours:</p><p>{{project_gallery}}</p><p>Let me know if you have questions!</p>' },
      { touch: 4, dayOffset: 7, channel: 'call_task', objective: 'Decision push',
        callScript: 'Call: "{{customer_name}}, any decision on the estimate? We\'re booking {{timeline}} and want to reserve your spot. Can offer {{incentive}} if you decide this week."' },
      { touch: 5, dayOffset: 14, channel: 'sms', objective: 'Limited offer',
        sms: 'Hi {{customer_name}}, still thinking about your {{service_type}}? We can do {{incentive}} if you book this week. Let me know!' },
      { touch: 6, dayOffset: 21, channel: 'email', objective: 'Final follow-up',
        emailSubject: 'Last chance: {{customer_name}} - {{incentive}} expires Friday',
        emailBody: '<p>Hi {{customer_name}},</p><p>This is my last follow-up on your {{service_type}} estimate. The {{incentive}} expires Friday.</p><p>If now isn\'t the right time, no worries - I\'ll check back in a few months.</p>' },
      { touch: 7, dayOffset: 30, channel: 'call_task', objective: 'Long-term nurture enroll',
        callScript: 'Call: "{{customer_name}}, haven\'t heard back so I\'ll move you to our quarterly check-in list. We\'ll reach out seasonally with promotions. Any final questions?"' }
    ]
  }];

  // ---- sanitization ---------------------------------------------------------
  function clean(v, max) {
    if (v == null) return '';
    return String(v).trim().slice(0, max);
  }
  function normPhone(p) { return String(p == null ? '' : p).replace(/\D/g, ''); }
  function normName(n) { return String(n == null ? '' : n).trim().toLowerCase(); }

  function emit(type, payload) {
    try { if (events()) events().emit(type, payload); } catch (_) {}
  }

  const Leads = {
    STAGES: STAGES,
    TRANSITIONS: TRANSITIONS,
    SOURCES: SOURCES,
    PAID_SOURCES: PAID_SOURCES,

    /** Idempotent startup hook. Templates are static; nothing to seed. */
    async boot() {
      if (!data()) return { ok: false, error: 'NO_DATA' };
      return { ok: true };
    },

    /**
     * Create a lead. Required: name, phone, source, serviceType. A duplicate
     * (same normalized phone + name) is a no-op returning the existing lead.
     *
     * Optional input.attribution (gclid/gbraid/wbraid, utm*, campaign, adGroup,
     * keyword, searchTerm, landingPage, channel, city, zip, consent) is handed
     * to the Ad Attribution ledger — a SEPARATE, PII-free collection keyed by
     * leadId — never merged into the lead record itself, so PII and click data
     * stay apart. The lead only carries attributionCaptured: true|false.
     */
    async createLead(input) {
      if (!data()) return { ok: false, error: 'NO_DATA' };
      input = input || {};
      const name = clean(input.name, 120);
      const phone = clean(input.phone, 32);
      const source = clean(input.source, 24);
      const serviceType = clean(input.serviceType, 60);
      if (!name || !phone || !source || !serviceType) {
        return { ok: false, error: 'MISSING_FIELDS', missing: [
          !name && 'name', !phone && 'phone', !source && 'source', !serviceType && 'serviceType'
        ].filter(Boolean) };
      }
      if (SOURCES.indexOf(source) === -1) return { ok: false, error: 'INVALID_SOURCE', source: source };

      // Duplicate check: same normalized phone + name → return the existing lead.
      const existing = (await data().list(COLLECTION)).find(function (l) {
        return l && normPhone(l.phone) === normPhone(phone) && normName(l.name) === normName(name);
      });
      if (existing) return { ok: true, lead: existing, reused: true };

      const t = now();
      const lead = {
        leadId: (ids() && ids().createId) ? ids().createId('lead') : ('lead_' + t),
        customerId: input.customerId ? clean(input.customerId, 64) : null,
        name: name, phone: phone, source: source, serviceType: serviceType,
        stage: 'NEW_LEAD',
        notes: clean(input.notes, 2000),
        attributionCaptured: false,
        createdAt: t, updatedAt: t,
        stageHistory: [{ stage: 'NEW_LEAD', at: t }]
      };

      // Attribution rides in a separate PII-free ledger keyed by leadId.
      const attrLedger = global.AAA_AD_ATTRIBUTION;
      if (input.attribution && attrLedger && attrLedger.attach) {
        try {
          const att = await attrLedger.attach(lead.leadId, input.attribution);
          lead.attributionCaptured = !!(att && att.ok);
        } catch (_) { lead.attributionCaptured = false; }
      }

      await data().put(COLLECTION, lead.leadId, lead);
      emit('LEAD_CREATED', { leadId: lead.leadId, source: source, serviceType: serviceType });
      return { ok: true, lead: lead };
    },

    /**
     * Measurement-gap report: paid-channel leads with NO attribution record.
     * "Missing attribution is visible" (Slice 1 done-when). Ids only, no PII.
     */
    async missingAttribution() {
      if (!data()) return [];
      const attrLedger = global.AAA_AD_ATTRIBUTION;
      const leads = (await data().list(COLLECTION)).filter(function (l) {
        return l && PAID_SOURCES.indexOf(l.source) !== -1;
      });
      const out = [];
      for (const l of leads) {
        const att = attrLedger && attrLedger.get ? await attrLedger.get(l.leadId) : null;
        if (!att) out.push({ leadId: l.leadId, source: l.source, createdAt: l.createdAt });
      }
      return out;
    },

    async getLead(id) {
      if (!data()) return null;
      return data().get(COLLECTION, id);
    },

    /** List leads, optionally filtered by { stage?, source?, serviceType? }. */
    async listLeads(filter) {
      if (!data()) return [];
      const f = filter || {};
      return (await data().list(COLLECTION)).filter(function (l) {
        if (!l) return false;
        if (f.stage && l.stage !== f.stage) return false;
        if (f.source && l.source !== f.source) return false;
        if (f.serviceType && l.serviceType !== f.serviceType) return false;
        return true;
      });
    },

    /**
     * Move a lead to the next stage. Validated against the ported transition
     * table; stage history is APPEND-ONLY. Specific error codes:
     * LEAD_NOT_FOUND, UNKNOWN_STAGE, INVALID_TRANSITION.
     */
    async updateStage(id, nextStage, note) {
      const lead = await this.getLead(id);
      if (!lead) return { ok: false, error: 'LEAD_NOT_FOUND', leadId: id };
      const to = clean(nextStage, 24);
      if (STAGES.indexOf(to) === -1) return { ok: false, error: 'UNKNOWN_STAGE', stage: to };
      const from = lead.stage;
      if ((TRANSITIONS[from] || []).indexOf(to) === -1) {
        return { ok: false, error: 'INVALID_TRANSITION', from: from, to: to };
      }
      const t = now();
      const entry = { stage: to, at: t };
      const n = clean(note, 500);
      if (n) entry.note = n;
      const upd = Object.assign({}, lead, {
        stage: to, updatedAt: t,
        stageHistory: (Array.isArray(lead.stageHistory) ? lead.stageHistory : []).concat([entry])
      });
      await data().put(COLLECTION, id, upd);
      emit('LEAD_STAGE_CHANGED', { leadId: id, from: from, to: to });
      return { ok: true, lead: upd };
    },

    /**
     * Record a WON or LOST outcome (revenue / lostReason captured on the lead).
     * Goes through updateStage, so only valid transitions are accepted.
     */
    async recordOutcome(id, outcome) {
      outcome = outcome || {};
      const result = clean(outcome.result, 8);
      if (result !== 'WON' && result !== 'LOST') return { ok: false, error: 'INVALID_RESULT', result: result };
      const moved = await this.updateStage(id, result, outcome.lostReason ? clean(outcome.lostReason, 500) : undefined);
      if (!moved.ok) return moved;
      const t = now();
      const fields = { result: result, at: t };
      if (result === 'WON' && outcome.revenue != null && !isNaN(+outcome.revenue)) fields.revenue = +outcome.revenue;
      if (result === 'LOST' && outcome.lostReason) fields.lostReason = clean(outcome.lostReason, 500);
      const upd = Object.assign({}, moved.lead, { outcome: fields, updatedAt: t });
      await data().put(COLLECTION, id, upd);
      emit('LEAD_OUTCOME', { leadId: id, result: result, revenue: fields.revenue != null ? fields.revenue : null });
      return { ok: true, lead: upd };
    },

    /** Static follow-up template sets (deep copies — drafts only, never sent). */
    listFollowupTemplates() {
      return JSON.parse(JSON.stringify(FOLLOWUP_TEMPLATES));
    },

    /** Honest health check over the real store. */
    async healthCheck() {
      if (!data()) return { ok: false, error: 'NO_DATA' };
      const leads = await data().list(COLLECTION);
      return { ok: true, leads: leads.length, stages: STAGES.length, templates: FOLLOWUP_TEMPLATES.length };
    }
  };

  global.AAA_LEADS = Leads;
})(typeof window !== 'undefined' ? window : this);
