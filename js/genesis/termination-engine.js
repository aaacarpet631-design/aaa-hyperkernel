/*
 * AAA Termination Engine — closes the run and takes the temp's badge.
 *
 * Termination is the guaranteed final step of every ephemeral lifecycle:
 *   - the run record is marked closed (with its outcome preserved forever)
 *   - the agent's scratch context (ephemeral_context) is SCRUBBED — the only
 *     deletion genesis ever performs, and it deletes only its own temp state,
 *     never a business record
 *   - a genesis.terminated event is published and the closure is audited
 *
 * rollback(runId) executes the spec's rollback plan: the run is marked
 * rolled_back and its graph_facts are tombstoned (retracted:true) — facts are
 * append-only, so a retraction is a new state, not an erasure. Idempotent.
 */
;(function (global) {
  'use strict';

  const RUNS = 'genesis_runs';
  const FACTS = 'graph_facts';
  const EPHEMERAL = 'ephemeral_context';

  function data() { return global.AAA_DATA; }
  function clock() { return global.AAA_RUNTIME_CLOCK; }
  function ledger() { return global.AAA_AUDIT_LEDGER; }
  function nowISO() { return clock() && clock().nowISO ? clock().nowISO() : new Date().toISOString(); }

  async function scrub(runId) {
    // The data layer is put/get/list; "scrub" = overwrite with a tombstone that
    // holds no payload. The temp's working memory is gone; the run record stays.
    const existing = await data().get(EPHEMERAL, runId);
    if (!existing) return false;
    await data().put(EPHEMERAL, runId, { id: runId, scrubbed: true, scrubbedAt: nowISO() });
    return true;
  }

  const Engine = {
    /** Close a run: scrub temp context, audit, publish. Idempotent. */
    async close(runId, opts) {
      const o = opts || {};
      const run = await data().get(RUNS, runId);
      if (!run) return { ok: false, error: 'RUN_NOT_FOUND' };
      if (run.closedAt) return { ok: true, run: run, already: true };
      const scrubbed = await scrub(runId);
      const upd = Object.assign({}, run, { closedAt: nowISO(), terminationReason: o.reason || run.status, contextScrubbed: scrubbed });
      await data().put(RUNS, runId, upd);
      try { if (ledger() && ledger().append) await ledger().append('genesis.terminated', { runId: runId, agentId: run.agentId, name: run.name, outcome: run.status, scrubbed: scrubbed }); } catch (_) {}
      try { if (global.AAA_EVENT_BUS) await global.AAA_EVENT_BUS.publish('genesis.terminated', { runId: runId, agentId: run.agentId, outcome: run.status }, { source: 'genesis' }); } catch (_) {}
      return { ok: true, run: upd };
    },

    /** Execute the rollback plan: tombstone this run's graph facts. */
    async rollback(runId, opts) {
      const o = opts || {};
      const run = await data().get(RUNS, runId);
      if (!run) return { ok: false, error: 'RUN_NOT_FOUND' };
      let retracted = 0;
      const facts = await data().list(FACTS);
      for (const f of facts) {
        if (f && f.provenance && f.provenance.runId === runId && !f.retracted) {
          await data().put(FACTS, f.id, Object.assign({}, f, { retracted: true, retractedAt: nowISO(), retractedReason: o.reason || 'rollback' }));
          retracted++;
        }
      }
      const upd = Object.assign({}, run, { status: 'rolled_back', rolledBackAt: nowISO() });
      await data().put(RUNS, runId, upd);
      try { if (ledger() && ledger().append) await ledger().append('genesis.rollback', { runId: runId, name: run.name, retractedFacts: retracted, reason: o.reason || null }); } catch (_) {}
      return { ok: true, retracted: retracted, run: upd };
    }
  };

  global.AAA_TERMINATION_ENGINE = Engine;
})(typeof window !== 'undefined' ? window : this);
