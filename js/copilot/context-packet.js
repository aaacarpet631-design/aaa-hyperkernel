/*
 * AAA Copilot Context Packet — the deterministic, permission-scoped view of
 * the business that the intelligence layer is ALLOWED to see. Slice C of
 * docs/HYPERKERNEL_CHAT_MISSION.md.
 *
 * assemble(job, opts) reads the REAL stores behind each phase-one job and
 * returns a contract-valid contextPacket (validated against
 * AAA_COPILOT_CONTRACT before it leaves this module — an invalid packet is
 * refused, never shipped):
 *
 *   attention_today  overdue follow-up quotes, stale NEW leads, envelopes
 *                    awaiting approval, today's scheduled jobs
 *   followups        the follow-up queue + idle contacted leads
 *   estimate_risk    one quote (opts.quoteId) + comparable outcomes;
 *                    margin/cost fields ONLY when RBAC grants VIEW_FINANCIALS
 *   agent_activity   recent decision envelopes, ads recommendations, and
 *                    gateway audit entries
 *   draft_followup   one quote (opts.quoteId) + its customer's service
 *                    context — free text marked untrusted, contact PII never
 *                    included
 *
 * Hard rules, enforced by code:
 *  - PII-REDACTED BY WHITELIST: items are built field-by-field; customer
 *    names/phones/emails/addresses never enter a packet. The standing
 *    redactions list declares it.
 *  - RBAC-SCOPED: financial fields (margin, internal cost, job cost) are
 *    included only when the CURRENT session's role holds VIEW_FINANCIALS.
 *  - TENANT-ISOLATED: every read goes through workspace-scoped stores.
 *  - UNTRUSTED MARKING: customer/external free text ships untrusted:true —
 *    data, never instructions.
 *  - DETERMINISTIC: stable sort on every section; same store + same clock →
 *    byte-identical packet.
 *  - READ-ONLY: this module never calls put().
 */
