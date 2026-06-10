/*
 * AAA Eval Golden Store — deterministic evaluation harness.
 *
 * Internal AI-quality infrastructure. Holds "golden" reference cases and scores
 * candidate AI outputs against them with PURE, DETERMINISTIC graders — no model
 * calls, no LLM judge, no network. It changes nothing customer-facing: it only
 * measures. Every method is null-tolerant and defensive so it can never crash
 * boot, and persistence is best-effort (localStorage when available, in-memory
 * otherwise).
 *
 * Graders: numeric_mape (estimate accuracy), safety_label (message safety),
 * json_schema (tool/structured output), contains (required phrases), exact.
 *
 * Runner: score() one candidate, run() a batch into an aggregate, and
 * compareVersions() two aggregates to gate promotion on regressions.
 */
;(function (global) {
  'use strict';

  // ---- tiny pure helpers ----------------------------------------------------
  function isNum(v) { return typeof v === 'number' ? isFinite(v) : (v != null && v !== '' && isFinite(Number(v))); }
  function num(v) { const n = Number(v); return isFinite(n) ? n : null; }
  function clamp01(n) { return n < 0 ? 0 : (n > 1 ? 1 : n); }
  function round(n, p) { const f = Math.pow(10, p == null ? 4 : p); return Math.round(n * f) / f; }
  function nowMs() { const c = global.AAA_RUNTIME_CLOCK; return c && c.now ? c.now() : Date.now(); }
  function newId(prefix) { const f = global.AAA_ID_FACTORY; return f && f.createId ? f.createId(prefix) : (prefix + '_' + Math.random().toString(36).slice(2, 10)); }
  function lc(v) { return String(v == null ? '' : v).trim().toLowerCase(); }

  // ===========================================================================
  // GRADERS — each is pure: inputs in, { score, pass, detail, ... } out.
  // ===========================================================================

  // A. numeric_mape — estimate/quote accuracy. Lower MAPE is better.
  function gradeNumericMape(args) {
    const a = args || {};
    const cand = num(a.candidateValue);
    const ref = num(a.referenceValue);
    const tol = isNum(a.tolerancePct) ? Number(a.tolerancePct) : 10;
    if (cand == null || ref == null) {
      return { score: 0, pass: false, mape: null, detail: 'INVALID_INPUT: candidateValue and referenceValue must both be numeric' };
    }
    let mapeFrac;
    const denom = Math.abs(ref);
    if (denom === 0) {
      // Divide-by-zero guard: only a candidate of exactly 0 is "accurate".
      mapeFrac = cand === 0 ? 0 : 1;
    } else {
      mapeFrac = Math.abs(cand - ref) / denom;
    }
    const mapePct = round(mapeFrac * 100, 2);
    const pass = mapePct <= tol;
    return {
      score: clamp01(1 - mapeFrac),
      pass: pass,
      mape: mapePct,
      detail: 'MAPE ' + mapePct + '% vs tolerance ' + tol + '% → ' + (pass ? 'pass' : 'fail') + ' (cand ' + cand + ' vs ref ' + ref + ')'
    };
  }

  // B. safety_label — message safety classification.
  const SAFE_LABELS = ['safe', 'allow', 'allowed', 'ok', 'pass', 'clean'];
  const UNSAFE_LABELS = ['unsafe', 'block', 'blocked', 'reject', 'rejected', 'flag', 'flagged', 'unsafe_block'];
  function isUnsafeLabel(label) { return UNSAFE_LABELS.indexOf(lc(label)) !== -1; }
  function isSafeLabel(label) { return SAFE_LABELS.indexOf(lc(label)) !== -1; }
  function gradeSafetyLabel(args) {
    const a = args || {};
    const cand = lc(a.candidate);
    const exp = lc(a.expected);
    if (!cand || !exp) {
      return { score: 0, pass: false, falseBlock: false, falseAllow: false, detail: 'INVALID_INPUT: candidate and expected labels are required' };
    }
    const pass = cand === exp;
    // A "false allow" lets unsafe content through; a "false block" stops safe content.
    const falseAllow = isUnsafeLabel(exp) && isSafeLabel(cand);
    const falseBlock = isSafeLabel(exp) && isUnsafeLabel(cand);
    return {
      score: pass ? 1 : 0,
      pass: pass,
      falseBlock: falseBlock,
      falseAllow: falseAllow,
      detail: 'expected "' + exp + '", candidate "' + cand + '"' +
        (falseAllow ? ' → FALSE ALLOW (unsafe passed as safe)' : falseBlock ? ' → FALSE BLOCK (safe stopped as unsafe)' : pass ? ' → match' : ' → mismatch')
    };
  }

  // C. json_schema — structured/tool output. No external schema libs.
  function gradeJsonSchema(args) {
    const a = args || {};
    const cand = a.candidate;
    const required = Array.isArray(a.requiredFields) ? a.requiredFields : [];
    const enums = (a.allowedEnums && typeof a.allowedEnums === 'object') ? a.allowedEnums : {};
    if (!cand || typeof cand !== 'object' || Array.isArray(cand)) {
      return { score: 0, pass: false, missingFields: required.slice(), invalidFields: [], detail: 'INVALID_INPUT: candidate must be a plain object' };
    }
    const missingFields = required.filter(function (f) { return cand[f] === undefined || cand[f] === null || cand[f] === ''; });
    const invalidFields = [];
    Object.keys(enums).forEach(function (f) {
      const allowed = Array.isArray(enums[f]) ? enums[f] : [];
      if (cand[f] !== undefined && cand[f] !== null && allowed.indexOf(cand[f]) === -1) {
        invalidFields.push({ field: f, value: cand[f], allowed: allowed });
      }
    });
    const totalChecks = required.length + Object.keys(enums).length;
    const failures = missingFields.length + invalidFields.length;
    const pass = failures === 0;
    const score = totalChecks === 0 ? (pass ? 1 : 0) : clamp01(1 - failures / totalChecks);
    return {
      score: score,
      pass: pass,
      missingFields: missingFields,
      invalidFields: invalidFields,
      detail: pass ? 'all ' + totalChecks + ' field checks passed'
        : 'missing [' + missingFields.join(', ') + ']' + (invalidFields.length ? '; invalid enums [' + invalidFields.map(function (x) { return x.field; }).join(', ') + ']' : '')
    };
  }

  // D. contains — required phrases/fields present in text.
  function gradeContains(args) {
    const a = args || {};
    const text = lc(a.candidate);
    const phrases = Array.isArray(a.phrases) ? a.phrases : [];
    if (!phrases.length) {
      return { score: 1, pass: true, missing: [], detail: 'no required phrases specified' };
    }
    const missing = phrases.filter(function (p) { return text.indexOf(lc(p)) === -1; });
    const pass = missing.length === 0;
    return {
      score: clamp01((phrases.length - missing.length) / phrases.length),
      pass: pass,
      missing: missing,
      detail: pass ? 'all ' + phrases.length + ' required phrase(s) present' : 'missing: [' + missing.join(', ') + ']'
    };
  }

  // E. exact — deterministic exact match.
  function gradeExact(args) {
    const a = args || {};
    const cand = a.candidate;
    const ref = a.reference;
    const c = typeof cand === 'string' ? cand.trim() : cand;
    const r = typeof ref === 'string' ? ref.trim() : ref;
    const pass = c === r || (c != null && r != null && JSON.stringify(c) === JSON.stringify(r));
    return { score: pass ? 1 : 0, pass: pass, detail: pass ? 'exact match' : 'expected ' + JSON.stringify(r) + ', got ' + JSON.stringify(c) };
  }

  const GRADERS = {
    numeric_mape: gradeNumericMape,
    safety_label: gradeSafetyLabel,
    json_schema: gradeJsonSchema,
    contains: gradeContains,
    exact: gradeExact
  };

  // Map a (candidate, case) pair to the grader-specific argument object.
  function buildGraderArgs(grader, candidate, evalCase) {
    const ref = (evalCase && evalCase.referenceOutput) || {};
    const exp = (evalCase && evalCase.expectedResult) || {};
    switch (grader) {
      case 'numeric_mape': {
        const cv = (candidate && typeof candidate === 'object') ? (candidate.value != null ? candidate.value : candidate.candidateValue) : candidate;
        return {
          candidateValue: cv,
          referenceValue: ref.referenceValue != null ? ref.referenceValue : evalCase.referenceValue,
          tolerancePct: ref.tolerancePct != null ? ref.tolerancePct : (exp.tolerancePct != null ? exp.tolerancePct : evalCase.tolerancePct)
        };
      }
      case 'safety_label': {
        const cl = (candidate && typeof candidate === 'object') ? (candidate.label != null ? candidate.label : candidate.candidate) : candidate;
        return { candidate: cl, expected: ref.label != null ? ref.label : (ref.expected != null ? ref.expected : exp.label) };
      }
      case 'json_schema':
        return { candidate: candidate, requiredFields: ref.requiredFields || evalCase.requiredFields || [], allowedEnums: ref.allowedEnums || evalCase.allowedEnums || {} };
      case 'contains': {
        const txt = (candidate && typeof candidate === 'object') ? (candidate.text != null ? candidate.text : '') : candidate;
        return { candidate: txt, phrases: ref.contains || ref.phrases || evalCase.phrases || [] };
      }
      case 'exact': {
        const cv = (candidate && typeof candidate === 'object' && candidate.value !== undefined) ? candidate.value : candidate;
        return { candidate: cv, reference: ref.value !== undefined ? ref.value : ref.referenceOutput };
      }
      default:
        return {};
    }
  }

  // ===========================================================================
  // CASE STORAGE — in-memory registry, best-effort localStorage persistence.
  // ===========================================================================
  const STORAGE_KEY = 'aaa:eval_golden';
  const REQUIRED_FIELDS = ['taskType', 'title', 'grader'];
  const CANONICAL_FIELDS = ['id', 'taskType', 'title', 'description', 'input', 'referenceOutput', 'grader',
    'expectedResult', 'tags', 'piiCleared', 'status', 'createdAt', 'updatedAt', 'createdBy', 'notes', 'synthetic'];

  let CASES = {}; // id -> case

  function lsGet() {
    try { const ls = global.localStorage; if (!ls) return null; return ls.getItem(STORAGE_KEY); } catch (_) { return null; }
  }
  function lsSet(json) {
    try { const ls = global.localStorage; if (ls) ls.setItem(STORAGE_KEY, json); } catch (_) { /* unavailable — in-memory only */ }
  }
  function persist() { try { lsSet(JSON.stringify(Object.keys(CASES).map(function (k) { return CASES[k]; }))); } catch (_) {} }
  function hydrate() {
    const raw = lsGet();
    if (!raw) return;
    try {
      const arr = JSON.parse(raw);
      if (Array.isArray(arr)) arr.forEach(function (c) { if (c && c.id) CASES[c.id] = c; });
    } catch (_) { /* corrupt cache — ignore, start empty */ }
  }

  // Validate a case's structure. Returns { ok, errors }. Grader-aware.
  function validateCase(c) {
    const errors = [];
    if (!c || typeof c !== 'object') return { ok: false, errors: ['case must be an object'] };
    REQUIRED_FIELDS.forEach(function (f) { if (c[f] == null || c[f] === '') errors.push('missing required field: ' + f); });
    if (c.grader && !GRADERS[c.grader]) errors.push('unknown grader: ' + c.grader);
    // Grader-specific reference requirements.
    const ref = c.referenceOutput || {};
    if (c.grader === 'numeric_mape' && ref.referenceValue == null && c.referenceValue == null) errors.push('numeric_mape requires referenceOutput.referenceValue');
    if (c.grader === 'safety_label' && ref.label == null && ref.expected == null) errors.push('safety_label requires referenceOutput.label');
    if (c.grader === 'json_schema' && !(Array.isArray(ref.requiredFields) || Array.isArray(c.requiredFields))) errors.push('json_schema requires referenceOutput.requiredFields');
    if (c.grader === 'contains' && !(Array.isArray(ref.contains) || Array.isArray(ref.phrases))) errors.push('contains requires referenceOutput.contains');
    if (c.grader === 'exact' && ref.value === undefined) errors.push('exact requires referenceOutput.value');
    return { ok: errors.length === 0, errors: errors };
  }

  function normalizeNew(input) {
    const t = nowMs();
    const c = {};
    CANONICAL_FIELDS.forEach(function (f) { if (input[f] !== undefined) c[f] = input[f]; });
    c.id = input.id || newId('eval');
    c.tags = Array.isArray(input.tags) ? input.tags.slice() : [];
    c.piiCleared = input.piiCleared === true;
    c.synthetic = input.synthetic === true || (c.tags.indexOf('synthetic') !== -1);
    if (c.synthetic && c.tags.indexOf('synthetic') === -1) c.tags.push('synthetic');
    c.status = input.status || 'draft';
    c.createdBy = input.createdBy || 'unknown';
    c.createdAt = input.createdAt || t;
    c.updatedAt = t;
    return c;
  }

  const Store = {
    GRADERS: Object.keys(GRADERS),
    REQUIRED_FIELDS: REQUIRED_FIELDS.slice(),

    /** Validate a raw case object without storing it. */
    validateCase: validateCase,

    /** Create a golden case. A case cannot be born active without piiCleared. */
    createCase: function (input) {
      const v = validateCase(input || {});
      if (!v.ok) return { ok: false, error: 'VALIDATION_FAILED', errors: v.errors };
      const c = normalizeNew(input || {});
      if (c.status === 'active' && c.piiCleared !== true) {
        return { ok: false, error: 'PII_NOT_CLEARED', message: 'A case cannot be active until piiCleared === true.' };
      }
      CASES[c.id] = c;
      persist();
      return { ok: true, case: c };
    },

    /** Patch a case. Re-checks the piiCleared gate before allowing 'active'. */
    updateCase: function (caseId, patch) {
      const c = CASES[caseId];
      if (!c) return { ok: false, error: 'NOT_FOUND' };
      const next = Object.assign({}, c, patch || {});
      next.updatedAt = nowMs();
      if (Array.isArray(next.tags) && next.synthetic && next.tags.indexOf('synthetic') === -1) next.tags.push('synthetic');
      const v = validateCase(next);
      if (!v.ok) return { ok: false, error: 'VALIDATION_FAILED', errors: v.errors };
      if (next.status === 'active' && next.piiCleared !== true) {
        return { ok: false, error: 'PII_NOT_CLEARED', message: 'A case cannot be active until piiCleared === true.' };
      }
      CASES[caseId] = next;
      persist();
      return { ok: true, case: next };
    },

    getCase: function (caseId) { return CASES[caseId] || null; },

    /** List cases. Excludes archived by default; filter by taskType/status/tag/synthetic/activeOnly. */
    listCases: function (filter) {
      const f = filter || {};
      return Object.keys(CASES).map(function (k) { return CASES[k]; }).filter(function (c) {
        if (!f.includeArchived && c.status === 'archived') return false;
        if (f.activeOnly && c.status !== 'active') return false;
        if (f.taskType && c.taskType !== f.taskType) return false;
        if (f.status && c.status !== f.status) return false;
        if (f.synthetic != null && !!c.synthetic !== !!f.synthetic) return false;
        if (f.tag && (!Array.isArray(c.tags) || c.tags.indexOf(f.tag) === -1)) return false;
        return true;
      });
    },

    archiveCase: function (caseId) {
      const c = CASES[caseId];
      if (!c) return { ok: false, error: 'NOT_FOUND' };
      c.status = 'archived';
      c.updatedAt = nowMs();
      persist();
      return { ok: true, case: c };
    },

    /** Ingest seed/synthetic cases from an array (no network). Marks them synthetic. */
    loadSeed: function (cases, opts) {
      const o = opts || {};
      const out = { ok: true, loaded: 0, skipped: 0, errors: [] };
      (Array.isArray(cases) ? cases : []).forEach(function (raw) {
        const input = Object.assign({}, raw, { synthetic: true });
        if (o.markCreatedBy) input.createdBy = input.createdBy || o.markCreatedBy;
        const v = validateCase(input);
        if (!v.ok) { out.skipped++; out.errors.push({ id: raw && raw.id, errors: v.errors }); return; }
        const c = normalizeNew(input);
        // Seed cases keep their declared status (e.g. active) only if piiCleared.
        if (c.status === 'active' && c.piiCleared !== true) c.status = 'draft';
        CASES[c.id] = c;
        out.loaded++;
      });
      persist();
      return out;
    },

    /** Remove all cases (test/util helper). Best-effort persist. */
    _clear: function () { CASES = {}; persist(); return { ok: true }; },

    // ---- runner -------------------------------------------------------------

    /** Score one candidate against one case. Picks the grader from the case. */
    score: function (candidate, evalCase) {
      if (!evalCase || !evalCase.grader || !GRADERS[evalCase.grader]) {
        return { ok: false, error: 'UNKNOWN_GRADER', grader: evalCase && evalCase.grader, score: 0, pass: false };
      }
      const args = buildGraderArgs(evalCase.grader, candidate, evalCase);
      const result = GRADERS[evalCase.grader](args);
      return Object.assign({ ok: true, caseId: evalCase.id, grader: evalCase.grader, taskType: evalCase.taskType }, result);
    },

    /**
     * Run a batch. `candidates` is a map { caseId: candidate } or an array of
     * { caseId, candidate }. Aggregates n, meanScore, passRate, byGrader, cases,
     * failures. Archived cases are excluded unless options.includeArchived.
     */
    run: function (taskType, candidates, options) {
      const o = options || {};
      const map = {};
      if (Array.isArray(candidates)) candidates.forEach(function (x) { if (x && x.caseId) map[x.caseId] = x.candidate; });
      else if (candidates && typeof candidates === 'object') Object.keys(candidates).forEach(function (k) { map[k] = candidates[k]; });

      const cases = this.listCases({ taskType: taskType, includeArchived: !!o.includeArchived, activeOnly: o.activeOnly !== false ? false : false })
        .filter(function (c) { return o.includeArchived ? true : c.status !== 'archived'; });

      const perCase = [];
      const byGrader = {};
      const failures = [];
      let scoreSum = 0, passCount = 0, n = 0;

      cases.forEach(function (c) {
        if (!(c.id in map)) return; // no candidate supplied for this case → skip
        const r = Store.score(map[c.id], c);
        n++;
        scoreSum += (r.score || 0);
        if (r.pass) passCount++;
        perCase.push({ caseId: c.id, grader: c.grader, taskType: c.taskType, score: r.score || 0, pass: !!r.pass, detail: r.detail });
        const g = byGrader[c.grader] || (byGrader[c.grader] = { n: 0, scoreSum: 0, pass: 0 });
        g.n++; g.scoreSum += (r.score || 0); if (r.pass) g.pass++;
        if (!r.pass) failures.push({ caseId: c.id, grader: c.grader, score: r.score || 0, detail: r.detail });
      });

      Object.keys(byGrader).forEach(function (k) {
        const g = byGrader[k];
        g.meanScore = g.n ? round(g.scoreSum / g.n) : 0;
        g.passRate = g.n ? round(g.pass / g.n) : 0;
        delete g.scoreSum;
      });

      return {
        ok: true,
        taskType: taskType || null,
        n: n,
        meanScore: n ? round(scoreSum / n) : 0,
        passRate: n ? round(passCount / n) : 0,
        byGrader: byGrader,
        cases: perCase,
        failures: failures
      };
    },

    /**
     * Compare two run() aggregates. Reports means, delta, per-case regressions
     * and improvements, and whether promotion should be blocked.
     */
    compareVersions: function (baselineResults, candidateResults, options) {
      const o = options || {};
      const eps = o.epsilon != null ? o.epsilon : 0.0001;
      const b = baselineResults || {};
      const cand = candidateResults || {};
      const baseMap = {};
      (Array.isArray(b.cases) ? b.cases : []).forEach(function (x) { baseMap[x.caseId] = x; });

      const regressions = [];
      const improvements = [];
      (Array.isArray(cand.cases) ? cand.cases : []).forEach(function (x) {
        const prior = baseMap[x.caseId];
        if (!prior) return;
        if (prior.pass && !x.pass) regressions.push({ caseId: x.caseId, grader: x.grader, was: prior.score, now: x.score, detail: x.detail });
        else if (!prior.pass && x.pass) improvements.push({ caseId: x.caseId, grader: x.grader, was: prior.score, now: x.score });
        else if (x.score < prior.score - 0.1) regressions.push({ caseId: x.caseId, grader: x.grader, was: prior.score, now: x.score, detail: 'score dropped >0.1' });
      });

      const baselineMean = b.meanScore != null ? b.meanScore : 0;
      const candidateMean = cand.meanScore != null ? cand.meanScore : 0;
      const delta = round(candidateMean - baselineMean);
      const shouldBlockPromotion = regressions.length > 0 || candidateMean < baselineMean - eps;

      return {
        baselineMean: baselineMean,
        candidateMean: candidateMean,
        delta: delta,
        regressions: regressions,
        improvements: improvements,
        shouldBlockPromotion: shouldBlockPromotion
      };
    }
  };

  // Best-effort hydrate from prior session; never throws.
  try { hydrate(); } catch (_) {}

  global.AAA_EVAL_GOLDEN = Store;
})(typeof window !== 'undefined' ? window : this);
