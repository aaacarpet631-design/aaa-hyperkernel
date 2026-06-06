/*
 * AAA Privacy & Data Governance — own the customer's data, prove you govern it.
 *
 * Local-first, zero-infra privacy controls:
 *   - PII classification: which fields carry personal data (name/phone/email/
 *     address/free-text), and an inventory scan across collections.
 *   - Encrypted privacy vault: AES-256-GCM at rest (WebCrypto), so sensitive PII
 *     can be sealed and opened without a server. Key is owner-only.
 *   - Retention policies: per-category windows + an "expired" report.
 *   - Data export (portability / DSAR): a structured bundle of everything tied to
 *     a customer — read-only.
 *   - Erasure workflow (right to be forgotten): request → owner approval →
 *     execute (redact PII in place + drop vault entries), human-only + audited.
 *
 * Governance preserved: privacy admin + erasure route through the gateway
 * (MANAGE_PRIVACY / ERASE_DATA, owner-only + audited); AI can never reconfigure
 * privacy or erase data. Null-tolerant; deterministic.
 */
;(function (global) {
  'use strict';

  const CONFIG = 'privacy_config';
  const VAULT = 'privacy_vault';
  const REQUESTS = 'deletion_requests';
  const CONFIG_ID = 'config';
  const REDACTED = '[erased]';

  // Default PII field map per collection (owner can extend via config).
  const DEFAULT_PII = {
    customers: ['name', 'phone', 'email', 'address', 'notes'],
    jobs: ['customerName', 'customerPhone', 'customerEmail', 'address'],
    quotes: ['customerName'],
    communications: ['to', 'body'],
    comm_inbound: ['from', 'body'],
    comm_threads: ['peer']
  };
  // Default retention windows (days) by category. 0 / absent = keep indefinitely.
  const DEFAULT_RETENTION = { communications: 365, comm_inbound: 365, event_log: 730, quotes: 1095, comm_threads: 365 };

  function cfg() { return global.AAA_CONFIG || {}; }
  function data() { return global.AAA_DATA; }
  function ids() { return global.AAA_ID_FACTORY; }
  function clock() { return global.AAA_RUNTIME_CLOCK; }
  function gateway() { return global.AAA_RUNTIME_GATEWAY; }
  function ws() { return cfg().workspaceId || 'default'; }
  function nowISO() { return clock() && clock().nowISO ? clock().nowISO() : new Date().toISOString(); }
  function nowMs() { return clock() && clock().now ? clock().now() : Date.now(); }
  function mine(r) { return r && (r.workspaceId == null || r.workspaceId === ws()); }
  function newId(p) { return ids() ? ids().createId(p) : p + '_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7); }
  function subtle() { return (global.crypto && global.crypto.subtle) || null; }
  function rand(n) { const a = new Uint8Array(n); if (global.crypto && global.crypto.getRandomValues) global.crypto.getRandomValues(a); else for (let i = 0; i < n; i++) a[i] = Math.floor(Math.random() * 256); return a; }
  function hex(buf) { const b = new Uint8Array(buf); let s = ''; for (let i = 0; i < b.length; i++) s += ('0' + b[i].toString(16)).slice(-2); return s; }
  function unhex(s) { const a = new Uint8Array(String(s).length / 2); for (let i = 0; i < a.length; i++) a[i] = parseInt(s.substr(i * 2, 2), 16); return a; }

  async function loadConfig() { const r = await data().get(CONFIG, CONFIG_ID); return mine(r) ? r : null; }
  async function ensureConfig() {
    let c = await loadConfig();
    if (!c) {
      c = { id: CONFIG_ID, workspaceId: ws(), vaultKeyHex: null, pii: {}, retention: Object.assign({}, DEFAULT_RETENTION), createdAt: nowISO(), updatedAt: nowISO() };
      await put(CONFIG, c);
    }
    return c;
  }
  async function ensureKey() {
    const c = await ensureConfig();
    if (c.vaultKeyHex) return unhex(c.vaultKeyHex);
    let keyHex;
    if (subtle()) { const k = await subtle().generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']); keyHex = hex(await subtle().exportKey('raw', k)); }
    else keyHex = hex(rand(32));
    await put(CONFIG, Object.assign({}, c, { vaultKeyHex: keyHex, updatedAt: nowISO() }));
    return unhex(keyHex);
  }

  function piiMap(c) { return Object.assign({}, DEFAULT_PII, (c && c.pii) || {}); }

  const Privacy = {
    CONFIG: CONFIG, VAULT: VAULT, REQUESTS: REQUESTS, REDACTED: REDACTED, DEFAULT_PII: DEFAULT_PII,

    // ---- PII classification + inventory -------------------------------------
    /** Which configured PII fields are present (non-empty) on a record. */
    classify(collection, record, c) {
      const fields = piiMap(c)[collection] || [];
      const present = fields.filter((f) => record && record[f] != null && record[f] !== '' && record[f] !== REDACTED);
      return { collection: collection, piiFields: present, hasPII: present.length > 0 };
    },
    /** Inventory of PII across the known collections. */
    async scan() {
      const c = await ensureConfig();
      const map = piiMap(c);
      const out = [];
      for (const coll of Object.keys(map)) {
        let rows = []; try { rows = (await data().list(coll)).filter(mine); } catch (_) { rows = []; }
        let withPII = 0; const fieldHits = {};
        rows.forEach((r) => { const k = this.classify(coll, r, c); if (k.hasPII) { withPII++; k.piiFields.forEach((f) => { fieldHits[f] = (fieldHits[f] || 0) + 1; }); } });
        out.push({ collection: coll, records: rows.length, withPII: withPII, fields: map[coll], fieldCounts: fieldHits });
      }
      return { ok: true, collections: out, totalPII: out.reduce((n, x) => n + x.withPII, 0) };
    },

    // ---- encrypted vault (AES-256-GCM) --------------------------------------
    /** Seal plaintext → { iv, ct, encrypted }. Owner-only key, local-first. */
    async seal(plaintext) {
      const key = await ensureKey();
      const ivb = rand(12);
      if (!subtle()) { return { iv: hex(ivb), ct: hex(new TextEncoder().encode(String(plaintext))), encrypted: false }; }
      const ck = await subtle().importKey('raw', key, { name: 'AES-GCM' }, false, ['encrypt']);
      const ct = await subtle().encrypt({ name: 'AES-GCM', iv: ivb }, ck, new TextEncoder().encode(String(plaintext)));
      return { iv: hex(ivb), ct: hex(ct), encrypted: true };
    },
    async open(sealed) {
      if (!sealed) return null;
      const key = await ensureKey();
      if (!sealed.encrypted) return new TextDecoder().decode(unhex(sealed.ct));
      const ck = await subtle().importKey('raw', key, { name: 'AES-GCM' }, false, ['decrypt']);
      const pt = await subtle().decrypt({ name: 'AES-GCM', iv: unhex(sealed.iv) }, ck, unhex(sealed.ct));
      return new TextDecoder().decode(pt);
    },
    /** Seal an object into the vault, linked to a subject. Returns the vault id. */
    async vaultPut(refType, refId, obj) {
      const sealed = await this.seal(JSON.stringify(obj == null ? null : obj));
      const id = newId('vlt');
      const rec = { id: id, workspaceId: ws(), refType: refType || null, refId: refId || null, iv: sealed.iv, ct: sealed.ct, encrypted: sealed.encrypted, createdAt: nowISO() };
      await put(VAULT, rec);
      return { ok: true, id: id, encrypted: sealed.encrypted };
    },
    async vaultGet(id) {
      const r = await data().get(VAULT, id); if (!mine(r)) return null;
      const txt = await this.open(r); try { return JSON.parse(txt); } catch (_) { return txt; }
    },
    async vaultList(refType, refId) { return (await data().list(VAULT)).filter((r) => mine(r) && (!refType || r.refType === refType) && (!refId || r.refId === refId)); },

    // ---- retention ----------------------------------------------------------
    async retention() { return piiRetention(await ensureConfig()); },
    async setRetention(category, days, opts) {
      return this._adminGated('setRetention', opts || {}, async () => {
        const c = await ensureConfig();
        const ret = Object.assign({}, c.retention || DEFAULT_RETENTION); ret[category] = Number(days);
        await put(CONFIG, Object.assign({}, c, { retention: ret, updatedAt: nowISO() }));
        return { category: category, days: Number(days) };
      });
    },
    /** Per-category retention status: total records + how many are past the window. */
    async retentionStatus(now) {
      const c = await ensureConfig();
      const ret = piiRetention(c);
      const ms = now != null ? now : nowMs();
      const out = [];
      for (const cat of Object.keys(ret)) {
        const days = Number(ret[cat]) || 0;
        let rows = []; try { rows = (await data().list(cat)).filter(mine); } catch (_) { rows = []; }
        let expired = 0;
        if (days > 0) rows.forEach((r) => { const t = Date.parse(r.createdAt || r.at || ''); if (isFinite(t) && (ms - t) > days * 86400000) expired++; });
        out.push({ category: cat, retentionDays: days, records: rows.length, expired: expired });
      }
      return { ok: true, categories: out, totalExpired: out.reduce((n, x) => n + x.expired, 0) };
    },
    async expiredRecords(category, now) {
      const c = await ensureConfig(); const days = Number(piiRetention(c)[category]) || 0; if (!days) return [];
      const ms = now != null ? now : nowMs();
      return (await data().list(category)).filter((r) => { if (!mine(r)) return false; const t = Date.parse(r.createdAt || r.at || ''); return isFinite(t) && (ms - t) > days * 86400000; });
    },

    // ---- data export (portability / DSAR) -----------------------------------
    /** Everything tied to a customer (read-only bundle). */
    async exportCustomer(customerId) {
      if (!customerId) return { ok: false, error: 'NO_CUSTOMER' };
      const customer = await safeGet('customers', customerId);
      const phone = customer && customer.phone, email = customer && customer.email;
      const byCustomer = (r) => r && (r.customerId === customerId);
      const byContact = (r) => r && ((phone && (r.to === phone || r.from === phone || r.peer === phone)) || (email && (r.to === email || r.from === email || r.peer === email)));
      const bundle = {
        ok: true, exportedAt: nowISO(), subjectType: 'customer', subjectId: customerId,
        customer: customer || null,
        jobs: (await safeList('jobs')).filter(byCustomer),
        quotes: (await safeList('quotes')).filter(byCustomer),
        communications: (await safeList('communications')).filter((r) => byCustomer(r) || byContact(r)),
        inbound: (await safeList('comm_inbound')).filter((r) => byCustomer(r) || byContact(r)),
        threads: (await safeList('comm_threads')).filter((r) => byCustomer(r) || byContact(r)),
        vault: (await this.vaultList('customer', customerId))
      };
      bundle.recordCount = bundle.jobs.length + bundle.quotes.length + bundle.communications.length + bundle.inbound.length + bundle.threads.length + (customer ? 1 : 0);
      return bundle;
    },

    // ---- erasure workflow (right to be forgotten) ---------------------------
    /** File an erasure request (audited). Does NOT erase — a person approves. */
    async requestErasure(input) {
      const i = input || {};
      if (!i.subjectId) return { ok: false, error: 'NO_SUBJECT' };
      return this._gated('MANAGE_PRIVACY', 'request_erasure', i, async (auditId) => {
        const id = newId('erase');
        const rec = { id: id, workspaceId: ws(), subjectType: i.subjectType || 'customer', subjectId: i.subjectId, reason: i.reason || null, status: 'pending', requestedBy: i.actor || null, requestedAt: nowISO(), auditRef: auditId, manifest: null, executedBy: null, executedAt: null };
        await put(REQUESTS, rec); return rec;
      });
    },
    async listRequests(status) { const all = (await data().list(REQUESTS)).filter(mine); return (status ? all.filter((r) => r.status === status) : all).sort((a, b) => String(b.requestedAt || '').localeCompare(String(a.requestedAt || ''))); },
    async getRequest(id) { const r = await data().get(REQUESTS, id); return mine(r) ? r : null; },

    /** Approve + EXECUTE an erasure: redact PII in place + drop vault entries.
     *  Human-only + audited (ERASE_DATA). Irreversible by design; manifest records
     *  exactly what was redacted. */
    async approveErasure(requestId, opts) {
      const o = opts || {};
      const req = await this.getRequest(requestId); if (!req) return { ok: false, error: 'NOT_FOUND' };
      if (req.status === 'executed') return { ok: true, already: true, request: req };
      return this._gated('ERASE_DATA', 'execute_erasure', o, async (auditId) => {
        const manifest = await this._erase(req.subjectType, req.subjectId);
        const rec = Object.assign({}, req, { status: 'executed', executedBy: o.actor || null, executedAt: nowISO(), manifest: manifest, executeAuditRef: auditId });
        await put(REQUESTS, rec);
        return rec;
      });
    },

    // ---- internals ----------------------------------------------------------
    async _erase(subjectType, subjectId) {
      const c = await ensureConfig(); const map = piiMap(c);
      const manifest = [];
      const customer = subjectType === 'customer' ? await safeGet('customers', subjectId) : null;
      const phone = customer && customer.phone, email = customer && customer.email;
      const targets = { customers: (r) => r.id === subjectId, jobs: (r) => r.customerId === subjectId, quotes: (r) => r.customerId === subjectId,
        communications: (r) => r.customerId === subjectId || (phone && r.to === phone) || (email && r.to === email),
        comm_inbound: (r) => r.customerId === subjectId || (phone && r.from === phone) || (email && r.from === email),
        comm_threads: (r) => r.customerId === subjectId || (phone && r.peer === phone) || (email && r.peer === email) };
      for (const coll of Object.keys(targets)) {
        const fields = map[coll] || []; if (!fields.length) continue;
        let rows = []; try { rows = (await data().list(coll)).filter(mine); } catch (_) { rows = []; }
        for (const r of rows.filter(targets[coll])) {
          const redactedFields = [];
          const patch = {};
          fields.forEach((f) => { if (r[f] != null && r[f] !== '' && r[f] !== REDACTED) { patch[f] = REDACTED; redactedFields.push(f); } });
          if (redactedFields.length) { await put(coll, Object.assign({}, r, patch, { piiErased: true, erasedAt: nowISO() })); manifest.push({ collection: coll, id: r.id, fields: redactedFields }); }
        }
      }
      // drop vault entries for the subject
      const vault = await this.vaultList(subjectType, subjectId);
      for (const v of vault) { try { await data().put(VAULT, v.id, { id: v.id, workspaceId: ws(), refType: v.refType, refId: v.refId, iv: null, ct: null, encrypted: false, erased: true, erasedAt: nowISO() }); manifest.push({ collection: VAULT, id: v.id, fields: ['ct'] }); } catch (_) {} }
      return manifest;
    },
    async _adminGated(op, o, mutate) { return this._gated('MANAGE_PRIVACY', op, o, mutate); },
    async _gated(action, op, o, mutate) {
      const gw = gateway(); if (!gw) return { ok: false, error: 'NO_GATEWAY' };
      const res = await gw.run({ action: action, origin: o.origin === 'ai' ? 'ai' : 'human', actor: o.actor || null, target: { type: 'privacy', id: op }, detail: { op: op } });
      if (!res.ok) return res;
      const out = await mutate(res.auditId);
      if (out && out.error) return { ok: false, error: out.error };
      return Object.assign({ ok: true, auditId: res.auditId }, out && out.id ? { request: out } : out);
    }
  };

  function piiRetention(c) { return Object.assign({}, DEFAULT_RETENTION, (c && c.retention) || {}); }
  async function safeGet(c, id) { try { const r = await data().get(c, id); return mine(r) ? r : null; } catch (_) { return null; } }
  async function safeList(c) { try { return (await data().list(c)).filter(mine); } catch (_) { return []; } }
  async function put(c, rec) {
    await data().put(c, rec.id, rec);
    try { if (data().cloudReady && data().cloudReady() && global.AAA_CLOUD) global.AAA_CLOUD.upsertEntity(c, rec.id, rec); } catch (_) {}
  }

  global.AAA_PRIVACY = Privacy;
})(typeof window !== 'undefined' ? window : this);
