/*
 * AAA Promotion Engine — decides whether a temp earns a permanent desk.
 *
 * An ephemeral agent may become permanent ONLY if all five rules hold:
 *   1. spawned at least MIN_SPAWNS (5) times
 *   2. succeeded at least MIN_SUCCESS (80%) of the time
 *   3. produced only low-risk decisions
 *   4. saved measurable time or money (savedMs/savedUsd > 0 across runs)
 *   5. governance approves the promotion (a human, with a written reason)
 *
 * Rules 1–4 are computed from real genesis_runs — never asserted. Rule 5 is
 * fail-closed: evaluate() can only ever say "eligible"; promotion happens
 * exclusively through propose() → approve(reason ≥ 20 chars, RBAC-gated),
 * mirroring the Governance Engine's override discipline. An approved
 * promotion registers the agent's signature in the Capability Registry, so
 * the next matching event is handled by the (now permanent) agent instead of
 * firing the Gap Detector.
 */
;(function (global) {
  'use strict';

  const PROPOSALS = 'promotion_proposals';
  const MIN_SPAWNS = 5;
  const MIN_SUCCESS = 0.8;
  const MIN_REASON = 20;

  function cfg() { return global.AAA_CONFIG || {}; }
  function data() { return global.AAA_DATA; }
  function ids() { return global.AAA_ID_FACTORY; }
  function clock() { return global.AAA_RUNTIME_CLOCK; }
  function rbac() { return global.AAA_RBAC; }
  function ledger() { return global.AAA_AUDIT_LEDGER; }
  function runtime() { return global.AAA_EPHEMERAL_RUNTIME; }
  function registry() { return global.AAA_CAPABILITY_REGISTRY; }
  function ws() { return cfg().workspaceId || 'default'; }
  function nowISO() { return clock() && clock().nowISO ? clock().nowISO() : new Date().toISOString(); }
  function canApprove() { const r = rbac(); return r && r.can ? !!r.can('MANAGE_GOVERNANCE') : true; }

  const Engine = {
    PROPOSALS: PROPOSALS, MIN_SPAWNS: MIN_SPAWNS, MIN_SUCCESS: MIN_SUCCESS,

    /** Real, computed track record for one agent name. */
    async stats(name) {
      const runs = await runtime().runs({ name: name });
      const spawns = runs.length;
      const succeeded = runs.filter((r) => r.status === 'succeeded').length;
      const savedMs = runs.reduce((a, r) => a + (Number(r.savedMs) || 0), 0);
      const savedUsd = runs.reduce((a, r) => a + (Number(r.savedUsd) || 0), 0);
      const allLowRisk = spawns > 0 && runs.every((r) => r.riskLevel === 'low');
      return { name: name, spawns: spawns, succeeded: succeeded, successRate: spawns ? succeeded / spawns : 0, savedMs: savedMs, savedUsd: savedUsd, allLowRisk: allLowRisk };
    },

    /**
     * Eligibility → { eligible, stats, failed:[] }. When the Capability Economy
     * scorer is loaded it is the authority (six rules over the immutable
     * ledger); otherwise this falls back to the built-in four-rule stats so the
     * foundry still works standalone.
     */
    async evaluate(name) {
      const scorer = global.AAA_PROMOTION_SCORER;
      const ledg = global.AAA_CAPABILITY_LEDGER;
      if (scorer && ledg) {
        const entry = (await ledg.entries({ name: name }))[0];
        if (entry) {
          const sc = await scorer.score(entry.signature);
          return { eligible: sc.eligible, stats: sc.reputation, failed: sc.failed, signature: entry.signature, checks: sc.checks, scored: true };
        }
      }
      const s = await this.stats(name);
      const failed = [];
      if (s.spawns < MIN_SPAWNS) failed.push('spawned ' + s.spawns + '/' + MIN_SPAWNS + ' times');
      if (s.successRate < MIN_SUCCESS) failed.push('success rate ' + Math.round(s.successRate * 100) + '% < ' + MIN_SUCCESS * 100 + '%');
      if (!s.allLowRisk) failed.push('not all decisions were low-risk');
      if (!(s.savedMs > 0 || s.savedUsd > 0)) failed.push('no measurable time/money saved');
      return { eligible: failed.length === 0, stats: s, failed: failed };
    },

    /**
     * Open a promotion proposal (only when eligible — no vanity proposals).
     * Emits CAPABILITY_PROMOTION_PROPOSED so promotion is never silent, and
     * refuses a banned capability outright.
     */
    async propose(name, need) {
      const sig = (global.AAA_CAPABILITY_LEDGER && need) ? global.AAA_CAPABILITY_LEDGER.signatureOf(need.action, need.entity, need.context) : null;
      if (sig && global.AAA_BANNED_CAPABILITIES && await global.AAA_BANNED_CAPABILITIES.isBanned(sig)) return { ok: false, error: 'CAPABILITY_BANNED', signature: sig };
      const ev = await this.evaluate(name);
      if (!ev.eligible) return { ok: false, error: 'NOT_ELIGIBLE', failed: ev.failed };
      const id = ids() ? ids().createId('promo') : 'promo_' + Date.now();
      const rec = {
        id: id, workspaceId: ws(), name: name, signature: sig || ev.signature || null, status: 'pending_governance',
        need: need || null, stats: ev.stats, checks: ev.checks || null, proposedAt: nowISO(), decidedAt: null, reason: null
      };
      await data().put(PROPOSALS, id, rec);
      try { if (global.AAA_EVENT_BUS) await global.AAA_EVENT_BUS.publish('capability.promotion_proposed', { name: name, signature: rec.signature, proposalId: id }, { source: 'genesis' }); } catch (_) {}
      try { if (ledger() && ledger().append) await ledger().append('genesis.promotion_proposed', { proposalId: id, name: name, signature: rec.signature }); } catch (_) {}
      return { ok: true, proposal: rec };
    },

    /** Rule 5: a human approves, with authority and a real written reason. */
    async approve(proposalId, opts) {
      const o = opts || {};
      if (!canApprove()) return { ok: false, error: 'FORBIDDEN' };
      const reason = String(o.reason == null ? '' : o.reason).trim();
      if (reason.length < MIN_REASON) return { ok: false, error: 'JUSTIFICATION_REQUIRED', minChars: MIN_REASON };
      const p = await data().get(PROPOSALS, proposalId);
      if (!p || p.status !== 'pending_governance') return { ok: false, error: 'NOT_PENDING' };

      const need = p.need || {};
      const reg = await registry().register(need.action, need.entity, need.context, p.name, 'B');
      if (!reg.ok) return { ok: false, error: reg.error };

      const upd = Object.assign({}, p, { status: 'promoted', decidedAt: nowISO(), reason: reason, signature: reg.record.signature });
      await data().put(PROPOSALS, proposalId, upd);
      try { if (ledger() && ledger().append) await ledger().append('genesis.promotion', { proposalId: proposalId, name: p.name, signature: reg.record.signature, reason: reason }); } catch (_) {}
      try { if (global.AAA_EVENT_BUS) await global.AAA_EVENT_BUS.publish('genesis.promoted', { name: p.name, signature: reg.record.signature }, { source: 'genesis' }); } catch (_) {}
      return { ok: true, proposal: upd };
    },

    /** Reject (also audited; a discarded temp is a recorded outcome, not silence). */
    async reject(proposalId, opts) {
      const o = opts || {};
      const p = await data().get(PROPOSALS, proposalId);
      if (!p || p.status !== 'pending_governance') return { ok: false, error: 'NOT_PENDING' };
      const upd = Object.assign({}, p, { status: 'rejected', decidedAt: nowISO(), reason: String(o.reason || '') });
      await data().put(PROPOSALS, proposalId, upd);
      try { if (ledger() && ledger().append) await ledger().append('genesis.promotion_rejected', { proposalId: proposalId, name: p.name, reason: upd.reason }); } catch (_) {}
      return { ok: true, proposal: upd };
    },

    async proposals() {
      const all = (await data().list(PROPOSALS)).filter((r) => r && (r.workspaceId == null || r.workspaceId === ws()));
      return all.sort((a, b) => String(b.proposedAt || '').localeCompare(String(a.proposedAt || '')));
    }
  };

  global.AAA_PROMOTION_ENGINE = Engine;
})(typeof window !== 'undefined' ? window : this);
