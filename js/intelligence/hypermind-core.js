/*
 * AAA HyperMind Core — the continuous cognition loop (HM-1, "the heartbeat").
 *
 * The intelligence org already exists (collectors, pipeline, debate, outcome
 * learning, calibration, graph, reliability). What it lacked was a HEARTBEAT:
 * something that drives the full cycle on a clock instead of a button. This is
 * that driver. One tick runs the nine canonical phases over the EXISTING
 * modules — it adds no new cognition, it just makes the system run itself:
 *
 *   Observe → Remember → Predict → Plan → Execute → Measure → Learn → Update → Repeat
 *
 * Design rules (matching the rest of the kernel):
 *   • OFF by default. Gated on the owner flag `hypermindEnabled`; boot() is a
 *     no-op until the owner turns it on, so existing behaviour is unchanged.
 *   • Honest + null-tolerant. Every phase is wrapped: a missing module or a
 *     thrown error is recorded as skipped/error on the tick — it never breaks
 *     the loop and never fabricates a result.
 *   • Auditable. Every tick is persisted to `hypermind_ticks` (an append-only
 *     ledger) and logged to agent_logs, so the Command Center can show exactly
 *     what the loop did, when, and what each phase produced.
 *   • Advisory-only in HM-1. The Execute phase delegates to an installed
 *     executor hook (AAA_HYPERMIND_EXECUTOR) if present; HM-1 ships none, so it
 *     observes/learns/retunes-internally but takes NO outward action. HM-4
 *     installs the governed autonomous executor into this exact seam.
 *   • Testable. tick() is the unit of work and is called directly in tests; the
 *     interval (start/stop) only schedules tick(). No real timers in tests.
 */
