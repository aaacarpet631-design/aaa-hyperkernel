/*
 * AAA Estimator Agent — drafts carpet/flooring quotes from field measurements.
 *
 * The first true "field" agent in the money loop, and recommendation-first by
 * construction:
 *   - recommend(input)  → prices a draft via the DETERMINISTIC pricing engine
 *                         (AAA_MEASUREMENT_QUOTE — never re-implemented here),
 *                         attaches a confidence + risk score, and logs an
 *                         agent_decisions record so the Supervisor scores it
 *                         against the real outcome later. Touches NO books and
 *                         does NOT modify the job.
 *   - accept(input)     → the HUMAN approval path: routes through the Runtime
 *                         Gateway's ADD_ESTIMATE (human-only, audited) to attach
 *                         the priced lines to the job as needs-review estimates.
 *
 * Hard guarantees (enforced by code, not trust):
 *   - The agent never finalizes a customer price, never posts to accounting, and
 *     never edits the rate card. Those are human-only gateway actions.
 *   - needsHumanApproval is ALWAYS true on a recommendation.
 *   - AI-origin accept() is hard-blocked by the gateway (ADD_ESTIMATE.aiAllowed
 *     === false) and the denial is audited.
 *   - Pricing hard rules ($45/room shampoo floor, stair ×1.5, min job) are owned
 *     by the pricing engine; the estimator cannot weaken them.
 */
