/*
 * AAA Outcome Spine — one normalized, labeled view of real-world outcomes.
 *
 * Pure measurement infrastructure. Outcomes are written today by several
 * modules in different shapes (the `outcomes` collection, resolved `quotes`,
 * and the `leads` record). This reads them, normalizes to ONE canonical shape,
 * de-duplicates per entity, and reports which resolved entities are missing the
 * fields evals need (e.g. estimated/final $ for MAPE).
 *
 * Read-only over source records — it NEVER mutates them. Owner gap-fills go to
 * an additive `outcome_labels` overlay (keyed by entityType:entityId), merged
 * at read time, so the correction is reversible and the source is untouched.
 */
;(function (global) {
  'use strict';

  function data() { return global.AAA_DATA; }
  function rbac() { return global.AAA_RBAC; }
  function clock() { return global.AAA_RUNTIME_CLOCK; }
  function now() { return clock() && clock().now ? clock().now() : Date.now(); }

  const OVERLAY = 'outcome_labels';
  const SUCCESS = ['won', 'contract_signed', 'review_received', 'quote_accepted', 'payment_completed'];
  const FAILURE = ['lost', 'refund', 'complaint', 'chargeback', 'quote_rejected'];
  // anything else (callback, abandoned, pending, unknown) → neutral

  // ---- pure helpers (exported) ----------------------------------------------
  function classify(result) {
    const r = String(result == null ? '' : result).toLowerCase();
    if (SUCCESS.indexOf(r) !== -1) return 'success';
    if (FAILURE.indexOf(r) !== -1) return 'failure';
    return 'neutral';
  }
  function num(v) {
    if (v == null) return null;
    const n = typeof v === 'number' ? v : parseFloat(String(v).replace(/[^0-9.-]/g, ''));
    return isNaN(n) ? null : n;
  }
  // Required fields for a "labeled" outcome; quote/job also need est + final for MAPE.
  function requiredFor(entityType) {
    const base = ['entityType', 'entityId', 'result', 'resultClass', 'recordedAt'];
    return (entityType === 'quote' || entityType === 'job') ? base.concat(['estimated', 'final']) : base;
  }
  function missingFields(o) {
    return requiredFor(o.entityType).filter(function (k) { return o[k] == null || o[k] === ''; });
  }

  // ---- per-source normalizers (pure, exported) ------------------------------
  function fromOutcomeRec(r) {
    const result = String(r.result || '').toLowerCase();
    const entityType = r.quoteId ? 'quote' : 'job';
    return {
      outcomeId: r.id || null, entityType: entityType, entityId: r.quoteId || r.jobId || r.id || null,
      result: result, resultClass: classify(result),
      estimated: num(r.estimated), final: num(r.finalAmount != null ? r.finalAmount : r.final),
      marginPct: num(r.marginPct), leadSource: r.leadSource || null, serviceType: r.serviceType || null,
      zip: r.zip || null, reason: r.reason || null, recordedAt: r.recordedAt || null, source: r.source || 'outcomes'
    };
  }
  function fromQuote(q) {
    if (!(q && (q.status === 'won' || q.status === 'lost'))) return null;
    return {
      outcomeId: 'q:' + (q.quoteId || q.id), entityType: 'quote', entityId: q.quoteId || q.id,
      result: q.status, resultClass: classify(q.status),
      estimated: num(q.customerTotal), final: num(q.finalPrice), marginPct: num(q.marginPct),
      leadSource: q.leadSource || null, serviceType: q.serviceType || null, zip: q.zip || null,
      reason: q.wonLostReason || null, recordedAt: q.resolvedAt || q.updatedAt || null, source: 'quotes'
    };
  }
  function fromLead(l) {
    const o = l && l.outcome;
    const resolved = l && (l.stage === 'WON' || l.stage === 'LOST');
    if (!o && !resolved) return null;
    const result = String((o && o.result) || l.stage || '').toLowerCase();
    return {
      outcomeId: 'l:' + l.leadId, entityType: 'lead', entityId: l.leadId,
      result: result, resultClass: classify(result),
      estimated: null, final: num(o && o.revenue), marginPct: null,
      leadSource: l.source || null, serviceType: l.serviceType || null, zip: null,
      reason: (o && o.lostReason) || null, recordedAt: (o && o.at) || l.updatedAt || null, source: 'leads'
    };
  }

  // Merge: fill null fields of `a` from `b` (a keeps identity + non-null values).
  function mergeFill(a, b) {
    const out = Object.assign({}, a);
    Object.keys(b).forEach(function (k) { if (out[k] == null && b[k] != null) out[k] = b[k]; });
    return out;
  }
  // Overlay fields a human supplied; recompute resultClass if result changed.
  const OVERLAY_FIELDS = ['estimated', 'final', 'marginPct', 'leadSource', 'serviceType', 'zip', 'reason', 'result', 'recordedAt'];
  function applyOverlay(base, fields) {
    const out = Object.assign({}, base);
    OVERLAY_FIELDS.forEach(function (k) { if (fields[k] != null) out[k] = (k === 'estimated' || k === 'final' || k === 'marginPct') ? num(fields[k]) : fields[k]; });
    if (fields.result != null) out.resultClass = classify(out.result);
    return out;
  }

  async function safeList(coll) {
    try { const r = (data() && data().list) ? await data().list(coll) : []; return Array.isArray(r) ? r : []; } catch (_) { return []; }
  }
  function ownerOk() { const r = rbac(); return !(r && r.can) || r.can('VIEW_FINANCIALS'); }

  const Spine = {
    OVERLAY: OVERLAY,
    // pure
    classify: classify, missingFields: missingFields, requiredFor: requiredFor,
    fromOutcomeRec: fromOutcomeRec, fromQuote: fromQuote, fromLead: fromLead,

    /** Normalized, de-duplicated, overlay-merged outcomes. Optional filter. */
    async list(filter) {
      if (!data()) return [];
      const byKey = {};
      function add(o) { if (!o || o.entityId == null) return; const k = o.entityType + ':' + o.entityId; byKey[k] = byKey[k] ? mergeFill(byKey[k], o) : o; }
      // quotes first (richest), then the outcomes collection, then leads
      (await safeList('quotes')).forEach(function (q) { add(fromQuote(q)); });
      (await safeList('outcomes')).forEach(function (r) { add(fromOutcomeRec(r)); });
      (await safeList('leads')).forEach(function (l) { add(fromLead(l)); });

      const ov = {}; (await safeList(OVERLAY)).forEach(function (x) { if (x && x.key) ov[x.key] = x.fields || {}; });

      let arr = Object.keys(byKey).map(function (k) {
        const merged = ov[k] ? applyOverlay(byKey[k], ov[k]) : byKey[k];
        merged.missing = missingFields(merged);
        merged.labeled = merged.missing.length === 0;
        return merged;
      });
      const f = filter || {};
      return arr.filter(function (o) {
        if (f.entityType && o.entityType !== f.entityType) return false;
        if (f.resultClass && o.resultClass !== f.resultClass) return false;
        if (f.labeled != null && o.labeled !== f.labeled) return false;
        return true;
      });
    },

    async forEntity(entityType, entityId) {
      return (await this.list({ entityType: entityType })).filter(function (o) { return o.entityId === entityId; })[0] || null;
    },

    /** Pure completeness check for one normalized outcome. */
    validate(o) { const missing = missingFields(o || {}); return { complete: missing.length === 0, missing: missing }; },

    /** Resolved entities still missing required fields — the owner's worklist. */
    async unlabeled(filter) { return (await this.list(filter)).filter(function (o) { return !o.labeled; }); },

    /** Label coverage KPI. */
    async coverage() {
      const all = await this.list();
      const byType = {};
      let labeled = 0;
      all.forEach(function (o) {
        if (o.labeled) labeled++;
        byType[o.entityType] = byType[o.entityType] || { total: 0, labeled: 0 };
        byType[o.entityType].total++; if (o.labeled) byType[o.entityType].labeled++;
      });
      return { total: all.length, labeled: labeled, pct: all.length ? Math.round(labeled / all.length * 1000) / 1000 : null, byEntityType: byType };
    },

    /**
     * Gap-fill an outcome via the additive overlay (owner-gated). Does NOT touch
     * the source record. Re-labeling merges into the same overlay entry.
     */
    async label(entityType, entityId, fields, opts) {
      if (!data()) return { ok: false, error: 'NO_DATA' };
      if (!ownerOk()) return { ok: false, error: 'FORBIDDEN' };
      if (!entityType || entityId == null) return { ok: false, error: 'ENTITY_REQUIRED' };
      const key = entityType + ':' + entityId;
      const id = OVERLAY + ':' + key;
      const existing = await data().get(OVERLAY, id);
      const clean = {};
      OVERLAY_FIELDS.forEach(function (k) { if (fields && fields[k] != null) clean[k] = fields[k]; });
      const rec = {
        id: id, key: key, entityType: entityType, entityId: entityId,
        fields: Object.assign({}, existing && existing.fields, clean),
        updatedAt: now(), by: (opts && opts.actorId) || null
      };
      await data().put(OVERLAY, id, rec);
      return { ok: true, label: rec, outcome: await this.forEntity(entityType, entityId) };
    }
  };

  global.AAA_OUTCOME_SPINE = Spine;
})(typeof window !== 'undefined' ? window : this);
