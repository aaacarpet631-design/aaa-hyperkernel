/*
 * AAA Outcome Spine — one canonical, labeled view over fragmented outcomes.
 *
 * Outcome truth lives in several places: the generic `outcomes` collection,
 * resolved `quotes` (AAA_QUOTES), lead outcomes (AAA_LEADS), and governance
 * agent outcomes (AAA_AGENT_OUTCOMES). This spine READS those sources and
 * normalizes them into one canonical shape so future scoring/backtesting has a
 * single, consistent surface.
 *
 * It NEVER mutates source records. Missing labels are supplied through an
 * additive `outcome_labels` overlay that merges in at read time only. Pure,
 * local-first, network-free, and defensive: absent stores or malformed records
 * can never throw.
 */
;(function (global) {
  'use strict';

  function data() { return global.AAA_DATA; }
  function quotesStore() { return global.AAA_QUOTES; }
  function leadsStore() { return global.AAA_LEADS; }
  function govOutcomes() { return global.AAA_AGENT_OUTCOMES; }
  function nowMs() { const c = global.AAA_RUNTIME_CLOCK; return c && c.now ? c.now() : Date.now(); }

  const OVERLAY_COLLECTION = 'outcome_labels';
  const REQUIRED = ['entityType', 'entityId', 'result', 'resultClass', 'recordedAt'];
  const ACCURACY_TYPES = ['quote', 'job']; // need estimated+final for MAPE-style scoring

  function num(v) { const n = Number(v); return isFinite(n) ? n : null; }
  function lc(v) { return String(v == null ? '' : v).trim().toLowerCase(); }
  function round(n, p) { const f = Math.pow(10, p == null ? 4 : p); return Math.round(n * f) / f; }

  // ---- result normalization -------------------------------------------------
  const SUCCESS = ['won', 'win', 'accepted', 'accept', 'completed', 'complete', 'paid', 'successful', 'success', 'closed_won'];
  const FAILURE = ['lost', 'loss', 'rejected', 'reject', 'abandoned', 'abandon', 'cancelled', 'canceled', 'unsuccessful', 'refund', 'refunded', 'chargeback', 'complaint', 'overridden', 'closed_lost', 'failed', 'failure'];
  const NEUTRAL = ['callback', 'call_back', 'review', 'pending', 'scheduled', 'follow_up', 'followup', 'in_progress', 'neutral', 'open'];

  function classifyResult(result) {
    const r = lc(result);
    if (!r) return 'unknown';
    if (SUCCESS.indexOf(r) !== -1) return 'success';
    if (FAILURE.indexOf(r) !== -1) return 'failure';
    if (NEUTRAL.indexOf(r) !== -1) return 'neutral';
    return 'unknown';
  }

  // ---- canonical builder ----------------------------------------------------
  function blank() {
    return {
      id: null, entityType: null, entityId: null, source: null, sourceId: null,
      customerId: null, leadId: null, quoteId: null, jobId: null,
      result: null, resultClass: null,
      estimatedAmount: null, finalAmount: null, grossMargin: null, marginPct: null,
      leadSource: null, serviceType: null, reason: null,
      recordedAt: null, createdAt: null, updatedAt: null,
      labelStatus: 'unlabeled', missing: [], raw: null
    };
  }

  function serviceTypeOf(v) {
    if (Array.isArray(v)) return v.filter(Boolean).join(' + ') || null;
    return v != null && v !== '' ? String(v) : null;
  }

  /**
   * Normalize one source record into the canonical shape. Pure, null-tolerant.
   * @param {object} record  the raw source record
   * @param {string} source  'outcomes' | 'quotes' | 'leads' | 'agent_outcomes'
   */
  function normalize(record, source) {
    const o = blank();
    if (!record || typeof record !== 'object') { o.raw = record == null ? null : record; o.source = source || 'unknown'; return finalize(o); }
    o.raw = record;
    o.source = source || 'unknown';

    if (source === 'quotes') {
      o.entityType = 'quote';
      o.entityId = record.quoteId || record.id || null;
      o.sourceId = record.quoteId || record.id || null;
      o.quoteId = record.quoteId || record.id || null;
      o.customerId = record.customerId || null;
      o.result = record.status != null ? record.status : record.result;
      o.estimatedAmount = num(record.customerTotal != null ? record.customerTotal : record.estimatedAmount);
      o.finalAmount = num(record.finalPrice != null ? record.finalPrice : record.finalAmount);
      o.marginPct = num(record.marginPct);
      o.leadSource = record.leadSource || null;
      o.serviceType = serviceTypeOf(record.serviceType);
      o.reason = record.wonLostReason || record.reason || null;
      o.recordedAt = record.resolvedAt || record.updatedAt || record.recordedAt || null;
    } else if (source === 'leads') {
      const oc = record.outcome || {};
      o.entityType = 'lead';
      o.entityId = record.leadId || record.id || null;
      o.sourceId = record.leadId || record.id || null;
      o.leadId = record.leadId || record.id || null;
      o.customerId = record.customerId || null;
      o.result = oc.result != null ? oc.result : record.result;
      o.finalAmount = num(oc.revenue);
      o.leadSource = record.source || null;
      o.serviceType = serviceTypeOf(record.serviceType);
      o.reason = oc.lostReason || record.lostReason || null;
      o.recordedAt = oc.at || record.updatedAt || record.recordedAt || null;
    } else if (source === 'agent_outcomes') {
      const oc = record.outcome || {};
      o.entityType = 'agent_decision';
      o.entityId = record.id || record.decisionId || null;
      o.sourceId = record.id || record.decisionId || null;
      o.result = oc.result != null ? oc.result : record.outcomeStatus;
      o.reason = oc.reason || record.reason || null;
      o.recordedAt = oc.at || record.updatedAt || record.createdAt || null;
    } else {
      // generic 'outcomes' collection
      o.entityType = record.jobId ? 'job' : (record.entityType || 'outcome');
      o.entityId = record.jobId || record.entityId || record.id || null;
      o.sourceId = record.id || null;
      o.jobId = record.jobId || null;
      o.customerId = record.customerId || null;
      o.result = record.result;
      o.estimatedAmount = num(record.estimatedAmount != null ? record.estimatedAmount : record.quotedAmount);
      o.finalAmount = num(record.finalAmount != null ? record.finalAmount : record.final_amount);
      o.marginPct = num(record.marginPct);
      o.grossMargin = num(record.grossMargin);
      o.leadSource = record.leadSource || null;
      o.serviceType = serviceTypeOf(record.serviceType);
      o.reason = record.reason || record.notes || null;
      o.recordedAt = record.recordedAt || record.createdAt || null;
    }

    if (o.grossMargin == null) o.grossMargin = num(record.grossMargin);
    o.createdAt = record.createdAt || o.recordedAt;
    o.updatedAt = record.updatedAt || o.recordedAt;
    o.id = (o.source || 'src') + ':' + (o.sourceId || o.entityId || 'unknown');
    return finalize(o);
  }

  // Compute resultClass, missing fields, and labelStatus for a canonical record.
  function finalize(o) {
    o.resultClass = classifyResult(o.result);
    const v = validate(o);
    o.missing = v.missing;
    o.labelStatus = v.ok ? 'labeled' : 'unlabeled';
    return o;
  }

  // ---- validation -----------------------------------------------------------
  function validate(outcome) {
    const missing = [];
    const warnings = [];
    const o = outcome || {};
    REQUIRED.forEach(function (f) {
      const val = o[f];
      if (val == null || val === '') missing.push(f);
    });
    if (ACCURACY_TYPES.indexOf(o.entityType) !== -1) {
      if (o.estimatedAmount == null) missing.push('estimatedAmount');
      if (o.finalAmount == null) missing.push('finalAmount');
    }
    if (classifyResult(o.result) === 'unknown' && o.result != null && o.result !== '') warnings.push('unrecognized result "' + o.result + '"');
    if (o.marginPct == null && ACCURACY_TYPES.indexOf(o.entityType) !== -1) warnings.push('marginPct missing');
    return { ok: missing.length === 0, missing: missing, warnings: warnings };
  }

  // ---- overlay (additive labels; never writes back to sources) --------------
  let OVERLAY = null; // key -> entry, lazily hydrated
  function overlayKey(entityType, entityId) { return String(entityType || '') + ':' + String(entityId || ''); }

  async function loadOverlay() {
    if (OVERLAY) return OVERLAY;
    OVERLAY = {};
    try {
      const d = data();
      if (d && d.list) {
        const rows = await d.list(OVERLAY_COLLECTION);
        (Array.isArray(rows) ? rows : []).forEach(function (e) { if (e && e.entityType && e.entityId != null) OVERLAY[overlayKey(e.entityType, e.entityId)] = e; });
      }
    } catch (_) { /* store absent — empty overlay */ }
    return OVERLAY;
  }

  // Apply an overlay entry's patch onto a canonical record (overlay wins).
  function applyOverlay(canonical, entry) {
    if (!entry || !entry.patch) return canonical;
    const patch = entry.patch;
    Object.keys(patch).forEach(function (k) {
      if (patch[k] !== undefined && k !== 'raw' && k !== 'id') canonical[k] = patch[k];
    });
    canonical.labeledBy = entry.actor || null;
    canonical.labeledAt = entry.updatedAt || entry.createdAt || null;
    canonical.labelReason = entry.reason || null;
    return finalize(canonical);
  }

  // ---- source reads ---------------------------------------------------------
  async function readAllSources() {
    const records = [];
    // generic outcomes
    try { const d = data(); if (d && d.list) (await d.list('outcomes') || []).forEach(function (r) { records.push(normalize(r, 'outcomes')); }); } catch (_) {}
    // quotes
    try { const q = quotesStore(); if (q && q.list) (await q.list() || []).forEach(function (r) { records.push(normalize(r, 'quotes')); }); } catch (_) {}
    // leads (only those with a recorded outcome carry result data; normalize all, filter later by validity)
    try { const l = leadsStore(); if (l && l.list) (await l.list() || []).forEach(function (r) { records.push(normalize(r, 'leads')); }); } catch (_) {}
    // governance agent outcomes (only attached ones are meaningful)
    try {
      const g = govOutcomes();
      if (g && g.listDecisions) {
        (await g.listDecisions() || []).forEach(function (r) {
          if (r && r.outcomeStatus && r.outcomeStatus !== 'pending') records.push(normalize(r, 'agent_outcomes'));
        });
      }
    } catch (_) {}
    return records;
  }

  const Spine = {
    normalize: normalize,
    validate: validate,
    classifyResult: classifyResult,
    REQUIRED: REQUIRED.slice(),

    /** All canonical outcomes with the overlay merged in. options.source filters. */
    list: async function (options) {
      const o = options || {};
      const overlay = await loadOverlay();
      const records = await readAllSources();
      const seen = {};
      const merged = records.map(function (rec) {
        const key = overlayKey(rec.entityType, rec.entityId);
        seen[key] = true;
        return overlay[key] ? applyOverlay(rec, Object.assign({}, overlay[key])) : rec;
      });
      // Overlay-only entries (labels for outcomes with no source record yet).
      Object.keys(overlay).forEach(function (key) {
        if (seen[key]) return;
        const e = overlay[key];
        const base = blank();
        base.source = 'overlay';
        base.entityType = e.entityType;
        base.entityId = e.entityId;
        base.id = 'overlay:' + key;
        merged.push(applyOverlay(base, Object.assign({}, e)));
      });
      let out = merged;
      if (o.source) out = out.filter(function (r) { return r.source === o.source; });
      if (o.entityType) out = out.filter(function (r) { return r.entityType === o.entityType; });
      if (o.resultClass) out = out.filter(function (r) { return r.resultClass === o.resultClass; });
      return out;
    },

    /** Canonical outcomes that are missing required fields (need labeling). */
    unlabeled: async function (options) {
      const all = await this.list(options);
      return all.filter(function (r) { return !validate(r).ok; });
    },

    /** Labeling coverage across all normalized outcomes. */
    coverage: async function (options) {
      const all = await this.list(options);
      const total = all.length;
      let labeled = 0;
      const missingByField = {};
      all.forEach(function (r) {
        const v = validate(r);
        if (v.ok) labeled++;
        v.missing.forEach(function (f) { missingByField[f] = (missingByField[f] || 0) + 1; });
      });
      return {
        total: total,
        labeled: labeled,
        unlabeled: total - labeled,
        coveragePct: total ? round((labeled / total) * 100, 1) : 0,
        missingByField: missingByField
      };
    },

    /**
     * Write/refresh an additive label in the overlay. NEVER touches the source.
     * Re-labeling the same entity updates its single overlay entry (no dupes).
     * @returns {Promise<{ok, entry}|{ok:false, error}>}
     */
    label: async function (entityType, entityId, patch, actor) {
      if (!entityType || entityId == null) return { ok: false, error: 'ENTITY_REQUIRED' };
      if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return { ok: false, error: 'PATCH_REQUIRED' };
      if (!actor) return { ok: false, error: 'ACTOR_REQUIRED', message: 'label() requires an actor for attribution.' };
      const overlay = await loadOverlay();
      const key = overlayKey(entityType, entityId);
      const t = nowMs();
      const existing = overlay[key];
      const entry = {
        entityType: entityType,
        entityId: entityId,
        patch: Object.assign({}, existing && existing.patch, patch),
        actor: actor,
        reason: (patch.reason != null ? patch.reason : (existing && existing.reason)) || null,
        createdAt: existing ? existing.createdAt : t,
        updatedAt: t
      };
      overlay[key] = entry;
      // Best-effort durable write to the OVERLAY collection only.
      try { const d = data(); if (d && d.put) await d.put(OVERLAY_COLLECTION, key, entry); } catch (_) {}
      return { ok: true, entry: entry };
    },

    /** Test/util: drop the in-memory overlay cache (forces re-hydrate). */
    _resetOverlayCache: function () { OVERLAY = null; return { ok: true }; }
  };

  global.AAA_OUTCOME_SPINE = Spine;
})(typeof window !== 'undefined' ? window : this);
