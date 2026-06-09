/*
 * AAA Governed Learning Loop — turn learning into GOVERNED improvement proposals.
 *
 * The platform could learn and recommend; this closes the loop WITHOUT touching
 * production. It detects a durable pattern from outcomes, drafts a concrete
 * change to a GOVERNED artifact (a policy), and files a PROPOSAL the owner reviews.
 * Approval creates a Governance Registry draft (still requiring activation — two
 * keys); rejection is retained as organizational learning (and never re-proposed).
 *
 *   Outcome → Learning Fabric → pattern → recommendation → PROPOSAL → owner review
 *           → approve ⇒ Governance draft (→ activate ⇒ production)   | reject ⇒ kept
 *
 * Every proposal carries evidence, confidence, a risk score, affected systems,
 * expected KPI impact, and a rollback path, and links to outcome events,
 * provenance traces, governance versions, and a replay simulation. NOTHING is
 * applied automatically. Owner-only; deterministic; null-tolerant.
 */
;(function (global) {
  'use strict';

  const PROPOSALS = 'proposals';
  const POLICY_NAME = 'sales_sla';
  const DEFAULT_POLICY = { followUpDays: 3, marginFloor: 25, reviewSlaHours: 48 };

  function cfg() { return global.AAA_CONFIG || {}; }
  function data() { return global.AAA_DATA; }
  function ids() { return global.AAA_ID_FACTORY; }
  function clock() { return global.AAA_RUNTIME_CLOCK; }
  function gateway() { return global.AAA_RUNTIME_GATEWAY; }
  function quotes() { return global.AAA_QUOTES; }
  function governance() { return global.AAA_GOVERNANCE; }
  function replay() { return global.AAA_REPLAY_SANDBOX; }
  function provenance() { return global.AAA_PROVENANCE; }
  function bus() { return global.AAA_EVENT_BUS; }
  function ws() { return cfg().workspaceId || 'default'; }
  function nowISO() { return clock() && clock().nowISO ? clock().nowISO() : new Date().toISOString(); }
  function mine(r) { return r && (r.workspaceId == null || r.workspaceId === ws()); }
  function newId(p) { return ids() ? ids().createId(p) : p + '_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7); }
  function num(v) { const n = Number(v); return isFinite(n) ? n : null; }
  function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, Math.round(n))); }
  async function quiet(fn, d) { try { const r = await fn(); return r == null ? d : r; } catch (_) { return d; } }

  // Register event contracts (no-op if the bus isn't present).
  try { if (bus() && bus().define) { ['proposal.created', 'proposal.approved', 'proposal.rejected'].forEach((t) => bus().define(t, { version: 1, description: 'Governed learning proposal ' + t.split('.')[1] + '.', schema: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } } })); } } catch (_) {}

  const Engine = {
    PROPOSALS: PROPOSALS, POLICY_NAME: POLICY_NAME,

    /** Detect patterns and file governed proposals (pending). Applies nothing. */
    async generate() {
      const existing = await this.list();
      const seen = {}; existing.forEach((p) => { seen[p.patternKey] = p.status; });   // dedupe incl. rejected (retained learning)
      const policy = await currentPolicy();
      const created = [];

      // Candidate 1 — follow-up timing: do faster follow-ups close materially more?
      const fu = await followUpAnalysis();
      if (fu && fu.uplift >= num(cfg().flag ? cfg().flag('proposalMinUplift', 5) : 5) && fu.fastDays != null && fu.fastDays !== policy.followUpDays) {
        const key = 'policy:followUpDays:' + fu.fastDays;
        if (!seen[key]) created.push(await this._file({
          patternKey: key, sourceKind: 'learning_fabric',
          title: 'Follow up within ' + fu.fastDays + ' day(s) — closes ' + fu.uplift + '% more',
          evidence: { sample: fu.sample, metric: 'winRate', currentValue: policy.followUpDays, proposedValue: fu.fastDays, baselineRate: fu.slowRate, observedRate: fu.fastRate },
          confidence: fu.confidence,
          proposedChange: { artifactType: 'policy', name: POLICY_NAME, content: Object.assign({}, policy, { followUpDays: fu.fastDays }) },
          expectedKpiImpact: 'Close rate +~' + fu.uplift + ' pts (jobs followed up within ' + fu.fastDays + 'd closed ' + fu.fastRate + '% vs ' + fu.slowRate + '% slower).',
          affectedSystems: ['Transport scheduler', 'Follow-up automation'],
          outcomeEventIds: fu.quoteIds
        }));
      }

      // Candidate 2 — margin floor: are we routinely winning at thin margins?
      const mf = await marginFloorAnalysis(policy);
      if (mf && mf.proposedFloor != null && mf.proposedFloor !== policy.marginFloor) {
        const key = 'policy:marginFloor:' + mf.proposedFloor;
        if (!seen[key]) created.push(await this._file({
          patternKey: key, sourceKind: 'outcome_learning',
          title: 'Raise the margin floor to ' + mf.proposedFloor + '% — ' + mf.thinWins + ' thin win(s) detected',
          evidence: { sample: mf.thinWins, metric: 'avgMarginPct', currentValue: policy.marginFloor, proposedValue: mf.proposedFloor, observedRate: mf.avgThinMargin },
          confidence: mf.confidence,
          proposedChange: { artifactType: 'policy', name: POLICY_NAME, content: Object.assign({}, policy, { marginFloor: mf.proposedFloor }) },
          expectedKpiImpact: 'Protect margin on low-margin work (avg thin win ' + mf.avgThinMargin + '% vs ' + policy.marginFloor + '% floor).',
          affectedSystems: ['Pricing optimizer', 'Executive council', 'Quote review'],
          outcomeEventIds: mf.quoteIds
        }));
      }

      return { ok: true, created: created.length, proposals: created };
    },

    async list(status) { const all = (await data().list(PROPOSALS)).filter(mine); return (status ? all.filter((p) => p.status === status) : all).sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || ''))); },
    async get(id) { const r = await data().get(PROPOSALS, id); return mine(r) ? r : null; },

    /**
     * Replay the proposed policy vs the in-force policy on a real provenance trace
     * (Replay Sandbox) and attach the KPI before/after. Read-only; no production
     * change. Best-effort: with no trace, the simulation is marked unavailable.
     */
    async simulate(proposalId, opts) {
      const o = opts || {};
      const p = await this.get(proposalId); if (!p) return { ok: false, error: 'NOT_FOUND' };
      if (!replay() || !provenance()) return { ok: false, error: 'NO_REPLAY' };
      const trace = (await provenance().list())[0] || null;
      if (!trace) { await put(Object.assign({}, p, { simulation: { available: false, reason: 'No provenance trace to replay against yet.' }, updatedAt: nowISO() })); return { ok: true, simulation: { available: false } }; }
      const current = await currentPolicy();
      const res = await replay().replay({ traceId: trace.id, actor: o.actor || null, inForcePolicy: current, chosenPolicy: p.proposedChange.content, persist: true });
      if (!res.ok) return res;
      const sim = { available: true, replaySimulationId: res.snapshotId || res.replayId, anyChange: res.anyChange, kpis: res.kpis, traceId: trace.id };
      const rec = Object.assign({}, p, { simulation: sim, links: Object.assign({}, p.links, { replaySimulationId: sim.replaySimulationId }), updatedAt: nowISO() });
      await put(rec);
      return { ok: true, simulation: sim, proposal: rec };
    },

    /**
     * Owner APPROVES: creates a Governance Registry draft of the change + proposes
     * it (it still needs activation in the registry — two keys). Audited. Never
     * activates here, so nothing reaches production without the registry step.
     */
    async approve(proposalId, opts) {
      const o = opts || {};
      const p = await this.get(proposalId); if (!p) return { ok: false, error: 'NOT_FOUND' };
      if (p.status !== 'pending') return { ok: false, error: 'NOT_PENDING' };
      const gw = gateway(); if (!gw) return { ok: false, error: 'NO_GATEWAY' };
      const auth = await gw.run({ action: 'REVIEW_PROPOSAL', origin: o.origin === 'ai' ? 'ai' : 'human', actor: o.actor || null, target: { type: 'proposal', id: proposalId }, detail: { decision: 'approve' } });
      if (!auth.ok) return auth;
      let governanceVersionId = null;
      try {
        if (governance() && governance().createDraft) {
          const ch = p.proposedChange || {};
          const draft = await governance().createDraft(ch.artifactType, ch.name, ch.content, { actor: o.actor || null, notes: 'From approved learning proposal ' + proposalId });
          if (draft.ok) { governanceVersionId = draft.version.id; await governance().propose(governanceVersionId, { actor: o.actor || null }); }
        }
      } catch (_) {}
      const rec = Object.assign({}, p, { status: 'approved', decisionBy: o.actor || null, decisionAt: nowISO(), auditRef: auth.auditId, links: Object.assign({}, p.links, { governanceVersionIds: (p.links.governanceVersionIds || []).concat(governanceVersionId ? [governanceVersionId] : []) }), updatedAt: nowISO() });
      await put(rec);
      try { if (bus() && bus().publish) bus().publish('proposal.approved', { id: proposalId }, { source: 'proposal-engine' }); } catch (_) {}
      return { ok: true, proposal: rec, governanceVersionId: governanceVersionId, auditId: auth.auditId, note: 'A governance draft was created + proposed. Activate it in the Governance Registry to reach production.' };
    },

    /** Owner REJECTS: retained as organizational learning (won't be re-proposed). */
    async reject(proposalId, opts) {
      const o = opts || {};
      const p = await this.get(proposalId); if (!p) return { ok: false, error: 'NOT_FOUND' };
      if (p.status !== 'pending') return { ok: false, error: 'NOT_PENDING' };
      const gw = gateway(); if (!gw) return { ok: false, error: 'NO_GATEWAY' };
      const auth = await gw.run({ action: 'REVIEW_PROPOSAL', origin: o.origin === 'ai' ? 'ai' : 'human', actor: o.actor || null, target: { type: 'proposal', id: proposalId }, detail: { decision: 'reject' } });
      if (!auth.ok) return auth;
      const rec = Object.assign({}, p, { status: 'rejected', decisionBy: o.actor || null, decisionAt: nowISO(), rejectionReason: o.reason || null, auditRef: auth.auditId, updatedAt: nowISO() });
      await put(rec);
      try { if (bus() && bus().publish) bus().publish('proposal.rejected', { id: proposalId }, { source: 'proposal-engine' }); } catch (_) {}
      return { ok: true, proposal: rec, auditId: auth.auditId };
    },

    // ---- internals ----
    async _file(spec) {
      const id = newId('prop');
      const affected = spec.affectedSystems || [];
      const confidence = clamp(num(spec.confidence) || 0, 0, 95);
      const riskScore = clamp(20 + affected.length * 8 + (100 - confidence) * 0.3, 0, 100);
      // Provenance trace for the proposal (links it into the Provenance Graph).
      let traceId = null;
      try {
        if (provenance() && provenance().record) {
          const tr = await provenance().record({ subjectType: 'governance_proposal', subjectId: id, subjectLabel: spec.title, agent: 'proposal_engine', summary: { decision: 'propose', confidence: confidence }, evidence: [{ kind: 'pattern', label: spec.title, detail: JSON.stringify(spec.evidence) }], modelVersion: 'deterministic', promptVersion: null, calibrationVersion: null, sourceQuotes: [], predictionIds: [], closureIds: [] });
          traceId = tr.id;
        }
      } catch (_) {}
      const rec = {
        id: id, workspaceId: ws(), title: spec.title, sourceKind: spec.sourceKind, patternKey: spec.patternKey,
        evidence: spec.evidence || {}, confidence: confidence, riskScore: riskScore,
        affectedSystems: affected, expectedKpiImpact: spec.expectedKpiImpact || null,
        rollbackPath: 'Reversible: roll back the policy version in the Governance Registry (one click) — prior behavior is restored.',
        proposedChange: spec.proposedChange,
        links: { outcomeEventIds: (spec.outcomeEventIds || []).slice(0, 50), provenanceTraceIds: traceId ? [traceId] : [], governanceVersionIds: [], replaySimulationId: null },
        simulation: null, status: 'pending', decisionBy: null, decisionAt: null, rejectionReason: null, auditRef: null,
        createdAt: nowISO(), updatedAt: nowISO()
      };
      await put(rec);
      try { if (bus() && bus().publish) bus().publish('proposal.created', { id: id }, { source: 'proposal-engine' }); } catch (_) {}
      return rec;
    }
  };

  async function currentPolicy() {
    try { if (governance() && governance().getActive) { const v = await governance().getActive('policy', POLICY_NAME); if (v && v.content) { const c = typeof v.content === 'string' ? JSON.parse(v.content) : v.content; return Object.assign({}, DEFAULT_POLICY, c); } } } catch (_) {}
    return Object.assign({}, DEFAULT_POLICY);
  }
  async function resolvedQuotes() { try { const list = quotes() && quotes().list ? await quotes().list() : (await data().list('quotes')); return list.filter((q) => mine(q) && (q.status === 'won' || q.status === 'lost')); } catch (_) { return []; } }
  async function followUpAnalysis() {
    const qs = (await resolvedQuotes()).filter((q) => q.sentAt && q.resolvedAt);
    const withDays = qs.map((q) => ({ q: q, days: Math.round((Date.parse(q.resolvedAt) - Date.parse(q.sentAt)) / 86400000) })).filter((x) => isFinite(x.days) && x.days >= 0);
    if (withDays.length < num(cfg().flag ? cfg().flag('proposalMinSample', 6) : 6)) return null;
    const winDays = withDays.filter((x) => x.q.status === 'won').map((x) => x.days);
    const thr = winDays.length ? Math.max(1, Math.round(winDays.reduce((a, b) => a + b, 0) / winDays.length)) : 2;
    const fast = withDays.filter((x) => x.days <= thr), slow = withDays.filter((x) => x.days > thr);
    if (fast.length < 2 || slow.length < 2) return null;
    const rate = (g) => Math.round((g.filter((x) => x.q.status === 'won').length / g.length) * 100);
    const fastRate = rate(fast), slowRate = rate(slow), uplift = fastRate - slowRate;
    return { fastDays: thr, fastRate: fastRate, slowRate: slowRate, uplift: uplift, sample: withDays.length, confidence: clamp(40 + Math.min(40, withDays.length * 3), 0, 95), quoteIds: fast.map((x) => x.q.quoteId || x.q.id).slice(0, 50) };
  }
  async function marginFloorAnalysis(policy) {
    const wins = (await resolvedQuotes()).filter((q) => q.status === 'won' && q.marginPct != null);
    const thin = wins.filter((q) => num(q.marginPct) < num(policy.marginFloor));
    if (thin.length < num(cfg().flag ? cfg().flag('proposalMinSample', 6) : 6) / 2) return null;
    const avgThin = Math.round(thin.reduce((s, q) => s + num(q.marginPct), 0) / thin.length);
    if (thin.length < Math.max(3, wins.length * 0.4)) return null;   // only if thin wins are common
    const proposedFloor = Math.min(num(policy.marginFloor) + 5, 40);
    return { thinWins: thin.length, avgThinMargin: avgThin, proposedFloor: proposedFloor, confidence: clamp(40 + Math.min(35, thin.length * 4), 0, 90), quoteIds: thin.map((q) => q.quoteId || q.id).slice(0, 50) };
  }
  async function put(rec) { await data().put(PROPOSALS, rec.id, rec); try { if (data().cloudReady && data().cloudReady() && global.AAA_CLOUD) global.AAA_CLOUD.upsertEntity(PROPOSALS, rec.id, rec); } catch (_) {} }

  global.AAA_PROPOSAL_ENGINE = Engine;
})(typeof window !== 'undefined' ? window : this);
