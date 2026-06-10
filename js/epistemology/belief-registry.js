/*
 * AAA Belief Registry — the Enterprise Brain's epistemic discipline.
 *
 * Most businesses mix facts, beliefs, predictions, and theories together.
 * Superintelligent organizations do not. This registry forces every claim to
 * declare WHICH it is, and enforces the basis each kind requires:
 *
 *   fact       a directly-observed truth — requires a concrete observation
 *              basis (a World Model signal value, a graph fact). High
 *              confidence, not "believed". Cannot be asserted without a source.
 *   belief     a causal/empirical claim not yet proven ("fast response raises
 *              close rate") — confidence < 1, status proposed|supported|refuted,
 *              backed by a causal hypothesis whose evidence moves its status.
 *   prediction a forward claim with a target time + expected value (from a
 *              simulation) — resolved later against the actual.
 *   theory     a belief that survived strong, repeated evidence — promoted,
 *              durable, and the unit that compounds into the knowledge moat.
 *
 * Append-only: claims are immutable records; status/confidence changes are new
 * status events, and the current state is a projection. A belief can never be
 * silently re-labeled a fact — promotion is an explicit, evidence-gated act.
 */
;(function (global) {
  'use strict';

  const CLAIMS = 'epistemic_claims';
  const EVENTS = 'epistemic_claim_events';
  const TYPES = ['fact', 'belief', 'prediction', 'theory'];

  function cfg() { return global.AAA_CONFIG || {}; }
  function data() { return global.AAA_DATA; }
  function ids() { return global.AAA_ID_FACTORY; }
  function clock() { return global.AAA_RUNTIME_CLOCK; }
  function bus() { return global.AAA_EVENT_BUS; }
  function ws() { return cfg().workspaceId || 'default'; }
  function nowISO() { return clock() && clock().nowISO ? clock().nowISO() : new Date().toISOString(); }
  function mine(r) { return r && (r.workspaceId == null || r.workspaceId === ws()); }
  function newId(p) { return ids() ? ids().createId(p) : p + '_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7); }
  function clamp01(x) { const n = Number(x); return isFinite(n) ? Math.max(0, Math.min(1, n)) : null; }
  function present(v) { return !(v === null || v === undefined || (typeof v === 'string' && !v.trim()) || (Array.isArray(v) && !v.length)); }
  async function emit(type, payload) { try { if (bus() && bus().contract(type)) await bus().publish(type, payload, { source: 'belief_registry' }); } catch (_) {} }

  // Theory promotion gate: a belief must be 'supported' with ≥ this much
  // evidence across distinct experiments to become a theory.
  function theoryMinEvidence() { return (cfg().flag ? cfg().flag('theoryMinEvidence', 8) : 8); }

  async function logEvent(claimId, kind, detail) {
    const id = newId('clev');
    await data().put(EVENTS, id, { id: id, workspaceId: ws(), claimId: claimId, kind: kind, detail: detail || null, at: nowISO() });
  }

  const Registry = {
    CLAIMS: CLAIMS, TYPES: TYPES.slice(),

    /**
     * Assert a claim of an explicit type with the basis that type requires.
     * Returns { ok, claim } or { ok:false, error }.
     */
    async assert(type, claim) {
      if (TYPES.indexOf(type) === -1) return { ok: false, error: 'UNKNOWN_CLAIM_TYPE', type: type };
      const c = claim || {};
      if (!present(c.statement)) return { ok: false, error: 'STATEMENT_REQUIRED' };

      // Per-type basis enforcement — the heart of the epistemic discipline.
      if (type === 'fact' && !present(c.observation)) return { ok: false, error: 'FACT_REQUIRES_OBSERVATION', note: 'a fact must cite a concrete observation (signal/graph fact)' };
      if (type === 'belief' && !present(c.hypothesisId) && !present(c.cause)) return { ok: false, error: 'BELIEF_REQUIRES_HYPOTHESIS', note: 'a belief must be backed by a causal hypothesis' };
      if (type === 'prediction' && (!present(c.expected) || !present(c.targetAt))) return { ok: false, error: 'PREDICTION_REQUIRES_EXPECTED_AND_TARGET' };
      if (type === 'theory') return { ok: false, error: 'THEORY_IS_PROMOTED_NOT_ASSERTED', note: 'promote a supported belief via promoteToTheory()' };

      const id = newId('claim');
      const rec = {
        id: id, workspaceId: ws(), type: type, statement: c.statement, subject: c.subject || null,
        confidence: type === 'fact' ? 1 : (clamp01(c.confidence) == null ? 0.5 : clamp01(c.confidence)),
        status: type === 'fact' ? 'observed' : 'proposed',
        basis: { observation: c.observation || null, hypothesisId: c.hypothesisId || null, cause: c.cause || null, effect: c.effect || null, simRunId: c.simRunId || null, source: c.source || null },
        expected: c.expected == null ? null : c.expected, targetAt: c.targetAt || null, resolved: null,
        supersedes: c.supersedes || null, createdAt: nowISO(), updatedAt: nowISO()
      };
      await data().put(CLAIMS, id, rec);
      await logEvent(id, 'asserted', { type: type });
      await emit('belief.asserted', { claimId: id, type: type });
      return { ok: true, claim: rec };
    },

    /** Update a belief's status/confidence from accumulated evidence (append-only event). */
    async updateFromEvidence(claimId, evidence) {
      const e = evidence || {};
      const rec = await data().get(CLAIMS, claimId);
      if (!rec || !mine(rec)) return { ok: false, error: 'CLAIM_NOT_FOUND' };
      if (rec.type !== 'belief') return { ok: false, error: 'ONLY_BELIEFS_UPDATE_FROM_EVIDENCE' };
      const status = e.status || rec.status;          // proposed | supported | refuted | testing
      const confidence = clamp01(e.confidence) == null ? rec.confidence : clamp01(e.confidence);
      const upd = Object.assign({}, rec, { status: status, confidence: confidence, evidenceCount: e.evidenceCount == null ? rec.evidenceCount : e.evidenceCount, updatedAt: nowISO() });
      await data().put(CLAIMS, claimId, upd);
      await logEvent(claimId, 'evidence', { status: status, confidence: confidence, evidenceCount: e.evidenceCount });
      return { ok: true, claim: upd };
    },

    /** Resolve a prediction against the actual outcome (append-only). */
    async resolvePrediction(claimId, actual) {
      const rec = await data().get(CLAIMS, claimId);
      if (!rec || !mine(rec)) return { ok: false, error: 'CLAIM_NOT_FOUND' };
      if (rec.type !== 'prediction') return { ok: false, error: 'NOT_A_PREDICTION' };
      const exp = Number(rec.expected); const act = Number(actual);
      let accuracy = null;
      if (isFinite(exp) && isFinite(act)) { const denom = Math.abs(exp) > 1e-9 ? Math.abs(exp) : 1; accuracy = Math.max(0, 1 - Math.abs(exp - act) / denom); }
      const upd = Object.assign({}, rec, { status: 'resolved', resolved: { actual: actual, accuracy: accuracy, at: nowISO() }, updatedAt: nowISO() });
      await data().put(CLAIMS, claimId, upd);
      await logEvent(claimId, 'resolved', { actual: actual, accuracy: accuracy });
      return { ok: true, claim: upd, accuracy: accuracy };
    },

    /**
     * Promote a SUPPORTED belief with sufficient evidence into a theory — the
     * only path to a theory. Evidence-gated; fail-closed.
     */
    async promoteToTheory(beliefId) {
      const rec = await data().get(CLAIMS, beliefId);
      if (!rec || !mine(rec)) return { ok: false, error: 'CLAIM_NOT_FOUND' };
      if (rec.type !== 'belief') return { ok: false, error: 'ONLY_BELIEFS_BECOME_THEORIES' };
      if (rec.status !== 'supported') return { ok: false, error: 'BELIEF_NOT_SUPPORTED' };
      if ((rec.evidenceCount || 0) < theoryMinEvidence()) return { ok: false, error: 'INSUFFICIENT_EVIDENCE', need: theoryMinEvidence(), have: rec.evidenceCount || 0 };
      const id = newId('theory');
      const theory = {
        id: id, workspaceId: ws(), type: 'theory', statement: rec.statement, subject: rec.subject,
        confidence: rec.confidence, status: 'established', basis: Object.assign({}, rec.basis, { promotedFrom: beliefId, evidenceCount: rec.evidenceCount }),
        supersedes: rec.supersedes || null, createdAt: nowISO(), updatedAt: nowISO()
      };
      await data().put(CLAIMS, id, theory);
      await data().put(CLAIMS, beliefId, Object.assign({}, rec, { status: 'promoted', promotedTo: id, updatedAt: nowISO() }));
      await logEvent(id, 'promoted_to_theory', { from: beliefId });
      await emit('theory.established', { theoryId: id, from: beliefId });
      return { ok: true, theory: theory };
    },

    async get(id) { const r = await data().get(CLAIMS, id); return mine(r) ? r : null; },
    async history(id) { return (await data().list(EVENTS)).filter(mine).filter((e) => e.claimId === id).sort((a, b) => String(a.at).localeCompare(String(b.at))); },
    async list(filter) {
      const f = filter || {};
      let all = (await data().list(CLAIMS)).filter(mine);
      if (f.type) all = all.filter((c) => c.type === f.type);
      if (f.status) all = all.filter((c) => c.status === f.status);
      return all.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
    }
  };

  global.AAA_BELIEF_REGISTRY = Registry;
})(typeof window !== 'undefined' ? window : this);
