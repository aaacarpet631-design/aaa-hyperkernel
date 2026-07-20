/*
 * AAA Assisted Draft Queue — Instruct drafts, the owner approves, nothing sends.
 *
 * The safe home for AI-drafted customer messages. draft() asks the GOVERNED model
 * router (Nemotron Instruct, task draft_customer_message) for a SUGGESTED message
 * and files it as `pending_owner` — carrying the model's governance version,
 * confidence, risk, output checksum, and provenance trace. A person then edits
 * and/or approves it; approval marks it ready (returning the final text to send by
 * the normal channel). It NEVER sends on its own.
 *
 * Governance held: drafting routes through RUN_MODEL (office-level; crew denied);
 * approve/reject route through APPROVE_ASSISTED_MSG (human-only — an AI origin can
 * request a draft but can never approve one). Advisory until a human says go.
 */
;(function (global) {
  'use strict';

  const DRAFTS = 'assisted_drafts';

  function cfg() { return global.AAA_CONFIG || {}; }
  function data() { return global.AAA_DATA; }
  function ids() { return global.AAA_ID_FACTORY; }
  function clock() { return global.AAA_RUNTIME_CLOCK; }
  function gateway() { return global.AAA_RUNTIME_GATEWAY; }
  function router() { return global.AAA_GOVERNED_MODEL_ROUTER; }
  function ws() { return cfg().workspaceId || 'default'; }
  function nowISO() { return clock() && clock().nowISO ? clock().nowISO() : new Date().toISOString(); }
  function mine(r) { return r && (r.workspaceId == null || r.workspaceId === ws()); }
  function newId(p) { return ids() ? ids().createId(p) : p + '_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7); }

  const Queue = {
    DRAFTS: DRAFTS,

    /** Ask the governed Instruct model for a SUGGESTED message; file it pending. */
    async draft(input) {
      const i = input || {};
      if (!router()) return { ok: false, error: 'NO_MODEL_ROUTER' };
      if (!i.to) return { ok: false, error: 'NO_RECIPIENT' };
      const modelInput = { intent: i.intent || 'follow_up', customerName: i.customerName || null, context: i.context || null, channel: i.channel || 'sms' };
      const env = await router().call({ taskType: 'draft_customer_message', input: modelInput, context: { subject: 'assisted_draft', customerId: i.customerId || null }, actor: i.actor || null, origin: i.origin, agent: 'assisted_drafts', ownerApprovalRequired: true });
      if (env && env.ok === false) return env;                       // gateway denial (e.g. crew) — surfaced + audited
      const unavailable = !!(env && env.fallback);
      const suggested = (!unavailable && env && env.output && env.output.text) ? env.output.text : '';
      const id = newId('adraft');
      const rec = {
        id: id, workspaceId: ws(), customerId: i.customerId || null, to: String(i.to), channel: i.channel || 'sms', intent: i.intent || 'follow_up',
        suggestedText: suggested, editedText: null, finalText: null,
        status: 'pending_owner', modelUnavailable: unavailable,
        model: env ? { modelKey: env.modelFamily ? ('nvidia.' + (env.modelId || '')) : null, modelId: env.modelId || null, governanceVersion: env.governanceVersion || null, provider: env.provider || null, confidence: env.confidence != null ? env.confidence : null, riskScore: env.riskScore != null ? env.riskScore : null, outputChecksum: env.outputChecksum || null, provenanceTraceId: env.provenanceTraceId || null, fallback: unavailable } : null,
        createdBy: i.actor || (i.origin === 'ai' ? 'ai' : null), createdAt: nowISO(), updatedAt: nowISO(),
        approvedBy: null, approvedAt: null, rejectionReason: null,
        history: [{ type: 'drafted', at: nowISO(), by: i.actor || (i.origin === 'ai' ? 'ai' : null), modelUnavailable: unavailable }]
      };
      await put(rec);
      return { ok: true, draft: rec, modelUnavailable: unavailable };
    },

    /**
     * File a PRE-WRITTEN draft (e.g. the remote copilot's draft_message card,
     * source 'copilot') straight into the pending-approval flow. No model
     * call, no send — the body (placeholders like {{customer_name}} intact)
     * lands as `pending_owner` and rides the exact same human approve/reject
     * path as draft(). AI may file; only a human can ever approve.
     */
    async file(input) {
      const i = input || {};
      const body = String(i.body == null ? '' : i.body);
      if (!body.trim()) return { ok: false, error: 'NO_BODY' };
      // Role parity with draft(): local drafting runs through RUN_MODEL
      // (office-level — crew denied by the gateway). Filing a remotely
      // drafted message is the same capability, so the same roles hold it;
      // the remote path must not be a side door around the local gate.
      const rb = global.AAA_RBAC;
      if (rb && rb.can && !rb.can('VIEW_ALL_JOBS')) return { ok: false, error: 'FORBIDDEN', permission: 'VIEW_ALL_JOBS' };
      const source = i.source || 'filed';
      const by = i.actor || (i.origin === 'ai' ? 'ai' : null);
      const id = newId('adraft');
      const rec = {
        id: id, workspaceId: ws(), customerId: i.customerId || null, to: i.to != null ? String(i.to) : null,
        channel: i.channel || 'sms', intent: i.intent || 'follow_up',
        suggestedText: body, editedText: null, finalText: null,
        status: 'pending_owner', modelUnavailable: false, source: source, model: null,
        createdBy: by, createdAt: nowISO(), updatedAt: nowISO(),
        approvedBy: null, approvedAt: null, rejectionReason: null,
        history: [{ type: 'filed', at: nowISO(), by: by, source: source }]
      };
      await put(rec);
      // Audit parity with the drafting path — ids only, never the body.
      try {
        const led = global.AAA_AUDIT_LEDGER;
        if (led && led.append) await led.append('assisted_draft.filed', { draftId: id, source: source, channel: rec.channel, by: by });
      } catch (_) { /* advisory — the pending draft record itself is the fallback trail */ }
      return { ok: true, draft: rec };
    },

    async list(status) { const all = (await data().list(DRAFTS)).filter(mine); return (status ? all.filter((d) => d.status === status) : all).sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || ''))); },
    async pending() { return this.list('pending_owner'); },
    async get(id) { const r = await data().get(DRAFTS, id); return mine(r) ? r : null; },

    /** Owner/office edits the suggested text before approving. Human-only path. */
    async edit(id, text, opts) {
      const o = opts || {};
      const d = await this.get(id); if (!d) return { ok: false, error: 'NOT_FOUND' };
      if (d.status !== 'pending_owner') return { ok: false, error: 'NOT_PENDING' };
      const rec = Object.assign({}, d, { editedText: String(text == null ? '' : text), updatedAt: nowISO(), history: (d.history || []).concat([{ type: 'edited', at: nowISO(), by: o.actor || null }]) });
      await put(rec); return { ok: true, draft: rec };
    },

    /** Human approval (APPROVE_ASSISTED_MSG, office, human-only). Marks it ready to
     *  send by the normal channel — it does NOT send. AI-origin is blocked. */
    async approve(id, opts) {
      const o = opts || {};
      const d = await this.get(id); if (!d) return { ok: false, error: 'NOT_FOUND' };
      if (d.status !== 'pending_owner') return { ok: false, error: 'NOT_PENDING' };
      const finalText = (o.text != null ? String(o.text) : (d.editedText != null ? d.editedText : d.suggestedText)) || '';
      if (!finalText.trim()) return { ok: false, error: 'EMPTY_MESSAGE', message: 'Write or edit the message before approving.' };
      const gw = gateway(); if (!gw) return { ok: false, error: 'NO_GATEWAY' };
      const auth = await gw.run({ action: 'APPROVE_ASSISTED_MSG', origin: o.origin === 'ai' ? 'ai' : 'human', actor: o.actor || null, target: { type: 'assisted_draft', id: id }, detail: { decision: 'approve', customerId: d.customerId } });
      if (!auth.ok) return auth;
      const rec = Object.assign({}, d, { status: 'approved', finalText: finalText, approvedBy: o.actor || null, approvedAt: nowISO(), updatedAt: nowISO(), auditRef: auth.auditId, history: (d.history || []).concat([{ type: 'approved', at: nowISO(), by: o.actor || null }]) });
      await put(rec);
      return { ok: true, draft: rec, finalText: finalText, sent: false, note: 'Approved. The message is ready for you to send — the system does not send it automatically.' };
    },

    /** Human rejection (APPROVE_ASSISTED_MSG, human-only). Retained. */
    async reject(id, opts) {
      const o = opts || {};
      const d = await this.get(id); if (!d) return { ok: false, error: 'NOT_FOUND' };
      if (d.status !== 'pending_owner') return { ok: false, error: 'NOT_PENDING' };
      const gw = gateway(); if (!gw) return { ok: false, error: 'NO_GATEWAY' };
      const auth = await gw.run({ action: 'APPROVE_ASSISTED_MSG', origin: o.origin === 'ai' ? 'ai' : 'human', actor: o.actor || null, target: { type: 'assisted_draft', id: id }, detail: { decision: 'reject' } });
      if (!auth.ok) return auth;
      const rec = Object.assign({}, d, { status: 'rejected', rejectionReason: o.reason || null, updatedAt: nowISO(), auditRef: auth.auditId, history: (d.history || []).concat([{ type: 'rejected', at: nowISO(), by: o.actor || null, reason: o.reason || null }]) });
      await put(rec); return { ok: true, draft: rec };
    }
  };

  async function put(rec) { await data().put(DRAFTS, rec.id, rec); try { if (data().cloudReady && data().cloudReady() && global.AAA_CLOUD) global.AAA_CLOUD.upsertEntity(DRAFTS, rec.id, rec); } catch (_) {} }

  global.AAA_ASSISTED_DRAFTS = Queue;
})(typeof window !== 'undefined' ? window : this);
