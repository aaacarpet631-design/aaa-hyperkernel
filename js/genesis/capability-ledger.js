/*
 * AAA Capability Ledger — the immutable accounting of the Capability Economy.
 *
 * Every Genesis-spawned run becomes one APPEND-ONLY ledger entry, keyed by its
 * capability DNA signature (action|entity|context). An entry is never mutated;
 * a downstream business outcome arrives as a separate append to
 * capability_outcomes (so "what did we know, and when?" stays answerable).
 * This is the substrate the reputation store, promotion scorer, ROI engine,
 * failure detector, and dashboard all read — none of them re-derive truth from
 * scratch, and none of them mutate history.
 *
 * Recorded per run (the directive's required fields):
 *   capability DNA · event trigger · agent spec · tool spec · execution result
 *   · confidence · risk · cost · latency · human approval required · rollback
 *   used · graph facts written · (later) downstream business outcome.
 *
 * Pure storage. Reads the run + its forged tools + its decision; writes only
 * its own collections. Null-tolerant; deterministic.
 */
;(function (global) {
  'use strict';

  const LEDGER = 'capability_ledger';
  const OUTCOMES = 'capability_outcomes';

  function cfg() { return global.AAA_CONFIG || {}; }
  function data() { return global.AAA_DATA; }
  function ids() { return global.AAA_ID_FACTORY; }
  function clock() { return global.AAA_RUNTIME_CLOCK; }
  function forge() { return global.AAA_TOOL_FORGE; }
  function capReg() { return global.AAA_CAPABILITY_REGISTRY; }
  function ws() { return cfg().workspaceId || 'default'; }
  function nowISO() { return clock() && clock().nowISO ? clock().nowISO() : new Date().toISOString(); }
  function mine(r) { return r && (r.workspaceId == null || r.workspaceId === ws()); }
  function newId(p) { return ids() ? ids().createId(p) : p + '_' + Date.now(); }

  function signatureOf(action, entity, context) {
    if (capReg() && capReg().key) return capReg().key(action, entity, context);
    const s = (v) => String(v == null ? '' : v).toLowerCase().trim().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
    return s(action) + '|' + s(entity) + (context ? '|' + s(context) : '');
  }

  const Ledger = {
    LEDGER: LEDGER, OUTCOMES: OUTCOMES, signatureOf: signatureOf,

    /**
     * Append one immutable ledger entry for a completed run. Pulls the agent
     * spec, the forged tool specs, and the decision confidence itself, so the
     * caller only passes the spec + run. Returns the stored entry.
     */
    async record(spec, run, extra) {
      const e = extra || {};
      const sig = signatureOf(spec.action, spec.targetEntity, spec.context);
      let toolSpec = [];
      try { if (forge()) toolSpec = (await forge().tools({ runId: run.id })).map((tl) => ({ name: tl.name, protocol: tl.protocol, target: tl.target, action: tl.action, invocations: tl.invocations, byot: !!(tl.provenance && tl.provenance.byot) })); } catch (_) {}
      let confidence = null;
      try { const dec = run.decisionId ? await data().get('agent_decisions', run.decisionId) : null; if (dec) confidence = dec.confidence; } catch (_) {}

      const id = newId('cap');
      const entry = {
        id: id, workspaceId: ws(), signature: sig,
        capabilityDNA: { action: spec.action, entity: spec.targetEntity, context: spec.context, domain: e.domain || null, klass: spec.klass },
        toolDNA: toolSpec.map((t) => t.protocol + '|' + t.target + '|' + t.action),
        eventTrigger: spec.triggerEvent,
        agentSpec: { agentId: spec.agentId, name: spec.name, council: spec.council, riskLevel: spec.riskLevel, approvalRequired: !!spec.approvalRequired, maxCostUsd: spec.maxCostUsd, maxRuntimeMs: spec.maxRuntimeMs },
        toolSpec: toolSpec,
        runId: run.id,
        executionResult: run.status,                       // succeeded | failed | rolled_back
        error: run.error || null,
        confidence: confidence,
        risk: spec.riskLevel,
        costUsd: Number(run.costUsd) || 0,
        latencyMs: Number(run.elapsedMs) || 0,
        humanApprovalRequired: !!spec.approvalRequired,
        rollbackUsed: run.status === 'rolled_back',
        graphFactsWritten: Array.isArray(run.factIds) ? run.factIds.length : 0,
        toolsDiscarded: Number(run.toolsDiscarded) || 0,
        downstreamOutcome: null,                            // filled by linkOutcome (overlay)
        recordedAt: nowISO()
      };
      await data().put(LEDGER, id, entry);
      return entry;
    },

    /**
     * Append a downstream business outcome for a run (append-only overlay — the
     * ledger entry is never rewritten). `roi` is any subset of ROI dimensions.
     */
    async linkOutcome(runId, outcome) {
      const o = outcome || {};
      const id = newId('capout');
      const rec = {
        id: id, workspaceId: ws(), runId: runId,
        result: o.result || null, resultClass: o.resultClass || null,
        roi: o.roi || {}, note: o.note || null, recordedAt: nowISO()
      };
      await data().put(OUTCOMES, id, rec);
      return rec;
    },

    /** All ledger entries (newest first), optionally filtered by signature. */
    async entries(filter) {
      const f = filter || {};
      let all = (await data().list(LEDGER)).filter(mine);
      if (f.signature) all = all.filter((e) => e.signature === f.signature);
      if (f.name) all = all.filter((e) => e.agentSpec && e.agentSpec.name === f.name);
      return all.sort((a, b) => String(b.recordedAt || '').localeCompare(String(a.recordedAt || '')));
    },

    /** Outcome overlays for a run (or all). */
    async outcomes(runId) {
      const all = (await data().list(OUTCOMES)).filter(mine);
      return runId ? all.filter((o) => o.runId === runId) : all;
    },

    /** Distinct capability signatures seen, with their DNA. */
    async signatures() {
      const all = await this.entries();
      const map = {};
      all.forEach((e) => { if (!map[e.signature]) map[e.signature] = { signature: e.signature, dna: e.capabilityDNA, name: e.agentSpec && e.agentSpec.name }; });
      return Object.keys(map).map((k) => map[k]);
    }
  };

  global.AAA_CAPABILITY_LEDGER = Ledger;
})(typeof window !== 'undefined' ? window : this);
