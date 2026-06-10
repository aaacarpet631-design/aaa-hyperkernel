/*
 * AAA Simulation Governance — the gate between imagined futures and production,
 * and the bridge that lets reality grade the kernel's predictions.
 *
 * No simulation-driven action enters a production workflow silently. propose()
 * records a pending recommendation and emits simulation.recommendation_proposed
 * (audited); only a human with authority + a written reason approves it before
 * it can act. (It mirrors the genesis/promotion governance discipline.)
 *
 * Learning loop — when reality eventually occurs, recordActual(runId, actual)
 * compares the predicted (expected) outcome to the real one, computes a
 * per-metric error and an accuracy score, appends it immutably, updates a
 * running calibration bias, and feeds the delta into outcome learning,
 * calibration, and capability reputation when those engines are present. This
 * is how "reality teaches HyperKernel" closes back onto simulation.
 */
;(function (global) {
  'use strict';

  function cfg() { return global.AAA_CONFIG || {}; }
  function data() { return global.AAA_DATA; }
  function clock() { return global.AAA_RUNTIME_CLOCK; }
  function rbac() { return global.AAA_RBAC; }
  function bus() { return global.AAA_EVENT_BUS; }
  function audit() { return global.AAA_AUDIT_LEDGER; }
  function ledger() { return global.AAA_SIM_LEDGER; }
  function estimator() { return global.AAA_OUTCOME_ESTIMATOR; }
  function ws() { return cfg().workspaceId || 'default'; }
  function nowISO() { return clock() && clock().nowISO ? clock().nowISO() : new Date().toISOString(); }
  function canApprove() { const r = rbac(); return r && r.can ? !!r.can('MANAGE_GOVERNANCE') : true; }
  async function log(type, payload) { try { if (audit() && audit().append) await audit().append(type, payload); } catch (_) {} }

  const CAL = 'sim_calibration';

  function defineContracts() {
    const b = bus();
    if (!b || b.contract('simulation.recommendation_proposed')) return;
    b.define('simulation.completed', { version: 1, description: 'A counterfactual simulation finished.', schema: { type: 'object', required: ['runId'], properties: { runId: { type: 'string' }, kind: { type: 'string' }, seed: { type: 'string' } } } });
    b.define('simulation.recommendation_proposed', { version: 1, description: 'A simulation-driven recommendation awaits governance before production.', schema: { type: 'object', required: ['recId', 'runId'], properties: { recId: { type: 'string' }, runId: { type: 'string' }, action: { type: 'string' } } } });
    b.define('simulation.actual_recorded', { version: 1, description: 'Reality was compared to a prediction (learning signal).', schema: { type: 'object', required: ['runId'], properties: { runId: { type: 'string' }, accuracy: { type: 'number' } } } });
  }

  const Governance = {
    /** Propose a simulation-driven recommendation. Never enters production silently. */
    async propose(runId, recommendation) {
      defineContracts();
      const run = await ledger().get(runId);
      if (!run) return { ok: false, error: 'RUN_NOT_FOUND' };
      const rec = await ledger().recordRecommendation({
        runId: runId, action: (recommendation && recommendation.action) || (run.scenario && run.scenario.label) || 'apply scenario',
        scenario: run.scenario, expected: run.outcomes ? run.outcomes.expected : null,
        scorecard: run.scorecard || null, rationale: (recommendation && recommendation.rationale) || null
      });
      try { if (bus()) await bus().publish('simulation.recommendation_proposed', { recId: rec.id, runId: runId, action: rec.action }, { source: 'simulation' }); } catch (_) {}
      await log('simulation.recommendation_proposed', { recId: rec.id, runId: runId, action: rec.action });
      return { ok: true, recommendation: rec };
    },

    /** Approve a recommendation into production — human, authority, written reason. */
    async approve(recId, opts) {
      const o = opts || {};
      if (!canApprove()) return { ok: false, error: 'FORBIDDEN' };
      const reason = String(o.reason == null ? '' : o.reason).trim();
      if (reason.length < 20) return { ok: false, error: 'JUSTIFICATION_REQUIRED', minChars: 20 };
      const rec = await ledger().recommendation(recId);
      if (!rec || rec.status !== 'pending_governance') return { ok: false, error: 'NOT_PENDING' };
      const upd = await ledger().updateRecommendation(recId, { status: 'approved', approvedAt: nowISO(), reason: reason });
      await log('simulation.recommendation_approved', { recId: recId, runId: rec.runId, reason: reason });
      return { ok: true, recommendation: upd };
    },
    async reject(recId, opts) {
      const o = opts || {};
      const rec = await ledger().recommendation(recId);
      if (!rec || rec.status !== 'pending_governance') return { ok: false, error: 'NOT_PENDING' };
      const upd = await ledger().updateRecommendation(recId, { status: 'rejected', decidedAt: nowISO(), reason: String(o.reason || '') });
      await log('simulation.recommendation_rejected', { recId: recId, runId: rec.runId });
      return { ok: true, recommendation: upd };
    },

    /**
     * Reality arrives: compare predicted (expected) vs actual, score accuracy,
     * append immutably, update calibration bias, and fan the delta out to the
     * learning engines that are present. actual: { metric: value, ... }.
     */
    async recordActual(runId, actual) {
      defineContracts();
      const run = await ledger().get(runId);
      if (!run) return { ok: false, error: 'RUN_NOT_FOUND' };
      const predicted = (run.outcomes && run.outcomes.expected) || {};
      const metrics = estimator() ? estimator().METRICS : Object.keys(predicted);
      const errors = {}; const ape = [];
      metrics.forEach((m) => {
        if (actual[m] == null || predicted[m] == null) return;
        const err = actual[m] - predicted[m];
        const denom = Math.abs(actual[m]) > 1e-9 ? Math.abs(actual[m]) : (Math.abs(predicted[m]) > 1e-9 ? Math.abs(predicted[m]) : 1);
        errors[m] = { predicted: predicted[m], actual: actual[m], error: err, absPctError: Math.abs(err) / denom };
        ape.push(Math.abs(err) / denom);
      });
      const mape = ape.length ? ape.reduce((a, b) => a + b, 0) / ape.length : null;
      const accuracy = mape == null ? null : Math.max(0, 1 - mape);

      const actRec = await ledger().recordActual({ runId: runId, kind: run.scenario && run.scenario.kind, predicted: predicted, actual: actual, errors: errors, mape: mape, accuracy: accuracy });

      // Update a running calibration bias per scenario kind (immutable history is
      // the actuals; this is the rolling corrector future estimates can read).
      try { await this._updateCalibration(run.scenario && run.scenario.kind, errors); } catch (_) {}

      // Fan out to the learning engines that exist (defensive; never required).
      try { if (global.AAA_OUTCOME_LEARNING_STORE && global.AAA_OUTCOME_LEARNING_STORE.record) await global.AAA_OUTCOME_LEARNING_STORE.record({ source: 'simulation', runId: runId, accuracy: accuracy }); } catch (_) {}
      try { if (global.AAA_CAPABILITY_LEDGER && run.scenario) await global.AAA_CAPABILITY_LEDGER.linkOutcome(runId, { result: accuracy != null && accuracy >= 0.8 ? 'validated' : 'invalidated', roi: {}, note: 'simulation accuracy ' + (accuracy == null ? 'n/a' : Math.round(accuracy * 100) + '%') }); } catch (_) {}

      try { if (bus()) await bus().publish('simulation.actual_recorded', { runId: runId, accuracy: accuracy == null ? 0 : accuracy }, { source: 'simulation' }); } catch (_) {}
      await log('simulation.actual_recorded', { runId: runId, accuracy: accuracy, mape: mape });
      return { ok: true, actual: actRec, accuracy: accuracy, mape: mape, errors: errors };
    },

    async _updateCalibration(kind, errors) {
      if (!kind) return;
      const id = 'simcal_' + kind;
      const cur = (await data().get(CAL, id)) || { id: id, workspaceId: ws(), kind: kind, n: 0, bias: {} };
      const bias = Object.assign({}, cur.bias);
      Object.keys(errors).forEach((m) => {
        const prev = bias[m] || 0; const e = errors[m].error;
        bias[m] = (prev * cur.n + e) / (cur.n + 1);       // running mean signed error
      });
      await data().put(CAL, id, { id: id, workspaceId: ws(), kind: kind, n: cur.n + 1, bias: bias, updatedAt: nowISO() });
    },

    async calibration(kind) { return data().get(CAL, 'simcal_' + kind); },

    /** Accuracy trend + failed assumptions for the dashboard. */
    async accuracyOverTime() {
      const acts = (await ledger().actuals()).filter((a) => a.accuracy != null).sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')));
      const points = acts.map((a) => ({ runId: a.runId, kind: a.kind, accuracy: a.accuracy, at: a.createdAt }));
      const overall = points.length ? points.reduce((s, p) => s + p.accuracy, 0) / points.length : null;
      // A "failed assumption" = a metric whose abs pct error exceeded a threshold.
      const failedAssumptions = [];
      acts.forEach((a) => { Object.keys(a.errors || {}).forEach((m) => { if (a.errors[m].absPctError > 0.25) failedAssumptions.push({ runId: a.runId, kind: a.kind, metric: m, absPctError: Math.round(a.errors[m].absPctError * 100) / 100 }); }); });
      return { points: points, overall: overall, failedAssumptions: failedAssumptions.slice(0, 20) };
    },

    install() { defineContracts(); return { ok: !!bus() }; }
  };

  global.AAA_SIM_GOVERNANCE = Governance;
})(typeof window !== 'undefined' ? window : this);
