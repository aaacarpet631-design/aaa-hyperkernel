/*
 * AAA Self-Improvement — the engine that closes the learning loop (Layer 13).
 *
 * The Supervisor scores each agent decision against the real won/lost outcome
 * (Brier calibration). This engine reads that real track record and, for any
 * agent with enough scored decisions, asks Claude to diagnose — grounded ONLY
 * in the supplied record — whether the agent is over/under-confident and what
 * guidance would have improved it. The diagnosis is written back as a TUNING:
 *   - confidenceBias: a clamped ±adjustment applied to future confidence
 *   - promptAddendum: concrete guidance appended to the agent's system prompt
 * The registry applies the addendum (AAA_AGENTS.get) and the orchestrator
 * applies the bias (agent-os), so the next decisions actually change and get
 * re-scored. Honest by construction: gated on the proxy, refuses below the
 * minimum sample, and never invents numbers — every input is real memory.
 */
;(function (global) {
  'use strict';

  const MIN_SCORED = 3;          // need at least this many scored decisions to tune
  const BIAS_CLAMP = 25;         // confidence nudge is bounded to ±25 points

  function data() { return global.AAA_DATA; }
  function cfg() { return global.AAA_CONFIG || {}; }
  function reg() { return global.AAA_AGENTS; }
  function clock() { return global.AAA_RUNTIME_CLOCK; }

  function round(n, p) { const f = Math.pow(10, p || 2); return Math.round(n * f) / f; }
  function mean(a) { return a.length ? a.reduce((x, y) => x + y, 0) / a.length : null; }

  const TUNING_SCHEMA = {
    type: 'object',
    properties: {
      confidenceBias: { type: 'integer', description: 'Signed adjustment (-25..25) to add to this agent\'s future confidence. Negative if it is overconfident (high confidence but losing), positive if underconfident (low confidence but winning), 0 if well-calibrated.' },
      promptAddendum: { type: 'string', description: 'Concise, concrete guidance (<= 600 chars) to append to this agent\'s instructions, drawn ONLY from the supplied record. Empty string if the record shows no actionable pattern.' },
      summary: { type: 'string', description: 'One sentence: what changed and why, citing the record.' },
      calibration: { type: 'string', enum: ['overconfident', 'underconfident', 'well_calibrated', 'insufficient'], description: 'Your read of this agent\'s calibration.' }
    },
    required: ['confidenceBias', 'promptAddendum', 'summary', 'calibration'],
    additionalProperties: false
  };

  const SYSTEM = 'You are the Self-Improvement engine for an AI operations team at a carpet-cleaning company. ' +
    'You are given ONE agent\'s real decision track record: each decision\'s recommendation, the confidence it stated, ' +
    'and the actual business outcome (won/lost) plus a calibration score (1=perfectly calibrated, 0=worst). ' +
    'Diagnose calibration and propose a tuning that would have improved this agent, grounded ONLY in the supplied record. ' +
    'Do not invent facts not present. If the record is too thin or shows no pattern, return confidenceBias 0, an empty ' +
    'promptAddendum, and calibration "insufficient". Be specific and operational. Respond ONLY as JSON matching the schema.';

  // Build the real, joined record for one agent: scored decisions + their outcome.
  async function recordFor(agentId, decisions, outByJob, outById) {
    const mine = decisions.filter((d) => d && (d.agent === agentId) && typeof d.score === 'number');
    const rows = mine.map((d) => {
      const o = (d.outcomeId && outById[d.outcomeId]) || (d.jobId && outByJob[d.jobId]) || null;
      return {
        recommendation: String(d.recommendation || d.decision || '').slice(0, 200),
        confidence: d.confidence,
        result: o ? o.result : null,
        score: d.score
      };
    }).filter((r) => r.result === 'won' || r.result === 'lost');
    const confs = rows.map((r) => r.confidence).filter((n) => typeof n === 'number');
    const won = rows.filter((r) => r.result === 'won').length;
    return {
      agentId: agentId,
      scoredCount: rows.length,
      winRate: rows.length ? round(won / rows.length, 3) : null,
      avgConfidence: confs.length ? round(mean(confs), 1) : null,
      avgCalibration: rows.length ? round(mean(rows.map((r) => r.score)), 3) : null,
      decisions: rows.slice(0, 24) // cap context; real sample, newest-first not required for stats
    };
  }

  async function loadOutcomeMaps() {
    const outcomes = await data().list('outcomes');
    const byJob = {}; const byId = {};
    outcomes.forEach((o) => { if (o.jobId) byJob[o.jobId] = o; byId[o.id] = o; });
    return { byJob: byJob, byId: byId };
  }

  async function persistTuning(rec) {
    await data().put('agent_tunings', rec.id, rec);
    try {
      if (data().cloudReady && data().cloudReady() && global.AAA_CLOUD) {
        await global.AAA_CLOUD.upsertEntity('agent_tunings', rec.id, rec);
      }
    } catch (_) {}
    if (reg() && reg().setTuning) reg().setTuning(rec.agentId, rec);
  }

  const Engine = {
    MIN_SCORED: MIN_SCORED,

    /** Proxy must be live to call the model. */
    isReady() {
      return !!(data() && reg() && cfg().isProxyConfigured && cfg().isProxyConfigured());
    },

    /**
     * Survey every agent's real track record. Returns who is eligible to tune.
     * Pure read — no model calls, no writes.
     */
    async analyze() {
      if (!data() || !reg()) return { ok: false, error: 'NO_DATA_LAYER' };
      const decisions = await data().list('agent_decisions');
      const maps = await loadOutcomeMaps();
      const ids = {};
      decisions.forEach((d) => { if (d && d.agent) ids[d.agent] = true; });
      const agents = [];
      for (const id of Object.keys(ids)) {
        const r = await recordFor(id, decisions, maps.byJob, maps.byId);
        const existing = await this.getTuning(id);
        agents.push({
          agentId: id,
          title: (reg().get(id) && reg().get(id).title) || id,
          scoredCount: r.scoredCount,
          winRate: r.winRate,
          avgConfidence: r.avgConfidence,
          avgCalibration: r.avgCalibration,
          eligible: r.scoredCount >= MIN_SCORED,
          tuned: !!existing,
          tuning: existing || null
        });
      }
      agents.sort((a, b) => (b.scoredCount - a.scoredCount));
      const eligible = agents.filter((a) => a.eligible).length;
      return { ok: true, agents: agents, eligible: eligible, minScored: MIN_SCORED };
    },

    /**
     * Learn from one agent's real record and write back a tuning.
     * @param {string} agentId
     */
    async improveAgent(agentId) {
      if (!this.isReady()) return { ok: false, error: 'AI_NOT_CONFIGURED', agentId: agentId };
      const base = reg().get(agentId);
      if (!base) return { ok: false, error: 'UNKNOWN_AGENT', agentId: agentId };
      const decisions = await data().list('agent_decisions');
      const maps = await loadOutcomeMaps();
      const record = await recordFor(agentId, decisions, maps.byJob, maps.byId);
      if (record.scoredCount < MIN_SCORED) {
        return { ok: false, error: 'INSUFFICIENT_DATA', agentId: agentId, scoredCount: record.scoredCount, need: MIN_SCORED };
      }

      const res = await data().callAgent({
        agent: 'self_improvement', model: 'claude-opus-4-8', max_tokens: 900,
        system: SYSTEM,
        output_config: { format: { type: 'json_schema', schema: TUNING_SCHEMA } },
        messages: [{ role: 'user', content:
          'AGENT: ' + (base.title || agentId) +
          '\nCURRENT INSTRUCTIONS:\n' + String(base.system || '').slice(0, 1200) +
          '\n\nREAL TRACK RECORD (JSON):\n' + JSON.stringify(record, null, 2) +
          '\n\nPropose a tuning per the schema. Ground every claim in the record above.' }]
      });
      if (!res || res.ok === false) return { ok: false, error: (res && res.error) || 'CALL_FAILED', agentId: agentId };

      // Reuse the orchestrator's tolerant parser when present; fall back locally.
      let parsed = null;
      try { parsed = JSON.parse(res.text); } catch (_) {
        const s = String(res.text || ''); const i = s.indexOf('{'); const j = s.lastIndexOf('}');
        if (i !== -1 && j > i) { try { parsed = JSON.parse(s.slice(i, j + 1)); } catch (_) {} }
      }
      if (!parsed || typeof parsed !== 'object') return { ok: false, error: 'BAD_OUTPUT', agentId: agentId, raw: res.text };

      const bias = Math.max(-BIAS_CLAMP, Math.min(BIAS_CLAMP, Math.round(+parsed.confidenceBias || 0)));
      const prev = await this.getTuning(agentId);
      const now = clock() ? clock().now() : Date.now();
      const rec = {
        id: agentId,                 // one live tuning per agent (keyed by id)
        agentId: agentId,
        version: prev ? (prev.version || 1) + 1 : 1,
        confidenceBias: bias,
        promptAddendum: String(parsed.promptAddendum || '').slice(0, 600),
        summary: String(parsed.summary || ''),
        calibration: parsed.calibration || 'well_calibrated',
        basedOn: { scoredCount: record.scoredCount, winRate: record.winRate, avgConfidence: record.avgConfidence, avgCalibration: record.avgCalibration },
        createdAt: prev ? prev.createdAt : now, updatedAt: now,
        history: prev ? (prev.history || []).concat([{ version: prev.version, confidenceBias: prev.confidenceBias, promptAddendum: prev.promptAddendum, at: prev.updatedAt }]) : []
      };
      await persistTuning(rec);
      try { if (data().logAgent) data().logAgent('self_improvement', 'Tuned "' + (base.title || agentId) + '" (' + rec.calibration + ', bias ' + (bias >= 0 ? '+' : '') + bias + ')', { agentId: agentId, version: rec.version }); } catch (_) {}
      return { ok: true, agentId: agentId, tuning: rec };
    },

    /** Improve every eligible agent. Returns per-agent results. */
    async improveAll() {
      if (!this.isReady()) return { ok: false, error: 'AI_NOT_CONFIGURED' };
      const a = await this.analyze();
      if (!a.ok) return a;
      const eligible = a.agents.filter((x) => x.eligible);
      if (!eligible.length) return { ok: false, error: 'INSUFFICIENT_DATA', need: MIN_SCORED };
      const results = [];
      for (const x of eligible) results.push(await this.improveAgent(x.agentId));
      return { ok: true, improved: results.filter((r) => r.ok).length, results: results };
    },

    async list() { return data() ? data().list('agent_tunings') : []; },
    async getTuning(agentId) { return data() ? data().get('agent_tunings', agentId) : null; },

    /** Remove a tuning entirely (agent reverts to its base behavior). */
    async revert(agentId) {
      if (!data()) return { ok: false, error: 'NO_DATA_LAYER' };
      const rec = await this.getTuning(agentId);
      if (!rec) return { ok: false, error: 'NOT_FOUND' };
      // Tombstone so cloud mirrors converge; registry drops it immediately.
      const now = clock() ? clock().now() : Date.now();
      const dead = Object.assign({}, rec, { confidenceBias: 0, promptAddendum: '', summary: 'reverted', calibration: 'well_calibrated', reverted: true, updatedAt: now });
      await data().put('agent_tunings', agentId, dead);
      try { if (data().cloudReady && data().cloudReady() && global.AAA_CLOUD) await global.AAA_CLOUD.upsertEntity('agent_tunings', agentId, dead); } catch (_) {}
      if (reg() && reg().setTuning) reg().setTuning(agentId, null);
      return { ok: true, agentId: agentId };
    },

    /** Load saved tunings into the registry on boot so they're applied. */
    async loadTunings() {
      try {
        const all = await this.list();
        let n = 0;
        all.forEach((rec) => {
          if (rec && !rec.reverted && reg() && reg().setTuning) { reg().setTuning(rec.agentId, rec); n++; }
        });
        return n;
      } catch (_) { return 0; }
    }
  };

  global.AAA_SELF_IMPROVEMENT = Engine;
})(typeof window !== 'undefined' ? window : this);
