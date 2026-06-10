/*
 * AAA Genesis Council — the orchestrator of the Dynamic Agent Foundry.
 *
 * Static agents are permanent employees; ephemeral agents are temporary
 * specialists. The Council only hires a temp when no employee can do the job,
 * and every hire walks the same ten-step, fully-governed flow:
 *
 *   1. Event enters the Event Bus (typed, contract-validated, hash-chained)
 *   2. The Capability Registry is checked for a permanent handler
 *   3. No handler → the Capability Gap Detector fires (gap persisted)
 *   4. The Agent Factory splices a DNA genome → ephemeral spec
 *   5. The Spawn Policy validates permissions, risk, and cost (audited)
 *   6. The Ephemeral Runtime executes ONE narrow task in a hard sandbox
 *   7. The Decision Log is written (impossible to bypass — runtime-owned)
 *   8. Approved facts land in the Knowledge Graph substrate (graph_facts)
 *   9. The Promotion Engine evaluates keep / improve / discard
 *  10. The Termination Engine scrubs temp context and closes the run
 *
 * needs_approval spawns are HELD (fail-closed): the spec is parked in
 * genesis_holds and nothing executes until a human releases it with a written
 * reason. deny spawns never execute at all. Honest by construction: with no
 * executor and no proxy, the run records AI_NOT_CONFIGURED — never invented.
 */
