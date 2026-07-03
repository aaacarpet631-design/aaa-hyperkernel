/*
 * AAA Decision Envelope — the ONE contract every agent decision ships in.
 *
 * The platform already has the parts: the Action Safety Gate judges blast
 * radius, the Escalation Policy judges stakes, the Audit Ledger chains the
 * record. What was missing is the unifying envelope: a single schema-locked
 * wrapper so a pricing call in Houston and a VAT-bearing quote in Berlin both
 * arrive with the same fields — confidence, evidence, localized impact, gate
 * verdict, approval requirement, rollback plan — and the same audit trail.
 *
 *   wrap(input)      → compose gate + escalation + country pack into an envelope
 *   validate(env)    → strict schema check (names every gap)
 *   seal(env)        → persist + chain into the audit ledger (invalid → refused)
 *   approve/reject   → governed human transitions (gate-denied can NEVER be approved)
 *   get/list         → workspace-scoped reads
 *
 * Conservative by design: when the safety gate is unavailable, actions require
 * approval (absence of a guard is not permission). Honest by construction:
 * missing composers are recorded as {available:false}, never silently skipped.
 */
;(function (global) {
  'use strict';

  const COLLECTION = 'decision_envelopes';
  const SCHEMA_VERSION = '1.0';

  function cfg() { return global.AAA_CONFIG || {}; }
  function flag(k, d) { return cfg().flag ? cfg().flag(k, d) : d; }
  function data() { return global.AAA_DATA; }
  function ids() { return global.AAA_ID_FACTORY; }
  function clock() { return global.AAA_RUNTIME_CLOCK; }
  function gate() { return global.AAA_ACTION_GATE; }
  function escalation() { return global.AAA_ESCALATION; }
  function packs() { return global.AAA_COUNTRY_PACKS; }
  function ledger() { return global.AAA_AUDIT_LEDGER; }
  function bus() { return global.AAA_EVENT_BUS; }
  function ws() { return cfg().workspaceId || 'default'; }
  function nowISO() { return clock() && clock().nowISO ? clock().nowISO() : new Date().toISOString(); }
  function newId(p) { return ids() && ids().createId ? ids().createId(p) : p + '_' + Math.random().toString(36).slice(2, 10); }

  function clampConf(c) { return isFinite(+c) ? Math.max(0, Math.min(100, Math.round(+c))) : null; }

  // The bus rejects unknown event types (no drift) — declare ours before use.
  function publishEvent(type, payload) {
    const b = bus();
    if (!b || !b.publish) return;
    if (b.define && !b.contract(type)) {
      b.define('envelope.sealed', { version: 1, description: 'A decision envelope was sealed into the audit trail.', schema: { type: 'object', required: ['envelopeId'], properties: { envelopeId: { type: 'string' }, agent: { type: 'string' }, status: { type: 'string' } } } });
      b.define('envelope.approved', { version: 1, description: 'A human approved a decision envelope.', schema: { type: 'object', required: ['envelopeId'], properties: { envelopeId: { type: 'string' }, approver: { type: 'string' } } } });
      b.define('envelope.rejected', { version: 1, description: 'A human rejected a decision envelope.', schema: { type: 'object', required: ['envelopeId'], properties: { envelopeId: { type: 'string' } } } });
    }
    return b.publish(type, payload);
  }

  // ---- composition ---------------------------------------------------------
  function judgeActions(nextActions) {
    const g = gate();
    if (!g || !g.assess) {
      // No guard installed: any proposed action conservatively needs a human.
      return { available: false, decision: (nextActions && nextActions.length) ? 'needs_approval' : 'allow', reasons: ['safety gate unavailable — conservative default'] };
    }
    let worst = 'allow';
    const details = [];
    (nextActions || []).forEach(function (a) {
      const r = g.assess(a);
      details.push({ action: typeof a === 'string' ? a : (a && (a.text || a.tool)) || 'action', decision: r.decision, categories: r.categories || [] });
      if (r.decision === 'deny') worst = 'deny';
      else if (r.decision === 'needs_approval' && worst !== 'deny') worst = 'needs_approval';
    });
    return { available: true, decision: worst, actions: details };
  }

  function judgeStakes(context, decision, impact) {
    const e = escalation();
    if (!e || !e.assess) return { available: false, highStakes: false };
    // The policy reads money from context.estimates; surface the envelope's
    // impact there (without clobbering real estimates the caller provided).
    const ctx = Object.assign({}, context || {});
    if (!Array.isArray(ctx.estimates) && impact && isFinite(+impact.amount)) {
      ctx.estimates = [{ estimatedQuoteRange: '$' + (+impact.amount) }];
    }
    const r = e.assess(ctx, { recommendation: decision.recommendation, rationale: decision.rationale, confidence: decision.confidence }) || {};
    const reasons = (r.reasons || []).map(function (x) { return x && x.detail ? x.detail : String(x); });
    return { available: true, highStakes: !!r.highStakes, reasons: reasons, stakesScore: r.stakesScore };
  }

  function localizeImpact(impact, countryCode) {
    const base = { amount: null, currency: null, formatted: null, description: (impact && impact.description) || null };
    if (!impact || !isFinite(+impact.amount)) return base;
    base.amount = +impact.amount;
    const cp = packs();
    if (cp) {
      const m = cp.formatMoney(base.amount, impact.currencyCountry || countryCode);
      if (m && m.ok) { base.currency = m.currency; base.formatted = m.text; return base; }
    }
    base.currency = impact.currency || 'USD';
    return base;
  }

  const Envelope = {
    COLLECTION: COLLECTION,
    SCHEMA_VERSION: SCHEMA_VERSION,

    /**
     * Compose an envelope from an agent decision. Pure of side effects except
     * id/time — nothing is persisted until seal().
     *
     * input: { agent, decision:{recommendation, rationale, confidence, risks[], next_actions[]},
     *          impact:{amount, description}, evidence:[{type,id,note}],
     *          rollback:{plan, reversible}, context:{}, country }
     */
    wrap: function (input) {
      const i = input || {};
      const d = i.decision || {};
      const issues = [];
      if (!i.agent) issues.push('agent required');
      if (!d.recommendation) issues.push('decision.recommendation required');
      if (!d.rationale) issues.push('decision.rationale required');
      if (clampConf(d.confidence) == null) issues.push('decision.confidence (0-100) required');
      if (issues.length) return { ok: false, error: 'INVALID_INPUT', issues: issues };

      const cp = packs();
      const country = i.country || (cp ? cp.activeCode() : 'US');
      const decision = {
        recommendation: String(d.recommendation),
        rationale: String(d.rationale),
        confidence: clampConf(d.confidence),
        risks: Array.isArray(d.risks) ? d.risks.slice() : [],
        next_actions: Array.isArray(d.next_actions) ? d.next_actions.slice() : []
      };

      const gateVerdict = judgeActions(decision.next_actions);
      const impact = localizeImpact(i.impact, country);
      const stakes = judgeStakes(i.context, decision, impact);

      const minConf = +flag('envelopeMinConfidence', 55);
      const approvalReasons = [];
      if (gateVerdict.decision === 'deny') approvalReasons.push('safety gate DENIED a proposed action');
      else if (gateVerdict.decision === 'needs_approval') approvalReasons.push(gateVerdict.available ? 'safety gate flagged a proposed action' : 'safety gate unavailable with proposed actions (conservative)');
      if (stakes.highStakes) approvalReasons.push('escalation policy: high-stakes (' + (stakes.reasons || []).join('; ') + ')');
      if (decision.confidence < minConf) approvalReasons.push('confidence ' + decision.confidence + ' below floor ' + minConf);

      const env = {
        id: newId('env'), schemaVersion: SCHEMA_VERSION, workspaceId: ws(),
        agent: String(i.agent), country: country,
        decision: decision,
        impact: impact,
        evidence: Array.isArray(i.evidence) ? i.evidence.filter(Boolean) : [],
        gate: gateVerdict,
        escalation: stakes,
        approval: {
          required: approvalReasons.length > 0,
          reasons: approvalReasons,
          status: gateVerdict.decision === 'deny' ? 'blocked' : (approvalReasons.length ? 'awaiting_approval' : 'auto_approved'),
          approver: null, decidedAt: null
        },
        rollback: {
          plan: (i.rollback && i.rollback.plan) || null,
          reversible: i.rollback ? i.rollback.reversible !== false : null
        },
        audit: null,
        createdAt: nowISO()
      };
      return { ok: true, envelope: env };
    },

    /** Strict schema check — names every gap, throws never. */
    validate: function (env) {
      const issues = [];
      const e = env || {};
      if (!e.id) issues.push('id');
      if (e.schemaVersion !== SCHEMA_VERSION) issues.push('schemaVersion');
      if (!e.agent) issues.push('agent');
      if (!e.country) issues.push('country');
      const d = e.decision || {};
      if (!d.recommendation) issues.push('decision.recommendation');
      if (!d.rationale) issues.push('decision.rationale');
      if (clampConf(d.confidence) == null) issues.push('decision.confidence');
      if (!Array.isArray(d.risks)) issues.push('decision.risks');
      if (!Array.isArray(d.next_actions)) issues.push('decision.next_actions');
      if (!e.gate || !e.gate.decision) issues.push('gate');
      if (!e.approval || typeof e.approval.required !== 'boolean' || !e.approval.status) issues.push('approval');
      if (!e.rollback || !('plan' in e.rollback)) issues.push('rollback');
      if (!Array.isArray(e.evidence)) issues.push('evidence');
      if (!e.createdAt) issues.push('createdAt');
      return issues.length ? { ok: false, issues: issues } : { ok: true };
    },

    /** Persist + chain into the audit ledger. Invalid envelopes are refused. */
    seal: async function (env) {
      const v = this.validate(env);
      if (!v.ok) return { ok: false, error: 'INVALID_ENVELOPE', issues: v.issues };
      if (!data()) return { ok: false, error: 'NO_DATA_LAYER' };
      const led = ledger();
      if (led && led.append) {
        // PII-minimal audit record: ids, verdicts, and money — never payloads.
        const entry = await led.append('decision.envelope', {
          envelopeId: env.id, agent: env.agent, country: env.country,
          confidence: env.decision.confidence, impactAmount: env.impact.amount,
          impactCurrency: env.impact.currency, gate: env.gate.decision,
          approvalStatus: env.approval.status
        });
        env.audit = { id: (entry && (entry.id || entry.entryId)) || null, at: nowISO() };
      } else {
        env.audit = { id: null, at: nowISO(), note: 'audit ledger unavailable' };
      }
      await data().put(COLLECTION, env.id, env);
      try { await publishEvent('envelope.sealed', { envelopeId: env.id, agent: env.agent, status: env.approval.status }); } catch (_) {}
      return { ok: true, envelope: env };
    },

    /** Human approves. A gate-DENIED envelope can never be approved. */
    approve: async function (envelopeId, opts) {
      const o = opts || {};
      const env = await data().get(COLLECTION, envelopeId);
      if (!env) return { ok: false, error: 'NOT_FOUND' };
      if (env.gate && env.gate.decision === 'deny') return { ok: false, error: 'GATE_DENIED', reason: 'a denied action cannot be human-approved; change the plan' };
      if (env.approval.status === 'approved') return { ok: false, error: 'ALREADY_APPROVED' };
      env.approval.status = 'approved';
      env.approval.approver = o.approver || 'owner';
      env.approval.decidedAt = nowISO();
      await data().put(COLLECTION, env.id, env);
      try { if (ledger() && ledger().append) await ledger().append('decision.envelope.approved', { envelopeId: env.id, approver: env.approval.approver }); } catch (_) {}
      try { await publishEvent('envelope.approved', { envelopeId: env.id, approver: env.approval.approver }); } catch (_) {}
      return { ok: true, envelope: env };
    },

    /** Human rejects — always allowed. */
    reject: async function (envelopeId, opts) {
      const o = opts || {};
      const env = await data().get(COLLECTION, envelopeId);
      if (!env) return { ok: false, error: 'NOT_FOUND' };
      env.approval.status = 'rejected';
      env.approval.approver = o.approver || 'owner';
      env.approval.reason = o.reason || null;
      env.approval.decidedAt = nowISO();
      await data().put(COLLECTION, env.id, env);
      try { if (ledger() && ledger().append) await ledger().append('decision.envelope.rejected', { envelopeId: env.id, approver: env.approval.approver, reason: env.approval.reason }); } catch (_) {}
      try { await publishEvent('envelope.rejected', { envelopeId: env.id }); } catch (_) {}
      return { ok: true, envelope: env };
    },

    get: async function (envelopeId) { return data() ? data().get(COLLECTION, envelopeId) : null; },

    /** Workspace-scoped list, newest first; filter { status, agent, country }. */
    list: async function (filter) {
      if (!data()) return [];
      const f = filter || {};
      let all = (await data().list(COLLECTION)).filter(function (e) { return e && (e.workspaceId == null || e.workspaceId === ws()); });
      if (f.status) all = all.filter(function (e) { return e.approval && e.approval.status === f.status; });
      if (f.agent) all = all.filter(function (e) { return e.agent === f.agent; });
      if (f.country) all = all.filter(function (e) { return e.country === f.country; });
      return all.sort(function (a, b) { return String(b.createdAt || '').localeCompare(String(a.createdAt || '')); });
    }
  };

  global.AAA_DECISION_ENVELOPE = Envelope;
})(typeof window !== 'undefined' ? window : this);
