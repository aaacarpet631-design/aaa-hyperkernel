/*
 * AAA Replay Sandbox — "what would this decision have been under different
 * governed versions?" — with ZERO production writes.
 *
 * It anchors on a recorded provenance trace (a real past recommendation or
 * council decision), resolves the governed versions that were IN FORCE at the
 * time (calibration / policy / prompt / model), lets the owner swap in any
 * other version (active or historical), and deterministically RECOMPUTES the
 * decision + its KPI impact. It then shows original vs replayed side by side and
 * links back to the provenance trace and the governance versions involved.
 *
 * Hard rules (enforced by code):
 *   - It NEVER writes a quote, job, customer, outcome, prediction, recommendation,
 *     or calibration. The only optional write is an owner-only `replay_snapshots`
 *     record (a sandbox artifact, never a business record) when persist:true.
 *   - Every run routes through the gateway (REPLAY_SANDBOX, human-only + audited).
 *     AI and non-owners are blocked.
 *   - The comparison core (pureReplay) is a PURE function of its inputs — no
 *     clock, no randomness — so a replay is bit-for-bit reproducible.
 *   - Calibration NEVER changes price (architecture rule 2); the price KPI delta
 *     is always 0 by construction, which the sandbox states plainly.
 *   - Null-tolerant throughout: missing trace/version/store degrades, never throws.
 */
