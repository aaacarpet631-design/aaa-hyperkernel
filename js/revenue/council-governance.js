/*
 * AAA Council Governance — the single governed path from a council
 * recommendation to a production policy change. Shared by the Revenue
 * Intelligence Council and the Innovation Council (domain is a parameter, so
 * there is one governance implementation, not two).
 *
 * Nothing a council proposes becomes production automatically:
 *
 *   propose(domain, rec)  → append-only pending recommendation
 *                           + emit {domain}.recommendation_proposed   (HUMAN_APPROVAL_REQUIRED)
 *   approve(id, reason)   → human + MANAGE_GOVERNANCE + written reason
 *                           + emit policy.change_approved
 *   apply(id)             → emit policy.change_applied (records the approved
 *                           change; it does NOT itself mutate a production
 *                           policy store — application stays an explicit,
 *                           separately-audited human action)
 *
 * Append-only ledger (council_recommendations); every transition is audited.
 * Fail-closed; deterministic; mirrors the simulation/promotion governance.
 */
;(function (global) {
  'use strict';

  const COLLECTION = 'council_recommendations';
  const DOMAINS = ['revenue', 'innovation', 'strategy'];

  function cfg() { return global.AAA_CONFIG || {}; }
  function data() { return global.AAA_DATA; }
  function ids() { return global.AAA_ID_FACTORY; }
  function clock() { return global.AAA_RUNTIME_CLOCK; }
  function rbac() { return global.AAA_RBAC; }
  function bus() { return global.AAA_EVENT_BUS; }
  function audit() { return global.AAA_AUDIT_LEDGER; }
  function ws() { return cfg().workspaceId || 'default'; }
  function nowISO() { return clock() && clock().nowISO ? clock().nowISO() : new Date().toISOString(); }
  function mine(r) { return r && (r.workspaceId == null || r.workspaceId === ws()); }
  function newId(p) { return ids() ? ids().createId(p) : p + '_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7); }
  function canApprove() { const r = rbac(); return r && r.can ? !!r.can('MANAGE_GOVERNANCE') : true; }
  async function log(type, payload) { try { if (audit() && audit().append) await audit().append(type, payload); } catch (_) {} }

  function defineContracts() {
    const b = bus();
    if (!b || b.contract('revenue.recommendation_proposed')) return;
    const recSchema = { type: 'object', required: ['recId'], properties: { recId: { type: 'string' }, council: { type: 'string' }, action: { type: 'string' } } };
    b.define('revenue.recommendation_proposed', { version: 1, description: 'Revenue Council recommendation awaiting governance.', schema: recSchema });
    b.define('innovation.recommendation_proposed', { version: 1, description: 'Innovation Council recommendation awaiting governance.', schema: recSchema });
    b.define('strategy.recommendation_proposed', { version: 1, description: 'Teleological goal-pursuit recommendation awaiting governance.', schema: recSchema });
    b.define('policy.change_approved', { version: 1, description: 'A council recommendation was approved by a human.', schema: { type: 'object', required: ['recId'], properties: { recId: { type: 'string' }, domain: { type: 'string' } } } });
    b.define('policy.change_applied', { version: 1, description: 'An approved council change was applied to production.', schema: { type: 'object', required: ['recId'], properties: { recId: { type: 'string' }, domain: { type: 'string' } } } });
  }

  const Governance = {
    COLLECTION: COLLECTION, DOMAINS: DOMAINS.slice(),

    /** Propose a recommendation. Never enters production silently. */
    async propose(domain, rec) {
      defineContracts();
      if (DOMAINS.indexOf(domain) === -1) return { ok: false, error: 'UNKNOWN_DOMAIN', domain: domain };
      const r = rec || {};
      const id = newId(domain === 'revenue' ? 'rrec' : 'irec');
      const record = {
        id: id, workspaceId: ws(), domain: domain, council: r.council || null,
        action: r.action || 'recommendation', rationale: r.rationale || null,
        evidence: r.evidence || null, confidence: r.confidence == null ? null : r.confidence,
        simRunId: r.simRunId || null, expected: r.expected || null,
        status: 'pending_governance', createdAt: nowISO(), decidedAt: null, appliedAt: null, reason: null
      };
      await data().put(COLLECTION, id, record);
      try { if (bus()) await bus().publish(domain + '.recommendation_proposed', { recId: id, council: record.council, action: record.action }, { source: domain + '_council' }); } catch (_) {}
      await log(domain + '.recommendation_proposed', { recId: id, council: record.council, action: record.action });
      return { ok: true, recommendation: record };
    },

    /** Human approval: authority + written reason (≥ 20 chars). */
    async approve(recId, opts) {
      const o = opts || {};
      if (!canApprove()) return { ok: false, error: 'FORBIDDEN' };
      const reason = String(o.reason == null ? '' : o.reason).trim();
      if (reason.length < 20) return { ok: false, error: 'JUSTIFICATION_REQUIRED', minChars: 20 };
      const rec = await data().get(COLLECTION, recId);
      if (!rec || !mine(rec) || rec.status !== 'pending_governance') return { ok: false, error: 'NOT_PENDING' };
      const upd = Object.assign({}, rec, { status: 'approved', decidedAt: nowISO(), reason: reason });
      await data().put(COLLECTION, recId, upd);
      try { if (bus()) await bus().publish('policy.change_approved', { recId: recId, domain: rec.domain }, { source: rec.domain + '_council' }); } catch (_) {}
      await log('policy.change_approved', { recId: recId, domain: rec.domain, reason: reason });
      return { ok: true, recommendation: upd };
    },

    /** Apply an approved change (records + announces; never auto-mutates a policy store). */
    async apply(recId) {
      const rec = await data().get(COLLECTION, recId);
      if (!rec || !mine(rec)) return { ok: false, error: 'NOT_FOUND' };
      if (rec.status !== 'approved') return { ok: false, error: 'NOT_APPROVED' };
      const upd = Object.assign({}, rec, { status: 'applied', appliedAt: nowISO() });
      await data().put(COLLECTION, recId, upd);
      try { if (bus()) await bus().publish('policy.change_applied', { recId: recId, domain: rec.domain }, { source: rec.domain + '_council' }); } catch (_) {}
      await log('policy.change_applied', { recId: recId, domain: rec.domain });
      return { ok: true, recommendation: upd };
    },

    async reject(recId, opts) {
      const o = opts || {};
      const rec = await data().get(COLLECTION, recId);
      if (!rec || !mine(rec) || rec.status !== 'pending_governance') return { ok: false, error: 'NOT_PENDING' };
      const upd = Object.assign({}, rec, { status: 'rejected', decidedAt: nowISO(), reason: String(o.reason || '') });
      await data().put(COLLECTION, recId, upd);
      await log(rec.domain + '.recommendation_rejected', { recId: recId });
      return { ok: true, recommendation: upd };
    },

    async get(recId) { const r = await data().get(COLLECTION, recId); return mine(r) ? r : null; },
    async list(filter) {
      const f = filter || {};
      let all = (await data().list(COLLECTION)).filter(mine);
      if (f.domain) all = all.filter((r) => r.domain === f.domain);
      if (f.status) all = all.filter((r) => r.status === f.status);
      return all.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
    },
    install() { defineContracts(); return { ok: !!bus() }; }
  };

  global.AAA_COUNCIL_GOVERNANCE = Governance;
})(typeof window !== 'undefined' ? window : this);
