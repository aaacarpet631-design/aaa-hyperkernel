/*
 * AAA Causal Hypothesis Store — the governed causal layer.
 *
 * Hypotheses connect a cause signal to an effect signal with a proposed
 * mechanism. Evidence is APPEND-ONLY (causal_evidence); the hypothesis's
 * counts, confidence, and status are projected from that evidence via the
 * Causal Learning Engine — so a hypothesis can never be hand-waved to
 * "supported": only accumulated, low-counter-evidence observations get it
 * there. Status transitions emit causal.status_changed.
 *
 * Schema: hypothesisId, causeSignal, effectSignal, proposedMechanism,
 * evidenceCount, counterEvidenceCount, confidence,
 * status(proposed|testing|supported|rejected), lastEvaluatedAt.
 */
;(function (global) {
  'use strict';

  const HYP = 'causal_hypotheses';
  const EV = 'causal_evidence';

  function cfg() { return global.AAA_CONFIG || {}; }
  function data() { return global.AAA_DATA; }
  function ids() { return global.AAA_ID_FACTORY; }
  function clock() { return global.AAA_RUNTIME_CLOCK; }
  function learning() { return global.AAA_CAUSAL_LEARNING_ENGINE; }
  function bus() { return global.AAA_EVENT_BUS; }
  function ws() { return cfg().workspaceId || 'default'; }
  function nowISO() { return clock() && clock().nowISO ? clock().nowISO() : new Date().toISOString(); }
  function mine(r) { return r && (r.workspaceId == null || r.workspaceId === ws()); }
  function newId(p) { return ids() ? ids().createId(p) : p + '_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7); }

  const Store = {
    HYP: HYP, EV: EV,

    /** Create a hypothesis (status 'proposed'; no evidence yet). */
    async create(causeSignal, effectSignal, proposedMechanism) {
      const id = newId('hyp');
      const rec = {
        hypothesisId: id, workspaceId: ws(),
        causeSignal: causeSignal, effectSignal: effectSignal, proposedMechanism: proposedMechanism || null,
        evidenceCount: 0, counterEvidenceCount: 0, confidence: 0.5, status: 'proposed',
        createdAt: nowISO(), lastEvaluatedAt: nowISO()
      };
      await data().put(HYP, id, rec);
      return rec;
    },

    /** Append one immutable evidence observation and re-project status. */
    async appendEvidence(hypothesisId, isSupporting, meta) {
      const hyp = await data().get(HYP, hypothesisId);
      if (!hyp || !mine(hyp)) return { ok: false, error: 'HYPOTHESIS_NOT_FOUND' };
      const evId = newId('cev');
      await data().put(EV, evId, { id: evId, workspaceId: ws(), hypothesisId: hypothesisId, supporting: !!isSupporting, meta: meta || null, at: nowISO() });

      const all = (await data().list(EV)).filter(mine).filter((e) => e.hypothesisId === hypothesisId);
      const support = all.filter((e) => e.supporting).length;
      const counter = all.length - support;
      const evalr = learning().evaluate(support, counter);

      const prevStatus = hyp.status;
      const upd = Object.assign({}, hyp, { evidenceCount: support, counterEvidenceCount: counter, confidence: evalr.confidence, status: evalr.status, lastEvaluatedAt: nowISO() });
      await data().put(HYP, hypothesisId, upd);
      if (evalr.status !== prevStatus) { try { if (bus() && bus().contract('causal.status_changed')) await bus().publish('causal.status_changed', { hypothesisId: hypothesisId, status: evalr.status }, { source: 'world_model' }); } catch (_) {} }
      return { ok: true, status: evalr.status, hypothesis: upd };
    },

    async get(hypothesisId) { const r = await data().get(HYP, hypothesisId); return mine(r) ? r : null; },
    async evidence(hypothesisId) { return (await data().list(EV)).filter(mine).filter((e) => e.hypothesisId === hypothesisId).sort((a, b) => String(a.at).localeCompare(String(b.at))); },
    async list() { return (await data().list(HYP)).filter(mine).sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || ''))); },

    /** Causal maturity: supported / total (null when no hypotheses exist). */
    async metrics() {
      const all = await this.list();
      if (!all.length) return { count: 0, supported: 0, rejected: 0, maturity: null };
      const supported = all.filter((h) => h.status === 'supported').length;
      const rejected = all.filter((h) => h.status === 'rejected').length;
      return { count: all.length, supported: supported, rejected: rejected, maturity: supported / all.length };
    }
  };

  global.AAA_CAUSAL_HYPOTHESIS_STORE = Store;
})(typeof window !== 'undefined' ? window : this);