;(function (global) {
  'use strict';

  function cfg() { return global.AAA_CONFIG || {}; }
  function data() { return global.AAA_DATA; }
  function clock() { return global.AAA_RUNTIME_CLOCK; }
  function rbac() { return global.AAA_RBAC; }
  function quotes() { return global.AAA_QUOTES; }
  function leads() { return global.AAA_LEADS; }
  function envelopes() { return global.AAA_DECISION_ENVELOPE; }
  function adsGov() { return global.AAA_ADS_GOVERNANCE; }
  function contract() { return global.AAA_COPILOT_CONTRACT; }
  function ws() { return cfg().workspaceId || 'default'; }
  function nowISO() { return clock() && clock().nowISO ? clock().nowISO() : new Date().toISOString(); }
  function nowMs() { return clock() && clock().now ? clock().now() : Date.now(); }
  function canFinancials() { const r = rbac(); return !r || !r.can ? false : !!r.can('VIEW_FINANCIALS'); }
  function role() { const r = rbac(); const v = r && r.role ? r.role() : 'owner'; return ['owner', 'manager', 'crew'].indexOf(v) !== -1 ? v : 'crew'; }

  // The standing declaration of what NEVER enters a packet.
  const REDACTIONS = ['customer.name', 'customer.phone', 'customer.email', 'customer.address', 'lead.name', 'lead.phone'];

  function ref(collection, id, field) {
    const r = { collection: collection, id: String(id), asOf: nowISO() };
    if (field) r.field = field;
    return r;
  }
  function item(sourceRef, dataObj, untrusted) {
    const it = { sourceRef: sourceRef, data: dataObj };
    if (untrusted) it.untrusted = true;
    return it;
  }
  function byRefId(a, b) { return String(a.sourceRef.id).localeCompare(String(b.sourceRef.id)); }
  function num(v) { const n = Number(v); return isFinite(n) ? n : null; }

  // ---- section builders (each returns an array of contract contextItems) ---
  async function attentionItems() {
    const out = [];
    const q = quotes();
    if (q && q.followUpQueue) {
      (await q.followUpQueue()).forEach(function (r) {
        out.push(item(ref('quotes', r.quoteId || r.id, 'status'), { status: r.status, total: num(r.finalPrice != null ? r.finalPrice : r.customerTotal), sentAt: r.sentAt || null }));
      });
    }
    const l = leads();
    if (l && l.listLeads) {
      const staleMs = 12 * 3600 * 1000;
      (await l.listLeads({ stage: 'NEW_LEAD' })).forEach(function (ld) {
        const age = nowMs() - (ld.createdAt || nowMs());
        if (age >= staleMs) {
          out.push(item(ref('leads', ld.leadId, 'stage'), { stage: ld.stage, serviceType: ld.serviceType, ageHours: Math.round(age / 3600000) },
            false));
        }
      });
    }
    const env = envelopes();
    if (env && env.list) {
      (await env.list({ status: 'awaiting_approval' })).forEach(function (e) {
        out.push(item(ref('decision_envelopes', e.id, 'approval.status'), { status: 'awaiting_approval', agent: e.agent, recommendation: String(e.decision && e.decision.recommendation || '').slice(0, 200) }));
      });
    }
    return out.sort(byRefId);
  }

  async function followupItems() {
    const out = [];
    const q = quotes();
    if (q && q.followUpQueue) {
      (await q.followUpQueue()).forEach(function (r) {
        const d = { status: r.status, sentAt: r.sentAt || null, serviceType: r.serviceType || null };
        if (canFinancials()) d.total = num(r.finalPrice != null ? r.finalPrice : r.customerTotal);
        out.push(item(ref('quotes', r.quoteId || r.id), d));
      });
    }
    const l = leads();
    if (l && l.listLeads) {
      const idleMs = 5 * 86400000;
      (await l.listLeads({ stage: 'CONTACTED' })).forEach(function (ld) {
        if (nowMs() - (ld.updatedAt || 0) >= idleMs) {
          out.push(item(ref('leads', ld.leadId, 'stage'), { stage: ld.stage, serviceType: ld.serviceType, idleDays: Math.round((nowMs() - ld.updatedAt) / 86400000) }));
        }
      });
    }
    return out.sort(byRefId);
  }

  async function estimateRiskItems(quoteId) {
    if (!quoteId) return { error: 'QUOTE_ID_REQUIRED' };
    const q = quotes();
    if (!q || !q.get) return { error: 'QUOTES_UNAVAILABLE' };
    const rec = await q.get(quoteId);
    if (!rec) return { error: 'QUOTE_NOT_FOUND' };
    const out = [];
    const base = { status: rec.status, serviceType: rec.serviceType || null, zip: rec.zip || null };
    if (canFinancials()) {
      base.total = num(rec.finalPrice != null ? rec.finalPrice : rec.customerTotal);
      base.grossMargin = num(rec.grossMargin);
      base.marginPct = num(rec.marginPct);
    }
    out.push(item(ref('quotes', rec.quoteId || rec.id), base));
    // Comparable outcomes: same service type, resolved won/lost — ids + amounts only.
    try {
      const comps = ((await data().list('outcomes')) || []).filter(function (o) {
        return o && (o.workspaceId == null || o.workspaceId === ws()) && o.serviceType === rec.serviceType && (o.result === 'won' || o.result === 'lost');
      }).slice(0, 5);
      comps.forEach(function (o) {
        const d = { comparable: true, result: o.result, serviceType: o.serviceType };
        if (canFinancials() && o.finalAmount != null) d.finalAmount = num(o.finalAmount);
        out.push(item(ref('outcomes', o.id), d));
      });
    } catch (_) { /* comparables are optional */ }
    return { items: out.sort(byRefId) };
  }

  async function agentActivityItems() {
    const out = [];
    const env = envelopes();
    if (env && env.list) {
      (await env.list()).slice(0, 10).forEach(function (e) {
        out.push(item(ref('decision_envelopes', e.id), { agent: e.agent, status: e.approval && e.approval.status, confidence: e.decision && e.decision.confidence }));
      });
    }
    const g = adsGov();
    if (g && g.list) {
      (await g.list()).slice(0, 10).forEach(function (r) {
        out.push(item(ref('ads_recommendations', r.id), { agent: r.agent, type: r.type, status: r.status }));
      });
    }
    const gw = global.AAA_RUNTIME_GATEWAY;
    if (gw && gw.recentAudit) {
      try {
        ((await gw.recentAudit(10)) || []).forEach(function (a) {
          out.push(item(ref('audit_log', a.id), { action: a.action, origin: a.origin, decision: a.decision, reason: a.reason || null }));
        });
      } catch (_) { /* audit read is optional */ }
    }
    return out.sort(byRefId);
  }

  async function draftContextItems(quoteId) {
    if (!quoteId) return { error: 'QUOTE_ID_REQUIRED' };
    const q = quotes();
    if (!q || !q.get) return { error: 'QUOTES_UNAVAILABLE' };
    const rec = await q.get(quoteId);
    if (!rec) return { error: 'QUOTE_NOT_FOUND' };
    const out = [];
    out.push(item(ref('quotes', rec.quoteId || rec.id), {
      status: rec.status, serviceType: rec.serviceType || null, sentAt: rec.sentAt || null,
      total: num(rec.finalPrice != null ? rec.finalPrice : rec.customerTotal) // the customer already saw this number
    }));
    if (rec.customerId) {
      try {
        const cust = (await data().listCustomers()).filter(function (c) { return c && c.id === rec.customerId; })[0];
        if (cust) {
          // Service context only: notes are customer free text → untrusted.
          // Name/phone/email/address NEVER ship; drafts use {{placeholders}}.
          out.push(item(ref('customers', cust.id, 'notes'), { preferredChannel: cust.preferredChannel || null, note: String(cust.notes || '').slice(0, 300) }, true));
        }
      } catch (_) { /* customer context is optional */ }
    }
    return { items: out.sort(byRefId) };
  }

  const Packet = {
    REDACTIONS: REDACTIONS.slice(),

    /**
     * Assemble the packet for one phase-one job.
     * opts: { quoteId? (estimate_risk / draft_followup) }
     * → { ok:true, packet } (contract-valid) or an honest { ok:false, error }.
     */
    async assemble(job, opts) {
      const c = contract();
      if (!c) return { ok: false, error: 'NO_CONTRACT' };
      if (c.JOBS.indexOf(job) === -1) return { ok: false, error: 'UNKNOWN_JOB', job: String(job) };
      if (!data()) return { ok: false, error: 'NO_STORE' };
      const o = opts || {};

      let sections;
      if (job === 'attention_today') sections = [{ kind: 'attention', items: await attentionItems() }];
      else if (job === 'followups') sections = [{ kind: 'followups', items: await followupItems() }];
      else if (job === 'estimate_risk') {
        const r = await estimateRiskItems(o.quoteId);
        if (r.error) return { ok: false, error: r.error };
        sections = [{ kind: 'estimate_risk', items: r.items }];
      } else if (job === 'agent_activity') sections = [{ kind: 'agent_activity', items: await agentActivityItems() }];
      else {
        const r = await draftContextItems(o.quoteId);
        if (r.error) return { ok: false, error: r.error };
        sections = [{ kind: 'draft_context', items: r.items }];
      }

      const packet = {
        packetVersion: 1,
        workspaceId: ws(),
        assembledAt: nowISO(),
        role: role(),
        sections: sections,
        redactions: REDACTIONS.slice()
      };
      const v = c.validateContextPacket(packet);
      if (!v.ok) return { ok: false, error: 'INVALID_PACKET', issues: v.issues };
      return { ok: true, packet: packet };
    }
  };

  global.AAA_COPILOT_CONTEXT = Packet;
})(typeof window !== 'undefined' ? window : this);