;(function (global) {
  'use strict';

  function cfg() { return global.AAA_CONFIG; }
  function data() { return global.AAA_DATA; }
  function ids() { return global.AAA_ID_FACTORY; }
  function clock() { return global.AAA_RUNTIME_CLOCK; }

  function now() { return clock() ? clock().now() : Date.now(); }
  function nowISO() { return clock() ? clock().nowISO() : new Date().toISOString(); }
  function newId(p) { return ids() ? ids().createId(p) : (p + '_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8)); }
  function flag(k, d) { return cfg() && cfg().flag ? cfg().flag(k, d) : d; }

  const DEFAULT_INTERVAL_MS = 300000; // 5 min; override via flag hypermindIntervalMs
  const MIN_INTERVAL_MS = 15000;      // floor so a bad config can't busy-loop
  const LEDGER = 'hypermind_ticks';

  // In-memory runtime state (the persisted record of work is the ledger).
  const state = { running: false, timer: null, count: 0, lastTickAt: null, lastStatus: null, lastTickId: null };

  /**
   * Run one phase: call fn(); capture {phase, status, ms, ...}. A phase whose
   * module/method is absent returns 'skipped'; a throw is caught as 'error'.
   * fn may return a small summary object that is merged into the phase record.
   */
  async function runPhase(name, fn) {
    const started = now();
    try {
      const out = await fn();
      if (out && out.__skip) return { phase: name, status: 'skipped', ms: now() - started, note: out.note || 'module unavailable' };
      return Object.assign({ phase: name, status: 'ran', ms: now() - started }, out && typeof out === 'object' ? { summary: out } : {});
    } catch (e) {
      return { phase: name, status: 'error', ms: now() - started, error: String((e && e.message) || e) };
    }
  }

  // Helper: a module/method accessor that signals a clean skip when absent.
  function call(modName, method, args) {
    const m = global[modName];
    if (!m || typeof m[method] !== 'function') return { __skip: true, note: modName + '.' + method + ' unavailable' };
    return m[method].apply(m, args || []);
  }

  const HyperMind = {
    PHASES: ['observe', 'remember', 'predict', 'plan', 'execute', 'measure', 'learn', 'update', 'repeat'],

    // ---- owner controls (persisted, default off) --------------------------
    enabled() { return !!flag('hypermindEnabled', false); },
    intervalMs() { return Math.max(MIN_INTERVAL_MS, Number(flag('hypermindIntervalMs', DEFAULT_INTERVAL_MS)) || DEFAULT_INTERVAL_MS); },
    running() { return !!state.running; },

    /** Turn the loop on/off (persisted). Starts/stops the interval immediately. */
    setEnabled(on) {
      if (cfg() && cfg().set) cfg().set({ hypermindEnabled: !!on });
      if (on) this.start(); else this.stop();
      return this.enabled();
    },

    /** Called at app boot. Starts the loop ONLY if the owner has enabled it. */
    boot() { if (this.enabled()) this.start(); return this.status(); },

    /** Begin the heartbeat. Idempotent. Schedules tick() on the interval. */
    start(opts) {
      opts = opts || {};
      if (state.running) return this.status();
      state.running = true;
      const ms = this.intervalMs();
      if (global.setInterval) {
        state.timer = global.setInterval(() => { this.tick({ source: 'interval' }); }, ms);
        // Don't let the interval keep a Node process alive (no-op in browsers).
        if (state.timer && typeof state.timer.unref === 'function') state.timer.unref();
      }
      if (opts.immediate) this.tick({ source: 'start' });
      return this.status();
    },

    /** Stop the heartbeat (kill switch). Idempotent. Does not change the flag. */
    stop() {
      if (state.timer && global.clearInterval) global.clearInterval(state.timer);
      state.timer = null;
      state.running = false;
      return this.status();
    },

    /**
     * One full cognition cycle over the existing modules. Returns the tick
     * record (also persisted to the ledger). Safe to call directly (tests do).
     * @param {object} [opts] { source?, deep? }  deep also runs the proxy-backed
     *                         intelligence pipeline when it is ready.
     */
    async tick(opts) {
      opts = opts || {};
      const tickId = newId('hmtick');
      const startedAt = now();
      const phases = [];

      // 1) OBSERVE — pull new business signals into the event stream.
      phases.push(await runPhase('observe', () => call('AAA_OUTCOME_INTELLIGENCE', 'ingest')));

      // 2) REMEMBER — refresh memory: relationship graph + job memory + the
      //    queryable knowledge fabric (index over all records).
      phases.push(await runPhase('remember', async () => {
        const graph = await call('AAA_GRAPH', 'stats');
        const fabric = await call('AAA_LEARNING_FABRIC', 'ingest');
        const knowledge = await call('AAA_KNOWLEDGE', 'index');
        return merge({ graph: graph, fabric: fabric, knowledge: knowledge });
      }));

      // 3) PREDICT — evaluate open predictions against the latest reality.
      phases.push(await runPhase('predict', () => call('AAA_PREDICTION_CLOSURE', 'evaluate')));

      // 4) PLAN — produce advisory recommendations from current learning.
      phases.push(await runPhase('plan', async () => {
        const pricing = await call('AAA_PRICING_OPTIMIZER', 'analyze');
        let pipeline = { __skip: true, note: 'deep pipeline not requested' };
        if (opts.deep && global.AAA_INTEL_PIPELINE && global.AAA_INTEL_PIPELINE.isReady && global.AAA_INTEL_PIPELINE.isReady()) {
          pipeline = await global.AAA_INTEL_PIPELINE.runAll({ source: 'hypermind' });
        }
        return merge({ recommendations: pricing, pipeline: pipeline });
      }));

      // 5) EXECUTE — HM-1 takes NO outward action. Delegate to a governed
      //    executor hook if one is installed (HM-4 provides it); else defer.
      phases.push(await runPhase('execute', async () => {
        const exec = global.AAA_HYPERMIND_EXECUTOR;
        if (!exec || typeof exec.run !== 'function') {
          return { __skip: true, note: 'no executor installed — advisory-only (autonomous apply arrives in HM-4)' };
        }
        return await exec.run({ tickId: tickId, source: opts.source || 'tick' });
      }));

      // 6) MEASURE — score agents/predictions against realized outcomes.
      phases.push(await runPhase('measure', async () => {
        const scored = await call('AAA_OUTCOME_INTELLIGENCE', 'scoreAgents');
        const closed = await call('AAA_PREDICTION_CLOSURE', 'close');
        return merge({ scored: scored, closed: closed });
      }));

      // 7) LEARN — recompute learning artifacts (patterns + fabric insights).
      phases.push(await runPhase('learn', async () => {
        const patterns = await call('AAA_OUTCOME_INTELLIGENCE', 'extractPatterns');
        const fabric = await call('AAA_LEARNING_FABRIC', 'refresh');
        return merge({ patterns: patterns, fabric: fabric });
      }));

      // 8) UPDATE — persist refreshed state snapshots for trend + health.
      phases.push(await runPhase('update', async () => {
        const reliability = await call('AAA_RELIABILITY', 'snapshot');
        const rankings = await call('AAA_RANKINGS', 'refresh');
        return merge({ reliability: reliability, rankings: rankings });
      }));

      // 9) REPEAT — record cadence metadata (the interval does the scheduling).
      phases.push({ phase: 'repeat', status: 'ran', ms: 0, nextInMs: state.running ? this.intervalMs() : null });

      const errored = phases.filter((p) => p.status === 'error').length;
      const ran = phases.filter((p) => p.status === 'ran').length;
      const skipped = phases.filter((p) => p.status === 'skipped').length;
      const record = {
        id: tickId, workspaceId: (cfg() && cfg().workspaceId) || null,
        source: opts.source || 'manual', deep: !!opts.deep,
        startedAt: startedAt, at: nowISO(), durationMs: now() - startedAt,
        status: errored ? 'degraded' : 'ok',
        counts: { ran: ran, skipped: skipped, error: errored },
        phases: phases
      };

      await persist(record);
      state.count += 1;
      state.lastTickAt = record.at;
      state.lastStatus = record.status;
      state.lastTickId = tickId;
      try { if (data() && data().logAgent) data().logAgent('hypermind', 'tick ' + record.status + ' (' + ran + ' ran / ' + skipped + ' skipped / ' + errored + ' err)', { tickId: tickId, source: record.source }); } catch (_) {}
      return record;
    },

    // ---- observability (for the Command Center) ---------------------------
    status() {
      return {
        enabled: this.enabled(), running: this.running(), intervalMs: this.intervalMs(),
        tickCount: state.count, lastTickAt: state.lastTickAt, lastStatus: state.lastStatus, lastTickId: state.lastTickId
      };
    },

    async history(limit) {
      if (!data()) return [];
      const all = await data().list(LEDGER);
      return all.slice().sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0)).slice(0, limit || 25);
    },

    /** Aggregate per-phase reliability across recent ticks (for a health panel). */
    async metrics(limit) {
      const ticks = await this.history(limit || 50);
      const phaseStats = {};
      this.PHASES.forEach((p) => { phaseStats[p] = { ran: 0, skipped: 0, error: 0 }; });
      let totalMs = 0;
      ticks.forEach((t) => {
        totalMs += t.durationMs || 0;
        (t.phases || []).forEach((ph) => { if (phaseStats[ph.phase]) phaseStats[ph.phase][ph.status] = (phaseStats[ph.phase][ph.status] || 0) + 1; });
      });
      return {
        ticks: ticks.length, lastTickAt: ticks[0] ? ticks[0].at : null,
        lastStatus: ticks[0] ? ticks[0].status : null,
        avgDurationMs: ticks.length ? Math.round(totalMs / ticks.length) : 0,
        phases: phaseStats, running: this.running(), enabled: this.enabled()
      };
    },

    // test hook: reset in-memory runtime state (does not touch the ledger).
    _reset() { this.stop(); state.count = 0; state.lastTickAt = null; state.lastStatus = null; state.lastTickId = null; }
  };

  // Persist a tick to the append-only ledger (+ mirror to cloud if ready).
  async function persist(record) {
    try { await data().put(LEDGER, record.id, record); } catch (_) {}
    try { if (data().cloudReady && data().cloudReady() && global.AAA_CLOUD) await global.AAA_CLOUD.upsertEntity(LEDGER, record.id, record); } catch (_) {}
    return record;
  }

  // Combine several sub-calls of one phase. If EVERY sub-call cleanly skipped
  // (its module was absent), the whole phase is a clean skip; otherwise return a
  // compact per-part summary so the phase reads as 'ran'.
  function merge(parts) {
    const vals = Object.keys(parts).map((k) => parts[k]);
    const allSkip = vals.length > 0 && vals.every((v) => v && v.__skip);
    if (allSkip) return { __skip: true, note: 'no modules available for this phase' };
    const out = {};
    Object.keys(parts).forEach((k) => { out[k] = summarize(parts[k]); });
    return out;
  }

  // Compress a module result into a compact, ledger-safe summary (no payloads).
  function summarize(r) {
    if (r == null) return null;
    if (r.__skip) return { skipped: true, note: r.note };
    if (typeof r !== 'object') return r;
    const keep = {};
    ['ok', 'added', 'scored', 'scoredAgents', 'patterns', 'totalEvents', 'count', 'closed', 'evaluated', 'updated', 'nodeCount', 'edgeCount', 'total', 'accepted', 'status'].forEach((k) => { if (r[k] != null) keep[k] = r[k]; });
    if (Array.isArray(r.recommendations)) keep.recommendations = r.recommendations.length;
    if (Array.isArray(r.results)) keep.results = r.results.length;
    if (r.stats && typeof r.stats === 'object') { if (r.stats.nodes != null) keep.nodes = r.stats.nodes; if (r.stats.edges != null) keep.edges = r.stats.edges; }
    return Object.keys(keep).length ? keep : { ok: r.ok !== false };
  }

  global.AAA_HYPERMIND = HyperMind;
})(typeof window !== 'undefined' ? window : this);