;(function (global) {
  'use strict';

  const HOLDS = 'genesis_holds';

  function cfg() { return global.AAA_CONFIG || {}; }
  function data() { return global.AAA_DATA; }
  function ids() { return global.AAA_ID_FACTORY; }
  function clock() { return global.AAA_RUNTIME_CLOCK; }
  function bus() { return global.AAA_EVENT_BUS; }
  function rbac() { return global.AAA_RBAC; }
  function detector() { return global.AAA_GAP_DETECTOR; }
  function factory() { return global.AAA_AGENT_FACTORY; }
  function policy() { return global.AAA_SPAWN_POLICY; }
  function runtime() { return global.AAA_EPHEMERAL_RUNTIME; }
  function promotion() { return global.AAA_PROMOTION_ENGINE; }
  function termination() { return global.AAA_TERMINATION_ENGINE; }
  function ws() { return cfg().workspaceId || 'default'; }
  function nowISO() { return clock() && clock().nowISO ? clock().nowISO() : new Date().toISOString(); }
  function newId(p) { return ids() ? ids().createId(p) : p + '_' + Date.now(); }

  // Genesis lifecycle contracts on the typed bus (additive, like the taxonomy).
  function defineContracts() {
    const b = bus();
    if (!b || b.contract('genesis.spawned')) return;
    b.define('photo.uploaded', { version: 1, description: 'A job photo was uploaded (genesis demo trigger).', schema: { type: 'object', required: ['photoId'], properties: { photoId: { type: 'string' }, jobId: { type: 'string' }, customerId: { type: 'string' }, tags: { type: 'array' } } } });
    b.define('genesis.spawned', { version: 1, description: 'The Genesis Council spawned an ephemeral agent.', schema: { type: 'object', required: ['agentId', 'name'], properties: { agentId: { type: 'string' }, name: { type: 'string' }, triggerEvent: { type: 'string' } } } });
    b.define('genesis.terminated', { version: 1, description: 'An ephemeral agent run was closed.', schema: { type: 'object', required: ['runId'], properties: { runId: { type: 'string' }, agentId: { type: 'string' }, outcome: { type: 'string' } } } });
    b.define('genesis.promoted', { version: 1, description: 'An ephemeral agent was promoted to permanent.', schema: { type: 'object', required: ['name'], properties: { name: { type: 'string' }, signature: { type: 'string' } } } });
  }

  const Council = {
    HOLDS: HOLDS,

    /**
     * Steps 2–10 for one typed event. Returns a narrated result:
     * { handledBy:'permanent', handler }            an employee had it
     * { spawned:false, reason:'no_need' }           the event implies no work
     * { spawned:false, held }                       spawn held for approval
     * { spawned:false, denied, reasons }            spawn denied
     * { spawned:true, spec, run, promotion }        full ephemeral lifecycle
     */
    async handleEvent(eventType, payload, opts) {
      const o = opts || {};
      defineContracts();

      // 2–3. permanent registry check → gap
      const inspect = await detector().inspect(eventType, payload);
      if (inspect.handled) return { handledBy: 'permanent', handler: inspect.handler, need: inspect.need };
      if (!inspect.need) return { spawned: false, reason: 'no_need' };

      // 4. splice DNA → spec
      const spliced = factory().splice(Object.assign({ triggerEvent: eventType }, inspect.need));
      if (!spliced.ok) return { spawned: false, denied: true, reasons: spliced.issues || [spliced.error] };
      const spec = spliced.spec;

      // 5. governance enforcer
      const verdict = await policy().evaluate(spec, { spawnedByAgent: !!o.spawnedByAgent, councilApproved: !!o.councilApproved });
      if (verdict.verdict === 'deny') return { spawned: false, denied: true, reasons: verdict.reasons, spec: spec };
      if (verdict.verdict === 'needs_approval') {
        const holdId = newId('hold');
        const hold = { id: holdId, workspaceId: ws(), spec: spec, gapId: inspect.gap ? inspect.gap.id : null, payload: payload || {}, status: 'held', reasons: verdict.reasons, heldAt: nowISO() };
        await data().put(HOLDS, holdId, hold);
        return { spawned: false, held: hold };
      }

      // 6–10. spawn → execute → log → facts → evaluate → terminate
      return this._spawnAndRun(spec, payload, inspect.gap, o);
    },

    async _spawnAndRun(spec, payload, gap, opts) {
      const o = opts || {};
      try { if (bus()) await bus().publish('genesis.spawned', { agentId: spec.agentId, name: spec.name, triggerEvent: spec.triggerEvent }, { source: 'genesis' }); } catch (_) {}

      const run = await runtime().execute(spec, payload, { savedMs: o.savedMs });

      if (gap && gap.id) await data().put(detector().GAPS, gap.id, Object.assign({}, gap, { status: run.status === 'succeeded' ? 'filled' : 'attempted', runId: run.id }));

      // 9. keep / improve / discard — evaluated on every run, promoted only via governance
      const evald = await promotion().evaluate(spec.name);

      // 10. terminate: scrub and close
      const closed = await termination().close(run.id);

      return { spawned: true, spec: spec, run: closed.ok ? closed.run : run, promotion: evald };
    },

    /**
     * Release a held spawn — a human, with authority and a written reason
     * (≥ 20 chars), fail-closed exactly like a governance override.
     */
    async approveHold(holdId, opts) {
      const o = opts || {};
      const r = rbac();
      if (r && r.can && !r.can('OVERRIDE_AI_DECISION')) return { ok: false, error: 'FORBIDDEN' };
      const reason = String(o.reason == null ? '' : o.reason).trim();
      if (reason.length < 20) return { ok: false, error: 'JUSTIFICATION_REQUIRED', minChars: 20 };
      const hold = await data().get(HOLDS, holdId);
      if (!hold || hold.status !== 'held') return { ok: false, error: 'NOT_HELD' };
      await data().put(HOLDS, holdId, Object.assign({}, hold, { status: 'released', releasedAt: nowISO(), reason: reason }));
      const result = await this._spawnAndRun(hold.spec, hold.payload, hold.gapId ? { id: hold.gapId } : null, {});
      return { ok: true, result: result };
    },

    async holds() {
      const all = (await data().list(HOLDS)).filter((r2) => r2 && (r2.workspaceId == null || r2.workspaceId === ws()));
      return all.sort((a, b) => String(b.heldAt || '').localeCompare(String(a.heldAt || '')));
    },

    /** Wire the foundry to live events (gap detector subscriptions). */
    install() {
      defineContracts();
      return detector().install();
    }
  };

  global.AAA_GENESIS_COUNCIL = Council;
})(typeof window !== 'undefined' ? window : this);
