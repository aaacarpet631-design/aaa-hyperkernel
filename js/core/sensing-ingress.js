/*
 * AAA Sensing Ingress — automate PERCEPTION, never action.
 *
 * Real-world signals (an inbound SMS, a missed call, a web lead) arrive via the
 * server webhook, are normalized, and land here. ingest() records the signal
 * (immutable event-bus log + a sensed_events row), audits it (SENSE_SIGNAL), and
 * routes it to an ADVISORY response — a suggested reply/follow-up filed in the
 * owner-approval queue (AAA_ASSISTED_DRAFTS) as pending_owner. Inbound messages
 * are also recorded into the governed inbox. Nothing is sent: a person approves.
 *
 * This is the report's one genuinely useful idea — close the SENSING loop —
 * implemented without touching the human-authority guarantees: the system now
 * notices things on its own, but still only proposes; the owner decides.
 * Idempotent (dedupes repeated webhooks); deterministic; null-tolerant.
 */
;(function (global) {
  'use strict';

  const SENSED = 'sensed_events';

  function cfg() { return global.AAA_CONFIG || {}; }
  function data() { return global.AAA_DATA; }
  function ids() { return global.AAA_ID_FACTORY; }
  function clock() { return global.AAA_RUNTIME_CLOCK; }
  function gateway() { return global.AAA_RUNTIME_GATEWAY; }
  function bus() { return global.AAA_EVENT_BUS; }
  function drafts() { return global.AAA_ASSISTED_DRAFTS; }
  function transport() { return global.AAA_TRANSPORT_CORE; }
  function ws() { return cfg().workspaceId || 'default'; }
  function nowISO() { return clock() && clock().nowISO ? clock().nowISO() : new Date().toISOString(); }
  function mine(r) { return r && (r.workspaceId == null || r.workspaceId === ws()); }
  function newId(p) { return ids() ? ids().createId(p) : p + '_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7); }

  // Register event-bus contracts for sensed signals (immutable, audited log).
  try { if (bus() && bus().define) { ['sensing.inbound_sms', 'sensing.missed_call', 'sensing.web_lead'].forEach((tp) => bus().define(tp, { version: 1, description: 'A real-world signal was sensed (' + tp.split('.')[1] + ').', schema: { type: 'object', required: ['id'], properties: { id: { type: 'string' }, externalId: { type: 'string' } } } })); } } catch (_) {}

  // Built-in sensors: signal type → advisory handler. Each returns { draftId?, inboundId?, intent }.
  const SENSORS = {
    async inbound_sms(ev, o) {
      const p = ev.payload || {};
      let inboundId = null;
      // Record into the governed inbox (advisory — just captures + notifies the owner).
      try { if (transport() && transport().receiveInbound) { const r = await transport().receiveInbound({ channel: 'sms', from: p.from, body: p.body, providerId: ev.externalId, actor: 'sensing', origin: 'ai' }); if (r && r.ok) inboundId = r.inbound && r.inbound.id; } } catch (_) {}
      const draftId = await suggestDraft(o, { to: p.from, channel: 'sms', intent: 'reply', context: { inbound: p.body }, customerName: null });
      return { inboundId: inboundId, draftId: draftId, intent: 'reply' };
    },
    async missed_call(ev, o) {
      const p = ev.payload || {};
      const draftId = await suggestDraft(o, { to: p.from, channel: 'sms', intent: 'missed_call_followup', context: { event: 'missed_call' } });
      return { draftId: draftId, intent: 'missed_call_followup' };
    },
    async web_lead(ev, o) {
      const p = ev.payload || {};
      const draftId = await suggestDraft(o, { to: p.phone || p.email, channel: p.phone ? 'sms' : 'email', intent: 'new_lead_intro', context: { lead: p }, customerName: p.name || null });
      return { draftId: draftId, intent: 'new_lead_intro' };
    }
  };

  const Sensing = {
    SENSED: SENSED, sensors() { return Object.keys(SENSORS); },
    register(type, handler) { if (type && typeof handler === 'function') SENSORS[type] = handler; return this; },

    /** Ingest a normalized signal → record + audit + advisory owner-queue draft. */
    async ingest(event, opts) {
      const o = opts || {};
      const ev = event || {};
      if (!ev.type || !SENSORS[ev.type]) return { ok: false, error: 'UNKNOWN_SIGNAL', type: ev.type || null };

      // Idempotency: a webhook may fire twice.
      const fingerprint = ev.type + '::' + (ev.externalId || JSON.stringify(ev.payload || {}));
      const existing = (await listAll()).find((s) => s.fingerprint === fingerprint);
      if (existing) return { ok: true, already: true, sensed: existing };

      // Audit the observation (not a privileged action — the RESPONSE is gated).
      const gw = gateway();
      if (gw) { const auth = await gw.run({ action: 'SENSE_SIGNAL', origin: o.origin === 'ai' ? 'ai' : (o.origin || 'human'), actor: o.actor || 'sensing', target: { type: 'signal', id: ev.type }, detail: { source: ev.source || null, externalId: ev.externalId || null } }); if (!auth.ok) return auth; }

      const id = newId('signal');
      const rec = { id: id, workspaceId: ws(), type: ev.type, source: ev.source || null, externalId: ev.externalId || null, payload: ev.payload || {}, fingerprint: fingerprint, status: 'sensed', draftId: null, inboundId: null, intent: null, at: ev.at || nowISO(), createdAt: nowISO() };
      await put(rec);
      try { if (bus() && bus().contract && bus().contract('sensing.' + ev.type)) bus().publish('sensing.' + ev.type, { id: id, externalId: ev.externalId || null }, { source: 'sensing' }); } catch (_) {}

      // Route to the advisory response (a pending owner-approval draft).
      let outcome = {};
      try { outcome = await SENSORS[ev.type](ev, o) || {}; } catch (_) { outcome = {}; }
      const routed = Object.assign({}, rec, { status: 'routed', draftId: outcome.draftId || null, inboundId: outcome.inboundId || null, intent: outcome.intent || null, updatedAt: nowISO() });
      await put(routed);
      return { ok: true, sensed: routed, draftId: routed.draftId, inboundId: routed.inboundId, advisory: true };
    },

    async list(limit) { return (await listAll()).sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || ''))).slice(0, limit || 50); },
    async get(id) { const r = await data().get(SENSED, id); return mine(r) ? r : null; },
    async metrics() {
      const all = await listAll();
      const byType = {}; all.forEach((s) => { byType[s.type] = (byType[s.type] || 0) + 1; });
      return { ok: true, total: all.length, byType: byType, draftsCreated: all.filter((s) => s.draftId).length, lastAt: (await this.list(1))[0] ? (await this.list(1))[0].createdAt : null };
    }
  };

  // Create a suggested, pending-owner draft (advisory). Never sends.
  async function suggestDraft(o, input) {
    if (!drafts() || !drafts().draft) return null;
    try {
      const res = await drafts().draft({ to: input.to, channel: input.channel, intent: input.intent, customerName: input.customerName || null, context: input.context || null, actor: (o && o.actor) || 'sensing', origin: 'ai' });
      return res && res.ok ? res.draft.id : null;
    } catch (_) { return null; }
  }
  async function listAll() { try { return (await data().list(SENSED)).filter(mine); } catch (_) { return []; } }
  async function put(rec) { await data().put(SENSED, rec.id, rec); try { if (data().cloudReady && data().cloudReady() && global.AAA_CLOUD) global.AAA_CLOUD.upsertEntity(SENSED, rec.id, rec); } catch (_) {} }

  global.AAA_SENSING = Sensing;
})(typeof window !== 'undefined' ? window : this);
