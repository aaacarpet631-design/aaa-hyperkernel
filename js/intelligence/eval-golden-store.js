/*
 * AAA Golden Eval Store — the reference scoreboard for AI task quality.
 *
 * Pure measurement infrastructure. Holds owner-curated "golden" eval cases
 * (a task input + a human reference) and scores a candidate output against the
 * reference with DETERMINISTIC graders only (no LLM judge in this slice). It is
 * the primitive the prompt/model registry will later use to gate releases:
 * a new version ships only if it does not regress the golden set.
 *
 * It never calls a model, never touches customer-facing flows, never acts on a
 * score — it only measures. Case authoring is owner-gated; an active case must
 * be marked piiCleared first.
 */
;(function (global) {
  'use strict';

  function data() { return global.AAA_DATA; }
  function ids() { return global.AAA_ID_FACTORY; }
  function clock() { return global.AAA_RUNTIME_CLOCK; }
  function rbac() { return global.AAA_RBAC; }
  function now() { return clock() && clock().now ? clock().now() : Date.now(); }

  const COLLECTION = 'eval_golden_cases';
  const TASK_TYPES = ['estimate', 'quote', 'follow_up', 'review_request', 'message_safety', 'tool_call', 'routing'];
  const GRADERS = ['numeric_mape', 'safety_label', 'json_schema', 'contains', 'exact'];

  // ---- pure helpers ---------------------------------------------------------
  function clamp01(x) { return Math.max(0, Math.min(1, x)); }
  function r3(x) { return Math.round(x * 1000) / 1000; }
  function lower(s) { return String(s == null ? '' : s).trim().toLowerCase(); }
  function num(v) {
    if (typeof v === 'number') return isFinite(v) ? v : null;
    if (v && typeof v === 'object' && typeof v.value === 'number') return v.value;
    if (v == null) return null;
    const n = parseFloat(String(v).replace(/[^0-9.-]/g, ''));
    return isNaN(n) ? null : n;
  }
  function textOf(candidate) {
    if (typeof candidate === 'string') return candidate;
    if (candidate && typeof candidate.text === 'string') return candidate.text;
    return candidate == null ? '' : JSON.stringify(candidate);
  }

  // ---- deterministic graders (pure, exported) -------------------------------
  // Estimate/quote accuracy: continuous score = 1 - MAPE, pass within tolerance.
  function gradeNumericMape(candidate, c) {
    const exp = num(c && c.referenceValue);
    const got = num(candidate && candidate.value != null ? candidate.value : candidate);
    if (exp == null || got == null || exp === 0) return { score: 0, pass: false, error: 'NON_NUMERIC', mape: null };
    const mape = Math.abs(got - exp) / Math.abs(exp);
    const tol = (c.graderConfig && c.graderConfig.tolerance != null) ? c.graderConfig.tolerance : 0.15;
    return { score: r3(clamp01(1 - mape)), pass: mape <= tol, mape: r3(mape) };
  }
  // Safety classification: predicted label vs expected (safe|unsafe).
  function gradeSafety(candidate, c) {
    const expected = lower((c.reference && c.reference.expected) != null ? c.reference.expected : c.referenceValue);
    const predicted = lower(candidate && candidate.label != null ? candidate.label : candidate);
    const pass = expected !== '' && expected === predicted;
    return { score: pass ? 1 : 0, pass: pass, expected: expected, predicted: predicted };
  }
  // Free-text inclusion/exclusion (e.g. follow-up must ask for a review).
  function gradeContains(candidate, c) {
    const text = lower(textOf(candidate));
    const cfg = c.graderConfig || {};
    const inc = (cfg.mustInclude || []).map(lower);
    const exc = (cfg.mustNotInclude || []).map(lower);
    const missing = inc.filter(function (w) { return text.indexOf(w) === -1; });
    const banned = exc.filter(function (w) { return text.indexOf(w) !== -1; });
    const pass = missing.length === 0 && banned.length === 0;
    return { score: pass ? 1 : 0, pass: pass, missing: missing, banned: banned };
  }
  function gradeExact(candidate, c) {
    const got = lower(textOf(candidate));
    const exp = lower((c.reference && c.reference.output) != null ? c.reference.output : c.referenceValue);
    const pass = got === exp;
    return { score: pass ? 1 : 0, pass: pass };
  }
  // Minimal JSON-schema check (required keys + shallow types) for tool outputs.
  function gradeJsonSchema(candidate, c) {
    if (candidate == null || typeof candidate !== 'object' || Array.isArray(candidate)) return { score: 0, pass: false, error: 'NOT_OBJECT' };
    const schema = (c.graderConfig && c.graderConfig.schema) || {};
    const required = schema.required || [];
    const missing = required.filter(function (k) { return !(k in candidate); });
    const props = schema.properties || {};
    const typeErrors = [];
    Object.keys(props).forEach(function (k) {
      if (k in candidate) {
        const want = props[k].type;
        const got = Array.isArray(candidate[k]) ? 'array' : typeof candidate[k];
        if (want && want !== got) typeErrors.push(k);
      }
    });
    const pass = missing.length === 0 && typeErrors.length === 0;
    return { score: pass ? 1 : 0, pass: pass, missing: missing, typeErrors: typeErrors };
  }
  const GRADER_FNS = { numeric_mape: gradeNumericMape, safety_label: gradeSafety, contains: gradeContains, exact: gradeExact, json_schema: gradeJsonSchema };

  /** Score one candidate output against one case (pure). */
  function score(candidate, caseObj) {
    const fn = GRADER_FNS[caseObj && caseObj.grader];
    if (!fn) return { caseId: caseObj && caseObj.caseId, score: 0, pass: false, error: 'UNKNOWN_GRADER' };
    return Object.assign({ caseId: caseObj.caseId, taskType: caseObj.taskType, grader: caseObj.grader }, fn(candidate, caseObj));
  }

  function ownerOk() { const r = rbac(); return !(r && r.can) || r.can('MANAGE_GOVERNANCE'); }

  const Golden = {
    COLLECTION: COLLECTION, TASK_TYPES: TASK_TYPES, GRADERS: GRADERS,
    // pure graders + scorer
    gradeNumericMape: gradeNumericMape, gradeSafety: gradeSafety, gradeContains: gradeContains,
    gradeExact: gradeExact, gradeJsonSchema: gradeJsonSchema, score: score,

    async listCases(filter) {
      if (!data()) return [];
      const f = filter || {};
      const all = await data().list(COLLECTION);
      return (all || []).filter(function (c) {
        if (f.taskType && c.taskType !== f.taskType) return false;
        if (f.status && c.status !== f.status) return false;
        return true;
      });
    },
    async getCase(id) { return data() ? data().get(COLLECTION, id) : null; },

    /** Author a case (owner-gated). Starts in 'draft' until piiCleared + activated. */
    async addCase(input) {
      if (!data()) return { ok: false, error: 'NO_DATA' };
      if (!ownerOk()) return { ok: false, error: 'FORBIDDEN' };
      input = input || {};
      if (TASK_TYPES.indexOf(input.taskType) === -1) return { ok: false, error: 'UNKNOWN_TASK_TYPE' };
      if (GRADERS.indexOf(input.grader) === -1) return { ok: false, error: 'UNKNOWN_GRADER' };
      const id = input.caseId || ((ids() && ids().createId) ? ids().createId('ev') : ('ev_' + now()));
      const rec = {
        caseId: id, version: input.version || 1, status: 'draft', taskType: input.taskType,
        input: input.input || {}, reference: input.reference || {},
        referenceValue: input.referenceValue != null ? input.referenceValue : null,
        grader: input.grader, graderConfig: input.graderConfig || {},
        labels: input.labels || { source: 'manual' }, piiCleared: !!input.piiCleared,
        createdBy: input.createdBy || null, createdAt: now(), updatedAt: now(), notes: input.notes || ''
      };
      await data().put(COLLECTION, id, rec);
      return { ok: true, case: rec };
    },

    /** draft → active (requires piiCleared) → archived. Owner-gated. */
    async setStatus(id, status) {
      if (!ownerOk()) return { ok: false, error: 'FORBIDDEN' };
      if (['draft', 'active', 'archived'].indexOf(status) === -1) return { ok: false, error: 'BAD_STATUS' };
      const c = await this.getCase(id);
      if (!c) return { ok: false, error: 'NOT_FOUND' };
      if (status === 'active' && !c.piiCleared) return { ok: false, error: 'PII_NOT_CLEARED' };
      const upd = Object.assign({}, c, { status: status, updatedAt: now() });
      await data().put(COLLECTION, id, upd);
      return { ok: true, case: upd };
    },

    /** Bulk import (e.g. the seed templates or an owner export). Owner-gated. */
    async importCases(arr) {
      if (!ownerOk()) return { ok: false, error: 'FORBIDDEN' };
      let imported = 0;
      for (const x of (arr || [])) {
        const r = await this.addCase(x);
        if (r.ok) { if (x.status && x.status !== 'draft') await this.setStatus(r.case.caseId, x.status); imported++; }
      }
      return { ok: true, imported: imported };
    },

    /**
     * Score a candidate set against the ACTIVE cases of a task type.
     * candidates = [{ caseId, output }]. Returns aggregate metrics; for
     * message_safety it also derives precision/recall/false-block.
     */
    async run(taskType, candidates) {
      const map = {}; (candidates || []).forEach(function (c) { map[c.caseId] = c.output; });
      const cases = await this.listCases({ taskType: taskType, status: 'active' });
      const results = []; let sum = 0, passes = 0; const byGrader = {};
      let tp = 0, fp = 0, tn = 0, fn = 0;
      for (const c of cases) {
        if (!(c.caseId in map)) continue;
        const r = score(map[c.caseId], c);
        results.push(r); sum += r.score; if (r.pass) passes++;
        byGrader[c.grader] = byGrader[c.grader] || { n: 0, pass: 0 };
        byGrader[c.grader].n++; if (r.pass) byGrader[c.grader].pass++;
        if (c.grader === 'safety_label') {
          const expU = r.expected === 'unsafe', predU = r.predicted === 'unsafe';
          if (expU && predU) tp++; else if (!expU && predU) fp++; else if (!expU && !predU) tn++; else fn++;
        }
      }
      const n = results.length;
      const out = { taskType: taskType, n: n, mean: n ? r3(sum / n) : null, passRate: n ? r3(passes / n) : null, byGrader: byGrader, results: results };
      if (tp + fp + tn + fn > 0) {
        out.safety = {
          precision: (tp + fp) ? r3(tp / (tp + fp)) : null,
          recall: (tp + fn) ? r3(tp / (tp + fn)) : null,
          falseBlockRate: (fp + tn) ? r3(fp / (fp + tn)) : null
        };
      }
      return out;
    },

    /** Compare two run() results → regressions (the release-gate primitive). Pure. */
    compareVersions(baseline, candidate) {
      const b = {}; ((baseline && baseline.results) || []).forEach(function (r) { b[r.caseId] = r; });
      const regressed = [], improved = []; let deltaSum = 0, nn = 0;
      ((candidate && candidate.results) || []).forEach(function (r) {
        const prev = b[r.caseId]; if (!prev) return;
        deltaSum += (r.score - prev.score); nn++;
        if (prev.pass && !r.pass) regressed.push(r.caseId);
        else if (!prev.pass && r.pass) improved.push(r.caseId);
      });
      return { regressed: regressed, improved: improved, meanDelta: nn ? r3(deltaSum / nn) : 0, hasRegression: regressed.length > 0 };
    }
  };

  global.AAA_EVAL_GOLDEN = Golden;
})(typeof window !== 'undefined' ? window : this);
