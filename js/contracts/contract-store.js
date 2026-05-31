/*
 * AAA Contracts — work agreements + on-device e-signature.
 *
 * A contract is generated from a job and its approved estimates: scope lines, a
 * total (the customer-facing price), and standard terms. The customer signs on
 * the device (typed full name + a drawn-signature data URL + timestamp). A
 * signed contract is immutable — its status, signature, and signedAt never
 * change afterward; corrections are new contracts (the prior one is voided).
 *
 * Signing finalizes a customer price, so the UI routes signing through the
 * Runtime Gateway (FINALIZE_PRICE): RBAC-checked, audited. Contracts live in a
 * workspace-isolated, cloud-mirrored collection.
 */
;(function (global) {
  'use strict';

  const CONTRACTS = 'contracts';

  function data() { return global.AAA_DATA; }
  function cfg() { return global.AAA_CONFIG || {}; }
  function ids() { return global.AAA_ID_FACTORY; }
  function clock() { return global.AAA_RUNTIME_CLOCK; }
  function ws() { return cfg().workspaceId || 'default'; }
  function nowISO() { return clock() && clock().nowISO ? clock().nowISO() : new Date().toISOString(); }
  function mine(r) { return r && (r.workspaceId == null || r.workspaceId === ws()); }
  function num(v) { const n = Number(v); return isFinite(n) ? n : 0; }
  function round(n) { return Math.round(n * 100) / 100; }

  const DEFAULT_TERMS = [
    'Estimate is based on conditions known at signing; significant hidden damage may change scope.',
    'A deposit may be required before materials are ordered. Balance is due on completion.',
    'Workmanship is warranted for 1 year; manufacturer warranty applies to materials.',
    'Customer is responsible for clearing the work area unless arranged otherwise.'
  ];

  const STATUSES = ['draft', 'signed', 'void'];

  /**
   * @typedef {Object} Contract
   * @property {string} id
   * @property {string|null} jobId
   * @property {string|null} customerId
   * @property {string} customerName
   * @property {Array<{description:string, amount:number}>} lines
   * @property {number} total
   * @property {string[]} terms
   * @property {'draft'|'signed'|'void'} status
   * @property {Object|null} signature  { name, dataUrl, signedAt } when signed
   */

  const Store = {
    COLLECTION: CONTRACTS,
    STATUSES: STATUSES,
    defaultTerms: function () { return DEFAULT_TERMS.slice(); },

    async list() { return (await data().list(CONTRACTS)).filter(mine).sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || ''))); },
    async get(id) { const r = await data().get(CONTRACTS, id); return mine(r) ? r : null; },
    async forJob(jobId) { return (await this.list()).filter((c) => c.jobId === jobId); },

    /** Build a DRAFT contract from a job + estimates. Does not finalize. */
    async createFromJob(job, opts) {
      if (!job) return null;
      const o = opts || {};
      const ests = Array.isArray(job.estimates) ? job.estimates : [];
      const lines = ests.map((e) => ({ description: String(e.type || 'Service'), amount: midOfRange(e.estimatedQuoteRange) }));
      const total = o.total != null ? round(num(o.total)) : round(lines.reduce((s, l) => s + l.amount, 0));
      return this.create({ jobId: job.id, customerId: job.customerId, customerName: job.customerName || 'Customer', lines: lines, total: total, terms: o.terms });
    },

    async create(input) {
      const i = input || {};
      const lines = Array.isArray(i.lines) ? i.lines.map((l) => ({ description: String(l.description || ''), amount: round(num(l.amount)) })) : [];
      const rec = {
        id: i.id || (ids() ? ids().createId('contract') : 'contract_' + Date.now()),
        jobId: i.jobId || null, customerId: i.customerId || null,
        customerName: String(i.customerName || 'Customer'),
        lines: lines,
        total: i.total != null ? round(num(i.total)) : round(lines.reduce((s, l) => s + l.amount, 0)),
        terms: Array.isArray(i.terms) && i.terms.length ? i.terms.slice() : DEFAULT_TERMS.slice(),
        status: 'draft', signature: null,
        workspaceId: ws(), createdAt: nowISO(), updatedAt: nowISO()
      };
      await put(rec); return rec;
    },

    /**
     * Capture the customer's signature and lock the contract.
     * @param {string} id
     * @param {{name:string, dataUrl?:string}} sig
     */
    async sign(id, sig) {
      const c = await this.get(id);
      if (!c) return { ok: false, error: 'NOT_FOUND' };
      if (c.status === 'signed') return { ok: false, error: 'ALREADY_SIGNED' };
      if (c.status === 'void') return { ok: false, error: 'VOID' };
      if (!sig || !String(sig.name || '').trim()) return { ok: false, error: 'NAME_REQUIRED' };
      const rec = Object.assign({}, c, {
        status: 'signed',
        signature: { name: String(sig.name).trim(), dataUrl: sig.dataUrl || null, signedAt: nowISO() },
        updatedAt: nowISO()
      });
      await put(rec);
      if (global.AAA_EVENTS) global.AAA_EVENTS.emit('contract.signed', { contractId: rec.id, jobId: rec.jobId, total: rec.total });
      return { ok: true, contract: rec };
    },

    /** Void a contract (e.g. to re-issue a corrected one). Signed stays on record. */
    async voidContract(id, reason) {
      const c = await this.get(id);
      if (!c) return { ok: false, error: 'NOT_FOUND' };
      const rec = Object.assign({}, c, { status: 'void', voidReason: reason || null, updatedAt: nowISO() });
      await put(rec); return { ok: true, contract: rec };
    },

    /** Plain-text rendering for preview / export / email body. */
    toText(c) {
      if (!c) return '';
      const biz = cfg().businessName || 'AAA Carpet';
      const lines = c.lines.map((l) => '  • ' + l.description + ' — $' + l.amount.toFixed(2)).join('\n');
      const terms = c.terms.map((t, n) => '  ' + (n + 1) + '. ' + t).join('\n');
      const sig = c.signature ? ('\nSigned by: ' + c.signature.name + ' on ' + c.signature.signedAt) : '\n[ Unsigned ]';
      return [
        biz + ' — Work Agreement',
        'Customer: ' + c.customerName,
        '',
        'Scope of work:', lines || '  (none)',
        '',
        'Total: $' + Number(c.total).toFixed(2),
        '',
        'Terms:', terms,
        sig
      ].join('\n');
    }
  };

  async function put(rec) {
    await data().put(CONTRACTS, rec.id, rec);
    try { if (data().cloudReady && data().cloudReady() && global.AAA_CLOUD) global.AAA_CLOUD.upsertEntity(CONTRACTS, rec.id, rec); } catch (_) {}
  }
  function midOfRange(range) {
    if (range == null) return 0;
    const nums = String(range).replace(/,/g, '').match(/\d+(?:\.\d+)?/g);
    if (!nums || !nums.length) return 0;
    return round(nums.map(Number).reduce((a, b) => a + b, 0) / nums.length);
  }

  global.AAA_CONTRACTS = Store;
})(typeof window !== 'undefined' ? window : this);
