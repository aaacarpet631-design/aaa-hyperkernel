/*
 * AAA Ads Governance — every Google Ads recommendation ships inside a sealed
 * Decision Envelope, and every MUTATION (budget, campaign, bidding, targeting,
 * conversion goals) waits for a human owner. No envelope → no recommendation.
 *
 * This is the Slice-1 foundation the agent team (Growth Commander, Search
 * Intent, Budget & Bidding, …) will write into. It does three things:
 *
 *   recommend(input)  — wrap the recommendation in AAA_DECISION_ENVELOPE
 *                       (gate + escalation + audit ledger), FORCE approval for
 *                       mutation types even if the envelope would have
 *                       auto-approved, seal it, and store a lean
 *                       ads_recommendations record linking to the envelope.
 *   approve/reject    — delegate to the envelope's human-only transitions.
 *   clearForApply(id) — flips the record to 'cleared' ONLY when its envelope
 *                       is human-approved. Returns the change order for a
 *                       (future) adapter to execute. NOTHING here calls the
 *                       Google Ads API — no fake campaign changes, ever.
 *
 * Analysis-tier outputs (ANALYSIS, NEGATIVE_KEYWORD_PATCH, TRACKING_ALERT…)
 * still get an envelope + audit record; they may auto-approve when the gate
 * and escalation policy allow, matching the plan's "guarded apply" tier.
 */
