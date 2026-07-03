/*
 * AAA Review Protocol — the reviewer that can BLOCK but never GRANT.
 *
 * The reviewer contract from the hierarchical-teams playbook: an independent
 * agent audits an artifact assuming the author may be wrong, incomplete, or
 * overconfident, and returns a schema-locked verdict —
 *
 *   { decision: approve|needs_revision|reject, severity, defects[], confidence }
 *
 * with mechanical honesty rules this module enforces (the model cannot talk
 * its way past them):
 *
 *   - needs_revision / reject MUST name at least one defect (no vibes-rejects)
 *   - approve with critical/high severity is a contradiction → refused
 *   - every defect needs a type and a fix_instruction (actionable, not vague)
 *
 * Governance asymmetry, by design: reviewEnvelope() can auto-REJECT a sealed
 * Decision Envelope on a critical reject verdict, but an approving reviewer
 * NEVER approves the envelope — granting stays with the human. A reviewer is
 * a brake, not a second gas pedal.
 *
 * setExecutor() is the governed seam (mirrors ephemeral-agent-runtime);
 * without a model the protocol returns AI_NOT_CONFIGURED — never an invented
 * verdict.
 */
;(function (global) {
  'use strict';

  const COLLECTION = 'review_verdicts';
  const DECISIONS = ['approve', 'needs_revision', 'reject'];
  const SEVERITIES = ['none', 'low', 'medium', 'high', 'critical'];
  const DEFECT_TYPES = ['factual', 'policy', 'security', 'tenant_isolation', 'i18n', 'schema', 'other'];

  function cfg() { return global.AAA_CONFIG || {}; }
  function data() { return global.AAA_DATA; }
  function ids() { return global.AAA_ID_FACTORY; }
  function clock() { return global.AAA_RUNTIME_CLOCK; }
  function ledger() { return global.AAA_AUDIT_LEDGER; }
  function envelope() { return global.AAA_DECISION_ENVELOPE; }
  function ws() { return cfg().workspaceId || 'default'; }
  function nowISO() { return clock() && clock().nowISO ? clock().nowISO() : new Date().toISOString(); }
  function newId(p) { return ids() && ids().createId ? ids().createId(p) : p + '_' + Math.random().toString(36).slice(2, 10); }

  const REVIEW_SCHEMA = {
    type: 'object',
    properties: {
      decision: { type: 'string', enum: DECISIONS },
      severity: { type: 'string', enum: SEVERITIES },
      defects: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            type: { type: 'string', enum: DEFECT_TYPES },
            description: { type: 'string' },
            evidence_ref: { type: 'string' },
            fix_instruction: { type: 'string' }
          },
          required: ['type', 'description', 'fix_instruction']
        }
      },
      confidence: { type: 'number' }
    },
    required: ['decision', 'severity', 'defects', 'confidence'],
    additionalProperties: true
  };

  const DEFAULT_SYSTEM =
    'You are a Reviewer Agent for AAA HyperKernel. Audit the submitted artifact for: factual grounding, policy compliance, tenant isolation, ' +
    'internationalization correctness (currency, tax regime, units, jurisdiction), operational safety, and completeness against the requested schema. ' +
    'Assume the author may be wrong, incomplete, or overconfident. Verify claims against the attached evidence; distinguish hard failures from optional improvements. ' +
    'If critical defects exist return decision "reject"; fixable gaps return "needs_revision" with prioritized, concrete fix_instruction entries. ' +
    'Never reject without naming defects. Respond ONLY as JSON matching the required schema.';

  let EXECUTOR = null; // {name, run(spec, task, context) → {ok, output}}

  async function proxyExecutor(spec, task, context) {
    const d = data();
    const c = cfg();
    if (!d || !d.callAgent || !c.isProxyConfigured || !c.isProxyConfigured()) {
      return { ok: false, error: 'AI_NOT_CONFIGURED' };
    }
    const res = await d.callAgent({
      agent: spec.role, max_tokens: 1200, system: spec.system,
      output_config: { format: { type: 'json_schema', schema: REVIEW_SCHEMA } },
      messages: [{ role: 'user', content: 'ARTIFACT TO REVIEW:\n' + task + '\n\nCONTEXT (JSON):\n' + JSON.stringify(context || {}, null, 2) }]
    });
    if (!res || res.ok === false) return { ok: false, error: (res && res.error) || 'CALL_FAILED' };
    let out = null;
    try { out = JSON.parse(String(res.text || '').replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '')); } catch (_) { /* fallthrough */ }
    return out ? { ok: true, output: out } : { ok: false, error: 'BAD_OUTPUT', raw: res.text };
  }

  // ---- verdict validation: the rules the model cannot talk past -------------
  function validateVerdict(v) {
    const issues = [];
    const x = v || {};
    if (DECISIONS.indexOf(x.decision) === -1) issues.push('decision must be ' + DECISIONS.join('|'));
    if (SEVERITIES.indexOf(x.severity) === -1) issues.push('severity must be ' + SEVERITIES.join('|'));
    if (!Array.isArray(x.defects)) issues.push('defects must be an array');
    const conf = +x.confidence;
    if (!isFinite(conf) || conf < 0 || conf > 1) issues.push('confidence must be 0..1');
    if (Array.isArray(x.defects)) {
      x.defects.forEach(function (d, i) {
        if (!d || DEFECT_TYPES.indexOf(d.type) === -1) issues.push('defects[' + i + '].type must be ' + DEFECT_TYPES.join('|'));
        if (!d || !d.description) issues.push('defects[' + i + '].description required');
        if (!d || !d.fix_instruction) issues.push('defects[' + i + '].fix_instruction required (actionable, not vague)');
      });
      if ((x.decision === 'reject' || x.decision === 'needs_revision') && !x.defects.length) {
        issues.push(x.decision + ' must name at least one defect (no vibes-rejects)');
      }
      if (x.decision === 'approve' && ['high', 'critical'].indexOf(x.severity) !== -1) {
        issues.push('approve with ' + x.severity + ' severity is a contradiction');
      }
    }
    return issues.length ? { ok: false, issues: issues } : { ok: true };
  }

  const ReviewProtocol = {
    COLLECTION: COLLECTION,
    REVIEW_SCHEMA: REVIEW_SCHEMA,
    validateVerdict: validateVerdict,

    /** Plug a governed executor (tests, native models). Pass null to restore the proxy. */
    setExecutor(ex) { EXECUTOR = (ex && typeof ex.run === 'function') ? ex : null; return { ok: true, executor: EXECUTOR ? EXECUTOR.name || 'custom' : 'proxy' }; },

    /**
     * Review an artifact. The verdict is schema-validated and persisted with
     * the artifact reference; malformed verdicts are refused (BAD_VERDICT).
     * opts: { kind, artifactRef, context }
     */
    async review(artifact, opts) {
      const o = opts || {};
      if (artifact == null || artifact === '') return { ok: false, error: 'NO_ARTIFACT' };
      const system = global.AAA_PROMPT_REGISTRY ? await global.AAA_PROMPT_REGISTRY.resolve('reviewer', DEFAULT_SYSTEM) : DEFAULT_SYSTEM;
      const exec = EXECUTOR || { name: 'proxy', run: proxyExecutor };
      const text = typeof artifact === 'string' ? artifact : JSON.stringify(artifact, null, 2);
      let result;
      try { result = await exec.run({ role: 'reviewer', system: system, schema: REVIEW_SCHEMA }, text, o.context || {}); }
      catch (e) { result = { ok: false, error: 'EXECUTOR_THREW: ' + (e && e.message) }; }
      if (!result || result.ok === false) return { ok: false, error: (result && result.error) || 'REVIEW_FAILED' };

      const v = validateVerdict(result.output);
      if (!v.ok) return { ok: false, error: 'BAD_VERDICT', issues: v.issues };

      const rec = {
        id: newId('rev'), workspaceId: ws(),
        kind: o.kind || 'artifact', artifactRef: o.artifactRef || null,
        decision: result.output.decision, severity: result.output.severity,
        defects: result.output.defects, confidence: +result.output.confidence,
        createdAt: nowISO()
      };
      if (data()) await data().put(COLLECTION, rec.id, rec);
      try { if (ledger() && ledger().append) await ledger().append('review.verdict', { reviewId: rec.id, kind: rec.kind, artifactRef: rec.artifactRef, decision: rec.decision, severity: rec.severity, defects: rec.defects.length }); } catch (_) {}
      return { ok: true, verdict: rec };
    },

    /**
     * Review a sealed Decision Envelope. Asymmetric by design:
     *   reject + critical/high → the envelope is auto-REJECTED (brake works)
     *   approve               → the envelope is left for the HUMAN to approve
     */
    async reviewEnvelope(envelopeId, opts) {
      const env = envelope();
      if (!env) return { ok: false, error: 'ENVELOPE_MODULE_MISSING' };
      const rec = await env.get(envelopeId);
      if (!rec) return { ok: false, error: 'ENVELOPE_NOT_FOUND', envelopeId: envelopeId };
      const r = await this.review(
        { agent: rec.agent, country: rec.country, decision: rec.decision, impact: rec.impact, evidence: rec.evidence, rollback: rec.rollback },
        Object.assign({}, opts || {}, { kind: 'decision_envelope', artifactRef: envelopeId })
      );
      if (!r.ok) return r;

      let enforcement = 'none';
      if (r.verdict.decision === 'reject' && ['high', 'critical'].indexOf(r.verdict.severity) !== -1) {
        if (rec.approval && rec.approval.status === 'approved') {
          enforcement = 'flagged_post_approval'; // already human-approved: flag loudly, never silently unwind
          try { if (ledger() && ledger().append) await ledger().append('review.post_approval_flag', { envelopeId: envelopeId, reviewId: r.verdict.id, severity: r.verdict.severity }); } catch (_) {}
        } else {
          const rj = await env.reject(envelopeId, { approver: 'reviewer:' + (r.verdict.id), reason: r.verdict.defects[0].description });
          enforcement = rj.ok ? 'envelope_rejected' : 'reject_failed';
        }
      }
      return { ok: true, verdict: r.verdict, enforcement: enforcement, note: r.verdict.decision === 'approve' ? 'reviewer approval does NOT approve the envelope — that stays with the human' : null };
    },

    async get(reviewId) { return data() ? data().get(COLLECTION, reviewId) : null; },

    /** Workspace-scoped verdicts, newest first; filter { decision, kind, artifactRef }. */
    async list(filter) {
      if (!data()) return [];
      const f = filter || {};
      let all = (await data().list(COLLECTION)).filter(function (r) { return r && (r.workspaceId == null || r.workspaceId === ws()); });
      if (f.decision) all = all.filter(function (r) { return r.decision === f.decision; });
      if (f.kind) all = all.filter(function (r) { return r.kind === f.kind; });
      if (f.artifactRef) all = all.filter(function (r) { return r.artifactRef === f.artifactRef; });
      return all.sort(function (a, b) { return String(b.createdAt || '').localeCompare(String(a.createdAt || '')); });
    }
  };

  global.AAA_REVIEW_PROTOCOL = ReviewProtocol;
})(typeof window !== 'undefined' ? window : this);
