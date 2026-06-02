/*
 * AAA Receipt Intake Store — the financial-memory queue between a photographed
 * receipt and a posted expense.
 *
 * Lifecycle of one receipt:
 *   capture (image stored locally) → ingest(ocr) → classify → de-dupe →
 *   suggest a job → land in the review queue → a PERSON approves →
 *   post to AAA_ACCOUNTING as a real expense (via the Runtime Gateway) → done.
 *
 * Hard rules (enforced by code, not trust):
 *   - Nothing posts to the books without a human approval: approveAndPost()
 *     calls the gateway with origin:'human' + action REVIEW_RECEIPTS, which is
 *     a human-only action. AI can ingest/classify/recommend, never post.
 *   - Posting is idempotent: a receipt can become at most ONE expense.
 *   - Duplicates are flagged on ingest (same vendor+date+total fingerprint) and
 *     cannot be posted without an explicit override.
 *   - Honest extraction: a low-confidence or incomplete OCR lands in
 *     'needs_review', never silently posts.
 *
 * Records live in the owner-only 'receipts' collection (same isolation as the
 * rest of accounting). This module owns the workflow + math; the gateway owns
 * the authority; firestore.rules owns the isolation.
 */
;(function (global) {
  'use strict';

  const RECEIPTS = 'receipts';

  // Workflow states.
  const S = {
    NEEDS_REVIEW: 'needs_review', // low confidence / missing data — person must fix
    READY: 'ready',               // confidently classified — awaits human approval
    DUPLICATE: 'duplicate',       // looks like an already-seen receipt
    POSTED: 'posted',             // became a real expense
    REJECTED: 'rejected'          // person discarded it
  };

  function data() { return global.AAA_DATA; }
  function cfg() { return global.AAA_CONFIG || {}; }
  function ids() { return global.AAA_ID_FACTORY; }
  function clock() { return global.AAA_RUNTIME_CLOCK; }
  function gateway() { return global.AAA_RUNTIME_GATEWAY; }
  function accounting() { return global.AAA_ACCOUNTING; }
  function classifier() { return global.AAA_EXPENSE_CLASSIFIER; }
  function ws() { return cfg().workspaceId || 'default'; }
  function nowISO() { return clock() && clock().nowISO ? clock().nowISO() : new Date().toISOString(); }
  function mine(r) { return r && (r.workspaceId == null || r.workspaceId === ws()); }
  function num(v) { const n = Number(v); return isFinite(n) ? n : 0; }
  function round(n) { return Math.round(n * 100) / 100; }

  const Store = {
    RECEIPTS: RECEIPTS, STATES: S,

    // ---- read -----------------------------------------------------------
    async list() { return (await data().list(RECEIPTS)).filter(mine).sort(byNewest); },
    async get(id) { const r = await data().get(RECEIPTS, id); return mine(r) ? r : null; },
    /** The review queue: everything awaiting a human decision, newest first. */
    async queue() { return (await this.list()).filter((r) => r.status === S.READY || r.status === S.NEEDS_REVIEW || r.status === S.DUPLICATE); },

    /**
     * Ingest an extracted receipt. Runs classification, duplicate detection and
     * a job-match suggestion, then files it in the review queue. Does NOT post.
     * @param {Object} input { ocr, mediaId?, blobKey? }
     */
    async ingest(input) {
      const i = input || {};
      const ocr = normalizeOcr(i.ocr);
      const id = i.id || (ids() ? ids().createId('rcpt') : 'rcpt_' + Date.now());

      const classification = classifier() ? await classifier().classify(ocr) : null;
      if (classifier() && classification) {
        // Log the prediction so accuracy can be measured at approval time.
        const pred = await classifier().logPrediction({
          receiptId: id, vendor: ocr.vendor, predicted: classification.category,
          confidence: classification.confidence, source: classification.source
        });
        classification.predictionId = pred && pred.id;
      }

      const fingerprint = fingerprintOf(ocr);
      const dup = await this._findDuplicate(fingerprint, id);
      const jobMatch = await this._suggestJob(ocr);

      const status = dup ? S.DUPLICATE
        : (needsReview(ocr, classification) ? S.NEEDS_REVIEW : S.READY);

      const rec = {
        id: id, workspaceId: ws(), status: status,
        mediaId: i.mediaId || null, blobKey: i.blobKey || null,
        ocr: ocr,
        classification: classification,
        category: classification ? classification.category : 'Uncategorized',
        jobId: jobMatch ? null : null,                // not assigned until a human confirms
        jobMatch: jobMatch,
        fingerprint: fingerprint, duplicateOf: dup ? dup.id : null,
        expenseId: null,
        reviewedBy: null, approvedAt: null, postedAt: null, rejectedReason: null,
        createdAt: nowISO(), updatedAt: nowISO()
      };
      await put(rec);
      return rec;
    },

    /** Apply a human re-categorization and teach the classifier. */
    async reclassify(id, category, opts) {
      const r = await this.get(id); if (!r) return { ok: false, error: 'NOT_FOUND' };
      if (r.status === S.POSTED) return { ok: false, error: 'ALREADY_POSTED' };
      const o = opts || {};
      if (classifier() && classifier().correct) {
        await classifier().correct({
          vendor: r.ocr && r.ocr.vendor, category: category, actor: o.actor,
          predictionId: r.classification && r.classification.predictionId
        });
      }
      const rec = Object.assign({}, r, {
        category: category,
        classification: Object.assign({}, r.classification, { category: category, source: 'human', confidence: 100, reasoning: 'Set by a person.', needsReview: false }),
        status: r.status === S.NEEDS_REVIEW ? S.READY : r.status,
        updatedAt: nowISO()
      });
      await put(rec); return { ok: true, receipt: rec };
    },

    /** Confirm which job this receipt belongs to (or clear it). */
    async assignJob(id, jobId) {
      const r = await this.get(id); if (!r) return { ok: false, error: 'NOT_FOUND' };
      const rec = Object.assign({}, r, { jobId: jobId || null, updatedAt: nowISO() });
      await put(rec); return { ok: true, receipt: rec };
    },

    /**
     * Human approval → post to the books. Routed through the Runtime Gateway as
     * a human-only action (REVIEW_RECEIPTS). Idempotent: a receipt becomes at
     * most one expense. Duplicates require opts.overrideDuplicate.
     */
    async approveAndPost(id, opts) {
      const o = opts || {};
      const r = await this.get(id); if (!r) return { ok: false, error: 'NOT_FOUND' };
      if (r.status === S.POSTED || r.expenseId) return { ok: true, alreadyPosted: true, expenseId: r.expenseId, receipt: r };
      if (r.status === S.REJECTED) return { ok: false, error: 'REJECTED' };
      if (r.status === S.DUPLICATE && !o.overrideDuplicate) return { ok: false, error: 'DUPLICATE', message: 'This looks like a receipt already on file. Confirm to post it anyway.' };
      if (!r.category || r.category === 'Uncategorized') return { ok: false, error: 'NEEDS_CATEGORY', message: 'Set a category before posting.' };
      const amount = round(num(r.ocr && r.ocr.total));
      if (!(amount > 0)) return { ok: false, error: 'NO_AMOUNT', message: 'Receipt has no usable total.' };

      const gw = gateway();
      if (!gw) return { ok: false, error: 'NO_GATEWAY' };
      const res = await gw.run({
        action: 'REVIEW_RECEIPTS',
        origin: 'human',
        actor: o.actor || null,
        target: { type: 'receipt', id: id },
        detail: { vendor: r.ocr && r.ocr.vendor, category: r.category, amount: amount, jobId: r.jobId || null },
        mutate: async () => accounting().addExpense({
          jobId: r.jobId || null,
          category: r.category,
          description: expenseDescription(r),
          amount: amount,
          receiptId: id,
          incurredAt: (r.ocr && r.ocr.date) || nowISO()
        })
      });
      if (!res.ok) return res;   // gateway denied (RBAC / AI) or mutation failed

      const expense = res.result;
      const rec = Object.assign({}, r, {
        status: S.POSTED, expenseId: expense && expense.id,
        reviewedBy: o.actor || null, approvedAt: nowISO(), postedAt: nowISO(),
        auditId: res.auditId, updatedAt: nowISO()
      });
      await put(rec);
      return { ok: true, expenseId: expense && expense.id, expense: expense, receipt: rec, auditId: res.auditId };
    },

    /** Discard a receipt (kept for the audit trail; never deleted). */
    async reject(id, reason, opts) {
      const r = await this.get(id); if (!r) return { ok: false, error: 'NOT_FOUND' };
      if (r.status === S.POSTED) return { ok: false, error: 'ALREADY_POSTED' };
      const rec = Object.assign({}, r, { status: S.REJECTED, rejectedReason: String(reason || ''), reviewedBy: (opts || {}).actor || null, updatedAt: nowISO() });
      await put(rec); return { ok: true, receipt: rec };
    },

    /** Queue + workflow stats for the dashboard. */
    async stats() {
      const all = await this.list();
      const by = (s) => all.filter((r) => r.status === s).length;
      const posted = all.filter((r) => r.status === S.POSTED);
      const postedTotal = round(posted.reduce((s, r) => s + num(r.ocr && r.ocr.total), 0));
      return {
        total: all.length,
        needsReview: by(S.NEEDS_REVIEW), ready: by(S.READY), duplicates: by(S.DUPLICATE),
        posted: posted.length, rejected: by(S.REJECTED),
        postedTotal: postedTotal,
        queueDepth: by(S.NEEDS_REVIEW) + by(S.READY) + by(S.DUPLICATE)
      };
    },

    // ---- internals ------------------------------------------------------
    async _findDuplicate(fingerprint, selfId) {
      if (!fingerprint) return null;
      const all = await this.list();
      return all.find((r) => r.id !== selfId && r.fingerprint === fingerprint && r.status !== S.REJECTED) || null;
    },
    /**
     * Suggest the most likely active job by date proximity + address overlap.
     * Deterministic and conservative — a human always confirms the assignment.
     */
    async _suggestJob(ocr) {
      let jobs = [];
      try { jobs = (await data().listJobs()).filter((j) => mine(j) && j.currentState !== 'CLOSED'); } catch (_) { return null; }
      if (!jobs.length) return null;
      const rDate = parseDate(ocr && ocr.date);
      const rTokens = addressTokens(ocr && ocr.address);
      let best = null;
      for (const j of jobs) {
        let score = 0; const reasons = [];
        const jDate = parseDate(j.scheduledDate);
        if (rDate && jDate) {
          const days = Math.abs(rDate - jDate) / 86400000;
          if (days <= 1) { score += 60; reasons.push('same-day as the job'); }
          else if (days <= 3) { score += 35; reasons.push('within 3 days of the job'); }
          else if (days <= 7) { score += 15; reasons.push('within a week of the job'); }
        }
        const overlap = tokenOverlap(rTokens, addressTokens(j.serviceAddress));
        if (overlap >= 2) { score += 30; reasons.push('receipt address overlaps the job site'); }
        else if (overlap === 1) { score += 12; reasons.push('partial address match'); }
        if (score > 0 && (!best || score > best.confidence)) best = { jobId: j.id, jobName: j.customerName || j.id, confidence: Math.min(score, 95), reason: reasons.join(', ') };
      }
      return best;
    }
  };

  // ---- pure helpers -----------------------------------------------------
  function byNewest(a, b) { return String(b.createdAt || '').localeCompare(String(a.createdAt || '')); }

  function normalizeOcr(ocr) {
    const o = ocr || {};
    const lineItems = Array.isArray(o.lineItems) ? o.lineItems.map((x) => ({
      description: String((x && (x.description || x.name)) || x || ''),
      quantity: x && x.quantity != null ? num(x.quantity) : null,
      sku: x && x.sku != null ? String(x.sku) : null,
      amount: x && x.amount != null ? round(num(x.amount)) : null
    })) : [];
    return {
      vendor: o.vendor != null ? String(o.vendor).trim() : '',
      date: o.date || null, time: o.time || null, address: o.address || null,
      subtotal: o.subtotal != null ? round(num(o.subtotal)) : null,
      tax: o.tax != null ? round(num(o.tax)) : null,
      total: o.total != null ? round(num(o.total)) : null,
      paymentMethod: o.paymentMethod || null,
      invoiceNumber: o.invoiceNumber || null, receiptNumber: o.receiptNumber || null,
      lineItems: lineItems,
      confidence: o.confidence == null ? null : num(o.confidence),
      quality: o.quality || null   // e.g. 'blurry' | 'partial' | 'ok'
    };
  }

  // A receipt needs human attention if the OCR was unsure, key money fields are
  // missing, the image was flagged, or the classifier wasn't confident.
  function needsReview(ocr, classification) {
    if (!ocr) return true;
    if (!(num(ocr.total) > 0)) return true;
    if (!ocr.vendor) return true;
    if (ocr.confidence != null && ocr.confidence < 70) return true;
    if (ocr.quality && ocr.quality !== 'ok') return true;
    if (classification && classification.needsReview) return true;
    return false;
  }

  // Fingerprint for duplicate detection: vendor + date + total. Cheap, real,
  // and catches the common "scanned the same receipt twice" case.
  function fingerprintOf(ocr) {
    if (!ocr) return null;
    const v = String(ocr.vendor || '').toLowerCase().replace(/\s+/g, '');
    const d = String(ocr.date || '').slice(0, 10);
    const tot = ocr.total != null ? round(num(ocr.total)).toFixed(2) : '';
    if (!v && !tot) return null;
    return v + '|' + d + '|' + tot;
  }

  function expenseDescription(r) {
    const o = r.ocr || {};
    const ref = o.receiptNumber || o.invoiceNumber;
    return [o.vendor || 'Receipt', ref ? '#' + ref : null].filter(Boolean).join(' ');
  }

  function parseDate(s) { if (!s) return null; const t = Date.parse(s); return isFinite(t) ? t : null; }
  function addressTokens(s) {
    if (!s) return [];
    return String(s).toLowerCase().match(/[a-z0-9]+/g) || [];
  }
  function tokenOverlap(a, b) {
    if (!a.length || !b.length) return 0;
    const setB = new Set(b);
    // ignore very common short tokens to avoid spurious matches
    const stop = new Set(['tx', 'st', 'rd', 'dr', 'ave', 'ln', 'the', 'of', 'houston']);
    let n = 0;
    for (const t of new Set(a)) if (t.length > 2 && !stop.has(t) && setB.has(t)) n++;
    return n;
  }

  async function put(rec) {
    await data().put(RECEIPTS, rec.id, rec);
    try { if (data().cloudReady && data().cloudReady() && global.AAA_CLOUD) global.AAA_CLOUD.upsertEntity(RECEIPTS, rec.id, rec); } catch (_) {}
  }

  global.AAA_RECEIPT_INTAKE = Store;
})(typeof window !== 'undefined' ? window : this);
