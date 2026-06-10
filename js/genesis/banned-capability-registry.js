/*
 * AAA Banned Capability Registry — the deny-list the Genesis Council consults
 * before it ever splices a genome.
 *
 * A capability DNA signature can be in one of three states here:
 *   banned       never spawn again (a human or the failure detector judged it
 *                unsafe/wasteful); spawning is REFUSED at the council door
 *   quarantined  spawn only with explicit human approval (held, fail-closed)
 *   (absent)     normal
 *
 * Bans are reversible only by an authorized human with a written reason
 * (lift()), and every transition is audited — a ban is governance state, not a
 * silent kill switch. autoEnforce() reads the failure detector's
 * recommendations and applies bans/quarantines, so the immune response can run
 * without a human in the loop for the dangerous cases — while still being fully
 * recorded and reversible. Fail-closed: an unknown RBAC denies lift().
 */
;(function (global) {
  'use strict';

  const BANNED = 'banned_capabilities';

  function cfg() { return global.AAA_CONFIG || {}; }
  function data() { return global.AAA_DATA; }
  function clock() { return global.AAA_RUNTIME_CLOCK; }
  function rbac() { return global.AAA_RBAC; }
  function audit() { return global.AAA_AUDIT_LEDGER; }
  function detector() { return global.AAA_FAILURE_DETECTOR; }
  function ws() { return cfg().workspaceId || 'default'; }
  function nowISO() { return clock() && clock().nowISO ? clock().nowISO() : new Date().toISOString(); }
  function mine(r) { return r && (r.workspaceId == null || r.workspaceId === ws()); }
  function canManage() { const r = rbac(); return r && r.can ? !!r.can('MANAGE_GOVERNANCE') : true; }
  async function log(type, payload) { try { if (audit() && audit().append) await audit().append(type, payload); } catch (_) {} }

  async function put(signature, state, reason, source) {
    const id = 'bancap_' + String(signature).replace(/[^a-z0-9]+/gi, '_');
    const rec = { id: id, workspaceId: ws(), signature: signature, state: state, reason: reason || null, source: source || 'system', updatedAt: nowISO() };
    await data().put(BANNED, id, rec);
    await log('genesis.capability_' + state, { signature: signature, reason: reason || null, source: source || 'system' });
    return rec;
  }

  const Registry = {
    BANNED: BANNED,

    /** Current record for a signature, or null. */
    async status(signature) {
      const r = await data().get(BANNED, 'bancap_' + String(signature).replace(/[^a-z0-9]+/gi, '_'));
      return mine(r) && r.state !== 'lifted' ? r : null;
    },
    async isBanned(signature) { const s = await this.status(signature); return !!(s && s.state === 'banned'); },
    async isQuarantined(signature) { const s = await this.status(signature); return !!(s && s.state === 'quarantined'); },

    /** Ban a capability (a human, or the immune system via autoEnforce). */
    async ban(signature, opts) {
      const o = opts || {};
      if (o.bySystem !== true && !canManage()) return { ok: false, error: 'FORBIDDEN' };
      return { ok: true, record: await put(signature, 'banned', o.reason || 'unspecified', o.bySystem ? 'failure_detector' : 'human') };
    },

    /** Quarantine (spawns require human approval). */
    async quarantine(signature, opts) {
      const o = opts || {};
      if (o.bySystem !== true && !canManage()) return { ok: false, error: 'FORBIDDEN' };
      return { ok: true, record: await put(signature, 'quarantined', o.reason || 'unspecified', o.bySystem ? 'failure_detector' : 'human') };
    },

    /** Lift a ban/quarantine — human, authority, written reason (≥ 20 chars). */
    async lift(signature, opts) {
      const o = opts || {};
      if (!canManage()) return { ok: false, error: 'FORBIDDEN' };
      const reason = String(o.reason == null ? '' : o.reason).trim();
      if (reason.length < 20) return { ok: false, error: 'JUSTIFICATION_REQUIRED', minChars: 20 };
      const cur = await this.status(signature);
      if (!cur) return { ok: false, error: 'NOT_LISTED' };
      const rec = { id: cur.id, workspaceId: ws(), signature: signature, state: 'lifted', reason: reason, source: 'human', updatedAt: nowISO() };
      await data().put(BANNED, cur.id, rec);
      await log('genesis.capability_lifted', { signature: signature, reason: reason });
      return { ok: true, record: rec };
    },

    /**
     * Apply the failure detector's recommendations automatically (immune
     * response). 'ban' → ban; 'quarantine' → quarantine. Records each, returns
     * what changed. Reversible and audited — never silent.
     */
    async autoEnforce() {
      if (!detector()) return { ok: false, error: 'NO_DETECTOR' };
      const recs = await detector().scanAll();
      const applied = [];
      for (const r of recs) {
        const cur = await this.status(r.signature);
        if (cur && (cur.state === 'banned' || cur.state === 'quarantined')) continue;
        if (r.recommendation === 'ban') { await this.ban(r.signature, { bySystem: true, reason: 'auto: ' + r.patterns.map((p) => p.kind).join(', ') }); applied.push({ signature: r.signature, state: 'banned' }); }
        else if (r.recommendation === 'quarantine') { await this.quarantine(r.signature, { bySystem: true, reason: 'auto: ' + r.patterns.map((p) => p.kind).join(', ') }); applied.push({ signature: r.signature, state: 'quarantined' }); }
      }
      return { ok: true, applied: applied };
    },

    async list() {
      const all = (await data().list(BANNED)).filter(mine).filter((r) => r.state !== 'lifted');
      return all.sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
    }
  };

  global.AAA_BANNED_CAPABILITIES = Registry;
})(typeof window !== 'undefined' ? window : this);
