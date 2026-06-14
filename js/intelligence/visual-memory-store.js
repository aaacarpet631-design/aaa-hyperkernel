/*
 * AAA Visual Memory — the moat layer of the Visual Intelligence platform.
 *
 * Every captured image becomes a STRUCTURED evidence record linked to the job,
 * customer, quote, technician — and, once the work closes, to the real business
 * OUTCOME. That linkage is the competitive asset: not photos, but photos joined
 * to diagnoses, estimates, margins, and results, so a new image can be answered
 * with "147 prior jobs like this closed at X, averaged Y labor hours."
 *
 * Honest by construction:
 *  - This is NOT a vision model. It stores whatever analysis the caller captured
 *    (a real /api/vision result, manual tags, or nothing) and NEVER invents a
 *    diagnosis — absent fields are stored as null.
 *  - Customer home photos are PII. Records are LOCAL-FIRST; this module performs
 *    no network egress of images. A `consent` flag (default false) gates any
 *    future external use. Retrieval aggregates are PII-MINIMIZED — counts and
 *    averages only, never names/addresses/phones.
 *  - Deterministic + null-tolerant throughout; methods resolve result objects
 *    instead of throwing into the field UI.
 *
 * Owner-scoped like the provenance ledger (financial — exposes margins / win
 * rates), enforced server-side; workspace-scoped in JS.
 */
