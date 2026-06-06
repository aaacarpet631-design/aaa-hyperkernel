/*
 * AAA Security — the hardening authority: session validation, step-up MFA,
 * approval signatures, and a tamper-evident (hash-chained) audit log.
 *
 * Design that fits a local-first PWA:
 *   - Real cryptography via WebCrypto (SHA-256, HMAC-SHA256, HMAC-SHA1/TOTP) —
 *     no hand-rolled primitives, no runtime dependencies.
 *   - OPT-IN enforcement. Until an owner turns hardening ON (configure + enforce),
 *     every hook is a no-op and the app behaves exactly as before. This keeps the
 *     change strictly non-breaking; security is something the owner enables.
 *   - The Runtime Gateway calls two optional hooks:
 *       gateCheck(action, origin) — blocks a privileged action without a valid
 *         session + a fresh step-up (STEP_UP_REQUIRED / SESSION_INVALID).
 *       sealAudit(entry)          — chains each audit entry to its predecessor
 *         (seq + prevHash + hash) and signs privileged approvals (approvalSig),
 *         so the audit log is append-only AND tamper-evident.
 *
 * Server authority: Firestore rules remain the real server-side authority for
 * RBAC + collection access (a tampered client still can't read/write what it
 * shouldn't). This module adds a SIGNED role binding to the session so local
 * role tampering is detectable, and gates privileged actions with step-up.
 *
 * NOTE: in a single-operator local install the signing key + step-up secrets
 * live in an owner-only collection; a multi-tenant deployment should hold these
 * server-side. Documented, not hidden. Null-tolerant throughout.
 */
