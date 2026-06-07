/*
 * AAA Signal Ingestion — the HyperMind's wider senses (HM-3).
 *
 * The loop already observes jobs/quotes/outcomes (via outcome-intelligence). This
 * module widens perception to the REST of the business by normalizing every other
 * signal source into one immutable, idempotent `signals` stream the loop reads on
 * each Observe phase:
 *
 *   Live today (real data sources already in the kernel):
 *     invoices  → invoice_issued / invoice_paid
 *     payments  → payment_received
 *     expenses  → expense_recorded
 *     customers → lead_captured            (lead source as segment)
 *   Schema-ready (normalized the moment records arrive — webhook / manual / future
 *   integration — otherwise a clean no-op; never fabricated):
 *     calls     → call_received / call_missed
 *     leads     → lead_captured            (web form, with campaign)
 *     refunds   → refund_issued
 *     ad_events → ad_click / ad_spend
 *
 * Honest by construction: every adapter is null-tolerant; an absent/empty source
 * contributes nothing. Idempotent via deterministic ids, workspace-scoped, and
 * mirrored to the event bus when a contract exists. metrics() derives real KPIs
 * (spend, paid-rate, missed-call rate, refund rate, CAC) with honest nulls when
 * the underlying data isn't there yet.
 */
;(function (global) {
  'use strict';

  const SIGNALS = 'signals';
  // Allowlist of normalized signal types (record() rejects anything else).
  const TYPES = [
    'invoice_issued', 'invoice_paid', 'payment_received', 'expense_recorded',
    'lead_captured', 'call_received', 'call_missed', 'refund_issued',
    'ad_click', 'ad_spend'
  ];

  function cfg() { return global.AAA_CONFIG || {}; }
  function data() { return global.AAA_DATA; }
  function ids() { return global.AAA_ID_FACTORY; }
  function clock() { return global.AAA_RUNTIME_CLOCK; }
  function bus() { return global.AAA_EVENT_BUS; }
  function ws() { return cfg().workspaceId || 'default'; }
  function nowISO() { return clock() && clock().nowISO ? clock().nowISO() : new Date().toISOString(); }
  function mine(r) { return r && (r.workspaceId == null || r.workspaceId === ws()); }
  function newId(p) { return ids() ? ids().createId(p) : p + '_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7); }
  function num(v) { const n = Number(v); return isFinite(n) ? n : null; }
  async function listSafe(coll) { try { return ((await data().list(coll)) || []).filter(mine); } catch (_) { return []; } }
  async function put(c, rec) { await data().put(c, rec.id, rec); try { if (data().cloudReady && data().cloudReady() && global.AAA_CLOUD) global.AAA_CLOUD.upsertEntity(c, rec.id, rec); } catch (_) {} }

  const Ingest = {
    SIGNALS: SIGNALS, TYPES: TYPES,

    /** Append a signal (immutable). Deterministic id => idempotent. Mirrors to bus. */
    async record(type, payload, opts) {
      const o = opts || {};
      if (TYPES.indexOf(type) === -1) return { ok: false, error: 'UNKNOWN_TYPE' };
      const id = o.id || newId('sig');
      if (o.id && (await data().get(SIGNALS, id))) return { ok: true, already: true, id: id };
      const p = payload || {};
      const rec = {
        id: id, workspaceId: ws(), type: type, source: p.source || null,
        refId: p.refId || null, customerId: p.customerId || null, jobId: p.jobId || null,
        value: p.value != null ? num(p.value) : null, segment: p.segment || null,
        at: p.at || nowISO(), recordedAt: nowISO()
      };
      await put(SIGNALS, rec);
      try { if (bus() && bus().contract && bus().contract('signal.' + type)) bus().publish('signal.' + type, { id: id, refId: rec.refId }, { source: 'signal-ingest' }); } catch (_) {}
      return { ok: true, id: id, signal: rec };
    },

    /** Run every source adapter (idempotent). Returns counts overall + by source. */
    async ingest() {
      const bySource = {};
      const ensure = async (type, id, payload) => { const r = await this.record(type, payload, { id: id }); return r && r.already ? 0 : (r && r.ok ? 1 : 0); };
      const tally = (src, n) => { if (n) bySource[src] = (bySource[src] || 0) + n; };

      // ---- invoices → invoice_issued / invoice_paid (real today) ----------
      for (const i of await listSafe('invoices')) {
        if (!i.id) continue;
        tally('invoices', await ensure('invoice_issued', 'sig_inv_iss_' + i.id, { source: 'invoices', refId: i.id, jobId: i.jobId || null, customerId: i.customerId || null, value: i.amount, at: i.issuedAt || i.createdAt }));
        if (i.status === 'paid') tally('invoices', await ensure('invoice_paid', 'sig_inv_paid_' + i.id, { source: 'invoices', refId: i.id, jobId: i.jobId || null, customerId: i.customerId || null, value: i.amount, at: i.paidAt || i.updatedAt || i.createdAt }));
      }
      // ---- payments → payment_received (real today) -----------------------
      for (const p of await listSafe('payments')) {
        if (!p.id) continue;
        tally('payments', await ensure('payment_received', 'sig_pay_' + p.id, { source: 'payments', refId: p.id, jobId: p.jobId || null, value: p.amount, at: p.receivedAt || p.createdAt }));
      }
      // ---- expenses → expense_recorded (real today) -----------------------
      for (const e of await listSafe('expenses')) {
        if (!e.id) continue;
        tally('expenses', await ensure('expense_recorded', 'sig_exp_' + e.id, { source: 'expenses', refId: e.id, jobId: e.jobId || null, value: e.amount, segment: e.category || null, at: e.incurredAt || e.createdAt }));
      }
      // ---- customers → lead_captured (real today; source as segment) ------
      for (const c of await listSafe('customers')) {
        if (!c.id || !(c.createdAt || c.source)) continue;
        tally('customers', await ensure('lead_captured', 'sig_lead_cust_' + c.id, { source: 'customers', refId: c.id, customerId: c.id, segment: c.source || 'unknown', at: c.createdAt || nowISO() }));
      }

      // ---- calls → call_received / call_missed (schema-ready) -------------
      for (const c of await listSafe('calls')) {
        if (!c.id) continue;
        const missed = c.missed === true || c.status === 'missed';
        tally('calls', await ensure(missed ? 'call_missed' : 'call_received', 'sig_call_' + c.id, { source: 'calls', refId: c.id, customerId: c.customerId || null, segment: c.source || null, at: c.at || c.createdAt }));
      }
      // ---- leads (web form) → lead_captured (schema-ready) ----------------
      for (const l of await listSafe('leads')) {
        if (!l.id) continue;
        tally('leads', await ensure('lead_captured', 'sig_lead_web_' + l.id, { source: 'leads', refId: l.id, customerId: l.customerId || null, segment: l.campaign || l.source || 'web', at: l.at || l.createdAt }));
      }
      // ---- refunds → refund_issued (schema-ready) -------------------------
      for (const r of await listSafe('refunds')) {
        if (!r.id) continue;
        tally('refunds', await ensure('refund_issued', 'sig_refund_' + r.id, { source: 'refunds', refId: r.id, jobId: r.jobId || null, customerId: r.customerId || null, value: r.amount, at: r.at || r.createdAt }));
      }
      // ---- ad_events → ad_click / ad_spend (schema-ready) ----------------
      for (const a of await listSafe('ad_events')) {
        if (!a.id) continue;
        const type = a.type === 'spend' || a.spend != null ? 'ad_spend' : 'ad_click';
        tally('ad_events', await ensure(type, 'sig_ad_' + a.id, { source: 'ad_events', refId: a.id, segment: a.campaign || a.channel || null, value: a.spend != null ? a.spend : (a.value != null ? a.value : null), at: a.at || a.createdAt }));
      }

      const added = Object.keys(bySource).reduce((n, k) => n + bySource[k], 0);
      return { ok: true, added: added, bySource: bySource };
    },

    /** All signals (newest first), optionally filtered by {type, source, customerId}. */
    async signals(filter) {
      const f = filter || {};
      let all = (await data().list(SIGNALS)).filter(mine);
      if (f.type) all = all.filter((s) => s.type === f.type);
      if (f.source) all = all.filter((s) => s.source === f.source);
      if (f.customerId) all = all.filter((s) => s.customerId === f.customerId);
      return all.sort((a, b) => String(b.at || '').localeCompare(String(a.at || '')));
    },

    /** Honest KPI rollup over the signal stream (nulls when data isn't there). */
    async metrics() {
      const all = (await data().list(SIGNALS)).filter(mine);
      const byType = {}; TYPES.forEach((t) => { byType[t] = 0; });
      const sum = {}; TYPES.forEach((t) => { sum[t] = 0; });
      all.forEach((s) => { byType[s.type] = (byType[s.type] || 0) + 1; if (s.value != null) sum[s.type] += s.value; });

      const issued = byType.invoice_issued, paid = byType.invoice_paid;
      const calls = byType.call_received + byType.call_missed;
      const adSpend = sum.ad_spend;
      const newCustomers = byType.lead_captured;
      const round = (n) => Math.round(n * 100) / 100;

      return {
        total: all.length, byType: byType,
        revenueBilled: round(sum.invoice_issued),
        revenueCollected: round(sum.payment_received),
        spend: round(sum.expense_recorded + sum.ad_spend),
        refundTotal: round(sum.refund_issued),
        invoicePaidRate: issued ? Math.round((paid / issued) * 100) : null,
        missedCallRate: calls ? Math.round((byType.call_missed / calls) * 100) : null,
        refundRate: byType.payment_received ? Math.round((byType.refund_issued / byType.payment_received) * 100) : null,
        leads: newCustomers,
        cac: adSpend > 0 && newCustomers > 0 ? round(adSpend / newCustomers) : null
      };
    }
  };

  global.AAA_SIGNAL_INGEST = Ingest;
})(typeof window !== 'undefined' ? window : this);
