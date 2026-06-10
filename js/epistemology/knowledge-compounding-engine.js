/*
 * AAA Knowledge Compounding Engine — the moat made measurable.
 *
 * Every estimate, job, callback, review, and loss flows up the ladder:
 *   Observation → Evidence → Belief → Theory → Policy.
 * This engine reads the epistemic stack (Belief Registry, Causal Store,
 * Experiment Registry, World Model observations) and reports how much durable
 * knowledge the organization has accumulated — and snapshots it over time so
 * the compounding is visible. No flattering defaults: a moat with no theories
 * is honestly reported as nascent, not dressed up.
 */
;(function (global) {
  'use strict';

  const SNAPSHOTS = 'knowledge_snapshots';

  function cfg() { return global.AAA_CONFIG || {}; }
  function data() { return global.AAA_DATA; }
  function ids() { return global.AAA_ID_FACTORY; }
  function clock() { return global.AAA_RUNTIME_CLOCK; }
  function beliefs() { return global.AAA_BELIEF_REGISTRY; }
  function causal() { return global.AAA_CAUSAL_HYPOTHESIS_STORE; }
  function experiments() { return global.AAA_EXPERIMENT_REGISTRY; }
  function ws() { return cfg().workspaceId || 'default'; }
  function nowISO() { return clock() && clock().nowISO ? clock().nowISO() : new Date().toISOString(); }
  function mine(r) { return r && (r.workspaceId == null || r.workspaceId === ws()); }
  function newId(p) { return ids() ? ids().createId(p) : p + '_' + Date.now(); }

  async function count(c) { try { return ((await data().list(c)) || []).filter(mine).length; } catch (_) { return 0; } }

  const Engine = {
    SNAPSHOTS: SNAPSHOTS,

    /** Current knowledge state across the epistemic stack. */
    async assess() {
      const claims = beliefs() ? await beliefs().list() : [];
      const byType = { fact: 0, belief: 0, prediction: 0, theory: 0 };
      claims.forEach((c) => { if (byType[c.type] != null) byType[c.type]++; });
      const theories = claims.filter((c) => c.type === 'theory');

      // Resolved predictions → mean accuracy (knowledge that proved out).
      const resolved = claims.filter((c) => c.type === 'prediction' && c.resolved && c.resolved.accuracy != null);
      const predictionAccuracy = resolved.length ? Math.round((resolved.reduce((a, c) => a + c.resolved.accuracy, 0) / resolved.length) * 1000) / 1000 : null;

      const cm = causal() ? await causal().metrics() : { count: 0, supported: 0 };
      const observations = await count('world_signals');
      const evidence = await count('causal_evidence');
      const experimentsRun = experiments() ? (await experiments().list()).filter((e) => e.status === 'succeeded' || e.status === 'failed').length : 0;

      // Moat score: theories carry it, weighted by the evidence beneath them and
      // proven prediction accuracy. Honest null when there is nothing durable yet.
      let moatScore = null, moatStatus = 'nascent';
      if (theories.length || cm.supported) {
        const evidenceFactor = Math.min(1, evidence / 50);
        const accFactor = predictionAccuracy == null ? 0.5 : predictionAccuracy;
        moatScore = Math.round((Math.min(1, theories.length / 10) * 0.6 + evidenceFactor * 0.2 + accFactor * 0.2) * 1000) / 1000;
        moatStatus = theories.length ? 'compounding' : 'forming';
      }

      return {
        counts: byType,
        theories: theories.map((t) => ({ id: t.id, statement: t.statement, confidence: t.confidence, evidence: t.basis && t.basis.evidenceCount })),
        causalHypotheses: cm.count, supportedHypotheses: cm.supported,
        observations: observations, evidence: evidence, experimentsRun: experimentsRun,
        predictionAccuracy: predictionAccuracy, predictionAccuracyStatus: predictionAccuracy == null ? 'insufficient_data' : 'derived',
        moatScore: moatScore, moatStatus: moatStatus
      };
    },

    /** Persist a dated knowledge snapshot — the compounding curve over time. */
    async snapshot() {
      const a = await this.assess();
      const id = newId('ksnap');
      const rec = Object.assign({ id: id, workspaceId: ws(), at: nowISO() }, a);
      await data().put(SNAPSHOTS, id, rec);
      return rec;
    },

    /** Knowledge growth over snapshots (theories + observations through time). */
    async trajectory() {
      const all = (await data().list(SNAPSHOTS)).filter(mine).sort((a, b) => String(a.at).localeCompare(String(b.at)));
      return all.map((s) => ({ at: s.at, theories: s.counts.theory, observations: s.observations, moatScore: s.moatScore }));
    }
  };

  global.AAA_KNOWLEDGE_COMPOUNDING_ENGINE = Engine;
})(typeof window !== 'undefined' ? window : this);
