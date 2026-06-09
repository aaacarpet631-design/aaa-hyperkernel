/*
 * AAA Financial Intelligence — the books, read as a decision surface.
 *
 * Sits on top of the accounting store (invoices / expenses / payments) and
 * derives the financial picture an operator actually needs: a P&L, AR aging,
 * monthly cash flow, expense breakdown, financial KPIs (margins, DSO, expense
 * ratio), anomaly flags (expense spikes / revenue drops), and a simple forward
 * forecast. Everything is COMPUTED from records — read-only; it posts nothing,
 * pays nothing, and changes no invoice. Owner-only; deterministic; null-tolerant.
 */
;(function (global) {
  'use strict';

  const SNAPSHOTS = 'financial_snapshots';

  function cfg() { return global.AAA_CONFIG || {}; }
  function data() { return global.AAA_DATA; }
  function ids() { return global.AAA_ID_FACTORY; }
  function clock() { return global.AAA_RUNTIME_CLOCK; }
  function acct() { return global.AAA_ACCOUNTING; }
  function ws() { return cfg().workspaceId || 'default'; }
  function nowISO() { return clock() && clock().nowISO ? clock().nowISO() : new Date().toISOString(); }
  function nowMs() { return clock() && clock().now ? clock().now() : Date.now(); }
  function mine(r) { return r && (r.workspaceId == null || r.workspaceId === ws()); }
  function newId(p) { return ids() ? ids().createId(p) : p + '_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7); }
  function num(v) { const n = Number(v); return isFinite(n) ? n : 0; }
  function round(n) { return Math.round(n); }
  function ym(t) { const d = new Date(t); return isFinite(d.getTime()) ? d.getUTCFullYear() + '-' + ('0' + (d.getUTCMonth() + 1)).slice(-2) : null; }

  async function invoices() { try { return acct() && acct().listInvoices ? await acct().listInvoices() : (await data().list('invoices')).filter(mine); } catch (_) { return []; } }
  async function expenses() { try { return acct() && acct().listExpenses ? await acct().listExpenses() : (await data().list('expenses')).filter(mine); } catch (_) { return []; } }
  async function payments() { try { return acct() && acct().listPayments ? await acct().listPayments() : (await data().list('payments')).filter(mine); } catch (_) { return []; } }
  function isPaid(inv) { return inv && (inv.status === 'paid'); }
  function isVoid(inv) { return inv && (inv.status === 'void' || inv.status === 'canceled'); }

  const FI = {
    SNAPSHOTS: SNAPSHOTS,

    /** Company P&L: revenue (paid) vs expenses → gross/net. */
    async pnl() {
      const invs = await invoices(), exps = await expenses();
      const revenue = invs.filter(isPaid).reduce((s, i) => s + num(i.amount), 0);
      const billed = invs.filter((i) => !isVoid(i)).reduce((s, i) => s + num(i.amount), 0);
      const expense = exps.reduce((s, e) => s + num(e.amount), 0);
      const net = revenue - expense;
      return { ok: true, revenue: round(revenue), billed: round(billed), expenses: round(expense), netProfit: round(net), netMargin: revenue ? Math.round((net / revenue) * 100) : null };
    },

    /** Accounts-receivable aging: unpaid invoices by age bucket. */
    async arAging(now) {
      const ms = now != null ? now : nowMs();
      const invs = (await invoices()).filter((i) => !isPaid(i) && !isVoid(i) && i.status !== 'draft');
      const buckets = { current: 0, d30: 0, d60: 0, d90plus: 0 };
      const detail = { current: [], d30: [], d60: [], d90plus: [] };
      invs.forEach((i) => {
        const age = (ms - Date.parse(i.issuedAt || i.createdAt || '')) / 86400000;
        const amt = num(i.amount);
        const b = !isFinite(age) || age < 30 ? 'current' : age < 60 ? 'd30' : age < 90 ? 'd60' : 'd90plus';
        buckets[b] += amt; detail[b].push({ id: i.id, customer: i.customerName || null, amount: round(amt), days: isFinite(age) ? Math.round(age) : null });
      });
      Object.keys(buckets).forEach((k) => buckets[k] = round(buckets[k]));
      return { ok: true, buckets: buckets, outstanding: round(buckets.current + buckets.d30 + buckets.d60 + buckets.d90plus), overdue: round(buckets.d30 + buckets.d60 + buckets.d90plus), detail: detail };
    },

    /** Monthly cash flow: payments in, expenses out, net — oldest→newest. */
    async cashFlow() {
      const pays = await payments(), exps = await expenses();
      const months = {};
      const bucket = (k) => (months[k] = months[k] || { month: k, inflow: 0, outflow: 0 });
      pays.forEach((p) => { const k = ym(Date.parse(p.receivedAt || p.createdAt || '')); if (k) bucket(k).inflow += num(p.amount); });
      exps.forEach((e) => { const k = ym(Date.parse(e.incurredAt || e.createdAt || '')); if (k) bucket(k).outflow += num(e.amount); });
      const series = Object.keys(months).sort().map((k) => ({ month: k, inflow: round(months[k].inflow), outflow: round(months[k].outflow), net: round(months[k].inflow - months[k].outflow) }));
      return { ok: true, months: series, netCash: round(series.reduce((s, m) => s + m.net, 0)) };
    },

    /** Expense totals by category, largest first. */
    async expenseBreakdown() {
      const exps = await expenses();
      const by = {}; exps.forEach((e) => { const c = e.category || 'General'; by[c] = (by[c] || 0) + num(e.amount); });
      const total = exps.reduce((s, e) => s + num(e.amount), 0);
      return { ok: true, total: round(total), categories: Object.keys(by).map((c) => ({ category: c, amount: round(by[c]), pct: total ? Math.round((by[c] / total) * 100) : 0 })).sort((a, b) => b.amount - a.amount) };
    },

    /** Financial KPIs: margins, DSO, expense ratio, average invoice. */
    async kpis() {
      const pnl = await this.pnl();
      const invs = await invoices(), pays = await payments();
      const paid = invs.filter(isPaid);
      const avgInvoice = paid.length ? round(paid.reduce((s, i) => s + num(i.amount), 0) / paid.length) : null;
      // DSO: avg days from issue → payment for paid invoices we can match.
      const payByInv = {}; pays.forEach((p) => { if (p.invoiceId) payByInv[p.invoiceId] = Math.max(payByInv[p.invoiceId] || 0, Date.parse(p.receivedAt || p.createdAt || '') || 0); });
      const dsoDays = paid.map((i) => { const pt = payByInv[i.id], it = Date.parse(i.issuedAt || i.createdAt || ''); return (pt && isFinite(it)) ? (pt - it) / 86400000 : null; }).filter((d) => d != null && d >= 0);
      const dso = dsoDays.length ? Math.round(dsoDays.reduce((a, b) => a + b, 0) / dsoDays.length) : null;
      return {
        ok: true, netMargin: pnl.netMargin, expenseRatio: pnl.revenue ? Math.round((pnl.expenses / pnl.revenue) * 100) : null,
        avgInvoice: avgInvoice, dso: dso, revenue: pnl.revenue, expenses: pnl.expenses, netProfit: pnl.netProfit
      };
    },

    /** Anomalies: latest-month expense spike or revenue drop vs trailing avg. */
    async anomalies() {
      const cf = await this.cashFlow();
      const ms = cf.months;
      const out = [];
      if (ms.length >= 3) {
        const last = ms[ms.length - 1], prior = ms.slice(0, -1);
        const avgOut = prior.reduce((s, m) => s + m.outflow, 0) / prior.length;
        const avgIn = prior.reduce((s, m) => s + m.inflow, 0) / prior.length;
        if (avgOut > 0 && last.outflow > avgOut * 1.5) out.push({ kind: 'expense_spike', month: last.month, value: last.outflow, baseline: round(avgOut), severity: 'warn' });
        if (avgIn > 0 && last.inflow < avgIn * 0.6) out.push({ kind: 'revenue_drop', month: last.month, value: last.inflow, baseline: round(avgIn), severity: 'warn' });
      }
      return { ok: true, anomalies: out };
    },

    /** Simple forward forecast of monthly net cash (avg of recent months). */
    async forecast(months) {
      const horizon = Math.max(1, Math.min(12, num(months) || 3));
      const cf = await this.cashFlow();
      const recent = cf.months.slice(-3);
      const avgNet = recent.length ? Math.round(recent.reduce((s, m) => s + m.net, 0) / recent.length) : 0;
      const path = [];
      for (let i = 1; i <= horizon; i++) path.push({ monthAhead: i, projectedNet: avgNet });
      return { ok: true, basisMonths: recent.length, monthlyNet: avgNet, horizon: horizon, projectedNet: avgNet * horizon, path: path, note: 'Flat projection from the last ' + recent.length + ' month(s) — a planning estimate.' };
    },

    /** One-call financial overview. */
    async overview() {
      const [pnl, ar, kpis, brk, anom] = [await this.pnl(), await this.arAging(), await this.kpis(), await this.expenseBreakdown(), await this.anomalies()];
      return { ok: true, pnl: pnl, ar: ar, kpis: kpis, expenseBreakdown: brk, anomalies: anom.anomalies, generatedAt: nowISO() };
    },

    /** Persist a snapshot (for trends). */
    async snapshot() { const o = await this.kpis(); const rec = { id: newId('finsnap'), workspaceId: ws(), at: nowISO(), revenue: o.revenue, expenses: o.expenses, netProfit: o.netProfit, netMargin: o.netMargin, dso: o.dso }; await put(rec); return { ok: true, snapshot: rec }; },
    async snapshots() { return (await data().list(SNAPSHOTS)).filter(mine).sort((a, b) => String(b.at || '').localeCompare(String(a.at || ''))); }
  };

  async function put(rec) { await data().put(SNAPSHOTS, rec.id, rec); try { if (data().cloudReady && data().cloudReady() && global.AAA_CLOUD) global.AAA_CLOUD.upsertEntity(SNAPSHOTS, rec.id, rec); } catch (_) {} }

  global.AAA_FINANCIAL_INTELLIGENCE = FI;
})(typeof window !== 'undefined' ? window : this);
