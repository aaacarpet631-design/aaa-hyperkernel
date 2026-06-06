/*
 * AAA Provenance Builder — assembles the trace behind a recommendation.
 *
 * Given an advisory artifact, it gathers the full chain of WHY:
 *   - source quotes it read (snapshots: customer, total, status, margin),
 *   - the resolved outcomes it learned from,
 *   - the prediction(s) it logged and the closure(s) that scored them,
 *   - the GOVERNED versions in force: calibration version (from the registry),
 *     prompt version, and model version,
 *   - human-readable evidence (the reasoning, concerns, supervisor critique).
 *
 * It produces an ordered node chain (origin → evidence → prediction → outcome →
 * governance) plus the structured ids, so the UI can render either a graph or a
 * plain list. PURE assembly + reads only — it changes nothing. The deterministic
 * agents (estimator / pricing_optimizer / agent_council) carry
 * modelVersion:'deterministic' and promptVersion:null; their calibration version
 * is read live from AAA_CALIBRATION_REGISTRY so the trace reflects what was
 * actually in force.
 *
 * buildAndRecord() persists the assembled trace through AAA_PROVENANCE (append-
 * only). Null-tolerant: a missing store/quote/closure degrades to an empty
 * section, never an exception.
 */
;(function (global) {
  'use strict';

  function quotes() { return global.AAA_QUOTES; }
  function closureEngine() { return global.AAA_PREDICTION_CLOSURE; }
  function calibration() { return global.AAA_CALIBRATION_REGISTRY; }
  function governance() { return global.AAA_GOVERNANCE; }
  function agents() { return global.AAA_AGENTS; }
  function provenance() { return global.AAA_PROVENANCE; }
  function clock() { return global.AAA_RUNTIME_CLOCK; }
  function nowISO() { return clock() && clock().nowISO ? clock().nowISO() : new Date().toISOString(); }
  function arr(v) { return Array.isArray(v) ? v : []; }
  function uniq(a) { return a.filter((v, i) => v != null && a.indexOf(v) === i); }

  // Which agent owns each subject type. All three are deterministic today.
  const AGENT_FOR = {
    pricing_recommendation: 'pricing_optimizer',
    council_session: 'agent_council',
    prediction_closure: 'pricing_optimizer',
    estimate: 'estimator'
  };

  function quoteSnapshot(q) {
    if (!q) return null;
    return {
      quoteId: q.quoteId || q.id || null,
      customerName: q.customerName || null,
      customerTotal: q.customerTotal != null ? q.customerTotal : null,
      status: q.status || null,
      marginPct: q.marginPct != null ? q.marginPct : null,
      resolvedAt: q.resolvedAt || null,
      resolved: q.status === 'won' || q.status === 'lost'
    };
  }

  async function fetchQuotes(quoteIds) {
    const out = [];
    if (!quotes() || !quotes().get) return out;
    for (const id of uniq(arr(quoteIds))) {
      try { const q = await quotes().get(id); const s = quoteSnapshot(q); if (s) out.push(s); } catch (_) {}
    }
    return out;
  }

  async function calibrationNode(agent) {
    try {
      if (!calibration() || !calibration().activeVersion) return null;
      const v = await calibration().activeVersion(agent);
      if (!v) return null;
      return { id: v.id, agent: agent, version: v.version, confidenceBias: v.confidenceBias, riskBias: v.riskBias, appliedAt: v.appliedAt || null };
    } catch (_) { return null; }
  }

  async function closuresFor(predicate) {
    try {
      if (!closureEngine() || !closureEngine().closures) return [];
      return (await closureEngine().closures()).filter(predicate);
    } catch (_) { return []; }
  }

  /**
   * Resolve the GOVERNED prompt + model versions in force for an agent from the
   * Governance Registry, and overlay them onto the graph. With no governed
   * version active (the default for the deterministic agents today), the trace
   * stays promptVersion:null / modelVersion:'deterministic' — existing behavior
   * is preserved; the moment an owner activates a prompt/model version it shows.
   */
  async function applyGovernance(g) {
    if (!g.agent) return g;
    try {
      if (governance() && governance().getActive) {
        const pv = await governance().getActive('prompt', g.agent);
        if (pv) { g.promptVersion = pv.version; g.promptVersionId = pv.id; g.promptChecksum = pv.checksum || null; }
        const mv = await governance().getActive('model', g.agent);
        if (mv) { g.modelVersion = (mv.content != null && typeof mv.content !== 'object') ? String(mv.content) : ('v' + mv.version); g.modelVersionId = mv.id; }
      }
    } catch (_) {}
    // No governed model version → fall back to the agent's declared model id if
    // one exists (LLM-backed agents), otherwise the 'deterministic' default.
    if (!g.modelVersionId && agents() && agents().get) {
      try { const a = agents().get(g.agent); if (a && a.model) g.modelVersion = a.model; } catch (_) {}
    }
    return g;
  }

  const Builder = {
    SUBJECT_TYPES: Object.keys(AGENT_FOR),

    /**
     * Assemble a provenance graph for an advisory artifact (no persistence).
     * @param {string} subjectType  one of SUBJECT_TYPES
     * @param {Object} payload       the artifact (recommendation / session / closure / quote)
     */
    async build(subjectType, payload) {
      const p = payload || {};
      const agent = AGENT_FOR[subjectType] || null;
      const base = {
        subjectType: subjectType,
        subjectId: null, subjectLabel: null, agent: agent,
        generatedAt: nowISO(),
        sourceQuotes: [], quoteIds: [], outcomeIds: [],
        predictionIds: [], closureIds: [],
        calibrationVersion: null, promptVersion: null, promptVersionId: null, promptChecksum: null,
        modelVersion: 'deterministic', modelVersionId: null,
        evidence: [], summary: null, nodes: []
      };
      let g;
      if (subjectType === 'pricing_recommendation') g = await this._pricing(base, p);
      else if (subjectType === 'council_session') g = await this._council(base, p);
      else if (subjectType === 'prediction_closure') g = await this._closure(base, p);
      else if (subjectType === 'estimate') g = await this._estimate(base, p);
      else g = base;
      await applyGovernance(g);
      g.nodes = buildNodes(g);
      return g;
    },

    /** Build + persist the trace (append-only) through AAA_PROVENANCE. */
    async buildAndRecord(subjectType, payload) {
      const g = await this.build(subjectType, payload);
      if (!provenance() || !provenance().record) return { ok: false, error: 'NO_PROVENANCE_STORE', graph: g };
      const rec = await provenance().record(g);
      return { ok: true, record: rec, graph: g };
    },

    // ---- per-subject assembly -------------------------------------------
    async _pricing(g, rec) {
      g.subjectId = rec.id || null;
      g.subjectLabel = rec.title || rec.type || rec.id || 'Pricing recommendation';
      g.summary = { decision: rec.recommendedAction || null, confidence: rec.adjustedConfidence != null ? rec.adjustedConfidence : rec.confidence, risk: rec.risk, expectedKpiImpact: rec.expectedKpiImpact || null };
      g.quoteIds = uniq(arr(rec.supportingQuoteIds));
      g.sourceQuotes = await fetchQuotes(g.quoteIds);
      g.outcomeIds = g.sourceQuotes.filter((q) => q.resolved).map((q) => q.quoteId);
      g.predictionIds = uniq([rec.predictionId].filter(Boolean));
      const closures = await closuresFor((c) => c.recommendationId === rec.id || (rec.predictionId && c.predictionId === rec.predictionId));
      g.closureIds = closures.map((c) => c.id);
      g.calibrationVersion = await calibrationNode('pricing_optimizer');
      if (rec.reasoning) g.evidence.push({ kind: 'reasoning', label: 'Why the optimizer flagged this', detail: rec.reasoning });
      if (rec.supervisorReview && rec.supervisorReview.note) g.evidence.push({ kind: 'supervisor', label: 'Supervisor critique (' + (rec.supervisorReview.verdict || '') + ')', detail: rec.supervisorReview.note + (arr(rec.supervisorReview.riskFlags).length ? ' [' + rec.supervisorReview.riskFlags.join('; ') + ']' : '') });
      closures.forEach((c) => g.evidence.push({ kind: 'closure', label: 'Outcome closure (' + c.status + ')', detail: c.explanation || '' }));
      return g;
    },

    async _council(g, s) {
      g.subjectId = s.id || null;
      g.subjectLabel = 'Council: ' + (s.customerName || s.quoteId || s.id || 'meeting');
      g.summary = { decision: s.decision || null, confidence: s.decisionConfidence, disagreement: s.disagreement };
      g.quoteIds = uniq([s.quoteId].filter(Boolean));
      g.sourceQuotes = await fetchQuotes(g.quoteIds);
      g.outcomeIds = g.sourceQuotes.filter((q) => q.resolved).map((q) => q.quoteId);
      g.predictionIds = uniq([s.predictionId].filter(Boolean));
      // The council does not apply a calibration version itself; it confidence-
      // weights seats by their track record. Record nothing for calibration but
      // capture each seat's stance as evidence.
      arr(s.positions).forEach((pos) => {
        if (!pos || pos.stance === 'abstain') return;
        g.evidence.push({ kind: 'vote', label: pos.title + ' → ' + pos.stance + ' (conf ' + pos.confidence + ')', detail: pos.concern || '' });
      });
      return g;
    },

    async _closure(g, c) {
      g.subjectId = c.id || c.predictionId || null;
      g.subjectLabel = 'Closure: ' + (c.type || c.segmentKey || c.predictionId || 'prediction');
      g.agent = c.agent || g.agent;
      g.summary = { decision: c.status || null, baseline: c.baseline, observed: c.observed, score: c.score };
      g.predictionIds = uniq([c.predictionId].filter(Boolean));
      g.closureIds = uniq([c.id].filter(Boolean));
      g.calibrationVersion = await calibrationNode(g.agent);
      if (c.explanation) g.evidence.push({ kind: 'closure', label: 'Verdict: ' + (c.status || ''), detail: c.explanation });
      return g;
    },

    async _estimate(g, q) {
      g.subjectId = q.quoteId || q.id || null;
      g.subjectLabel = 'Estimate: ' + (q.customerName || q.quoteId || q.id || '');
      g.summary = { decision: q.status || null, confidence: q.confidence, risk: q.risk };
      const snap = quoteSnapshot(q);
      if (snap) { g.sourceQuotes = [snap]; g.quoteIds = uniq([snap.quoteId].filter(Boolean)); if (snap.resolved) g.outcomeIds = [snap.quoteId]; }
      g.calibrationVersion = await calibrationNode('estimator');
      return g;
    }
  };

  // Flatten the structured trace into an ordered node chain for the graph UI:
  // governance (versions) → evidence → predictions → outcomes → the subject.
  function buildNodes(g) {
    const nodes = [];
    nodes.push({ type: 'subject', label: g.subjectLabel || g.subjectType, detail: g.summary ? JSON.stringify(g.summary) : '', ref: g.subjectId });
    if (g.modelVersion) nodes.push({ type: 'model', label: 'Model: ' + g.modelVersion + (g.modelVersionId ? ' (governed)' : ''), detail: '', ref: g.modelVersionId || g.modelVersion });
    if (g.promptVersion) nodes.push({ type: 'prompt', label: 'Prompt v' + g.promptVersion + ' (governed)', detail: g.promptChecksum ? 'checksum ' + g.promptChecksum : '', ref: g.promptVersionId || g.promptVersion });
    if (g.calibrationVersion) nodes.push({ type: 'calibration', label: 'Calibration v' + g.calibrationVersion.version + ' (' + g.calibrationVersion.agent + ')', detail: 'confidenceBias ' + g.calibrationVersion.confidenceBias, ref: g.calibrationVersion.id });
    arr(g.evidence).forEach((e) => nodes.push({ type: 'evidence', label: e.label, detail: e.detail || '', ref: e.kind }));
    arr(g.sourceQuotes).forEach((q) => nodes.push({ type: 'quote', label: (q.customerName || q.quoteId) + (q.status ? ' · ' + q.status : ''), detail: (q.customerTotal != null ? '$' + q.customerTotal : '') + (q.marginPct != null ? ' · ' + q.marginPct + '% margin' : ''), ref: q.quoteId }));
    arr(g.predictionIds).forEach((id) => nodes.push({ type: 'prediction', label: 'Prediction ' + id, detail: '', ref: id }));
    arr(g.closureIds).forEach((id) => nodes.push({ type: 'closure', label: 'Closure ' + id, detail: '', ref: id }));
    return nodes;
  }

  global.AAA_PROVENANCE_BUILDER = Builder;
})(typeof window !== 'undefined' ? window : this);
