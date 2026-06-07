/*
 * AAA Reliability Command Center — one pane of glass over the whole system.
 *
 * Aggregates signals the other modules already produce (transport delivery,
 * conversion, prediction/agent accuracy, calibration, review/queue backlog,
 * webhook/sync health, event-bus + audit-chain integrity) into named metrics
 * with status thresholds, derives alerts, snapshots metrics for trends, and
 * maintains an incident timeline. Read-only/observational — it never mutates a
 * business record and never auto-remediates; a person acts. Null-tolerant: any
 * missing module simply yields a null metric, never an exception. Deterministic.
 */
;(function (global) {
  'use strict';

  const SNAPSHOTS = 'reliability_snapshots';
  const INCIDENTS = 'incidents';

  function cfg() { return global.AAA_CONFIG || {}; }
  function data() { return global.AAA_DATA; }
  function ids() { return global.AAA_ID_FACTORY; }
  function clock() { return global.AAA_RUNTIME_CLOCK; }
  function ws() { return cfg().workspaceId || 'default'; }
  function nowISO() { return clock() && clock().nowISO ? clock().nowISO() : new Date().toISOString(); }
  function mine(r) { return r && (r.workspaceId == null || r.workspaceId === ws()); }
  function newId(p) { return ids() ? ids().createId(p) : p + '_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7); }
  function num(v) { const n = Number(v); return isFinite(n) ? n : null; }
  function flag(k, d) { return cfg().flag ? cfg().flag(k, d) : d; }
  async function quiet(fn, dflt) { try { return await fn(); } catch (_) { return dflt; } }

  // Threshold helpers. 'low' metrics (failure/backlog): higher is worse.
  // 'high' metrics (delivery/conversion/accuracy): lower is worse.
  function statusLow(v, warn, crit) { if (v == null) return 'unknown'; if (v >= crit) return 'crit'; if (v >= warn) return 'warn'; return 'ok'; }
  function statusHigh(v, warnBelow, critBelow) { if (v == null) return 'unknown'; if (v <= critBelow) return 'crit'; if (v <= warnBelow) return 'warn'; return 'ok'; }
  function metric(key, label, value, unit, status, detail) { return { key: key, label: label, value: value, unit: unit || '', status: status || 'unknown', detail: detail || null }; }

  const Reliability = {
    SNAPSHOTS: SNAPSHOTS, INCIDENTS: INCIDENTS,

    /** Gather every reliability metric (null-tolerant). */
    async metrics() {
      const m = [];

      // --- transport delivery + backlog ---
      const tstats = await quiet(() => (global.AAA_TRANSPORT && global.AAA_TRANSPORT.stats ? global.AAA_TRANSPORT.stats() : null), null);
      if (tstats) {
        const attempted = num(tstats.sent) + num(tstats.delivered) + num(tstats.failed) + num(tstats.bounced);
        const failRate = attempted > 0 ? Math.round(((num(tstats.failed) + num(tstats.bounced)) / attempted) * 100) : 0;
        const delivRate = attempted > 0 ? Math.round((num(tstats.delivered) / attempted) * 100) : null;
        m.push(metric('transport_failure_rate', 'Transport failure rate', failRate, '%', statusLow(failRate, num(flag('relWarnFailRate', 10)), num(flag('relCritFailRate', 25))), (tstats.failed + tstats.bounced) + ' of ' + attempted));
        m.push(metric('transport_delivery_rate', 'Transport delivery rate', delivRate, '%', statusHigh(delivRate, 70, 40), null));
        const backlog = num(tstats.pendingApproval) + num(tstats.queued);
        m.push(metric('queue_backlog', 'Send queue backlog', backlog, '', statusLow(backlog, num(flag('relWarnBacklog', 10)), num(flag('relCritBacklog', 25))), tstats.pendingApproval + ' awaiting approval'));
        m.push(metric('review_queue', 'Messages awaiting review', num(tstats.pendingApproval), '', statusLow(num(tstats.pendingApproval), 8, 20), null));
      }

      // --- conversion (won/lost) ---
      const agg = await quiet(() => (global.AAA_OUTCOME_LEARNING && global.AAA_OUTCOME_LEARNING.aggregate ? global.AAA_OUTCOME_LEARNING.aggregate() : null), null);
      if (agg && agg.overall) { const conv = agg.overall.winRate != null ? Math.round(agg.overall.winRate * 100) : null; m.push(metric('conversion_rate', 'Quote conversion', conv, '%', statusHigh(conv, num(flag('relWarnConv', 25)), num(flag('relCritConv', 10))), (agg.overall.resolved || 0) + ' resolved')); }

      // --- prediction accuracy + calibration effectiveness ---
      const cal = await quiet(() => (global.AAA_PREDICTION_CLOSURE && global.AAA_PREDICTION_CLOSURE.calibrationSummary ? global.AAA_PREDICTION_CLOSURE.calibrationSummary() : null), null);
      if (cal && cal.agents) {
        const rates = cal.agents.map((a) => a.validationRate).filter((r) => r != null);
        const avg = rates.length ? Math.round((rates.reduce((x, y) => x + y, 0) / rates.length) * 100) : null;
        m.push(metric('prediction_accuracy', 'Prediction validation rate', avg, '%', statusHigh(avg, 50, 30), (cal.agents.reduce((n, a) => n + num(a.closures), 0)) + ' closures'));
        const totalConclusive = cal.agents.reduce((n, a) => n + num(a.validated) + num(a.contradicted), 0);
        m.push(metric('calibration_effectiveness', 'Calibration signal strength', totalConclusive, '', totalConclusive > 0 ? 'ok' : 'unknown', 'conclusive closures feeding calibration'));
      }

      // --- agent accuracy (supervisor) ---
      const sup = await quiet(() => (global.AAA_SUPERVISOR && global.AAA_SUPERVISOR.metrics ? global.AAA_SUPERVISOR.metrics() : null), null);
      if (sup && sup.perAgent) { const scores = Object.keys(sup.perAgent).map((k) => sup.perAgent[k].avgScore).filter((s) => typeof s === 'number'); const avg = scores.length ? Math.round((scores.reduce((x, y) => x + y, 0) / scores.length) * 100) : null; m.push(metric('agent_accuracy', 'Agent accuracy', avg, '%', statusHigh(avg, 50, 30), scores.length + ' scored agents')); }

      // --- backlogs across governed inboxes ---
      const calPending = await quiet(async () => (global.AAA_CALIBRATION_REGISTRY ? (await global.AAA_CALIBRATION_REGISTRY.listProposals('pending')).length : null), null);
      if (calPending != null) m.push(metric('calibration_backlog', 'Calibration proposals pending', calPending, '', statusLow(calPending, 5, 15), null));
      const erasurePending = await quiet(async () => (global.AAA_PRIVACY ? (await global.AAA_PRIVACY.listRequests('pending')).length : null), null);
      if (erasurePending != null) m.push(metric('erasure_backlog', 'Erasure requests pending', erasurePending, '', statusLow(erasurePending, 1, 5), null));

      // --- webhook / cloud sync health ---
      const cloudReady = await quiet(() => (data() && data().cloudReady ? !!data().cloudReady() : null), null);
      if (cloudReady != null) m.push(metric('sync_health', 'Cloud sync', cloudReady ? 'online' : 'offline', '', cloudReady ? 'ok' : 'warn', cloudReady ? 'mirroring to cloud' : 'local-only (offline)'));

      // --- integrity: event-bus chain + audit chain ---
      const evChain = await quiet(() => (global.AAA_EVENT_BUS && global.AAA_EVENT_BUS.verifyChain ? global.AAA_EVENT_BUS.verifyChain() : null), null);
      if (evChain) m.push(metric('event_chain', 'Event-log integrity', evChain.ok ? 'intact' : (evChain.breaks.length + ' break(s)'), '', evChain.ok ? 'ok' : 'crit', evChain.length + ' events'));
      const auChain = await quiet(() => (global.AAA_SECURITY && global.AAA_SECURITY.verifyAuditChain ? global.AAA_SECURITY.verifyAuditChain() : null), null);
      if (auChain && auChain.length) m.push(metric('audit_chain', 'Audit-log integrity', auChain.ok ? 'intact' : (auChain.breaks.length + ' break(s)'), '', auChain.ok ? 'ok' : 'crit', auChain.length + ' entries'));

      return m;
    },

    /** Overall health: score (% of known metrics that are ok) + worst status. */
    async health() {
      const m = await this.metrics();
      const known = m.filter((x) => x.status !== 'unknown');
      const okCount = known.filter((x) => x.status === 'ok').length;
      const worst = m.some((x) => x.status === 'crit') ? 'crit' : (m.some((x) => x.status === 'warn') ? 'warn' : (known.length ? 'ok' : 'unknown'));
      return { ok: true, status: worst, score: known.length ? Math.round((okCount / known.length) * 100) : null, metrics: m.length, known: known.length, generatedAt: nowISO() };
    },

    /** Alerts: every metric in warn/crit, most severe first. */
    async alerts() {
      const m = await this.metrics();
      return m.filter((x) => x.status === 'warn' || x.status === 'crit')
        .map((x) => ({ key: x.key, label: x.label, status: x.status, value: x.value, unit: x.unit, detail: x.detail }))
        .sort((a, b) => (a.status === 'crit' ? 0 : 1) - (b.status === 'crit' ? 0 : 1));
    },

    // ---- trends (snapshots) -------------------------------------------------
    /** Persist a metrics snapshot for trend tracking. */
    async snapshot() {
      const h = await this.health();
      const m = await this.metrics();
      const rec = { id: newId('relsnap'), workspaceId: ws(), at: nowISO(), status: h.status, score: h.score, values: m.reduce((o, x) => { o[x.key] = x.value; return o; }, {}) };
      await put(SNAPSHOTS, rec);
      return { ok: true, snapshot: rec };
    },
    async snapshots(limit) { return (await data().list(SNAPSHOTS)).filter(mine).sort((a, b) => String(b.at || '').localeCompare(String(a.at || ''))).slice(0, limit || 50); },
    /** A metric's value over recent snapshots (oldest→newest). */
    async trend(metricKey, limit) {
      const snaps = (await this.snapshots(limit || 20)).slice().reverse();
      return snaps.map((s) => ({ at: s.at, value: s.values ? s.values[metricKey] : null }));
    },

    // ---- incident timeline --------------------------------------------------
    /**
     * Open/refresh incidents from current crit alerts (idempotent per metric key
     * while an incident is open). Observational — never auto-remediates.
     */
    async evaluate() {
      const alerts = await this.alerts();
      const crit = alerts.filter((a) => a.status === 'crit');
      const open = await this.incidents('open');
      const openByKey = {}; open.forEach((i) => { openByKey[i.metricKey] = i; });
      const opened = [];
      for (const a of crit) {
        if (openByKey[a.key]) { const i = openByKey[a.key]; await put(INCIDENTS, Object.assign({}, i, { lastSeenAt: nowISO(), occurrences: num(i.occurrences) + 1, lastValue: a.value })); }
        else { const rec = { id: newId('inc'), workspaceId: ws(), metricKey: a.key, title: a.label + ' critical', status: 'open', severity: 'crit', firstSeenAt: nowISO(), lastSeenAt: nowISO(), occurrences: 1, lastValue: a.value, detail: a.detail || null, history: [{ type: 'opened', at: nowISO(), value: a.value }] }; await put(INCIDENTS, rec); opened.push(rec); }
      }
      return { ok: true, opened: opened.length, openTotal: (await this.incidents('open')).length };
    },
    async incidents(status) { const all = (await data().list(INCIDENTS)).filter(mine); return (status ? all.filter((i) => i.status === status) : all).sort((a, b) => String(b.lastSeenAt || b.firstSeenAt || '').localeCompare(String(a.lastSeenAt || a.firstSeenAt || ''))); },
    async recordIncident(input) { const i = input || {}; const rec = { id: newId('inc'), workspaceId: ws(), metricKey: i.metricKey || 'manual', title: i.title || 'Incident', status: 'open', severity: i.severity || 'warn', firstSeenAt: nowISO(), lastSeenAt: nowISO(), occurrences: 1, detail: i.detail || null, history: [{ type: 'opened', at: nowISO(), by: i.actor || null }] }; await put(INCIDENTS, rec); return { ok: true, incident: rec }; },
    async resolveIncident(id, opts) {
      const o = opts || {};
      const i = (await data().get(INCIDENTS, id)); if (!mine(i)) return { ok: false, error: 'NOT_FOUND' };
      const rec = Object.assign({}, i, { status: 'resolved', resolvedAt: nowISO(), resolvedBy: o.actor || null, note: o.note || null, history: (i.history || []).concat([{ type: 'resolved', at: nowISO(), by: o.actor || null, note: o.note || null }]) });
      await put(INCIDENTS, rec);
      return { ok: true, incident: rec };
    }
  };

  async function put(c, rec) {
    await data().put(c, rec.id, rec);
    try { if (data().cloudReady && data().cloudReady() && global.AAA_CLOUD) global.AAA_CLOUD.upsertEntity(c, rec.id, rec); } catch (_) {}
  }

  global.AAA_RELIABILITY = Reliability;
})(typeof window !== 'undefined' ? window : this);
