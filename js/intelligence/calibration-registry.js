/*
 * AAA Calibration Registry — the human-gated governance layer for AI tuning.
 *
 * Turns the Prediction-Closure calibration SIGNALS (advisory) into formal
 * PROPOSALS, then — and only then — applies an approved proposal as a versioned
 * agent tuning. The flow is strictly:
 *
 *   advisory signal → propose() → (pending proposal) → APPROVE (human, audited)
 *     → new calibration_version (active) + AAA_AGENTS.setTuning(...) applied
 *     → future recommendations carry the bias
 *   rollback() → revert to the prior version (or baseline), audited
 *   simulate() → "what would have happened?" historical replay, NO live change
 *
 * Hard rules (enforced by code):
 *   - propose() NEVER applies anything (no setTuning, no mutation of agents).
 *   - approve/reject/rollback route through the gateway (APPLY_CALIBRATION,
 *     human-only + audited); AI and non-owners are blocked.
 *   - It never changes a price, quote, margin, or customer record.
 *   - Versions are kept (append-only history) for rollback + comparison.
 *   - Owner-only collections (financial). Null-tolerant throughout.
 */
;(function (global) {
  'use strict';

  const PROPOSALS = 'calibration_proposals';
  const VERSIONS = 'calibration_versions';

  function cfg() { return global.AAA_CONFIG || {}; }
  function data() { return global.AAA_DATA; }
  function ids() { return global.AAA_ID_FACTORY; }
  function clock() { return global.AAA_RUNTIME_CLOCK; }
  function gateway() { return global.AAA_RUNTIME_GATEWAY; }
  function closure() { return global.AAA_PREDICTION_CLOSURE; }
  function registry() { return global.AAA_AGENTS; }
  function ws() { return cfg().workspaceId || 'default'; }
  function nowISO() { return clock() && clock().nowISO ? clock().nowISO() : new Date().toISOString(); }
  function mine(r) { return r && (r.workspaceId == null || r.workspaceId === ws()); }
  function num(v) { const n = Number(v); return isFinite(n) ? n : 0; }
  function round(n) { return Math.round(n * 100) / 100; }
  function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }

  const Registry = {
    PROPOSALS: PROPOSALS, VERSIONS: VERSIONS,

    // ---- proposals (advisory → formal; NEVER applied here) -------------
    /**
     * Build pending calibration proposals from the advisory closure signals.
     * Idempotent: one pending proposal per agent (replaces a prior pending one).
     * Applies NOTHING.
     */
    async propose(opts) {
      const o = opts || {};
      if (!closure()) return { ok: false, error: 'NO_CLOSURE_ENGINE' };
      const summary = await closure().calibrationSummary();
      const closures = await closure().closures();
      const out = [];
      for (const agentSig of (summary.agents || [])) {
        if (o.agent && agentSig.agent !== o.agent) continue;
        const conclusive = num(agentSig.validated) + num(agentSig.contradicted);
        if (conclusive < num(cfg().flag ? cfg().flag('calMinClosures', 2) : 2)) continue; // need a little evidence
        const confidenceBias = num(agentSig.suggestedConfidenceBias);
        const riskBias = clamp(Math.round(-num(agentSig.netConfidenceSignal) / 5), -10, 10) === 0
          ? (agentSig.contradicted > agentSig.validated ? 5 : (agentSig.validated > agentSig.contradicted ? -5 : 0))
          : clamp(Math.round((num(agentSig.contradicted) - num(agentSig.validated))) * 2, -10, 10);
        const segmentAdjustments = segmentBiases(closures, agentSig.agent);
        const id = keyFor(agentSig.agent);
        const existing = await getOne(PROPOSALS, id);
        const rec = {
          id: id, agent: agentSig.agent, workspaceId: ws(), status: 'pending',
          confidenceBias: confidenceBias, riskBias: riskBias, segmentAdjustments: segmentAdjustments,
          basis: { validated: agentSig.validated, contradicted: agentSig.contradicted, validationRate: agentSig.validationRate, closures: agentSig.closures },
          rationale: 'From ' + conclusive + ' conclusive closure(s): ' + agentSig.validated + ' validated / ' + agentSig.contradicted + ' contradicted (validation ' + (agentSig.validationRate != null ? Math.round(agentSig.validationRate * 100) + '%' : '—') + '). Suggests confidence bias ' + signed(confidenceBias) + ', risk bias ' + signed(riskBias) + '.',
          reviewedBy: null, reviewedAt: null, versionId: null,
          createdAt: (existing && existing.createdAt) || nowISO(), updatedAt: nowISO()
        };
        await put(PROPOSALS, rec);
        out.push(rec);
      }
      return { ok: true, proposals: out };
    },

    async listProposals(status) { const all = (await data().list(PROPOSALS)).filter(mine); return (status ? all.filter((p) => p.status === status) : all).sort(byNewest); },
    async getProposal(id) { return getOne(PROPOSALS, id); },
    async versions(agent) { return (await data().list(VERSIONS)).filter((v) => mine(v) && (!agent || v.agent === agent)).sort((a, b) => (b.version || 0) - (a.version || 0)); },
    async activeVersion(agent) { return (await this.versions(agent)).find((v) => v.active) || null; },

    // ---- approval workflow (human-only, audited; the ONLY apply path) ---
    async approve(proposalId, opts) {
      const o = opts || {};
      const p = await getOne(PROPOSALS, proposalId);
      if (!p) return { ok: false, error: 'NOT_FOUND' };
      if (p.status === 'approved') return { ok: true, alreadyApproved: true, versionId: p.versionId };
      return this._gated('APPLY_CALIBRATION', 'approve', proposalId, o, async () => {
        const prior = await this.activeVersion(p.agent);
        const version = await this._nextVersion(p.agent);
        const ver = {
          id: ids() ? ids().createId('calv') : 'calv_' + Date.now(), workspaceId: ws(), agent: p.agent, version: version,
          confidenceBias: p.confidenceBias, riskBias: p.riskBias, segmentAdjustments: p.segmentAdjustments || [],
          proposalId: p.id, active: true, appliedBy: o.actor || null, appliedAt: nowISO(),
          supersedes: prior ? prior.id : null, rolledBack: false, note: o.note || null
        };
        if (prior) await put(VERSIONS, Object.assign({}, prior, { active: false, supersededBy: ver.id, updatedAt: nowISO() }));
        await put(VERSIONS, ver);
        this._applyTuning(p.agent, ver);   // the ONLY place a tuning is installed
        await put(PROPOSALS, Object.assign({}, p, { status: 'approved', reviewedBy: o.actor || null, reviewedAt: nowISO(), versionId: ver.id, updatedAt: nowISO() }));
        return ver;
      });
    },

    async reject(proposalId, opts) {
      const o = opts || {};
      const p = await getOne(PROPOSALS, proposalId);
      if (!p) return { ok: false, error: 'NOT_FOUND' };
      return this._gated('APPLY_CALIBRATION', 'reject', proposalId, o, async () => {
        const rec = Object.assign({}, p, { status: 'rejected', reviewedBy: o.actor || null, reviewedAt: nowISO(), updatedAt: nowISO() });
        await put(PROPOSALS, rec);
        return rec;
      });
    },

    /** One-click revert to the prior version (or baseline). Audited. */
    async rollback(agent, opts) {
      const o = opts || {};
      const active = await this.activeVersion(agent);
      if (!active) return { ok: false, error: 'NOTHING_ACTIVE', message: 'No active calibration to roll back.' };
      return this._gated('APPLY_CALIBRATION', 'rollback', agent, o, async () => {
        const prior = active.supersedes ? await getOne(VERSIONS, active.supersedes) : null;
        const before = await this.simulate({ agent: agent, confidenceBias: active.confidenceBias });
        const version = await this._nextVersion(agent);
        const ver = {
          id: ids() ? ids().createId('calv') : 'calv_' + Date.now(), workspaceId: ws(), agent: agent, version: version,
          confidenceBias: prior ? prior.confidenceBias : 0, riskBias: prior ? prior.riskBias : 0, segmentAdjustments: prior ? (prior.segmentAdjustments || []) : [],
          proposalId: null, active: true, appliedBy: o.actor || null, appliedAt: nowISO(),
          supersedes: active.id, rolledBack: true, rolledBackFrom: active.id, note: 'Rollback of v' + active.version + (prior ? ' to v' + prior.version : ' to baseline')
        };
        await put(VERSIONS, Object.assign({}, active, { active: false, supersededBy: ver.id, updatedAt: nowISO() }));
        await put(VERSIONS, ver);
        if (prior) this._applyTuning(agent, prior); else if (registry() && registry().setTuning) registry().setTuning(agent, null);
        const after = await this.simulate({ agent: agent, confidenceBias: ver.confidenceBias });
        ver.beforeAfter = { before: before.afterAlignmentRate, after: after.afterAlignmentRate };
        await put(VERSIONS, ver);
        return ver;
      });
    },

    /**
     * Re-install active tunings into the registry (call on app boot). No audit.
     * Migration-safe: skips malformed/older records and never throws — a bad
     * version can't break startup, and older records (missing segmentAdjustments
     * / riskBias / schema) are applied with safe defaults.
     */
    async rehydrate() {
      let rows = [];
      try { rows = await data().list(VERSIONS); } catch (_) { return { ok: true, applied: 0, skipped: 0 }; }
      let applied = 0, skipped = 0;
      (rows || []).forEach((v) => {
        if (!mine(v) || !v.active) return;
        if (!v.agent || typeof v.agent !== 'string') { skipped++; return; } // malformed → skip
        try { this._applyTuning(v.agent, v); applied++; } catch (_) { skipped++; }
      });
      return { ok: true, applied: applied, skipped: skipped };
    },

    /** Version comparison (params + bias diffs). */
    async compare(versionIdA, versionIdB) {
      const a = await getOne(VERSIONS, versionIdA);
      const b = await getOne(VERSIONS, versionIdB);
      if (!a || !b) return { ok: false, error: 'NOT_FOUND' };
      return { ok: true, a: a, b: b, diff: { confidenceBias: num(b.confidenceBias) - num(a.confidenceBias), riskBias: num(b.riskBias) - num(a.riskBias) } };
    },

    /**
     * Simulation: "what would have happened if this calibration were active?"
     * Replays the agent's past predictions vs their closure outcomes and measures
     * how confidence-implied expectation aligns with reality, before vs after the
     * proposed bias. READ-ONLY — installs nothing, changes nothing.
     */
    async simulate(proposalOrParams) {
      const p = proposalOrParams || {};
      const agent = p.agent;
      const bias = num(p.confidenceBias);
      if (!closure()) return { ok: false, error: 'NO_CLOSURE_ENGINE' };
      const closures = (await closure().closures()).filter((c) => !agent || c.agent === agent);
      const decisions = await data().list('agent_decisions');
      const byId = {}; decisions.forEach((d) => { byId[d.id] = d; });
      let n = 0, beforeHit = 0, afterHit = 0;
      closures.forEach((c) => {
        if (c.status !== 'validated' && c.status !== 'contradicted') return;
        const dec = byId[c.predictionId]; if (!dec || dec.confidence == null) return;
        n++;
        const actualValidated = c.status === 'validated';
        const before = (num(dec.confidence) >= 50) === actualValidated;
        const after = (clamp(num(dec.confidence) + bias, 0, 100) >= 50) === actualValidated;
        if (before) beforeHit++; if (after) afterHit++;
      });
      return {
        ok: true, liveChange: false, sample: n,
        beforeAlignmentRate: n ? round(beforeHit / n) : null,
        afterAlignmentRate: n ? round(afterHit / n) : null,
        improvement: n ? round((afterHit - beforeHit) / n) : null,
        note: n ? 'Historical replay only — no live change was made.' : 'Not enough conclusive closures to simulate yet.'
      };
    },

    // ---- internals ----
    _applyTuning(agent, ver) {
      const A = registry(); if (!A || !A.setTuning) return;
      A.setTuning(agent, { confidenceBias: num(ver.confidenceBias), riskBias: num(ver.riskBias), segmentAdjustments: ver.segmentAdjustments || [], version: ver.version, source: 'calibration_registry' });
    },
    async _nextVersion(agent) { const vs = await this.versions(agent); return (vs.length ? vs[0].version : 0) + 1; },
    async _gated(action, op, targetId, o, mutate) {
      const gw = gateway();
      if (!gw) return { ok: false, error: 'NO_GATEWAY' };
      const res = await gw.run({ action: action, origin: o.origin === 'ai' ? 'ai' : 'human', actor: o.actor || null, target: { type: 'calibration', id: targetId }, detail: { op: op }, mutate: mutate });
      if (!res.ok) return res;
      return { ok: true, result: res.result, versionId: res.result && res.result.id, auditId: res.auditId };
    }
  };

  // ---- helpers ----
  function byNewest(a, b) { return String(b.createdAt || '').localeCompare(String(a.createdAt || '')); }
  function signed(n) { return (n > 0 ? '+' : '') + num(n); }
  function keyFor(agent) { return 'calprop_' + ws() + '_' + String(agent).replace(/[^a-z0-9_]+/gi, '_'); }
  function segmentBiases(closures, agent) {
    const by = {};
    (closures || []).filter((c) => c.agent === agent && c.segmentDim && c.segmentKey && c.segmentDim !== 'all' && c.segmentDim !== 'marginAll').forEach((c) => {
      const k = c.segmentDim + '|' + c.segmentKey;
      const g = by[k] || (by[k] = { segmentDim: c.segmentDim, segmentKey: c.segmentKey, validated: 0, contradicted: 0 });
      if (c.status === 'validated') g.validated++; else if (c.status === 'contradicted') g.contradicted++;
    });
    return Object.keys(by).map((k) => {
      const g = by[k]; const net = g.validated - g.contradicted;
      return { segmentDim: g.segmentDim, segmentKey: g.segmentKey, confidenceBias: clamp(net * 5, -10, 10) };
    }).filter((s) => s.confidenceBias !== 0);
  }
  async function getOne(c, id) { const r = await data().get(c, id); return mine(r) ? r : null; }
  async function put(c, rec) {
    await data().put(c, rec.id, rec);
    try { if (data().cloudReady && data().cloudReady() && global.AAA_CLOUD) global.AAA_CLOUD.upsertEntity(c, rec.id, rec); } catch (_) {}
  }

  global.AAA_CALIBRATION_REGISTRY = Registry;
})(typeof window !== 'undefined' ? window : this);
