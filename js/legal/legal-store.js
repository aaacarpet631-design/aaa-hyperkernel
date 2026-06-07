/*
 * AAA Legal Memory — the versioned, append-only record of everything legal.
 *
 * One collection (legal_records) holds contracts, change orders, customer
 * acknowledgements, incidents, compliance obligations, legal reviews, preserved
 * evidence, communications, liens, and collection actions. Every record carries
 * the six things the directive requires — source, timestamp, author, confidence,
 * risk, and an audit trail — and NOTHING is silently modified: every revision
 * increments `version` and pushes the prior snapshot into `history`.
 *
 * Writes route through the Runtime Gateway so each one is audited (who, what,
 * why) in the same immutable audit_log as the rest of the OS, and the Gateway's
 * hard AI-block keeps an agent from fabricating a binding legal record — agents
 * advise; humans (with MANAGE_LEGAL) record. The one exception is a `legal_review`
 * package, which is advisory by nature and so is AI-allowed (PREPARE_LEGAL_REVIEW).
 */
;(function (global) {
  'use strict';

  const COLLECTION = 'legal_records';

  // Record types and the Gateway action each one is created through.
  const TYPES = ['contract', 'change_order', 'acknowledgement', 'incident',
    'compliance_event', 'legal_review', 'communication', 'evidence', 'lien',
    'collection', 'policy'];

  const TYPE_ACTION = {
    incident: 'FILE_INCIDENT',
    legal_review: 'PREPARE_LEGAL_REVIEW',
    // everything else is a deliberate human legal record
    _default: 'ADD_LEGAL_RECORD'
  };

  const SEVERITY = ['low', 'medium', 'high', 'critical'];

  function data() { return global.AAA_DATA; }
  function cfg() { return global.AAA_CONFIG || {}; }
  function ids() { return global.AAA_ID_FACTORY; }
  function clock() { return global.AAA_RUNTIME_CLOCK; }
  function gateway() { return global.AAA_RUNTIME_GATEWAY; }
  function events() { return global.AAA_EVENTS; }
  function cloud() { return global.AAA_CLOUD; }

  function now() { return clock() ? clock().now() : Date.now(); }
  function ws() { return cfg().workspaceId || 'default'; }
  function mine(r) { return r && (r.workspaceId == null || r.workspaceId === ws()); }
  function clampScore(n) { const v = Math.round(Number(n)); return Number.isFinite(v) ? Math.max(0, Math.min(100, v)) : null; }
  function sev(s) { return SEVERITY.indexOf(s) !== -1 ? s : null; }

  async function persist(rec) {
    await data().put(COLLECTION, rec.id, rec);
    try {
      if (data().cloudReady && data().cloudReady() && cloud()) await cloud().upsertEntity(COLLECTION, rec.id, rec);
    } catch (_) {}
    return rec;
  }

  // Run a legal write through the Gateway (audited). Returns { ok, rec?, error? }.
  async function guarded(action, origin, actor, target, detail, mutate) {
    const gw = gateway();
    if (!gw || !gw.run) {
      // No gateway in this context (e.g. a test): perform the mutation directly.
      const rec = await mutate();
      return { ok: true, rec: rec, auditId: null };
    }
    const res = await gw.run({ action: action, origin: origin || 'human', actor: actor || null, target: target, detail: detail, mutate: mutate });
    if (!res.ok) return { ok: false, error: res.error, message: res.message };
    return { ok: true, rec: res.result, auditId: res.auditId };
  }

  const Legal = {
    COLLECTION: COLLECTION,
    TYPES: TYPES,

    /**
     * Create a legal record (audited, versioned). AI may not create binding
     * records — pass origin:'ai' only for type 'legal_review'.
     * @param {string} type   one of TYPES
     * @param {object} payload type-specific data → stored under `data`
     * @param {object} opts   { origin, author, source, title, summary, status,
     *                          confidence, riskScore, riskSeverity, links }
     */
    async add(type, payload, opts) {
      if (!data()) return { ok: false, error: 'NO_DATA_LAYER' };
      if (TYPES.indexOf(type) === -1) return { ok: false, error: 'UNKNOWN_TYPE', type: type };
      const o = opts || {};
      const id = ids() ? ids().createId('legal') : ('legal-' + Date.now());
      const t = now();
      const author = o.author || (global.AAA_RBAC ? global.AAA_RBAC.role() : 'unknown');
      const rec = {
        id: id, type: type, workspaceId: ws(),
        title: String(o.title || '').slice(0, 200) || (type + ' record'),
        summary: String(o.summary || '').slice(0, 1000),
        source: o.source || ((o.origin === 'ai' ? 'agent:' : 'human:') + author),
        author: author,
        createdAt: t, updatedAt: t, version: 1,
        status: o.status || (type === 'compliance_event' ? 'open' : type === 'incident' ? 'open' : 'active'),
        riskScore: clampScore(o.riskScore),
        riskSeverity: sev(o.riskSeverity),
        confidence: clampScore(o.confidence),
        links: o.links || {},
        data: payload || {},
        history: [{ version: 1, at: t, author: author, change: 'created', snapshot: null }],
        auditIds: []
      };
      const action = TYPE_ACTION[type] || TYPE_ACTION._default;
      const g = await guarded(action, o.origin, author, { type: 'legal_record', id: id }, { op: 'create', type: type, title: rec.title }, async () => {
        return persist(rec);
      });
      if (!g.ok) return g;
      if (g.auditId) { g.rec.auditIds.push(g.auditId); await persist(g.rec); }
      try { if (events()) events().emit('legal.record.added', { id: id, type: type, riskSeverity: rec.riskSeverity, links: rec.links }); } catch (_) {}
      if (type === 'incident') { try { if (events()) events().emit('legal.incident.filed', { id: id, links: rec.links }); } catch (_) {} }
      return { ok: true, record: g.rec, auditId: g.auditId };
    },

    /**
     * Revise a record without ever losing the prior state. Increments version,
     * snapshots the previous content into history. Audited.
     * @param {string} id
     * @param {object} patch  shallow fields to change (status, summary, riskScore,
     *                        riskSeverity, confidence, links, data, title)
     * @param {object} opts   { origin, author, change }
     */
    async revise(id, patch, opts) {
      if (!data()) return { ok: false, error: 'NO_DATA_LAYER' };
      const cur = await this.get(id);
      if (!cur) return { ok: false, error: 'NOT_FOUND', id: id };
      const o = opts || {}; const p = patch || {};
      const author = o.author || (global.AAA_RBAC ? global.AAA_RBAC.role() : 'unknown');
      const t = now();
      const prevSnapshot = {
        title: cur.title, summary: cur.summary, status: cur.status,
        riskScore: cur.riskScore, riskSeverity: cur.riskSeverity, confidence: cur.confidence,
        links: cur.links, data: cur.data
      };
      const next = Object.assign({}, cur, {
        title: p.title != null ? String(p.title).slice(0, 200) : cur.title,
        summary: p.summary != null ? String(p.summary).slice(0, 1000) : cur.summary,
        status: p.status != null ? p.status : cur.status,
        riskScore: p.riskScore != null ? clampScore(p.riskScore) : cur.riskScore,
        riskSeverity: p.riskSeverity != null ? (sev(p.riskSeverity) || cur.riskSeverity) : cur.riskSeverity,
        confidence: p.confidence != null ? clampScore(p.confidence) : cur.confidence,
        links: p.links != null ? Object.assign({}, cur.links, p.links) : cur.links,
        data: p.data != null ? Object.assign({}, cur.data, p.data) : cur.data,
        updatedAt: t, version: (cur.version || 1) + 1,
        history: (cur.history || []).concat([{ version: cur.version || 1, at: t, author: author, change: o.change || 'revised', snapshot: prevSnapshot }])
      });
      const g = await guarded('ADD_LEGAL_RECORD', o.origin, author, { type: 'legal_record', id: id }, { op: 'revise', version: next.version, change: o.change || 'revised' }, async () => persist(next));
      if (!g.ok) return g;
      if (g.auditId) { g.rec.auditIds = (g.rec.auditIds || []).concat([g.auditId]); await persist(g.rec); }
      try { if (events()) events().emit('legal.record.revised', { id: id, type: next.type, version: next.version }); } catch (_) {}
      return { ok: true, record: g.rec, auditId: g.auditId };
    },

    async get(id) { const r = data() ? await data().get(COLLECTION, id) : null; return mine(r) ? r : null; },

    /** All legal records for this workspace, newest first. Optional {type, status, jobId}. */
    async list(filter) {
      if (!data()) return [];
      const f = filter || {};
      let all = (await data().list(COLLECTION)).filter(mine);
      if (f.type) all = all.filter((r) => r.type === f.type);
      if (f.status) all = all.filter((r) => r.status === f.status);
      if (f.jobId) all = all.filter((r) => r.links && r.links.jobId === f.jobId);
      return all.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    },

    byType(type) { return this.list({ type: type }); },
    byJob(jobId) { return this.list({ jobId: jobId }); },
    async history(id) { const r = await this.get(id); return r ? (r.history || []) : []; },

    /**
     * Compliance obligations needing attention. Returns open compliance_events,
     * flagging which are overdue / due soon (by data.dueDate, ms or ISO).
     */
    async obligations(windowDays) {
      const win = (windowDays || 30) * 86400000;
      const list = await this.list({ type: 'compliance_event' });
      const t = now();
      return list.filter((r) => r.status === 'open' || r.status === 'active').map((r) => {
        const due = r.data && r.data.dueDate != null ? new Date(r.data.dueDate).getTime() : null;
        const ms = Number.isFinite(due) ? due - t : null;
        return Object.assign({}, r, {
          dueInMs: ms,
          overdue: ms != null && ms < 0,
          dueSoon: ms != null && ms >= 0 && ms <= win
        });
      }).sort((a, b) => {
        if (a.dueInMs == null) return 1; if (b.dueInMs == null) return -1; return a.dueInMs - b.dueInMs;
      });
    }
  };

  global.AAA_LEGAL_STORE = Legal;
})(typeof window !== 'undefined' ? window : this);
