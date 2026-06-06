/*
 * AAA Outcome Intelligence Engine — turn outcomes into agent scores + patterns.
 *
 * Closes the loop from "outcome stored" to "agent scored / pattern learned":
 *   - records a normalized outcome_events stream (quote_sent / won / lost /
 *     margin_achieved / review_received / response_time / clv_updated),
 *     idempotently derivable from existing quotes so it works on real history;
 *   - scores EVERY agent (agent_scores) from prediction closures + the Supervisor
 *     track record + decision volume, and snapshots accuracy over time
 *     (agent_accuracy) for trends;
 *   - extracts learning_patterns (segments that close/earn better) from the
 *     Outcome Learning aggregates — surfaced as evidence, never auto-applied.
 *
 * Observational + advisory: it writes its own analytics collections only; it
 * NEVER mutates a quote, price, margin, or customer record, and it changes no
 * agent behavior on its own (calibration stays human-gated). Reuses existing
 * seams (AAA_OUTCOME_LEARNING, AAA_PREDICTION_CLOSURE, AAA_SUPERVISOR,
 * AAA_EVENT_BUS, AAA_QUOTES). Owner-only collections. Null-tolerant; deterministic.
 */
;(function (global) {
  'use strict';

  const EVENTS = 'outcome_events';
  const SCORES = 'agent_scores';
  const ACCURACY = 'agent_accuracy';
  const PATTERNS = 'learning_patterns';
  const TYPES = ['quote_sent', 'quote_won', 'quote_lost', 'margin_achieved', 'review_received', 'response_time', 'clv_updated'];

  function cfg() { return global.AAA_CONFIG || {}; }
  function data() { return global.AAA_DATA; }
  function ids() { return global.AAA_ID_FACTORY; }
  function clock() { return global.AAA_RUNTIME_CLOCK; }
  function quotes() { return global.AAA_QUOTES; }
  function learning() { return global.AAA_OUTCOME_LEARNING; }
  function closure() { return global.AAA_PREDICTION_CLOSURE; }
  function supervisor() { return global.AAA_SUPERVISOR; }
  function bus() { return global.AAA_EVENT_BUS; }
  function ws() { return cfg().workspaceId || 'default'; }
  function nowISO() { return clock() && clock().nowISO ? clock().nowISO() : new Date().toISOString(); }
  function mine(r) { return r && (r.workspaceId == null || r.workspaceId === ws()); }
  function newId(p) { return ids() ? ids().createId(p) : p + '_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7); }
  function num(v) { const n = Number(v); return isFinite(n) ? n : null; }
  async function quiet(fn, dflt) { try { return await fn(); } catch (_) { return dflt; } }

  const Engine = {
    EVENTS: EVENTS, SCORES: SCORES, ACCURACY: ACCURACY, PATTERNS: PATTERNS, TYPES: TYPES,

    // ---- outcome event stream ----------------------------------------------
    /** Append an outcome event (immutable). Optionally a deterministic id makes
     *  it idempotent (used by ingest). Mirrors to the event bus if present. */
    async record(type, payload, opts) {
      const o = opts || {};
      if (TYPES.indexOf(type) === -1) return { ok: false, error: 'UNKNOWN_TYPE' };
      const id = o.id || newId('oe');
      if (o.id && (await data().get(EVENTS, id))) return { ok: true, already: true, id: id }; // idempotent
      const p = payload || {};
      const rec = { id: id, workspaceId: ws(), type: type, quoteId: p.quoteId || null, jobId: p.jobId || null, customerId: p.customerId || null, agent: p.agent || null, value: p.value != null ? p.value : null, segment: p.segment || null, at: p.at || nowISO() };
      await put(EVENTS, rec);
      try { if (bus() && bus().contract && bus().contract('outcome.' + type)) bus().publish('outcome.' + type, { id: id, quoteId: rec.quoteId }, { source: 'outcome-intel' }); } catch (_) {}
      return { ok: true, id: id, event: rec };
    },

    /** Derive outcome events from existing resolved quotes (idempotent). */
    async ingest() {
      const qs = await listQuotes();
      let added = 0;
      for (const q of qs) {
        const qid = q.quoteId || q.id; if (!qid) continue;
        const resolved = q.status === 'won' || q.status === 'lost';
        if (q.sentAt) added += await ensure('quote_sent', 'oe_sent_' + qid, { quoteId: qid, jobId: q.jobId || null, customerId: q.customerId || null, at: q.sentAt });
        if (resolved) {
          added += await ensure(q.status === 'won' ? 'quote_won' : 'quote_lost', 'oe_' + q.status + '_' + qid, { quoteId: qid, jobId: q.jobId || null, customerId: q.customerId || null, at: q.resolvedAt || q.updatedAt || nowISO() });
          if (q.status === 'won' && q.marginPct != null) added += await ensure('margin_achieved', 'oe_margin_' + qid, { quoteId: qid, value: num(q.marginPct), at: q.resolvedAt || nowISO() });
          if (q.sentAt && q.resolvedAt) { const days = Math.round((Date.parse(q.resolvedAt) - Date.parse(q.sentAt)) / 86400000); if (isFinite(days) && days >= 0) added += await ensure('response_time', 'oe_resp_' + qid, { quoteId: qid, value: days, at: q.resolvedAt }); }
        }
      }
      return { ok: true, added: added };
    },

    async events(filter) { const f = filter || {}; let all = (await data().list(EVENTS)).filter(mine); if (f.type) all = all.filter((e) => e.type === f.type); if (f.customerId) all = all.filter((e) => e.customerId === f.customerId); return all.sort((a, b) => String(b.at || '').localeCompare(String(a.at || ''))); },

    // ---- agent scoring ------------------------------------------------------
    /** Score every agent from closures + Supervisor track record + decision
     *  volume. Persists agent_scores (current) + agent_accuracy (a snapshot). */
    async scoreAgents() {
      const acc = {}; // agent -> partial
      const touch = (a) => (acc[a] = acc[a] || { agent: a, accuracy: null, validated: 0, contradicted: 0, sample: 0, decisions: 0 });

      // prediction-closure validation → accuracy
      const cal = await quiet(() => (closure() && closure().calibrationSummary ? closure().calibrationSummary() : null), null);
      if (cal && cal.agents) cal.agents.forEach((a) => { const p = touch(a.agent); const concl = num(a.validated) + num(a.contradicted) || 0; p.validated = num(a.validated) || 0; p.contradicted = num(a.contradicted) || 0; p.sample = concl; if (concl > 0) p.accuracy = Math.round((p.validated / concl) * 100); });

      // supervisor per-agent avgScore (fills agents without closures)
      const sm = await quiet(() => (supervisor() && supervisor().metrics ? supervisor().metrics() : null), null);
      if (sm && sm.perAgent) Object.keys(sm.perAgent).forEach((a) => { const p = touch(a); p.decisions = num(sm.perAgent[a].decisions) || p.decisions; if (p.accuracy == null && typeof sm.perAgent[a].avgScore === 'number') { p.accuracy = Math.round(sm.perAgent[a].avgScore * 100); p.sample = num(sm.perAgent[a].scoredCount) || p.sample; } });

      // decision volume from agent_decisions
      const decisions = await quiet(() => data().list('agent_decisions'), []);
      decisions.forEach((d) => { if (!d || !mine(d)) return; const p = touch(d.agent || 'unknown'); p.decisions = (p.decisions || 0) + 0; });
      const volByAgent = {}; decisions.forEach((d) => { if (d && mine(d)) volByAgent[d.agent || 'unknown'] = (volByAgent[d.agent || 'unknown'] || 0) + 1; });

      const at = nowISO();
      const board = [];
      for (const a of Object.keys(acc)) {
        const p = acc[a];
        const decisionsCount = Math.max(p.decisions || 0, volByAgent[a] || 0);
        // composite score: accuracy tempered by sample confidence (more evidence → trust the number).
        const confidence = p.sample > 0 ? Math.min(1, p.sample / 10) : 0;
        const score = p.accuracy == null ? null : Math.round(p.accuracy * (0.5 + 0.5 * confidence));
        const rec = { id: 'score_' + a, workspaceId: ws(), agent: a, accuracy: p.accuracy, sample: p.sample, validated: p.validated, contradicted: p.contradicted, decisions: decisionsCount, score: score, confidence: Math.round(confidence * 100), updatedAt: at };
        await put(SCORES, rec);
        await put(ACCURACY, { id: newId('aacc'), workspaceId: ws(), agent: a, accuracy: p.accuracy, score: score, sample: p.sample, at: at });
        board.push(rec);
      }
      board.sort((x, y) => (y.accuracy == null ? -1 : y.accuracy) - (x.accuracy == null ? -1 : x.accuracy) || (y.decisions - x.decisions));
      return { ok: true, agents: board.length, scoreboard: board };
    },

    async scoreboard() { const all = (await data().list(SCORES)).filter(mine); return all.sort((a, b) => (b.accuracy == null ? -1 : b.accuracy) - (a.accuracy == null ? -1 : a.accuracy) || (b.decisions - a.decisions)); },
    async agentTrend(agent, limit) { return (await data().list(ACCURACY)).filter((r) => mine(r) && r.agent === agent).sort((a, b) => String(a.at || '').localeCompare(String(b.at || ''))).slice(-(limit || 20)); },

    // ---- pattern extraction (advisory; never auto-applied) ------------------
    async extractPatterns() {
      const agg = await quiet(() => (learning() && learning().aggregate ? learning().aggregate() : null), null);
      if (!agg) return { ok: false, error: 'NO_LEARNING' };
      const minSample = num(cfg().flag ? cfg().flag('oiMinSample', 2) : 2) || 2;
      const out = [];
      const consider = (dim, groups, metric) => {
        (groups || []).forEach((g) => {
          if (!g || g.key === 'unknown' || g.key === 'unspecified' || (g.count || 0) < minSample) return;
          const val = metric === 'winRate' ? g.winRate : g.avgMarginPct;
          if (val == null) return;
          out.push({ dimension: dim, key: g.key, metric: metric, value: metric === 'winRate' ? Math.round(val * 100) : Math.round(val), sample: g.count, confidence: Math.min(100, Math.round((g.count / 10) * 100)) });
        });
      };
      consider('serviceType', agg.byServiceType, 'winRate');
      consider('zip', agg.byZip, 'avgMarginPct');
      consider('leadSource', agg.byLeadSource, 'winRate');
      // keep the strongest signals
      out.sort((a, b) => b.value - a.value || b.sample - a.sample);
      const top = out.slice(0, 24);
      for (const p of top) {
        const id = 'pat_' + p.dimension + '_' + p.metric + '_' + slug(p.key);
        await put(PATTERNS, { id: id, workspaceId: ws(), dimension: p.dimension, key: p.key, metric: p.metric, value: p.value, sample: p.sample, confidence: p.confidence, updatedAt: nowISO() });
      }
      return { ok: true, patterns: top.length };
    },
    async patterns(dimension) { const all = (await data().list(PATTERNS)).filter(mine); return (dimension ? all.filter((p) => p.dimension === dimension) : all).sort((a, b) => b.value - a.value); },

    // ---- one-call refresh + summary ----------------------------------------
    async refresh() { await this.ingest(); await this.scoreAgents(); await this.extractPatterns(); return this.metrics(); },
    async metrics() {
      const evs = await this.events();
      const byType = {}; evs.forEach((e) => { byType[e.type] = (byType[e.type] || 0) + 1; });
      const won = byType.quote_won || 0, lost = byType.quote_lost || 0;
      const margins = evs.filter((e) => e.type === 'margin_achieved' && e.value != null).map((e) => e.value);
      const resp = evs.filter((e) => e.type === 'response_time' && e.value != null).map((e) => e.value);
      return {
        ok: true, totalEvents: evs.length, byType: byType,
        conversion: (won + lost) ? Math.round((won / (won + lost)) * 100) : null,
        avgMargin: margins.length ? Math.round(margins.reduce((a, b) => a + b, 0) / margins.length) : null,
        avgResponseDays: resp.length ? Math.round((resp.reduce((a, b) => a + b, 0) / resp.length) * 10) / 10 : null,
        scoredAgents: (await this.scoreboard()).length, patterns: (await this.patterns()).length
      };
    }
  };

  async function listQuotes() { try { if (quotes() && quotes().list) return (await quotes().list()).filter(mine); return (await data().list('quotes')).filter(mine); } catch (_) { return []; } }
  async function ensure(type, id, payload) { const r = await Engine.record(type, payload, { id: id }); return r.ok && !r.already ? 1 : 0; }
  function slug(s) { return String(s == null ? 'x' : s).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 40) || 'x'; }
  async function put(c, rec) { await data().put(c, rec.id, rec); try { if (data().cloudReady && data().cloudReady() && global.AAA_CLOUD) global.AAA_CLOUD.upsertEntity(c, rec.id, rec); } catch (_) {} }

  global.AAA_OUTCOME_INTELLIGENCE = Engine;
})(typeof window !== 'undefined' ? window : this);
