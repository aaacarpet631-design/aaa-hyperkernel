/*
 * AAA QuickBooks Export — turn the books into importable CSV.
 *
 * QuickBooks Online imports invoices, expenses, and bank transactions from CSV.
 * This module reads the real records from AAA_ACCOUNTING and emits clean,
 * properly-escaped CSV with the column headers QuickBooks expects. It does NOT
 * mutate anything — pure read + format — so it carries no gateway action; the
 * data it exposes is owner-only at the source (financial collections).
 *
 * Browsers: callers can hand the returned {filename, csv} to a Blob download.
 */
;(function (global) {
  'use strict';

  function acct() { return global.AAA_ACCOUNTING; }
  function cfg() { return global.AAA_CONFIG || {}; }

  // RFC-4180 CSV: quote fields containing comma/quote/newline; double inner quotes.
  function cell(v) {
    const s = v == null ? '' : String(v);
    return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }
  function toCsv(headers, rows) {
    const out = [headers.map(cell).join(',')];
    rows.forEach((r) => out.push(r.map(cell).join(',')));
    return out.join('\r\n');
  }
  function dateOnly(iso) { return iso ? String(iso).slice(0, 10) : ''; }

  const Exporter = {
    /** Invoices CSV — QuickBooks Online invoice import columns. */
    async invoicesCsv() {
      const invoices = await acct().listInvoices();
      const headers = ['InvoiceNo', 'Customer', 'InvoiceDate', 'DueDate', 'Item(Product/Service)', 'ItemAmount', 'Status'];
      const rows = [];
      invoices.forEach((inv) => {
        const items = (inv.items && inv.items.length) ? inv.items : [{ description: 'Services', amount: inv.amount }];
        items.forEach((it) => {
          rows.push([inv.id, inv.customerName, dateOnly(inv.issuedAt), dateOnly(inv.issuedAt), it.description || 'Services', Number(it.amount || 0).toFixed(2), inv.status]);
        });
      });
      return { filename: file('invoices'), csv: toCsv(headers, rows), count: invoices.length };
    },

    /** Expenses CSV — QuickBooks expense/bill import columns. */
    async expensesCsv() {
      const expenses = await acct().listExpenses();
      const headers = ['Date', 'Category', 'Description', 'Amount', 'JobRef'];
      const rows = expenses.map((e) => [dateOnly(e.incurredAt), e.category, e.description, Number(e.amount || 0).toFixed(2), e.jobId || '']);
      return { filename: file('expenses'), csv: toCsv(headers, rows), count: expenses.length };
    },

    /** Payments CSV — bank deposit / received-payment rows. */
    async paymentsCsv() {
      const payments = await acct().listPayments();
      const headers = ['Date', 'InvoiceRef', 'Method', 'Amount', 'JobRef'];
      const rows = payments.map((p) => [dateOnly(p.receivedAt), p.invoiceId || '', p.method, Number(p.amount || 0).toFixed(2), p.jobId || '']);
      return { filename: file('payments'), csv: toCsv(headers, rows), count: payments.length };
    },

    /** All three at once. */
    async exportAll() {
      return { invoices: await this.invoicesCsv(), expenses: await this.expensesCsv(), payments: await this.paymentsCsv() };
    },

    /** Trigger a browser download for a {filename, csv} bundle. */
    download(bundle) {
      if (!bundle || typeof document === 'undefined') return false;
      const blob = new Blob([bundle.csv], { type: 'text/csv;charset=utf-8;' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = bundle.filename;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      return true;
    }
  };

  function file(kind) {
    const slug = String(cfg().businessName || 'aaa').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'aaa';
    const d = new Date().toISOString().slice(0, 10);
    return slug + '-' + kind + '-' + d + '.csv';
  }

  global.AAA_QUICKBOOKS_EXPORT = Exporter;
})(typeof window !== 'undefined' ? window : this);
