/*
 * AAA Scientific Discovery Council — the Enterprise Scientist.
 *
 * Replaces "we think this works" with "how do we know?" It runs the scientific
 * loop on top of organs that already exist — no duplication:
 *
 *   identifyBottleneck()  read the World Model; find the dimension furthest
 *                         from health → a research QUESTION
 *   formHypothesis()      create a causal hypothesis (Causal Store) AND a
 *                         BELIEF (Belief Registry) — a claim, not a fact
 *   designExperiment()    register a governed experiment (Experiment Registry,
 *                         rollback required) to test the belief
 *   recordEvidence()      feed the Causal Store; project the belief's status
 *                         (supported|refuted|testing) + confidence from it
 *   concludeAndCompound() a belief that earns enough evidence is promoted to a
 *                         THEORY — knowledge compounds
 *
 * Honest by construction: with no observations it asks no questions; a belief
 * never becomes a theory without evidence. Nothing touches production — the
 * experiment it designs is itself governed (human approval before it runs).
 */
;(function (global) {
  'use strict';

  function world() { return global.AAA_WORLD_MODEL; }
  function beliefs() { return global.AAA_BELIEF_REGISTRY; }
  function causal() { return global.AAA_CAUSAL_HYPOTHESIS_STORE; }
  function experiments() { return global.AAA_EXPERIMENT_REGISTRY; }
  function clock() { return global.AAA_RUNTIME_CLOCK; }
  function nowMs() { return clock() && clock().now ? clock().now() : Date.now(); }

  // Signal → a "healthy" reference + whether higher is better (for gap ranking).
  const HEALTH = {
    close_rate: { good: 0.5, higher: true },
    gross_margin: { good: 0.5, higher: true },
    crew_utilization: { good: 0.8, higher: true },
    review_velocity: { good: 10, higher: true },
    callback_rate: { good: 0.05, higher: false },
    response_time: { good: 4, higher: false }
  };

  const Council = {
    /**
     * Rank usable signals by how far below health they sit → research questions.
     * Returns [{ signal, value, gap, question }] worst-first, or [] if blind.
     */
    async identifyBottleneck(now) {
      const ref = now != null ? now : nowMs();
      if (!world()) return { status: 'unavailable', bottlenecks: [] };
      const found = [];
      for (const sig of Object.keys(HEALTH)) {
        const s = await world().signal(sig, ref);
        if (!s || s.value == null || !(s.status === 'fresh' || s.status === 'degraded')) continue;
        const h = HEALTH[sig];
        const gap = h.higher ? (h.good - s.value) / h.good : (s.value - h.good) / Math.max(h.good, 1e-6);
        if (gap > 0) found.push({ signal: sig, value: s.value, gap: Math.round(gap * 1000) / 1000, question: 'What would move ' + sig + ' toward ' + h.good + '?' });
      }
      found.sort((a, b) => b.gap - a.gap);
      return { status: found.length ? 'derived' : 'insufficient_data', bottlenecks: found };
    },

    /**
     * Form a hypothesis: a causal link + a registered belief (proposed).
     * @returns { ok, hypothesisId, belief }.
     */
    async formHypothesis(causeSignal, effectSignal, mechanism, opts) {
      const o = opts || {};
      if (!causal() || !beliefs()) return { ok: false, error: 'STORES_UNAVAILABLE' };
      const hyp = await causal().create(causeSignal, effectSignal, mechanism);
      const statement = o.statement || (mechanism || (causeSignal + ' affects ' + effectSignal));
      const belief = await beliefs().assert('belief', { statement: statement, subject: effectSignal, cause: causeSignal, effect: effectSignal, hypothesisId: hyp.hypothesisId, confidence: 0.5 });
      if (!belief.ok) return belief;
      return { ok: true, hypothesisId: hyp.hypothesisId, belief: belief.claim };
    },

    /** Design a governed experiment to test a belief (rollback plan required). */
    async designExperiment(beliefId, spec) {
      const s = spec || {};
      if (!experiments() || !beliefs()) return { ok: false, error: 'STORES_UNAVAILABLE' };
      const belief = await beliefs().get(beliefId);
      if (!belief) return { ok: false, error: 'BELIEF_NOT_FOUND' };
      const exp = await experiments().create({
        hypothesis: s.hypothesis || belief.statement,
        assumptions: s.assumptions || ['ceteris paribus over the test window'],
        expectedOutcome: s.expectedOutcome || ('measurable lift in ' + (belief.effect || belief.subject || 'the metric')),
        successCriteria: s.successCriteria || 'effect exceeds noise at the agreed threshold',
        governanceRequired: true,
        rollbackPlan: s.rollbackPlan || 'Revert the tested change for the cohort; no production policy persists without approval.'
      });
      if (!exp.ok) return exp;
      return { ok: true, experiment: exp.experiment, beliefId: beliefId };
    },

    /**
     * Record one evidence observation for a belief's hypothesis and project the
     * belief's status/confidence from the causal verdict.
     */
    async recordEvidence(beliefId, isSupporting) {
      const belief = await beliefs().get(beliefId);
      if (!belief || !belief.basis || !belief.basis.hypothesisId) return { ok: false, error: 'NO_HYPOTHESIS' };
      const res = await causal().appendEvidence(belief.basis.hypothesisId, !!isSupporting);
      if (!res.ok) return res;
      const h = res.hypothesis;
      const status = h.status === 'supported' ? 'supported' : (h.status === 'rejected' ? 'refuted' : 'testing');
      await beliefs().updateFromEvidence(beliefId, { status: status, confidence: h.confidence, evidenceCount: h.evidenceCount });
      return { ok: true, status: status, evidenceCount: h.evidenceCount, confidence: h.confidence };
    },

    /** Promote a sufficiently-supported belief into a theory (knowledge compounds). */
    async concludeAndCompound(beliefId) {
      const belief = await beliefs().get(beliefId);
      if (!belief) return { ok: false, error: 'BELIEF_NOT_FOUND' };
      if (belief.status !== 'supported') return { ok: false, error: 'NOT_SUPPORTED', status: belief.status };
      return beliefs().promoteToTheory(beliefId);
    },

    /** Weekly research agenda: the open questions ranked by bottleneck severity. */
    async researchAgenda(now) {
      const b = await this.identifyBottleneck(now);
      return { generatedAt: clock() && clock().nowISO ? clock().nowISO() : new Date().toISOString(), status: b.status, questions: b.bottlenecks.slice(0, 5) };
    }
  };

  global.AAA_SCIENTIFIC_DISCOVERY_COUNCIL = Council;
})(typeof window !== 'undefined' ? window : this);