;(function (global) {
  'use strict';

  function cfg() { return global.AAA_CONFIG || {}; }
  function data() { return global.AAA_DATA; }
  function ids() { return global.AAA_ID_FACTORY; }
  function clock() { return global.AAA_RUNTIME_CLOCK; }
  function gateway() { return global.AAA_RUNTIME_GATEWAY; }
  function quote() { return global.AAA_MEASUREMENT_QUOTE; }
  function models() { return global.AAA_MEASUREMENT_MODELS; }
  function events() { return global.AAA_EVENTS; }
  function nowISO() { return clock() && clock().nowISO ? clock().nowISO() : new Date().toISOString(); }
  function num(v) { const n = Number(v); return isFinite(n) ? n : 0; }
  function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }

  // The full agent contract (per the AAA agent spec). Real metadata the command
  // center / supervisor / docs read — not decoration.
  const SPEC = {
    agentId: 'estimator',
    agentType: 'domain.advisory',
    name: 'AI Estimator',
    description: 'Drafts carpet & flooring quotes from field measurements (and optional photo analysis) using the deterministic pricing engine. Recommendation-first — it never finalizes a price.',
    allowedActions: ['read_measurements', 'read_photo_analysis', 'compute_priced_estimate', 'recommend_draft', 'log_decision'],
    blockedActions: ['finalize_price', 'approve_quote', 'modify_accounting', 'post_invoice', 'edit_rate_card', 'write_books', 'auto_send_to_customer'],
    inputs: ['measurement sessions (sqft / linear ft / stairs)', 'selected or inferred service types', 'optional vision photo analysis', 'owner-controlled rate card'],
    outputs: ['priced quote (internal cost view + customer receipt view)', 'confidence 0-100', 'risk 0-100', 'reasoning', 'risks[]', 'nextActions[]', 'needsHumanApproval (always true)'],
    confidenceModel: 'Deterministic factor sum: measurable data present, dimension completeness, capture source quality (BLE/AI confidence vs manual), explicit vs inferred service selection, and whether the owner has set a real rate card.',
    riskModel: 'Deterministic factor sum: job dollar size, low confidence, missing/au unmeasurable data, pricing-edge flags (below-min / shampoo floor fired), and thin margin (price vs labor+material cost).',
    memoryReads: ['measurements', 'jobs', 'rateCard (config)'],
    memoryWrites: ['agent_decisions (customer-safe summary + confidence/risk, for Supervisor scoring)', 'agent_logs (event)'],
    auditEvents: ['estimator.recommended (agent event log)', 'ADD_ESTIMATE (audit_log, on human accept via the gateway)'],
    supervisorReview: 'recommend() logs an agent_decisions record keyed by jobId; AAA_SUPERVISOR.scoreOutcome() scores its confidence (Brier calibration) and estimate accuracy vs the final amount when the job outcome is recorded.',
    humanApprovalThreshold: 'Always. The agent produces a draft only; a person must accept() it through the gateway (ADD_ESTIMATE, human-only) to attach it to the job. Nothing is auto-finalized or auto-sent.',
    kpiImpact: ['quote turnaround time', 'estimate accuracy (vs final amount)', 'close-rate via confidence calibration', 'margin protection (flags below-min / floor / thin margin)']
  };

  const Engine = {
    SPEC: SPEC,

    /**
     * Price a draft estimate. Pure + read-only — no persistence, no mutation.
     * @param {Object} input { sessions:[], services?:[serviceId], visionAnalysis?, jobId?, customerName? }
     */
    estimate(input) {
      const i = input || {};
      const Q = quote();
      if (!Q) return { ok: false, error: 'NO_PRICING_ENGINE' };
      const sessions = Array.isArray(i.sessions) ? i.sessions.filter(Boolean) : [];
      if (!sessions.length) return { ok: false, error: 'NO_MEASUREMENTS', message: 'Add at least one room measurement to estimate.' };

      // Service selection: explicit if provided, otherwise inferred from what was
      // measured (lower confidence + flagged so a human notices).
      let services = Array.isArray(i.services) && i.services.length ? i.services.slice() : null;
      const inferred = !services;
      if (inferred) services = inferServices(sessions, Q);
      if (!services.length) return { ok: false, error: 'NO_SERVICES', message: 'Pick at least one service to price.' };

      const selections = services.map((serviceId) => ({ serviceId: serviceId, sessions: sessions }));
      const q = Q.buildQuote(selections);
      const receipt = Q.toReceipt(q, { customerName: i.customerName || null });

      const conf = computeConfidence(sessions, services, inferred, i.visionAnalysis, q);
      const risk = computeRisk(q, conf.score);

      const reasoning = buildReasoning(q, services, inferred, conf, risk);
      return {
        ok: true,
        agent: SPEC.agentId,
        jobId: i.jobId || null,
        services: services,
        inferredServices: inferred,
        quote: q,                 // includes internal _labor/_material/_ruleNotes
        receipt: receipt,         // customer-safe
        confidence: conf.score,
        confidenceFactors: conf.factors,
        risk: risk.score,
        severity: risk.severity,
        riskFactors: risk.factors,
        reasoning: reasoning,
        risks: risk.factors.map((f) => f.label),
        nextActions: buildNextActions(q, conf, risk),
        needsHumanApproval: true  // ALWAYS — the agent only drafts
      };
    },

    /**
     * Produce a recommendation: estimate + persist an agent_decisions record so
     * the Supervisor can score it against the outcome. No books, no job changes.
     */
    async recommend(input) {
      const est = this.estimate(input);
      if (!est.ok) return est;

      // Customer-safe decision record (NO cost internals) for supervisor scoring.
      const id = ids() ? ids().createId('dec') : 'dec_' + Date.now();
      const decision = {
        id: id, agent: SPEC.agentId, kind: 'estimate',
        jobId: est.jobId, workspaceId: cfg().workspaceId || 'default',
        recommendation: est.services.join(', ') + ' — ' + est.receipt.estimateRange,
        total: est.quote.total, range: est.quote.totalRange,
        confidence: est.confidence, risk: est.risk,
        rationale: est.reasoning, createdAt: nowISO()
      };
      try {
        await data().put('agent_decisions', id, decision);
        if (data().cloudReady && data().cloudReady() && global.AAA_CLOUD) await global.AAA_CLOUD.upsertEntity('agent_decisions', id, decision);
      } catch (_) {}
      try { if (data().logAgent) data().logAgent(SPEC.agentId, 'Drafted estimate ' + decision.recommendation + ' (conf ' + est.confidence + ', risk ' + est.risk + ')', { jobId: est.jobId }); } catch (_) {}
      if (events()) events().emit('estimator.recommended', { jobId: est.jobId, total: est.quote.total, confidence: est.confidence, risk: est.risk });

      est.decisionId = id;
      return est;
    },

    /**
     * Persist this estimate as a DRAFT quote in the lifecycle store (the one
     * AI-allowed write — a draft, never a commitment). Returns the quote record.
     * @param {Object} input { sessions, services?, customer?, jobId?, leadSource?, zip?, actor?, origin? }
     */
    async draftQuote(input) {
      const est = await this.recommend(input);
      if (!est.ok) return est;
      if (!global.AAA_QUOTES) return Object.assign({}, est, { quoteDraft: null, quoteError: 'NO_QUOTE_STORE' });
      const i = input || {};
      const draft = await global.AAA_QUOTES.createDraft({
        estimate: est, customer: i.customer, customerId: i.customerId, customerName: i.customerName,
        jobId: i.jobId, leadSource: i.leadSource, zip: i.zip, address: i.address,
        sessions: i.sessions, photos: i.photos, actor: i.actor, origin: i.origin
      });
      est.quoteId = draft.quoteId;
      est.quoteDraft = draft;
      return est;
    },

    /**
     * Human approval → attach the priced lines to the job as needs-review
     * estimates, through the gateway (ADD_ESTIMATE: human-only, RBAC, audited).
     * AI-origin callers are hard-blocked here.
     * @param {Object} input { jobId, estimate (from estimate()/recommend()), origin?, actor? }
     */
    async accept(input) {
      const i = input || {};
      const est = i.estimate;
      if (!i.jobId) return { ok: false, error: 'NO_JOB', message: 'Select a job to attach the estimate to.' };
      if (!est || !est.ok || !est.quote) return { ok: false, error: 'NO_ESTIMATE' };
      const gw = gateway();
      if (!gw) return { ok: false, error: 'NO_GATEWAY' };
      const Q = quote();
      const sessionIds = (Array.isArray(i.sessionIds) ? i.sessionIds : []).slice();

      const res = await gw.run({
        action: 'ADD_ESTIMATE',
        origin: i.origin === 'ai' ? 'ai' : 'human',
        actor: i.actor || null,
        target: { type: 'job', id: i.jobId },
        detail: { source: 'estimator', services: est.services, total: est.quote.total, confidence: est.confidence, risk: est.risk },
        mutate: async () => {
          const entries = Q.toEstimateEntries(est.quote, { sessionIds: sessionIds })
            .map((e) => Object.assign({}, e, { source: 'AI_ESTIMATOR' }));
          const job = await data().get('jobs', i.jobId);
          if (!job) throw new Error('Job not found.');
          const updated = Object.assign({}, job, {
            estimates: (Array.isArray(job.estimates) ? job.estimates : []).concat(entries),
            updatedAt: nowISO()
          });
          await data().put('jobs', i.jobId, updated);
          try { if (data().cloudReady && data().cloudReady() && global.AAA_CLOUD) global.AAA_CLOUD.upsertEntity('jobs', i.jobId, updated); } catch (_) {}
          if (events()) events().emit('estimate.added', { jobId: i.jobId, count: entries.length, source: 'estimator' });
          return entries;
        }
      });
      if (!res.ok) return res;
      return { ok: true, entries: res.result, auditId: res.auditId, jobId: i.jobId };
    }
  };

  // ---- service inference (only when caller didn't specify) ----------------
  function inferServices(sessions, Q) {
    const out = [];
    const anyArea = sessions.some((s) => num(s.squareFeet) > 0);
    const anyLinear = sessions.some((s) => num(s.linearFeet) > 0);
    const anyStairs = sessions.some((s) => num(s.stairsCount) > 0);
    if (anyArea) out.push('carpet_install');   // most common area job; human re-picks if wrong
    if (anyLinear) out.push('carpet_repair');
    if (anyStairs) out.push('stairs');
    return out;
  }

  // ---- confidence model (deterministic, explainable) ---------------------
  function computeConfidence(sessions, services, inferred, vision, q) {
    let score = 50; const factors = [];
    const add = (delta, label) => { score += delta; factors.push({ delta: delta, label: label }); };

    const measurable = sessions.filter((s) => num(s.squareFeet) > 0 || num(s.linearFeet) > 0 || num(s.stairsCount) > 0);
    if (measurable.length === sessions.length && sessions.length) add(20, 'All rooms have a usable measurement');
    else if (measurable.length) add(5, 'Some rooms lack a usable measurement');
    else add(-25, 'No usable measurements');

    const dimComplete = sessions.filter((s) => (s.length != null && s.width != null) || num(s.linearFeet) > 0 || num(s.stairsCount) > 0);
    if (dimComplete.length === sessions.length) add(10, 'Dimensions complete');

    // Capture source quality: BLE/AI readings with a confidence beat raw manual.
    const cs = sessions.map((s) => s && s.confidenceScore).filter((n) => typeof n === 'number');
    if (cs.length) {
      const avg = cs.reduce((a, b) => a + b, 0) / cs.length;
      add(Math.round((avg - 0.5) * 20), 'Capture confidence ' + Math.round(avg * 100) + '%');
    }

    if (inferred) add(-12, 'Service type was inferred, not chosen');
    else add(8, 'Service type chosen explicitly');

    // A real, owner-set rate card beats placeholder defaults.
    const hasRateCard = !!(cfg().flag && cfg().flag('rateCard', null));
    add(hasRateCard ? 5 : -5, hasRateCard ? 'Owner rate card configured' : 'Using placeholder default rates');

    if (vision && typeof vision.confidence === 'number') add(Math.round((vision.confidence - 50) / 10), 'Photo analysis confidence ' + vision.confidence + '%');

    return { score: clamp(Math.round(score), 0, 100), factors: factors };
  }

  // ---- risk model (deterministic, explainable) ---------------------------
  function computeRisk(q, confidence) {
    let score = 10; const factors = [];
    const add = (delta, label) => { score += delta; factors.push({ delta: delta, label: label }); };

    const total = num(q.total);
    if (total > 2000) add(25, 'Large job (> $2,000) — verify scope');
    else if (total > 1000) add(15, 'Sizable job (> $1,000)');
    else if (total > 500) add(5, 'Mid-size job');

    if (confidence < 50) add(25, 'Low input confidence');
    else if (confidence < 70) add(10, 'Moderate input confidence');

    // Pricing-edge flags from the engine's internal trace.
    const ruleNotes = [].concat.apply([], (q.lines || []).map((l) => l._ruleNotes || []));
    if ((q.lines || []).some((l) => l._belowMin)) add(10, 'Hit the job minimum (small job)');
    if (ruleNotes.some((n) => /shampoo floor/.test(n))) add(8, 'Shampoo per-room floor applied');

    // Thin margin: price vs internal cost (labor + material).
    const cost = num(q._laborTotal) + num(q._materialTotal);
    if (total > 0) {
      const margin = (total - cost) / total;
      if (margin < 0.15) add(15, 'Thin margin (< 15%)');
      else if (margin < 0.25) add(7, 'Margin under target (< 25%)');
    }

    score = clamp(Math.round(score), 0, 100);
    const severity = score >= 60 ? 'high' : (score >= 30 ? 'medium' : 'low');
    return { score: score, severity: severity, factors: factors };
  }

  function buildReasoning(q, services, inferred, conf, risk) {
    return 'Priced ' + (q.lines || []).length + ' service line(s) totaling $' + q.total + ' (' + q.totalRange + ')' +
      (inferred ? ', service type inferred from the measurements' : '') +
      '. Confidence ' + conf.score + ', risk ' + risk.score + ' (' + risk.severity + '). Draft only — a person reviews and approves before it attaches to the job.';
  }
  function buildNextActions(q, conf, risk) {
    const a = ['Review the line items and confirm the service type', 'Approve to attach the estimate to the job (needs-review)'];
    if (conf.score < 70) a.unshift('Double-check the measurements — confidence is moderate/low');
    if (risk.severity === 'high') a.unshift('Verify scope before quoting — risk is high');
    return a;
  }

  global.AAA_ESTIMATOR = Engine;
})(typeof window !== 'undefined' ? window : this);
