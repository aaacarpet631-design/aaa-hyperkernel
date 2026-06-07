/*
 * AAA HyperMind Executor — the governed autonomous apply (HM-4).
 *
 * This fills the Execute seam HM-1 left open. When the owner has switched on full
 * autonomy (hypermindAutoApply, default on but inert until the loop is enabled),
 * the loop doesn't just LEARN — it APPLIES what it learned, with no human gate:
 *
 *   • Calibration — propose() from closure signals, then autoApprove() each
 *     proposal (a simulate() guard skips any tuning that would REDUCE alignment).
 *   • Prompt tunings — improveAll() (LLM-driven), only when the proxy is ready.
 *
 * Strict boundaries (this is the whole safety story):
 *   • INTERNAL learning only. Every apply goes through the gateway's AUTO_TUNE
 *     action, which touches NO price/money/customer/message — those remain
 *     hard-blocked for AI regardless of any flag. The executor literally has no
 *     code path to a business mutation.
 *   • Fully audited. Every gateway apply records origin:'ai', autonomous:true;
 *     every run is also written to the hypermind_actions ledger.
 *   • Reversible. rollback(agent)/rollbackAll() revert via autoRollback; the
 *     owner can also setAutoApply(false) to drop to advisory instantly.
 *   • Advisory fallback. With autonomy off, run() still PROPOSES (leaving
 *     proposals pending for human review) and applies nothing.
 */
