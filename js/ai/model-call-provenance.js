/*
 * AAA Model-Call Provenance — every external model call leaves a trace.
 *
 * For each governed model call the router makes, this records a Provenance Graph
 * trace (subjectType 'model_call') linking the source prompt/context, the governed
 * prompt + model versions, the requesting agent, the runtime provider, and an
 * output checksum — and persists a usage record to `model_calls` (the audit/usage
 * stream the governance UI reports on: last call, error rate, latency, by agent).
 *
 * Read-only over the business; it writes only provenance + usage. Deterministic.
 */
;(function (global) {
  'use strict';

  const USAGE = 'model_calls';

  function cfg() { return global.AAA_CONFIG || {}; }
  function data() { return global.AAA_DATA; }
  function ids() { return global.AAA_ID_FACTORY; }
  function clock() { return global.AAA_RUNTIME_CLOCK; }
  function provenance() { return global.AAA_PROVENANCE; }
  function ws() { return cfg().workspaceId || 'default'; }
  function nowISO() { return clock() && clock().nowISO ? clock().nowISO() : new Date().toISOString(); }
  function mine(r) { return r && (r.workspaceId == null || r.workspaceId === ws()); }
  function newId(p) { return ids() ? ids().createId(p) : p + '_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7); }

  function hash32(s) { let h = 0x811c9dc5; const str = typeof s === 'string' ? s : JSON.stringify(s == null ? '' : s); for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0; } return h >>> 0; }
  function checksum(output) { return ('0000000' + hash32(output).toString(16)).slice(-8); }
  function trunc(s, n) { const str = typeof s === 'string' ? s : JSON.stringify(s == null ? '' : s); return str.length > (n || 240) ? str.slice(0, n || 240) + '…' : str; }

  const MCP = {
    USAGE: USAGE,
    checksum: checksum,

    /** Record a provenance trace + a usage row for a model call. Never throws. */
    async record(call) {
      const c = call || {};
      const out = c.output != null ? c.output : null;
      const ck = checksum(out);
      let traceId = null;
      try {
        if (provenance() && provenance().record) {
          const tr = await provenance().record({
            subjectType: 'model_call', subjectId: newId('mc'), subjectLabel: (c.modelKey || 'model') + ' · ' + (c.taskType || 'task'),
            agent: c.agent || 'model_router',
            summary: { decision: 'model_call', confidence: c.confidence != null ? c.confidence : null, riskScore: c.riskScore != null ? c.riskScore : null },
            evidence: [
              { kind: 'input', label: c.taskType || 'input', detail: trunc(c.input) },
              { kind: 'output', label: 'checksum:' + ck, detail: trunc(out) },
              { kind: 'provider', label: c.provider || 'nvidia', detail: 'modelId=' + (c.modelId || '?') + ' runtime=' + (c.runtime || '?') + (c.fallback ? ' (fallback)' : '') + (c.stub ? ' (stub)' : '') }
            ],
            modelVersion: c.modelId || null, promptVersion: c.promptVersion || null, calibrationVersion: c.governanceVersion || null,
            sourceQuotes: (c.sourceContext && c.sourceContext.quoteIds) || [], predictionIds: [], closureIds: []
          });
          traceId = tr && tr.id ? tr.id : null;
        }
      } catch (_) { traceId = null; }

      const usage = { id: newId('mcall'), workspaceId: ws(), modelKey: c.modelKey || null, taskType: c.taskType || null, agent: c.agent || null, provider: c.provider || 'nvidia', ok: c.ok !== false, fallback: !!c.fallback, stub: !!c.stub, latencyMs: c.latencyMs != null ? c.latencyMs : null, governanceVersion: c.governanceVersion || null, checksum: ck, traceId: traceId, at: nowISO() };
      try { await put(usage); } catch (_) {}
      return { ok: true, traceId: traceId, checksum: ck, usageId: usage.id };
    },

    async usage(filter) { const f = filter || {}; let all = (await data().list(USAGE)).filter(mine); if (f.modelKey) all = all.filter((u) => u.modelKey === f.modelKey); return all.sort((a, b) => String(b.at || '').localeCompare(String(a.at || ''))); },

    /** Operational metrics for a model (for the governance panel). */
    async metrics(modelKey) {
      const rows = await this.usage(modelKey ? { modelKey: modelKey } : null);
      const n = rows.length, errs = rows.filter((r) => r.ok === false || r.fallback).length;
      const lat = rows.map((r) => r.latencyMs).filter((x) => x != null);
      const byAgent = {}; rows.forEach((r) => { const a = r.agent || 'unknown'; byAgent[a] = (byAgent[a] || 0) + 1; });
      return { ok: true, calls: n, errorRate: n ? Math.round((errs / n) * 100) : null, avgLatencyMs: lat.length ? Math.round(lat.reduce((a, b) => a + b, 0) / lat.length) : null, lastAt: rows[0] ? rows[0].at : null, byAgent: byAgent };
    }
  };

  async function put(rec) { await data().put(USAGE, rec.id, rec); try { if (data().cloudReady && data().cloudReady() && global.AAA_CLOUD) global.AAA_CLOUD.upsertEntity(USAGE, rec.id, rec); } catch (_) {} }

  global.AAA_MODEL_CALL_PROVENANCE = MCP;
})(typeof window !== 'undefined' ? window : this);