;(function (global) {
  'use strict';

  const CONFIG = 'security_config';
  const SESSIONS = 'security_sessions';
  const CONFIG_ID = 'config';

  // Privileged actions: money, governance, calibration, security itself.
  const DEFAULT_PRIVILEGED = ['FINALIZE_PRICE', 'APPROVE_PAYMENT', 'MODIFY_ACCOUNTING', 'REVIEW_RECEIPTS', 'EDIT_RATE_CARD', 'APPLY_CALIBRATION', 'GOVERN_REGISTRY', 'REPLAY_SANDBOX', 'MANAGE_SECURITY', 'RESOLVE_LEGAL_REVIEW'];

  function cfg() { return global.AAA_CONFIG || {}; }
  function data() { return global.AAA_DATA; }
  function ids() { return global.AAA_ID_FACTORY; }
  function clock() { return global.AAA_RUNTIME_CLOCK; }
  function gateway() { return global.AAA_RUNTIME_GATEWAY; }
  function rbac() { return global.AAA_RBAC; }
  function ws() { return cfg().workspaceId || 'default'; }
  function nowISO() { return clock() && clock().nowISO ? clock().nowISO() : new Date().toISOString(); }
  function nowMs() { return clock() && clock().now ? clock().now() : Date.now(); }
  function mine(r) { return r && (r.workspaceId == null || r.workspaceId === ws()); }
  function newId(p) { return ids() ? ids().createId(p) : p + '_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7); }
  function subtle() { return (global.crypto && global.crypto.subtle) || null; }
  function enc(s) { return new TextEncoder().encode(String(s == null ? '' : s)); }
  function hex(buf) { const b = new Uint8Array(buf); let s = ''; for (let i = 0; i < b.length; i++) s += ('0' + b[i].toString(16)).slice(-2); return s; }

  // ---- crypto primitives (WebCrypto) ----------------------------------------
  async function sha256Hex(str) {
    if (!subtle()) return fallbackHash(str);
    try { return hex(await subtle().digest('SHA-256', enc(str))); } catch (_) { return fallbackHash(str); }
  }
  async function hmacHex(keyStr, msgStr, hash) {
    if (!subtle()) return fallbackHash(String(keyStr) + '|' + String(msgStr));
    try {
      const key = await subtle().importKey('raw', enc(keyStr), { name: 'HMAC', hash: hash || 'SHA-256' }, false, ['sign']);
      return hex(await subtle().sign('HMAC', key, enc(msgStr)));
    } catch (_) { return fallbackHash(String(keyStr) + '|' + String(msgStr)); }
  }
  // Deterministic non-crypto fallback (only if WebCrypto is somehow unavailable).
  function fallbackHash(str) { let h1 = 0xdeadbeef, h2 = 0x41c6ce57; const s = String(str); for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); h1 = Math.imul(h1 ^ c, 2654435761); h2 = Math.imul(h2 ^ c, 1597334677); } h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909); h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909); return ('0000000' + (h1 >>> 0).toString(16)).slice(-8) + ('0000000' + (h2 >>> 0).toString(16)).slice(-8); }

  // RFC 4648 base32 decode → Uint8Array.
  function base32Decode(s) {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
    const clean = String(s || '').toUpperCase().replace(/=+$/, '').replace(/\s+/g, '');
    let bits = 0, value = 0; const out = [];
    for (let i = 0; i < clean.length; i++) {
      const idx = alphabet.indexOf(clean[i]); if (idx === -1) continue;
      value = (value << 5) | idx; bits += 5;
      if (bits >= 8) { out.push((value >>> (bits - 8)) & 0xff); bits -= 8; }
    }
    return new Uint8Array(out);
  }
  // RFC 6238 TOTP (HMAC-SHA1). @returns zero-padded code string.
  async function totp(secretBase32, opts) {
    const o = opts || {};
    const step = o.step || 30, digits = o.digits || 6;
    const t = Math.floor((o.time != null ? o.time : nowMs() / 1000) / step);
    if (!subtle()) return null;
    const keyBytes = base32Decode(secretBase32);
    const counter = new Uint8Array(8);
    let v = t; for (let i = 7; i >= 0; i--) { counter[i] = v & 0xff; v = Math.floor(v / 256); }
    try {
      const key = await subtle().importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']);
      const mac = new Uint8Array(await subtle().sign('HMAC', key, counter));
      const off = mac[mac.length - 1] & 0x0f;
      const bin = ((mac[off] & 0x7f) << 24) | ((mac[off + 1] & 0xff) << 16) | ((mac[off + 2] & 0xff) << 8) | (mac[off + 3] & 0xff);
      const code = (bin % Math.pow(10, digits)).toString();
      return ('0000000000' + code).slice(-digits);
    } catch (_) { return null; }
  }

  // ---- config + signing key -------------------------------------------------
  async function loadConfig() { const r = await data().get(CONFIG, CONFIG_ID); return mine(r) ? r : null; }
  async function ensureConfig() {
    let c = await loadConfig();
    if (!c) {
      c = { id: CONFIG_ID, workspaceId: ws(), enforce: false, stepUpEnabled: false, totpEnabled: false, pinHash: null, pinSalt: null, totpSecret: null, signingKey: newId('sk') + newId('sk'), privileged: DEFAULT_PRIVILEGED.slice(), stepUpTtlMs: 15 * 60000, sessionTtlMs: 12 * 3600000, createdAt: nowISO(), updatedAt: nowISO() };
      await put(CONFIG, c);
    } else if (!c.signingKey) { c.signingKey = newId('sk') + newId('sk'); await put(CONFIG, c); }
    return c;
  }

  const Security = {
    CONFIG: CONFIG, SESSIONS: SESSIONS, DEFAULT_PRIVILEGED: DEFAULT_PRIVILEGED,
    // expose primitives for tests / other modules
    _totp: totp, _sha256Hex: sha256Hex, _hmacHex: hmacHex,

    async status() {
      const c = await ensureConfig();
      const s = await this.currentSession();
      const sv = await this.validateSession();
      return {
        enforce: !!c.enforce, stepUpEnabled: !!c.stepUpEnabled, totpEnabled: !!c.totpEnabled,
        pinConfigured: !!c.pinHash, privileged: c.privileged || DEFAULT_PRIVILEGED,
        session: s ? { id: s.id, role: s.role, actor: s.actor, expiresAt: s.expiresAt } : null,
        sessionValid: sv.ok, stepUpValid: await this.stepUpValid()
      };
    },

    // ---- security admin (owner-only, audited via MANAGE_SECURITY) -----------
    /** Configure step-up factors and the privileged set. */
    async configure(opts) {
      const o = opts || {};
      return this._adminGated('configure', o, async () => {
        const c = await ensureConfig();
        const patch = { updatedAt: nowISO() };
        if (o.pin != null) { const salt = newId('salt'); patch.pinSalt = salt; patch.pinHash = await sha256Hex(salt + '|' + o.pin); patch.stepUpEnabled = true; }
        if (o.totpSecret != null) { patch.totpSecret = String(o.totpSecret); patch.totpEnabled = true; patch.stepUpEnabled = true; }
        if (Array.isArray(o.privileged)) patch.privileged = o.privileged.slice();
        if (o.stepUpTtlMs != null) patch.stepUpTtlMs = Number(o.stepUpTtlMs);
        if (o.sessionTtlMs != null) patch.sessionTtlMs = Number(o.sessionTtlMs);
        const rec = Object.assign({}, c, patch);
        await put(CONFIG, rec);
        return { stepUpEnabled: rec.stepUpEnabled, totpEnabled: rec.totpEnabled, pinConfigured: !!rec.pinHash };
      });
    },
    /** Turn enforcement on/off (owner-only, audited). Off = baseline behavior. */
    async setEnforce(on, opts) {
      const o = opts || {};
      return this._adminGated('setEnforce', o, async () => {
        const c = await ensureConfig();
        if (on && !c.stepUpEnabled) return { error: 'STEP_UP_NOT_CONFIGURED' };
        await put(CONFIG, Object.assign({}, c, { enforce: !!on, updatedAt: nowISO() }));
        return { enforce: !!on };
      });
    },

    // ---- sessions (signed role binding + expiry + device) -------------------
    async startSession(input) {
      const i = input || {};
      const c = await ensureConfig();
      const id = newId('sess');
      const issuedAt = nowISO();
      const actor = i.actor || (rbac() && rbac().label && rbac().label()) || 'owner';
      const role = i.role || (rbac() && rbac().role && rbac().role()) || 'owner';
      const deviceId = i.deviceId || cfg().deviceId || 'device';
      const expiresAt = new Date(nowMs() + (i.ttlMs || c.sessionTtlMs || 12 * 3600000)).toISOString();
      const roleSig = await hmacHex(c.signingKey, [id, actor, role, deviceId, issuedAt].join('|'));
      const rec = { id: id, workspaceId: ws(), actor: actor, role: role, deviceId: deviceId, issuedAt: issuedAt, expiresAt: expiresAt, roleSig: roleSig, stepUpAt: null, stepUpExpiresAt: null, current: true, createdAt: issuedAt };
      // mark any prior current session not-current
      const all = (await data().list(SESSIONS)).filter(mine);
      for (const p of all) if (p.current) await put(SESSIONS, Object.assign({}, p, { current: false }));
      await put(SESSIONS, rec);
      return { ok: true, session: rec };
    },
    async currentSession() { const all = (await data().list(SESSIONS)).filter(mine); return all.filter((s) => s.current).sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')))[0] || null; },
    async validateSession(opts) {
      const o = opts || {};
      const s = await this.currentSession();
      if (!s) return { ok: false, reason: 'NO_SESSION' };
      if (Date.parse(s.expiresAt || '') <= nowMs()) return { ok: false, reason: 'EXPIRED' };
      if (o.deviceId && o.deviceId !== s.deviceId) return { ok: false, reason: 'DEVICE_MISMATCH' };
      const c = await ensureConfig();
      const expect = await hmacHex(c.signingKey, [s.id, s.actor, s.role, s.deviceId, s.issuedAt].join('|'));
      if (expect !== s.roleSig) return { ok: false, reason: 'ROLE_BINDING_TAMPERED' };
      return { ok: true, session: s };
    },
    /** Detect local role tampering: live RBAC role must match the signed binding. */
    async verifyRoleBinding() {
      const v = await this.validateSession();
      if (!v.ok) return { ok: false, reason: v.reason };
      const live = rbac() && rbac().role ? rbac().role() : null;
      if (live && v.session.role && live !== v.session.role) return { ok: false, reason: 'ROLE_MISMATCH', signed: v.session.role, live: live };
      return { ok: true };
    },
    async endSession() { const s = await this.currentSession(); if (s) await put(SESSIONS, Object.assign({}, s, { current: false, endedAt: nowISO() })); return { ok: true }; },

    // ---- step-up (MFA) ------------------------------------------------------
    requiresStepUp(action, c) { const conf = c || {}; const set = conf.privileged || DEFAULT_PRIVILEGED; return !!conf.stepUpEnabled && set.indexOf(action) !== -1; },
    /** Verify a PIN and/or TOTP code; on success records a fresh grant on the session. */
    async verifyStepUp(input) {
      const i = input || {};
      const c = await ensureConfig();
      if (!c.stepUpEnabled) return { ok: false, error: 'STEP_UP_NOT_CONFIGURED' };
      let okPin = c.pinHash == null, okTotp = !c.totpEnabled;
      if (c.pinHash != null && i.pin != null) okPin = (await sha256Hex(c.pinSalt + '|' + i.pin)) === c.pinHash;
      if (c.totpEnabled && i.totp != null) { const code = await totp(c.totpSecret, { time: i.time }); okTotp = code != null && String(i.totp) === code; }
      // Require at least one provided factor to match; both must pass if both required.
      const provided = (i.pin != null) || (i.totp != null);
      if (!provided) return { ok: false, error: 'NO_FACTOR' };
      if (!okPin || !okTotp) return { ok: false, error: 'BAD_FACTOR' };
      const s = await this.currentSession();
      if (!s) return { ok: false, error: 'NO_SESSION' };
      const at = nowISO();
      const rec = Object.assign({}, s, { stepUpAt: at, stepUpExpiresAt: new Date(nowMs() + (c.stepUpTtlMs || 15 * 60000)).toISOString() });
      await put(SESSIONS, rec);
      return { ok: true, stepUpExpiresAt: rec.stepUpExpiresAt };
    },
    async stepUpValid() { const s = await this.currentSession(); return !!(s && s.stepUpExpiresAt && Date.parse(s.stepUpExpiresAt) > nowMs()); },

    // ---- gateway hook: gate a privileged action -----------------------------
    /** Called by the gateway before a human mutation. Allows unless hardening is
     *  ON and the action is privileged without a valid session + fresh step-up. */
    async gateCheck(action, origin) {
      let c; try { c = await loadConfig(); } catch (_) { return { allow: true }; }
      if (!c || !c.enforce) return { allow: true };          // opt-in: off = baseline
      if (origin === 'ai') return { allow: true };           // AI block is the gateway's own job
      const sv = await this.validateSession();
      if (!sv.ok) return { allow: false, error: 'SESSION_INVALID', reason: sv.reason };
      if (this.requiresStepUp(action, c) && !(await this.stepUpValid())) return { allow: false, error: 'STEP_UP_REQUIRED' };
      return { allow: true };
    },

    // ---- gateway hook: seal an audit entry into the chain -------------------
    /** Chains an audit entry to its predecessor and signs privileged approvals.
     *  Returns the sealed entry (the gateway persists it). Never throws. */
    async sealAudit(entry) {
      try {
        const c = await ensureConfig();
        const prev = await this._lastSealed();
        const seq = (prev ? prev.seq : 0) + 1;
        const prevHash = prev ? prev.hash : null;
        const sealed = Object.assign({}, entry, { seq: seq, prevHash: prevHash });
        sealed.hash = await sha256Hex(canonicalAudit(sealed));
        if (entry.decision === 'allowed' && (c.privileged || DEFAULT_PRIVILEGED).indexOf(entry.action) !== -1) {
          sealed.approvalSig = await hmacHex(c.signingKey, sealed.hash);
        }
        return sealed;
      } catch (_) { return entry; }
    },

    /** Recompute the whole audit chain and report any break (tamper detection). */
    async verifyAuditChain() {
      const c = await ensureConfig();
      const all = (await data().list('audit_log')).filter((e) => e && (e.workspaceId == null || e.workspaceId === ws()) && e.seq != null).sort((a, b) => a.seq - b.seq);
      const breaks = [];
      let prevHash = null;
      for (let i = 0; i < all.length; i++) {
        const e = all[i];
        if (i > 0 && e.seq !== all[i - 1].seq + 1) breaks.push({ seq: e.seq, id: e.id, reason: 'seq_gap' });
        if ((e.prevHash || null) !== (prevHash || null)) breaks.push({ seq: e.seq, id: e.id, reason: 'chain_break' });
        const expect = await sha256Hex(canonicalAudit(e));
        if (expect !== e.hash) breaks.push({ seq: e.seq, id: e.id, reason: 'hash_mismatch', expected: expect, stored: e.hash });
        if (e.approvalSig) { const sig = await hmacHex(c.signingKey, e.hash); if (sig !== e.approvalSig) breaks.push({ seq: e.seq, id: e.id, reason: 'approval_sig_invalid' }); }
        prevHash = e.hash;
      }
      return { ok: breaks.length === 0, length: all.length, breaks: breaks };
    },

    /** Recent signed privileged approvals (for the Security Center). */
    async approvals(limit) {
      const all = (await data().list('audit_log')).filter((e) => mine(e) && e.approvalSig).sort((a, b) => (b.seq || 0) - (a.seq || 0));
      return all.slice(0, limit || 25);
    },

    // ---- internals ----------------------------------------------------------
    async _lastSealed() {
      const all = (await data().list('audit_log')).filter((e) => e && (e.workspaceId == null || e.workspaceId === ws()) && e.seq != null);
      return all.sort((a, b) => (b.seq || 0) - (a.seq || 0))[0] || null;
    },
    async _adminGated(op, o, mutate) {
      const gw = gateway();
      if (!gw) return { ok: false, error: 'NO_GATEWAY' };
      const res = await gw.run({ action: 'MANAGE_SECURITY', origin: o.origin === 'ai' ? 'ai' : 'human', actor: o.actor || null, target: { type: 'security', id: op }, detail: { op: op } });
      if (!res.ok) return res;
      const out = await mutate();
      if (out && out.error) return { ok: false, error: out.error };
      return Object.assign({ ok: true, auditId: res.auditId }, out);
    }
  };

  // Canonical audit serialization for hashing (stable, excludes hash/sig fields).
  function canonicalAudit(e) {
    return JSON.stringify([e.seq, e.at, e.action, e.origin, e.actor || null, e.role || null, e.decision, e.reason || null, e.target || null, e.detail || null, e.prevHash || null]);
  }
  async function put(c, rec) {
    await data().put(c, rec.id, rec);
    try { if (data().cloudReady && data().cloudReady() && global.AAA_CLOUD) global.AAA_CLOUD.upsertEntity(c, rec.id, rec); } catch (_) {}
  }

  global.AAA_SECURITY = Security;
})(typeof window !== 'undefined' ? window : this);