;(function (global) {
  'use strict';

  const LEDGER = 'hypermind_actions';

  function cfg() { return global.AAA_CONFIG || {}; }
  function data() { return global.AAA_DATA; }
  function ids() { return global.AAA_ID_FACTORY; }
  function clock() { return global.AAA_RUNTIME_CLOCK; }
  function hm() { return global.AAA_HYPERMIND; }
  function cal() { return global.AAA_CALIBRATION_REGISTRY; }
  function selfImp() { return global.AAA_SELF_IMPROVEMENT; }
  function ws() { return cfg().workspaceId || 'default'; }
  function nowISO() { return clock() && clock().nowISO ? clock().nowISO() : new Date().toISOString(); }
  function now() { return clock() && clock().now ? clock().now() : Date.now(); }
  function newId(p) { return ids() ? ids().createId(p) : p + '_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7); }
  function mine(r) { return r && (r.workspaceId == null || r.workspaceId === ws()); }
  async function quiet(fn, dflt) { try { return await fn(); } catch (_) { return dflt; } }
  // Does an active calibration version already encode this proposal's tuning?
  function sameTuning(ver, p) {
    return Number(ver.confidenceBias) === Number(p.confidenceBias) &&
      Number(ver.riskBias) === Number(p.riskBias) &&
      JSON.stringify(ver.segmentAdjustments || []) === JSON.stringify(p.segmentAdjustments || []);
  }

  const Executor = {
    /** Is autonomous apply currently active? (owner flag, default on). */
    autoApply() { return hm() && hm().autoApply ? hm().autoApply() : false; },

    /**
     * Execute one autonomous-learning pass. Called by HM-1's Execute phase.
     * @param {object} [ctx] { tickId, source }
     * @returns {object} { ok, mode, proposed, applied, skipped, promptTunings, details }
     */
    async run(ctx) {
      ctx = ctx || {};
      const auto = this.autoApply();
      const out = { ok: true, mode: auto ? 'autonomous' : 'advisory', proposed: 0, applied: 0, skipped: 0, promptTunings: 0, details: [] };
      const C = cal();

      // --- 1) Calibration: propose, then (if autonomous) auto-apply -----------
      if (C && C.propose) {
        const pr = await quiet(() => C.propose(), null);
        const proposals = (pr && pr.proposals) || [];
        out.proposed = proposals.length;

        if (!auto) {
          if (proposals.length) out.details.push({ kind: 'calibration', action: 'advisory', note: proposals.length + ' proposal(s) left pending for human review' });
        } else {
          for (const p of proposals) {
            // Idempotency: skip when the active version already matches this proposal
            // (propose() re-emits pending each tick; we must not re-apply unchanged).
            const active = C.activeVersion ? await quiet(() => C.activeVersion(p.agent), null) : null;
            if (active && sameTuning(active, p)) { out.details.push({ kind: 'calibration', agent: p.agent, action: 'unchanged' }); continue; }
            // Safety guard: never auto-apply a tuning that DEMONSTRABLY hurts.
            const sim = C.simulate ? await quiet(() => C.simulate({ agent: p.agent, confidenceBias: p.confidenceBias }), null) : null;
            if (sim && sim.ok && sim.improvement != null && sim.improvement < 0) {
              out.skipped++; out.details.push({ kind: 'calibration', agent: p.agent, action: 'skipped', reason: 'would_reduce_alignment', improvement: sim.improvement });
              continue;
            }
            const ap = await quiet(() => C.autoApprove(p.id, { actor: 'hypermind' }), null);
            if (ap && ap.ok && !ap.error) { out.applied++; out.details.push({ kind: 'calibration', agent: p.agent, action: 'applied', versionId: ap.versionId || (ap.result && ap.result.id), auditId: ap.auditId }); }
            else { out.skipped++; out.details.push({ kind: 'calibration', agent: p.agent, action: 'skipped', reason: (ap && ap.error) || 'apply_failed' }); }
          }
        }
      }

      // --- 2) Prompt tunings (LLM): autonomous + proxy ready only -------------
      if (auto && selfImp() && selfImp().isReady && selfImp().isReady()) {
        const imp = await quiet(() => selfImp().improveAll(), null);
        if (imp && imp.ok) { out.promptTunings = imp.improved || (Array.isArray(imp.results) ? imp.results.filter((r) => r.ok).length : 0); if (out.promptTunings) out.details.push({ kind: 'prompt', action: 'applied', count: out.promptTunings }); }
      }

      await this._record(ctx, out);
      return out;
    },

    /** Revert one agent's autonomous calibration (kill-switch granularity). */
    async rollback(agent, opts) {
      if (!cal() || !cal().autoRollback) return { ok: false, error: 'NO_REGISTRY' };
      const res = await cal().autoRollback(agent, Object.assign({ actor: 'hypermind' }, opts || {}));
      await this._record({ source: 'rollback' }, { ok: res && res.ok !== false, mode: 'rollback', agent: agent, applied: res && res.ok ? 1 : 0, details: [{ kind: 'calibration', agent: agent, action: 'rolled_back', error: res && res.error }] });
      return res;
    },

    /** Revert every agent that currently has an active autonomous tuning. */
    async rollbackAll() {
      if (!cal() || !cal().versions) return { ok: false, error: 'NO_REGISTRY' };
      const versions = await quiet(() => cal().versions(), []);
      const agents = Array.from(new Set((versions || []).filter((v) => v && v.active && !v.rolledBack).map((v) => v.agent)));
      let reverted = 0;
      for (const a of agents) { const r = await this.rollback(a); if (r && r.ok !== false) reverted++; }
      return { ok: true, reverted: reverted, agents: agents };
    },

    /** Recent autonomous-action ledger entries (newest first) — for the UI/audit. */
    async history(limit) {
      if (!data()) return [];
      const all = (await data().list(LEDGER)).filter(mine);
      return all.sort((a, b) => (b.at || 0) - (a.at || 0)).slice(0, limit || 25);
    },

    async _record(ctx, out) {
      const rec = {
        id: newId('hma'), workspaceId: ws(), at: now(), atISO: nowISO(),
        tickId: (ctx && ctx.tickId) || null, source: (ctx && ctx.source) || null,
        mode: out.mode, proposed: out.proposed || 0, applied: out.applied || 0,
        skipped: out.skipped || 0, promptTunings: out.promptTunings || 0, details: out.details || []
      };
      try { await data().put(LEDGER, rec.id, rec); } catch (_) {}
      try { if (data().cloudReady && data().cloudReady() && global.AAA_CLOUD) await global.AAA_CLOUD.upsertEntity(LEDGER, rec.id, rec); } catch (_) {}
      try { if (data().logAgent) data().logAgent('hypermind', 'autonomous apply: ' + rec.applied + ' applied / ' + rec.skipped + ' skipped (' + rec.mode + ')', { tickId: rec.tickId }); } catch (_) {}
      return rec;
    }
  };

  global.AAA_HYPERMIND_EXECUTOR = Executor;
})(typeof window !== 'undefined' ? window : this);
