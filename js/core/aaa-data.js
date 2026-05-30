/*
 * AAA Data — the unified data layer and shared-memory seam.
 *
 * One API over the local-first store that every screen and every AI agent can
 * read/write: customers, jobs, estimates, outcomes, reviews, agent decisions.
 * Local-first is the source of truth (offline-safe); when Supabase is
 * configured it mirrors idempotently to the cloud so the field app and office
 * OS — and the agents — all see the same data.
 *
 * This module is additive: existing flows keep using AAA_LOCAL_FIRST_STORAGE
 * directly and remain compatible, because aaa-data wraps the same collections.
 */
;(function (global) {
  'use strict';

  function store() { return global.AAA_LOCAL_FIRST_STORAGE; }
  function cfg() { return global.AAA_CONFIG || {}; }
  function sb() { return global.AAA_SUPABASE; }
  function cloud() { return global.AAA_CLOUD; }
  function ids() { return global.AAA_ID_FACTORY; }
  function clock() { return global.AAA_RUNTIME_CLOCK; }

  function iso(v) {
    if (v == null || v === '') return null;
    const d = typeof v === 'number' ? new Date(v) : new Date(v);
    return isNaN(d.getTime()) ? null : d.toISOString();
  }

  const data = {
    // ---- local-first entity access (source of truth) --------------------
    async list(collection) { return store().getAll(collection); },
    async get(collection, id) { return store().get(collection, id); },
    async put(collection, id, value) { return store().put(collection, id, value); },

    listJobs() { return this.list('jobs'); },
    listCustomers() { return this.list('customers'); },

    /** Append an outcome (won/lost/callback/review) for a job. Local + cloud. */
    async recordOutcome(jobId, result, extra) {
      const id = ids() ? ids().createId('outcome') : String(Date.now());
      const rec = Object.assign({
        id: id, jobId: jobId, result: result,
        recordedAt: clock() ? clock().now() : Date.now()
      }, extra || {});
      await store().put('outcomes', id, rec);
      this._mirrorOutcome(rec); // best-effort
      return rec;
    },

    /** Log an agent decision into shared memory (for the Supervisor + learning). */
    async logDecision(decision) {
      const id = ids() ? ids().createId('dec') : String(Date.now());
      const rec = Object.assign({ id: id, createdAt: clock() ? clock().now() : Date.now() }, decision || {});
      await store().put('agent_decisions', id, rec);
      this._mirrorDecision(rec);
      return rec;
    },

    /** Persist a KPI snapshot (metrics rollup) to shared memory + cloud. */
    async saveKpiSnapshot(period, metrics) {
      const id = ids() ? ids().createId('kpi') : String(Date.now());
      const rec = { id: id, period: period || 'day', metrics: metrics || {}, createdAt: clock() ? clock().now() : Date.now() };
      await store().put('kpi_snapshots', id, rec);
      if (this.cloudReady()) {
        try { await cloud().insertEvent('kpi_snapshots', { period: rec.period, metrics: rec.metrics }); } catch (_) {}
      }
      return rec;
    },

    /** Append an agent log line into shared memory. */
    async logAgent(agent, message, context) {
      const id = ids() ? ids().createId('log') : String(Date.now());
      const rec = { id: id, agent: agent, message: message, context: context || {}, createdAt: clock() ? clock().now() : Date.now() };
      await store().put('agent_logs', id, rec);
      return rec;
    },

    // ---- the single AI funnel -------------------------------------------
    /** Call Claude through the server-side proxy. { ok, text, content, usage }. */
    async callAgent(payload) {
      if (!cloud() || !cfg().isProxyConfigured || !cfg().isProxyConfigured()) {
        return { ok: false, error: 'PROXY_NOT_CONFIGURED' };
      }
      return cloud().callProxy(payload);
    },

    // ---- cloud mirror (backend-agnostic, idempotent per client id) -------
    cloudReady() {
      return !!(cloud() && cloud().isConfigured() && cfg().workspaceId);
    },

    /** Push local customers → jobs → estimates to the active cloud backend. */
    async mirrorToCloud() {
      if (!this.cloudReady()) return { ok: false, error: 'NOT_CONFIGURED' };
      const customers = await this.listCustomers();
      const jobs = await this.listJobs();
      // Supabase uses relational FKs (uuid) and keeps its dedicated path;
      // Firebase (and any per-document backend) upserts docs keyed by client id.
      if (cloud().provider() !== 'supabase') {
        for (const c of customers) await cloud().upsertEntity('customers', c.id, c);
        for (const j of jobs) await cloud().upsertEntity('jobs', j.id, j);
        let est = 0;
        for (const j of jobs) {
          for (const e of (Array.isArray(j.estimates) ? j.estimates : [])) {
            await cloud().upsertEntity('estimates', e.estimateId || (j.id + ':' + (e.type || '')), Object.assign({ jobId: j.id }, e));
            est++;
          }
        }
        return { ok: true, provider: cloud().provider(), customers: customers.length, jobs: jobs.length, estimates: est };
      }
      return this._mirrorSupabase(customers, jobs);
    },

    /** Supabase-specific mirror with uuid FK resolution. */
    async _mirrorSupabase(customers, jobs) {
      const ws = cfg().workspaceId;

      // 1) customers
      const custRows = customers.map((c) => ({
        workspace_id: ws, client_id: c.id, name: c.name || 'Unnamed',
        address: c.address || null, phone: c.phone || null, email: c.email || null,
        gate_code: c.gateCode || null, source: c.source || null
      }));
      const custMap = {};
      if (custRows.length) {
        const r = await sb().upsert('customers', custRows, 'workspace_id,client_id');
        if (r.ok && Array.isArray(r.data)) r.data.forEach((row) => { custMap[row.client_id] = row.id; });
      }

      // 2) jobs (resolve customer uuid via the map)
      const jobRows = jobs.map((j) => ({
        workspace_id: ws, client_id: j.id, customer_id: custMap[j.customerId] || null,
        current_state: j.currentState || 'QUOTE_OPEN', service_address: j.serviceAddress || null,
        scheduled_date: iso(j.scheduledDate), notes: j.notes || null,
        latitude: j.latitude, longitude: j.longitude, closed_at: iso(j.closedAt)
      }));
      const jobMap = {};
      if (jobRows.length) {
        const r = await sb().upsert('jobs', jobRows, 'workspace_id,client_id');
        if (r.ok && Array.isArray(r.data)) r.data.forEach((row) => { jobMap[row.client_id] = row.id; });
      }

      // 3) estimates (flattened from each job)
      const estRows = [];
      jobs.forEach((j) => (Array.isArray(j.estimates) ? j.estimates : []).forEach((e) => {
        estRows.push({
          workspace_id: ws, client_id: e.estimateId || (j.id + ':' + (e.type || '')), job_id: jobMap[j.id] || null,
          type: e.type || null, severity: e.severity || null, confidence: e.confidence != null ? e.confidence : null,
          est_time_mins: e.estimatedTimeMins != null ? e.estimatedTimeMins : null,
          quote_range: e.estimatedQuoteRange || null, materials: Array.isArray(e.materials) ? e.materials : [],
          source: e.source === 'MANUAL' ? 'MANUAL' : 'AI'
        });
      }));
      if (estRows.length) await sb().upsert('estimates', estRows, 'workspace_id,client_id');

      return { ok: true, customers: custRows.length, jobs: jobRows.length, estimates: estRows.length };
    },

    async _mirrorOutcome(rec) {
      if (!this.cloudReady()) return;
      try { await cloud().upsertEntity('outcomes', rec.id, rec); } catch (_) {}
    },
    async _mirrorDecision(rec) {
      if (!this.cloudReady()) return;
      try { await cloud().upsertEntity('agent_decisions', rec.id, rec); } catch (_) {}
    }
  };

  global.AAA_DATA = data;
})(typeof window !== 'undefined' ? window : this);