;(function (global) {
  'use strict';

  const COLLECTION = 'ads_recommendations';

  // Recommendation taxonomy. mutation:true = touches spend/structure/goals →
  // owner approval is ALWAYS required, regardless of gate/stakes verdicts.
  const TYPES = {
    ANALYSIS:               { mutation: false },
    TRACKING_ALERT:         { mutation: false },
    NEGATIVE_KEYWORD_PATCH: { mutation: false },
    BROKEN_URL_PAUSE:       { mutation: false },
    KEYWORD_RECOMMENDATION: { mutation: false },
    COPY_CHANGE:            { mutation: false },
    BUDGET_CHANGE:          { mutation: true },
    CAMPAIGN_LAUNCH:        { mutation: true },
    CAMPAIGN_PAUSE:         { mutation: true },
    BID_STRATEGY_CHANGE:    { mutation: true },
    NEW_SERVICE_AREA:       { mutation: true },
    CONVERSION_GOAL_CHANGE: { mutation: true }
  };

  function cfg() { return global.AAA_CONFIG || {}; }
  function data() { return global.AAA_DATA; }
  function ids() { return global.AAA_ID_FACTORY; }
  function clock() { return global.AAA_RUNTIME_CLOCK; }
  function envelopes() { return global.AAA_DECISION_ENVELOPE; }
  function gateway() { return global.AAA_RUNTIME_GATEWAY; }
  function outcomes() { return global.AAA_AGENT_OUTCOMES; }
  function ws() { return cfg().workspaceId || 'default'; }
  function nowISO() { return clock() && clock().nowISO ? clock().nowISO() : new Date().toISOString(); }
  function mine(r) { return r && (r.workspaceId == null || r.workspaceId === ws()); }
  function newId(p) { return ids() && ids().createId ? ids().createId(p) : p + '_' + Math.random().toString(36).slice(2, 10); }
  function str(v, max) { return v == null ? null : String(v).slice(0, max || 300); }

  const Desk = {
    COLLECTION: COLLECTION,
    TYPES: Object.keys(TYPES),
    isMutation(type) { return !!(TYPES[type] && TYPES[type].mutation); },

    /**
     * Record a governed ads recommendation.
     * input: { agent, type, recommendation, rationale, confidence(0-100),
     *          impactUSD?, evidence?[], campaign?, payload? }
     * payload is the machine-readable change (e.g. {campaign, newDailyBudget}),
     * stored for the future apply adapter — never executed here.
     */
    async recommend(input) {
      const i = input || {};
      if (!TYPES[i.type]) return { ok: false, error: 'UNKNOWN_TYPE', type: String(i.type) };
      const env = envelopes();
      if (!env || !env.wrap) return { ok: false, error: 'NO_GOVERNANCE', reason: 'decision envelope module required — an ungoverned ads recommendation is not recorded' };
      if (!data()) return { ok: false, error: 'NO_STORE' };

      const isMutation = TYPES[i.type].mutation;
      const wrapped = env.wrap({
        agent: i.agent || 'agent:ads-desk',
        decision: {
          recommendation: i.recommendation,
          rationale: i.rationale,
          confidence: i.confidence,
          risks: Array.isArray(i.risks) ? i.risks : [],
          // A mutation always proposes a real-world action → the safety gate /
          // conservative default sees it; analysis proposes none.
          next_actions: isMutation ? ['apply Google Ads ' + i.type + (i.campaign ? ' on campaign "' + i.campaign + '"' : '')] : []
        },
        impact: i.impactUSD != null ? { amount: i.impactUSD, description: 'estimated monthly ad-spend impact' } : null,
        evidence: Array.isArray(i.evidence) ? i.evidence : [],
        rollback: { plan: isMutation ? 'revert the change in Google Ads to the prior recorded value' : 'n/a (advisory only)', reversible: true },
        context: i.context || {}
      });
      if (!wrapped.ok) return { ok: false, error: 'INVALID_INPUT', issues: wrapped.issues };

      const envelope = wrapped.envelope;
      // Belt-and-braces: ad mutations NEVER auto-approve, whatever the gate said.
      if (isMutation && envelope.approval.status === 'auto_approved') {
        envelope.approval.required = true;
        envelope.approval.status = 'awaiting_approval';
        envelope.approval.reasons = (envelope.approval.reasons || []).concat(['ads mutation (' + i.type + ') always requires owner approval']);
      }
      const sealed = await env.seal(envelope);
      if (!sealed.ok) return { ok: false, error: 'SEAL_FAILED', issues: sealed.issues };

      const rec = {
        id: newId('adsrec'),
        workspaceId: ws(),
        type: i.type,
        mutation: isMutation,
        agent: str(i.agent, 80) || 'agent:ads-desk',
        campaign: str(i.campaign, 160),
        summary: str(i.recommendation, 300),
        payload: i.payload || null,
        envelopeId: sealed.envelope.id,
        status: sealed.envelope.approval.status === 'auto_approved' ? 'auto_approved' : 'awaiting_approval',
        outcomeDecisionId: null,
        createdAt: nowISO(), decidedAt: null, clearedAt: null
      };
      // Measurability: register the decision in the Agent Outcome Registry so
      // scorecards can grade this agent later. Advisory only — a missing or
      // failing registry never blocks governance; the record then honestly
      // carries outcomeDecisionId: null.
      const reg = outcomes();
      if (reg && reg.recordDecision) {
        try {
          const d = await reg.recordDecision({
            agentId: rec.agent, agentType: 'ads',
            confidence: i.confidence,
            recommendation: str(i.recommendation, 300),
            subjectType: 'ads_recommendation', subjectId: rec.id,
            sourceModule: 'ads-governance'
          });
          if (d && d.ok && d.decision) rec.outcomeDecisionId = d.decision.decisionId;
        } catch (_) { /* advisory — never blocks */ }
      }
      await data().put(COLLECTION, rec.id, rec);
      return { ok: true, recommendation: rec, envelope: sealed.envelope };
    },

    /**
     * Human approves. Double-gated: the RUNTIME GATEWAY (REVIEW_ADS_
     * RECOMMENDATION, aiAllowed:false — an origin:'ai' call is hard-blocked
     * and audited) wraps the ENVELOPE's human-only transition (non-human
     * approver identities and gate-denied envelopes are refused there).
     */
    async approve(recId, opts) {
      const o = opts || {};
      const rec = await this._get(recId);
      if (!rec) return { ok: false, error: 'NOT_FOUND' };
      const gw = gateway();
      if (!gw) return { ok: false, error: 'NO_GATEWAY' };
      const run = await gw.run({
        action: 'REVIEW_ADS_RECOMMENDATION', origin: o.origin === 'ai' ? 'ai' : 'human', actor: o.approver || null,
        target: { type: 'ads_recommendation', id: rec.id }, detail: { type: rec.type, verdict: 'approve' },
        mutate: async () => {
          const r = await envelopes().approve(rec.envelopeId, o);
          if (!r.ok) return r;
          rec.status = 'approved'; rec.decidedAt = nowISO();
          await data().put(COLLECTION, rec.id, rec);
          return { ok: true, recommendation: rec, envelope: r.envelope };
        }
      });
      if (!run.ok) return run;
      return run.result;
    },

    /** Human rejects — always allowed. */
    async reject(recId, opts) {
      const rec = await this._get(recId);
      if (!rec) return { ok: false, error: 'NOT_FOUND' };
      const r = await envelopes().reject(rec.envelopeId, opts);
      if (!r.ok) return r;
      rec.status = 'rejected'; rec.decidedAt = nowISO();
      await data().put(COLLECTION, rec.id, rec);
      // A human rejection overrides the agent's call — feed that back to the
      // outcome registry as training signal (advisory; never blocks the reject).
      if (rec.outcomeDecisionId) {
        const reg = outcomes();
        if (reg && reg.markOverridden) {
          try {
            const o = opts || {};
            await reg.markOverridden(rec.outcomeDecisionId, { reason: o.reason || null, actorId: o.approver || null });
          } catch (_) { /* advisory — never blocks */ }
        }
      }
      return { ok: true, recommendation: rec };
    },

    /**
     * Clear an APPROVED recommendation for application. Runs through the
     * gateway (APPLY_ADS_CHANGE, aiAllowed:false) and returns the change
     * order (type + payload + envelope id) for a future adapter; applies
     * nothing itself. Unapproved / rejected / gate-denied → refused.
     */
    async clearForApply(recId, opts) {
      const o = opts || {};
      const rec = await this._get(recId);
      if (!rec) return { ok: false, error: 'NOT_FOUND' };
      const env = await envelopes().get(rec.envelopeId);
      const status = env && env.approval ? env.approval.status : null;
      const cleared = status === 'approved' || (!rec.mutation && status === 'auto_approved');
      if (!cleared) return { ok: false, error: 'NOT_APPROVED', status: status, reason: 'ad changes apply only after human approval' };
      const gw = gateway();
      if (!gw) return { ok: false, error: 'NO_GATEWAY' };
      const run = await gw.run({
        action: 'APPLY_ADS_CHANGE', origin: o.origin === 'ai' ? 'ai' : 'human', actor: o.actor || null,
        target: { type: 'ads_recommendation', id: rec.id }, detail: { type: rec.type, campaign: rec.campaign },
        mutate: async () => {
          rec.status = 'cleared'; rec.clearedAt = nowISO();
          await data().put(COLLECTION, rec.id, rec);
          return { ok: true, changeOrder: { recommendationId: rec.id, envelopeId: rec.envelopeId, type: rec.type, campaign: rec.campaign, payload: rec.payload } };
        }
      });
      if (!run.ok) return run;
      return run.result;
    },

    async _get(id) { const r = await data().get(COLLECTION, id); return mine(r) ? r : null; },

    /** Newest first; filter { status?, type?, mutation? }. */
    async list(filter) {
      if (!data()) return [];
      const f = filter || {};
      return ((await data().list(COLLECTION)) || []).filter(mine).filter(function (r) {
        if (f.status && r.status !== f.status) return false;
        if (f.type && r.type !== f.type) return false;
        if (f.mutation != null && r.mutation !== f.mutation) return false;
        return true;
      }).sort(function (a, b) { return String(b.createdAt || '').localeCompare(String(a.createdAt || '')); });
    }
  };

  global.AAA_ADS_GOVERNANCE = Desk;
})(typeof window !== 'undefined' ? window : this);