;(function (global) {
  'use strict';

  const COLLECTION = 'visual_memory';

  function cfg() { return global.AAA_CONFIG || {}; }
  function data() { return global.AAA_DATA; }
  function ids() { return global.AAA_ID_FACTORY; }
  function clock() { return global.AAA_RUNTIME_CLOCK; }
  function provenance() { return global.AAA_PROVENANCE; }
  function ws() { return cfg().workspaceId || 'default'; }
  function nowISO() { return clock() && clock().nowISO ? clock().nowISO() : new Date().toISOString(); }
  function mine(r) { return r && (r.workspaceId == null || r.workspaceId === ws()); }
  function byNewest(a, b) { return String(b.capturedAt || '').localeCompare(String(a.capturedAt || '')); }

  function numOrNull(v) { if (v == null || v === '') return null; const n = Number(v); return isFinite(n) ? n : null; }
  function boolOrNull(v) { return v === true ? true : (v === false ? false : null); }
  function arr(v) { return Array.isArray(v) ? v.filter(function (x) { return x != null; }) : (v != null ? [v] : []); }
  function round(n) { return Math.round(n); }
  function newId() { return ids() ? ids().createId('vis') : 'vis_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8); }

  // Store ONLY what was actually captured — never fabricate a diagnosis.
  function normalizeAnalysis(a) {
    a = a || {};
    return {
      category: a.category != null ? String(a.category) : null,
      recommendation: a.recommendation != null ? String(a.recommendation) : null,
      confidenceScore: numOrNull(a.confidenceScore),
      estimateLowUSD: numOrNull(a.estimateLowUSD),
      estimateHighUSD: numOrNull(a.estimateHighUSD)
    };
  }

  async function put(rec) {
    await data().put(COLLECTION, rec.id, rec);
    try { if (data().cloudReady && data().cloudReady() && global.AAA_CLOUD) global.AAA_CLOUD.upsertEntity(COLLECTION, rec.id, rec); } catch (_) {}
    return rec;
  }

  const Store = {
    COLLECTION: COLLECTION,

    /** Append a structured visual-evidence record. Returns the stored record. */
    async record(evidence) {
      const e = evidence || {};
      if (!data() || !data().put) return { ok: false, error: 'NO_STORE' };
      const rec = {
        id: newId(),
        workspaceId: ws(),
        capturedAt: e.capturedAt || nowISO(),
        jobId: e.jobId != null ? e.jobId : null,
        customerId: e.customerId != null ? e.customerId : null,
        quoteId: e.quoteId != null ? e.quoteId : null,
        technicianId: e.technicianId != null ? e.technicianId : null,
        imageRef: e.imageRef != null ? e.imageRef : null,   // local storage key — NOT pixels inline
        source: e.source || 'manual',
        analysis: normalizeAnalysis(e.analysis),
        tags: arr(e.tags).map(String),
        serviceType: arr(e.serviceType).map(String),
        zip: e.zip != null ? String(e.zip) : null,
        consent: e.consent === true,
        outcome: null
      };
      try { await put(rec); } catch (_) { return { ok: false, error: 'WRITE_FAILED' }; }
      // Trace it into the provenance ledger so every image is answerable later.
      try {
        if (provenance() && provenance().record) {
          await provenance().record({
            subjectType: 'visual_evidence', subjectId: rec.id,
            kind: 'visual_evidence', recordId: rec.id, jobId: rec.jobId,
            category: rec.analysis.category, source: rec.source
          });
        }
      } catch (_) {}
      return rec;
    },

    async get(id) {
      try { const r = await data().get(COLLECTION, id); return mine(r) ? r : null; } catch (_) { return null; }
    },

    /** Records in this workspace (newest first), optionally filtered. */
    async list(opts) {
      const o = opts || {};
      let all;
      try { all = (await data().list(COLLECTION)) || []; } catch (_) { return []; }
      return all.filter(mine).filter(function (r) {
        if (o.jobId != null && String(r.jobId) !== String(o.jobId)) return false;
        if (o.customerId != null && String(r.customerId) !== String(o.customerId)) return false;
        if (o.category != null && (!r.analysis || r.analysis.category !== o.category)) return false;
        return true;
      }).sort(byNewest);
    },

    /** Link the real business outcome back to a visual prediction (Phase 4). */
    async linkOutcome(id, outcome) {
      const rec = await this.get(id);
      if (!rec) return { ok: false, reason: 'NOT_FOUND' };
      const o = outcome || {};
      rec.outcome = {
        finalAmountUSD: numOrNull(o.finalAmountUSD),
        won: boolOrNull(o.won),
        laborHours: numOrNull(o.laborHours),
        satisfaction: numOrNull(o.satisfaction)
      };
      try { await put(rec); } catch (_) { return { ok: false, reason: 'WRITE_FAILED' }; }
      return { ok: true, record: rec };
    },

    /**
     * Evidence-driven retrieval (Phase 3): given a record/id/descriptor, find
     * prior records like it and aggregate their REAL outcomes. Widens the match
     * from category → serviceType → zip so a thin category still returns signal.
     * Samples are PII-minimized; aggregates only count records that actually
     * have a linked outcome — no fabricated stats.
     */
    async findSimilar(queryOrId, opts) {
      const o = opts || {};
      const empty = { ok: true, matchedOn: 'none', count: 0, samples: [], outcomes: { withOutcome: 0, avgFinalAmountUSD: null, closeRatePct: null, avgLaborHours: null } };
      if (!data() || !data().list) return Object.assign({}, empty, { ok: false, error: 'NO_STORE' });

      let q = queryOrId;
      let selfId = null;
      if (typeof queryOrId === 'string') { q = await this.get(queryOrId); selfId = queryOrId; }
      if (!q) return empty;
      const category = o.category != null ? o.category : (q.analysis ? q.analysis.category : q.category) || null;
      const serviceType = arr(o.serviceType != null ? o.serviceType : q.serviceType).map(String);
      const zip = o.zip != null ? o.zip : (q.zip != null ? String(q.zip) : null);

      const all = (await this.list()).filter(function (r) { return r.id !== selfId; });

      let matchedOn = 'none', matches = [];
      if (category) { matches = all.filter(function (r) { return r.analysis && r.analysis.category === category; }); if (matches.length) matchedOn = 'category'; }
      if (!matches.length && serviceType.length) { matches = all.filter(function (r) { return (r.serviceType || []).some(function (s) { return serviceType.indexOf(s) !== -1; }); }); if (matches.length) matchedOn = 'serviceType'; }
      if (!matches.length && zip) { matches = all.filter(function (r) { return r.zip === zip; }); if (matches.length) matchedOn = 'zip'; }
      if (!matches.length) return empty;

      const samples = matches.slice(0, o.limit || 10).map(function (r) {
        // PII-MIN: id + analysis only. No customerId/customerName/address/phone.
        return { id: r.id, category: r.analysis ? r.analysis.category : null, confidenceScore: r.analysis ? r.analysis.confidenceScore : null, estimateLowUSD: r.analysis ? r.analysis.estimateLowUSD : null, estimateHighUSD: r.analysis ? r.analysis.estimateHighUSD : null };
      });

      const withOutcome = matches.filter(function (r) { return r.outcome; });
      const finals = withOutcome.map(function (r) { return r.outcome.finalAmountUSD; }).filter(function (n) { return n != null; });
      const labors = withOutcome.map(function (r) { return r.outcome.laborHours; }).filter(function (n) { return n != null; });
      const won = withOutcome.filter(function (r) { return r.outcome.won === true; }).length;
      const lost = withOutcome.filter(function (r) { return r.outcome.won === false; }).length;
      return {
        ok: true, matchedOn: matchedOn, count: matches.length, samples: samples,
        outcomes: {
          withOutcome: withOutcome.length,
          avgFinalAmountUSD: finals.length ? round(finals.reduce(function (s, n) { return s + n; }, 0) / finals.length) : null,
          closeRatePct: (won + lost) ? round((won / (won + lost)) * 100) : null,
          avgLaborHours: labors.length ? Math.round((labors.reduce(function (s, n) { return s + n; }, 0) / labors.length) * 10) / 10 : null
        }
      };
    },

    /**
     * Phase-4 readout: how often the captured estimate range actually contained
     * the final amount, and the average absolute error vs the range midpoint.
     * Only scores records that have BOTH an estimate range and a final amount.
     */
    async predictionAccuracy(opts) {
      const o = opts || {};
      let all;
      try { all = await this.list(o.jobId ? { jobId: o.jobId } : undefined); } catch (_) { return { ok: false, sample: 0, withinRangePct: null, avgAbsErrorUSD: null }; }
      const scored = all.filter(function (r) {
        return r.analysis && r.analysis.estimateLowUSD != null && r.analysis.estimateHighUSD != null && r.outcome && r.outcome.finalAmountUSD != null;
      });
      if (!scored.length) return { ok: true, sample: 0, withinRangePct: null, avgAbsErrorUSD: null };
      let within = 0, errSum = 0;
      scored.forEach(function (r) {
        const lo = r.analysis.estimateLowUSD, hi = r.analysis.estimateHighUSD, fin = r.outcome.finalAmountUSD;
        if (fin >= lo && fin <= hi) within++;
        errSum += Math.abs(fin - (lo + hi) / 2);
      });
      return { ok: true, sample: scored.length, withinRangePct: round((within / scored.length) * 100), avgAbsErrorUSD: round(errSum / scored.length) };
    }
  };

  global.AAA_VISUAL_MEMORY = Store;
})(typeof window !== 'undefined' ? window : this);
