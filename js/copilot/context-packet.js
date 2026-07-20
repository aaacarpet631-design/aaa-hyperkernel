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
 *  - RECORD-LEVEL asOf: every sourceRef carries the RECORD's own timestamp
 *    (updatedAt || createdAt || sentAt), not the assembly instant, so evidence
 *    integrity checks can pin claims to record versions.
 *  - BOUNDED: every section is capped at flag('copilotSectionMaxItems', 25)
 *    items (contract hard cap 50); a capped section declares truncated:true +
 *    omittedCount — the gap is honest, never hidden.
 *  - FREE-TEXT SCRUBBED: phone-like and email-like patterns inside free text
 *    (customer notes, agent recommendations, audit reasons) are masked with
 *    '[redacted]' before packing.
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

  function flag(k, d) { const c = cfg(); return c && c.flag ? c.flag(k, d) : d; }

  // The standing declaration of what NEVER enters a packet.
  const REDACTIONS = ['customer.name', 'customer.phone', 'customer.email', 'customer.address', 'lead.name', 'lead.phone', 'freeText.phone', 'freeText.email'];

  // Normalize any timestamp (ms number or parseable string) to the contract's
  // ISO-8601 UTC instant format; null when absent/unparseable.
  function toISO(v) {
    if (v == null || v === '') return null;
    const t = typeof v === 'number' ? v : Date.parse(String(v));
    if (!isFinite(t)) return null;
    try { return new Date(t).toISOString(); } catch (_) { return null; }
  }
  // A sourceRef's asOf is the RECORD's own age, not the assembly instant.
  function recAsOf(rec) {
    const r = rec || {};
    return toISO(r.updatedAt) || toISO(r.createdAt) || toISO(r.sentAt) || nowISO();
  }
  function ref(collection, id, field, rec) {
    const r = { collection: collection, id: String(id), asOf: recAsOf(rec) };
    if (field) r.field = field;
    return r;
  }
  function item(sourceRef, dataObj, untrusted) {
    const it = { sourceRef: sourceRef, data: dataObj };
    if (untrusted) it.untrusted = true;
    return it;
  }
  // Codepoint comparison — localeCompare is host-locale-dependent, which
  // breaks the byte-identical determinism guarantee across environments.
  function byRefId(a, b) { const x = String(a.sourceRef.id), y = String(b.sourceRef.id); return x < y ? -1 : x > y ? 1 : 0; }
  function num(v) { const n = Number(v); return isFinite(n) ? n : null; }

  // Mask phone-like (7+ digit runs, separators allowed) and email-like
  // patterns in free text — customer notes and agent prose can embed contact
  // PII that the whitelist alone can't keep out.
  const EMAIL_LIKE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
  const PHONE_LIKE = /\+?(?:\d[\s().-]?){6,}\d/g;
  const ISO_DATEISH = /^\d{4}-\d{2}-\d{2}/;
  function scrub(text) {
    return String(text == null ? '' : text)
      .replace(EMAIL_LIKE, '[redacted]')
      .replace(PHONE_LIKE, function (m, offset, whole) {
        // Keep non-contact digit runs: ISO dates/timestamps and digit runs
        // glued to a word or record id (quote_2026070901) carry scheduling /
        // reference meaning, not PII. Bare separator-formatted runs still mask.
        if (ISO_DATEISH.test(m)) return m;
        const prev = offset > 0 ? whole.charAt(offset - 1) : '';
        if (/[A-Za-z_]/.test(prev)) return m;
        return '[redacted]';
      });
  }

  // Bound a section to the configured cap (contract hard cap is 50). Items
  // must already be in deterministic priority order; the cut is declared.
  function sectionOf(kind, items) {
    const raw = num(flag('copilotSectionMaxItems', 25));
    const cap = raw != null && raw >= 1 ? Math.min(Math.floor(raw), 50) : 25;
    const s = { kind: kind, items: items.slice(0, cap) };
    if (items.length > cap) { s.truncated = true; s.omittedCount = items.length - cap; }
    return s;
  }

  // ---- section builders (each returns an array of contract contextItems) ---
  async function attentionItems() {
    const out = [];
    const q = quotes();
    if (q && q.followUpQueue) {
      (await q.followUpQueue()).forEach(function (r) {
        const d = { status: r.status, sentAt: r.sentAt || null };
        if (canFinancials()) d.total = num(r.finalPrice != null ? r.finalPrice : r.customerTotal);
        out.push(item(ref('quotes', r.quoteId || r.id, 'status', r), d));
      });
    }
    const l = leads();
    if (l && l.listLeads) {
      const staleMs = 12 * 3600 * 1000;
      (await l.listLeads({ stage: 'NEW_LEAD' })).forEach(function (ld) {
        const created = num(ld.createdAt);
        const age = nowMs() - (created != null ? created : nowMs());
        if (age >= staleMs) {
          out.push(item(ref('leads', ld.leadId, 'stage', ld), { stage: ld.stage, serviceType: ld.serviceType, ageHours: num(Math.round(age / 3600000)) }));
        }
      });
    }
    const env = envelopes();
    if (env && env.list) {
      (await env.list({ status: 'awaiting_approval' })).forEach(function (e) {
        out.push(item(ref('decision_envelopes', e.id, 'approval.status', e), { status: 'awaiting_approval', agent: e.agent, recommendation: scrub(String(e.decision && e.decision.recommendation || '')).slice(0, 200) }));
      });
    }
    // Today's scheduled/active jobs — ids and state only, never customer PII.
    const d = data();
    if (d && d.listJobs) {
      try {
        ((await d.listJobs()) || []).forEach(function (j) {
          if (!j || j.id == null) return;
          if (j.workspaceId != null && j.workspaceId !== ws()) return;
          const state = String(j.currentState || j.status || '').toUpperCase();
          if (!state || state === 'CLOSED' || state === 'LOST') return;
          out.push(item(ref('jobs', j.id, 'currentState', j), { state: j.currentState || j.status, scheduledFor: toISO(j.scheduledFor) }));
        });
      } catch (_) { /* jobs are optional */ }
    }
    return out.sort(byRefId);
  }

  // Priority order: oldest touch first (the most-neglected records lead the
  // list), ref id as the deterministic tie-break — so the section cap keeps
  // the items that most need a nudge.
  async function followupItems() {
    const entries = [];
    const q = quotes();
    if (q && q.followUpQueue) {
      (await q.followUpQueue()).forEach(function (r) {
        const d = { status: r.status, sentAt: r.sentAt || null, serviceType: r.serviceType || null };
        if (canFinancials()) d.total = num(r.finalPrice != null ? r.finalPrice : r.customerTotal);
        const touch = toISO(r.sentAt) || toISO(r.updatedAt);
        entries.push({ touch: touch ? Date.parse(touch) : 0, it: item(ref('quotes', r.quoteId || r.id, null, r), d) });
      });
    }
    const l = leads();
    if (l && l.listLeads) {
      const idleMs = 5 * 86400000;
      (await l.listLeads({ stage: 'CONTACTED' })).forEach(function (ld) {
        const upd = num(ld.updatedAt);
        const touch = upd != null ? upd : 0;
        if (nowMs() - touch >= idleMs) {
          entries.push({ touch: touch, it: item(ref('leads', ld.leadId, 'stage', ld), { stage: ld.stage, serviceType: ld.serviceType, idleDays: num(Math.round((nowMs() - touch) / 86400000)) }) });
        }
      });
    }
    return entries.sort(function (a, b) { return a.touch !== b.touch ? a.touch - b.touch : byRefId(a.it, b.it); }).map(function (e) { return e.it; });
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
    out.push(item(ref('quotes', rec.quoteId || rec.id, null, rec), base));
    // Comparable outcomes: same service type, resolved won/lost — ids + amounts only.
    try {
      const comps = ((await data().list('outcomes')) || []).filter(function (o) {
        return o && (o.workspaceId == null || o.workspaceId === ws()) && o.serviceType === rec.serviceType && (o.result === 'won' || o.result === 'lost');
      }).slice(0, 5);
      comps.forEach(function (o) {
        const d = { comparable: true, result: o.result, serviceType: o.serviceType };
        if (canFinancials() && o.finalAmount != null) d.finalAmount = num(o.finalAmount);
        out.push(item(ref('outcomes', o.id, null, o), d));
      });
    } catch (_) { /* comparables are optional */ }
    return { items: out.sort(byRefId) };
  }

  async function agentActivityItems() {
    const out = [];
    const env = envelopes();
    if (env && env.list) {
      (await env.list()).slice(0, 10).forEach(function (e) {
        out.push(item(ref('decision_envelopes', e.id, null, e), { agent: e.agent, status: e.approval && e.approval.status, confidence: num(e.decision && e.decision.confidence) }));
      });
    }
    const g = adsGov();
    if (g && g.list) {
      (await g.list()).slice(0, 10).forEach(function (r) {
        out.push(item(ref('ads_recommendations', r.id, null, r), { agent: r.agent, type: r.type, status: r.status }));
      });
    }
    const gw = global.AAA_RUNTIME_GATEWAY;
    if (gw && gw.recentAudit) {
      try {
        ((await gw.recentAudit(10)) || []).forEach(function (a) {
          out.push(item(ref('audit_log', a.id, null, a), { action: a.action, origin: a.origin, decision: a.decision, reason: a.reason ? scrub(String(a.reason)) : null }));
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
    out.push(item(ref('quotes', rec.quoteId || rec.id, null, rec), {
      status: rec.status, serviceType: rec.serviceType || null, sentAt: rec.sentAt || null,
      total: num(rec.finalPrice != null ? rec.finalPrice : rec.customerTotal) // the customer already saw this number
    }));
    if (rec.customerId) {
      try {
        const cust = (await data().listCustomers()).filter(function (c) { return c && c.id === rec.customerId; })[0];
        if (cust) {
          // Service context only: notes are customer free text → untrusted,
          // and scrubbed for embedded phones/emails BEFORE the length cap so a
          // truncated match can never leak partial digits.
          // Name/phone/email/address NEVER ship; drafts use {{placeholders}}.
          out.push(item(ref('customers', cust.id, 'notes', cust), { preferredChannel: cust.preferredChannel || null, note: scrub(String(cust.notes || '')).slice(0, 300) }, true));
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
      if (job === 'attention_today') sections = [sectionOf('attention', await attentionItems())];
      else if (job === 'followups') sections = [sectionOf('followups', await followupItems())];
      else if (job === 'estimate_risk') {
        const r = await estimateRiskItems(o.quoteId);
        if (r.error) return { ok: false, error: r.error };
        sections = [sectionOf('estimate_risk', r.items)];
      } else if (job === 'agent_activity') sections = [sectionOf('agent_activity', await agentActivityItems())];
      else {
        const r = await draftContextItems(o.quoteId);
        if (r.error) return { ok: false, error: r.error };
        sections = [sectionOf('draft_context', r.items)];
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