;(function (global) {
  'use strict';

  const SNAPSHOTS = 'replay_snapshots';
  // The KPI dimensions every replay reports (the six in the acceptance bar plus
  // confidence, the primary calibration effect, and — for council — decision).
  const KPI_KEYS = ['price', 'margin', 'risk', 'followUp', 'review', 'booking', 'confidence'];

  function cfg() { return global.AAA_CONFIG || {}; }
  function data() { return global.AAA_DATA; }
  function ids() { return global.AAA_ID_FACTORY; }
  function clock() { return global.AAA_RUNTIME_CLOCK; }
  function gateway() { return global.AAA_RUNTIME_GATEWAY; }
  function provenance() { return global.AAA_PROVENANCE; }
  function governance() { return global.AAA_GOVERNANCE; }
  function calibration() { return global.AAA_CALIBRATION_REGISTRY; }
  function ws() { return cfg().workspaceId || 'default'; }
  function nowISO() { return clock() && clock().nowISO ? clock().nowISO() : new Date().toISOString(); }
  function mine(r) { return r && (r.workspaceId == null || r.workspaceId === ws()); }
  function num(v) { const n = Number(v); return isFinite(n) ? n : 0; }
  function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, Math.round(n))); }
  function arr(v) { return Array.isArray(v) ? v : []; }

  // ---- the deterministic core ------------------------------------------
  // A PURE function: same input → same output, no IO, no clock, no randomness.
  function pureReplay(input) {
    const i = input || {};
    const base = i.base || {};
    const inForce = i.inForce || {};
    const chosen = i.chosen || {};
    const cal0 = inForce.calibration || { confidenceBias: 0, riskBias: 0 };
    const cal1 = chosen.calibration || cal0;
    const pol0 = inForce.policy || {};
    const pol1 = chosen.policy || {};

    // Confidence + risk move by the DIFFERENCE between the chosen and in-force
    // calibration bias (the trace's stored confidence already bakes in cal0).
    const confDelta = num(cal1.confidenceBias) - num(cal0.confidenceBias);
    const riskDelta = num(cal1.riskBias) - num(cal0.riskBias);
    const origConf = base.confidence != null ? clamp(num(base.confidence), 0, 100) : null;
    const replConf = origConf == null ? null : clamp(origConf + confDelta, 0, 100);
    const origRisk = base.risk != null ? clamp(num(base.risk), 0, 100) : null;
    const replRisk = origRisk == null ? null : clamp(origRisk + riskDelta, 0, 100);

    // Booking likelihood is modeled monotonically from confidence (clearly
    // labeled as modeled, not measured).
    const origBook = origConf;
    const replBook = replConf;

    const kpis = [];
    // price — calibration/prompt/model never change a price (rule 2).
    kpis.push(kpi('price', 'Price', base.price != null ? num(base.price) : null, base.price != null ? num(base.price) : null, '$', 'none — pricing is never auto-changed'));
    // margin — governed by a policy marginFloor; we show the floor + pass/fail.
    const f0 = pol0.marginFloor, f1 = pol1.marginFloor;
    if (f0 != null || f1 != null) {
      const row = kpi('margin', 'Margin floor', f0 != null ? num(f0) : null, f1 != null ? num(f1) : null, '%', 'policy.marginFloor');
      if (base.marginPct != null) { row.originalPass = num(base.marginPct) >= num(f0 != null ? f0 : f1); row.replayedPass = num(base.marginPct) >= num(f1 != null ? f1 : f0); }
      kpis.push(row);
    } else kpis.push(kpi('margin', 'Margin floor', null, null, '%', 'policy.marginFloor'));
    // risk
    kpis.push(kpi('risk', 'Risk', origRisk, replRisk, '', 'calibration.riskBias'));
    // follow-up SLA (days) — policy
    kpis.push(kpi('followUp', 'Follow-up SLA', pol0.followUpDays != null ? num(pol0.followUpDays) : null, pol1.followUpDays != null ? num(pol1.followUpDays) : null, 'd', 'policy.followUpDays'));
    // review SLA (hours) — policy
    kpis.push(kpi('review', 'Review SLA', pol0.reviewSlaHours != null ? num(pol0.reviewSlaHours) : null, pol1.reviewSlaHours != null ? num(pol1.reviewSlaHours) : null, 'h', 'policy.reviewSlaHours'));
    // booking likelihood — modeled from confidence
    kpis.push(kpi('booking', 'Booking likelihood', origBook, replBook, '%', 'modeled from confidence'));
    // confidence
    kpis.push(kpi('confidence', 'Confidence', origConf, replConf, '', 'calibration.confidenceBias'));

    const original = { confidence: origConf, risk: origRisk, bookingLikelihood: origBook };
    const replayed = { confidence: replConf, risk: replRisk, bookingLikelihood: replBook };

    // Council decision replay: re-apply the cautious-downgrade rule under the
    // chosen split threshold (and re-pick from the tally when available).
    if (i.subjectType === 'council_session') {
      const thr = pol1.splitThreshold != null ? num(pol1.splitThreshold) : (pol0.splitThreshold != null ? num(pol0.splitThreshold) : 40);
      const thr0 = pol0.splitThreshold != null ? num(pol0.splitThreshold) : 40;
      const origDecision = decide(base.tally, base.decision, num(base.disagreement), thr0);
      const replDecision = decide(base.tally, base.decision, num(base.disagreement), thr);
      original.decision = origDecision;
      replayed.decision = replDecision;
      // Confidence downgrade mirrors the council: a demotion to revise scales
      // decision confidence by the disagreement.
      original.decisionConfidence = origConf;
      replayed.decisionConfidence = (replDecision === 'revise' && (base.decision === 'approve')) ? clamp(num(origConf) * (1 - num(base.disagreement) / 100), 0, 100) : replConf;
      kpis.push({ key: 'decision', label: 'Council decision', original: origDecision, replayed: replDecision, delta: null, changed: origDecision !== replDecision, unit: '', affectedBy: 'policy.splitThreshold' });
    }

    return { original: original, replayed: replayed, kpis: kpis, anyChange: kpis.some((k) => k.changed) };
  }

  function kpi(key, label, original, replayed, unit, affectedBy) {
    const delta = (typeof original === 'number' && typeof replayed === 'number') ? Math.round((replayed - original) * 100) / 100 : null;
    return { key: key, label: label, original: original == null ? null : original, replayed: replayed == null ? null : replayed, delta: delta, changed: delta != null ? delta !== 0 : (original !== replayed && !(original == null && replayed == null)), unit: unit || '', affectedBy: affectedBy };
  }
  // Council decision under a split threshold. Uses the weighted tally when
  // present; always applies the cautious approve→revise downgrade on a split room.
  function decide(tally, fallbackDecision, disagreement, splitThreshold) {
    let decision = fallbackDecision || 'revise';
    if (tally && (tally.approve != null || tally.revise != null || tally.reject != null)) {
      let top = -1;
      ['reject', 'revise', 'approve'].forEach((s) => { const v = num(tally[s]); if (v > top) { top = v; decision = s; } });
    }
    if (decision === 'approve' && num(disagreement) >= num(splitThreshold)) decision = 'revise';
    return decision;
  }

  const Sandbox = {
    SNAPSHOTS: SNAPSHOTS, KPI_KEYS: KPI_KEYS,
    pureReplay: pureReplay,

    /**
     * Run a replay. Owner-only + audited (REPLAY_SANDBOX). Reads a provenance
     * trace, resolves in-force vs chosen governed versions, recomputes the
     * decision + KPI deltas, and returns the comparison. Writes NOTHING to any
     * business collection; persists an owner-only snapshot only if opts.persist.
     */
    async replay(opts) {
      const o = opts || {};
      const gw = gateway();
      if (!gw) return { ok: false, error: 'NO_GATEWAY' };
      // Authorization + audit FIRST (no business mutation runs on a denial).
      const auth = await gw.run({
        action: 'REPLAY_SANDBOX', origin: o.origin === 'ai' ? 'ai' : 'human', actor: o.actor || null,
        target: { type: 'replay', id: o.traceId || null }, detail: { persist: !!o.persist }
      });
      if (!auth.ok) return auth; // AI_NOT_PERMITTED / FORBIDDEN (audited)

      const trace = o.traceId && provenance() ? await provenance().get(o.traceId) : null;
      if (o.traceId && !trace) return { ok: false, error: 'TRACE_NOT_FOUND', auditId: auth.auditId };
      const subject = o.subject || null;
      const subjectType = (trace && trace.subjectType) || (subject && subject.subjectType) || o.subjectType || 'pricing_recommendation';
      const agent = (trace && trace.agent) || o.agent || 'pricing_optimizer';

      // ---- resolve the base decision snapshot (zero writes) ----
      const base = await buildBase(subjectType, trace, subject);

      // ---- resolve in-force vs chosen calibration ----
      const baseline = o.baseline || {};
      const scenario = o.scenario || {};
      const calInForce = await resolveCalibration(agent, baseline.calibrationVersionId, trace, o.inForceCalibration);
      const calChosen = await resolveCalibration(agent, scenario.calibrationVersionId, trace, o.chosenCalibration) || calInForce;

      // ---- resolve in-force vs chosen policy ----
      const polInForce = await resolvePolicy(baseline.policyVersionId, o.inForcePolicy);
      const polChosen = await resolvePolicy(scenario.policyVersionId, o.chosenPolicy) || polInForce;

      // ---- resolve prompt/model/template versions (linked; no numeric effect for deterministic agents) ----
      const promptV = await govVersion(scenario.promptVersionId);
      const modelV = await govVersion(scenario.modelVersionId);
      const templateV = await govVersion(scenario.templateVersionId);

      const core = pureReplay({
        subjectType: subjectType, base: base,
        inForce: { calibration: calInForce, policy: polInForce },
        chosen: { calibration: calChosen, policy: polChosen }
      });

      const governanceVersionIds = [scenario.policyVersionId, scenario.promptVersionId, scenario.modelVersionId, scenario.templateVersionId].filter(Boolean);
      const calibrationVersionIds = [calInForce && calInForce.id, calChosen && calChosen.id].filter(Boolean);
      const result = {
        ok: true, replayId: ids() ? ids().createId('rpl') : 'rpl_' + Date.now(), at: nowISO(),
        trace: trace ? { id: trace.id, subjectType: trace.subjectType, subjectId: trace.subjectId, agent: trace.agent, subjectLabel: trace.subjectLabel } : null,
        subjectType: subjectType, agent: agent,
        baseline: { calibration: calInForce, policy: polInForce, promptVersion: trace ? trace.promptVersion : null, modelVersion: trace ? trace.modelVersion : null },
        scenario: { calibration: calChosen, policy: polChosen, promptVersionId: scenario.promptVersionId || null, modelVersionId: scenario.modelVersionId || null, templateVersionId: scenario.templateVersionId || null, prompt: promptV, model: modelV, template: templateV },
        original: core.original, replayed: core.replayed, kpis: core.kpis, anyChange: core.anyChange,
        links: { provenanceTraceId: trace ? trace.id : null, governanceVersionIds: governanceVersionIds, calibrationVersionIds: calibrationVersionIds },
        writes: 0, persisted: false, snapshotId: null, auditId: auth.auditId
      };

      // ---- optional, owner-only snapshot (the ONLY write; never a business record) ----
      if (o.persist) {
        const snap = Object.assign({}, result, { id: result.replayId, workspaceId: ws(), persisted: true, createdBy: o.actor || null, createdAt: nowISO() });
        await put(SNAPSHOTS, snap);
        result.persisted = true; result.snapshotId = snap.id;
      }
      return result;
    },

    /** Available versions for the UI to choose from (calibration + governance). */
    async listVersions(agent) {
      const out = { calibration: [], policy: [], prompt: [], model: [], template: [] };
      try { if (calibration() && calibration().versions) out.calibration = await calibration().versions(agent); } catch (_) {}
      try {
        if (governance() && governance().list) {
          out.policy = await governance().list({ artifactType: 'policy' });
          out.prompt = await governance().list({ artifactType: 'prompt', name: agent });
          out.model = await governance().list({ artifactType: 'model', name: agent });
          out.template = await governance().list({ artifactType: 'template' });
        }
      } catch (_) {}
      return out;
    },

    async snapshots() { return (await data().list(SNAPSHOTS)).filter(mine).sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || ''))); },
    async getSnapshot(id) { const r = await data().get(SNAPSHOTS, id); return mine(r) ? r : null; }
  };

  // ---- base-snapshot extraction (read-only) ----------------------------
  async function buildBase(subjectType, trace, subject) {
    const s = subject || {};
    const sum = (trace && trace.summary) || {};
    if (subjectType === 'council_session') {
      return {
        confidence: s.decisionConfidence != null ? s.decisionConfidence : sum.confidence,
        risk: null, decision: s.decision || sum.decision || null,
        disagreement: s.disagreement != null ? s.disagreement : sum.disagreement,
        tally: s.tally || null
      };
    }
    // pricing_recommendation / estimate / prediction_closure
    const price = firstQuoteTotal(trace);
    return {
      confidence: s.adjustedConfidence != null ? s.adjustedConfidence : (s.confidence != null ? s.confidence : sum.confidence),
      risk: s.risk != null ? s.risk : sum.risk,
      marginPct: s.marginPct != null ? s.marginPct : (firstQuoteMargin(trace)),
      price: price
    };
  }
  function firstQuoteTotal(trace) { const q = trace && arr(trace.sourceQuotes)[0]; return q && q.customerTotal != null ? q.customerTotal : null; }
  function firstQuoteMargin(trace) { const q = trace && arr(trace.sourceQuotes)[0]; return q && q.marginPct != null ? q.marginPct : null; }

  // ---- version resolution (read-only) ----------------------------------
  async function resolveCalibration(agent, versionId, trace, inline) {
    if (inline) return { id: inline.id || null, confidenceBias: num(inline.confidenceBias), riskBias: num(inline.riskBias), version: inline.version != null ? inline.version : null };
    if (versionId && calibration() && calibration().versions) {
      try { const v = (await calibration().versions(agent)).find((x) => x.id === versionId); if (v) return { id: v.id, version: v.version, confidenceBias: num(v.confidenceBias), riskBias: num(v.riskBias), segmentAdjustments: v.segmentAdjustments || [] }; } catch (_) {}
    }
    // Default in-force: the calibration recorded on the trace.
    if (trace && trace.calibrationVersion) { const c = trace.calibrationVersion; return { id: c.id, version: c.version, confidenceBias: num(c.confidenceBias), riskBias: num(c.riskBias) }; }
    return null;
  }
  async function resolvePolicy(versionId, inline) {
    if (inline) return parsePolicy(inline, null);
    if (versionId && governance() && governance().get) {
      try { const v = await governance().get(versionId); if (v) return parsePolicy(v.content, v); } catch (_) {}
    }
    return null;
  }
  function parsePolicy(content, version) {
    let c = content;
    if (typeof c === 'string') { try { c = JSON.parse(c); } catch (_) { c = {}; } }
    c = c || {};
    return {
      versionId: version ? version.id : (c.id || null), version: version ? version.version : null,
      marginFloor: c.marginFloor != null ? num(c.marginFloor) : null,
      followUpDays: c.followUpDays != null ? num(c.followUpDays) : null,
      reviewSlaHours: c.reviewSlaHours != null ? num(c.reviewSlaHours) : null,
      splitThreshold: c.splitThreshold != null ? num(c.splitThreshold) : null
    };
  }
  async function govVersion(id) {
    if (!id || !governance() || !governance().get) return null;
    try { const v = await governance().get(id); return v ? { id: v.id, artifactType: v.artifactType, name: v.name, version: v.version, status: v.status, checksum: v.checksum } : null; } catch (_) { return null; }
  }

  async function put(c, rec) {
    await data().put(c, rec.id, rec);
    try { if (data().cloudReady && data().cloudReady() && global.AAA_CLOUD) global.AAA_CLOUD.upsertEntity(c, rec.id, rec); } catch (_) {}
  }

  global.AAA_REPLAY_SANDBOX = Sandbox;
})(typeof window !== 'undefined' ? window : this);
