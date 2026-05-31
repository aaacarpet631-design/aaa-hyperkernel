/*
 * AAA Accounting Store — revenue, expenses, invoices, and job costing.
 *
 * The financial source of truth. Every record lives in an owner-only Firestore
 * collection (enforced server-side) and every WRITE is meant to flow through the
 * Runtime Gateway (MODIFY_ACCOUNTING / APPROVE_PAYMENT) so AI can never mutate
 * the books. This store provides the deterministic math; the gateway provides
 * the authority; the rules provide the isolation.
 *
 * Collections: 'invoices', 'expenses', 'payments'. Profitability is computed
 * from REAL data — invoices/payments in, expenses + job costs out.
 */
;(function (global) {
  'use strict';

  const INVOICES = 'invoices';
  const EXPENSES = 'expenses';
  const PAYMENTS = 'payments';

  function data() { return global.AAA_DATA; }
  function cfg() { return global.AAA_CONFIG || {}; }
  function ids() { return global.AAA_ID_FACTORY; }
  function clock() { return global.AAA_RUNTIME_CLOCK; }
  function ws() { return cfg().workspaceId || 'default'; }
  function nowISO() { return clock() && clock().nowISO ? clock().nowISO() : new Date().toISOString(); }
  function mine(r) { return r && !r.deleted && (r.workspaceId == null || r.workspaceId === ws()); }
  function num(v) { const n = Number(v); return isFinite(n) ? n : 0; }
  function round(n) { return Math.round(n * 100) / 100; }

  /**
   * @typedef {Object} Invoice
   * @property {string} id
   * @property {string|null} jobId
   * @property {string|null} customerId
   * @property {string} customerName
   * @property {number} amount               total billed
   * @property {'draft'|'sent'|'paid'|'void'} status
   * @property {Array<{description:string, amount:number}>} items
   * @property {string} issuedAt
   */

  const Store = {
    INVOICES: INVOICES, EXPENSES: EXPENSES, PAYMENTS: PAYMENTS,

    // ---- invoices -------------------------------------------------------
    async listInvoices() { return (await data().list(INVOICES)).filter(mine).sort(byNewest); },
    async createInvoice(input) {
      const i = input || {};
      const items = Array.isArray(i.items) ? i.items.map((x) => ({ description: String(x.description || ''), amount: round(num(x.amount)) })) : [];
      const amount = i.amount != null ? round(num(i.amount)) : round(items.reduce((s, x) => s + x.amount, 0));
      const rec = {
        id: i.id || (ids() ? ids().createId('inv') : 'inv_' + Date.now()),
        jobId: i.jobId || null, customerId: i.customerId || null,
        customerName: String(i.customerName || 'Customer'),
        amount: amount, status: i.status || 'draft', items: items,
        issuedAt: i.issuedAt || nowISO(), workspaceId: ws(), createdAt: nowISO(), updatedAt: nowISO()
      };
      await put(INVOICES, rec); return rec;
    },
    async setInvoiceStatus(id, status) {
      const r = await getOne(INVOICES, id); if (!r) return { ok: false, error: 'NOT_FOUND' };
      const rec = Object.assign({}, r, { status: status, updatedAt: nowISO() });
      await put(INVOICES, rec); return { ok: true, invoice: rec };
    },

    /** Build an invoice from a job's approved estimates (does NOT finalize). */
    async invoiceFromJob(job) {
      if (!job) return null;
      const ests = Array.isArray(job.estimates) ? job.estimates : [];
      const items = ests.map((e) => ({ description: e.type || 'Service', amount: midOfRange(e.estimatedQuoteRange) }));
      return this.createInvoice({ jobId: job.id, customerId: job.customerId, customerName: job.customerName || 'Customer', items: items, status: 'draft' });
    },

    // ---- expenses -------------------------------------------------------
    async listExpenses() { return (await data().list(EXPENSES)).filter(mine).sort(byNewest); },
    async addExpense(input) {
      const i = input || {};
      const rec = {
        id: i.id || (ids() ? ids().createId('exp') : 'exp_' + Date.now()),
        jobId: i.jobId || null, category: String(i.category || 'General'),
        description: String(i.description || ''), amount: round(num(i.amount)),
        incurredAt: i.incurredAt || nowISO(), workspaceId: ws(), createdAt: nowISO(), updatedAt: nowISO()
      };
      await put(EXPENSES, rec); return rec;
    },

    // ---- payments -------------------------------------------------------
    async listPayments() { return (await data().list(PAYMENTS)).filter(mine).sort(byNewest); },
    async recordPayment(input) {
      const i = input || {};
      const rec = {
        id: i.id || (ids() ? ids().createId('pay') : 'pay_' + Date.now()),
        invoiceId: i.invoiceId || null, jobId: i.jobId || null,
        amount: round(num(i.amount)), method: String(i.method || 'cash'),
        receivedAt: i.receivedAt || nowISO(), workspaceId: ws(), createdAt: nowISO(), updatedAt: nowISO()
      };
      await put(PAYMENTS, rec);
      // Mark the invoice paid when fully covered.
      if (rec.invoiceId) {
        const inv = await getOne(INVOICES, rec.invoiceId);
        if (inv) {
          const paid = (await this.listPayments()).filter((p) => p.invoiceId === rec.invoiceId).reduce((s, p) => s + p.amount, 0);
          if (paid + 1e-6 >= inv.amount) await put(INVOICES, Object.assign({}, inv, { status: 'paid', updatedAt: nowISO() }));
        }
      }
      return rec;
    },

    // ---- profitability (real, derived) ---------------------------------
    /** Company P&L from invoices/payments in and expenses out. */
    async summary() {
      const invoices = await this.listInvoices();
      const expenses = await this.listExpenses();
      const payments = await this.listPayments();
      const billed = round(invoices.filter((i) => i.status !== 'void').reduce((s, i) => s + i.amount, 0));
      const collected = round(payments.reduce((s, p) => s + p.amount, 0));
      const expensed = round(expenses.reduce((s, e) => s + e.amount, 0));
      const outstanding = round(billed - collected);
      const profit = round(collected - expensed);
      const margin = collected > 0 ? Math.round((profit / collected) * 100) : null;
      return {
        billed: billed, collected: collected, expensed: expensed,
        outstanding: outstanding, profit: profit, marginPct: margin,
        counts: { invoices: invoices.length, expenses: expenses.length, payments: payments.length }
      };
    },

    /** Per-job costing: revenue (paid) vs expenses tagged to that job. */
    async jobCosting(jobId) {
      const invoices = (await this.listInvoices()).filter((i) => i.jobId === jobId);
      const payments = (await this.listPayments()).filter((p) => p.jobId === jobId);
      const expenses = (await this.listExpenses()).filter((e) => e.jobId === jobId);
      const revenue = round(payments.reduce((s, p) => s + p.amount, 0));
      const cost = round(expenses.reduce((s, e) => s + e.amount, 0));
      return { jobId: jobId, billed: round(invoices.reduce((s, i) => s + i.amount, 0)), revenue: revenue, cost: cost, profit: round(revenue - cost) };
    }
  };

  function byNewest(a, b) { return String(b.createdAt || '').localeCompare(String(a.createdAt || '')); }
  async function getOne(c, id) { const r = await data().get(c, id); return mine(r) ? r : null; }
  async function put(c, rec) {
    await data().put(c, rec.id, rec);
    try { if (data().cloudReady && data().cloudReady() && global.AAA_CLOUD) global.AAA_CLOUD.upsertEntity(c, rec.id, rec); } catch (_) {}
  }
  function midOfRange(range) {
    if (range == null) return 0;
    const nums = String(range).replace(/,/g, '').match(/\d+(?:\.\d+)?/g);
    if (!nums || !nums.length) return 0;
    return round(nums.map(Number).reduce((a, b) => a + b, 0) / nums.length);
  }

  global.AAA_ACCOUNTING = Store;
})(typeof window !== 'undefined' ? window : this);
