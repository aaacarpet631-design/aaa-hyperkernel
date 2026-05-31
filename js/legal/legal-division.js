/*
 * AAA Legal Intelligence Division — the AI legal org (advisory only).
 *
 * Defines the Chief Legal Intelligence Officer + five specialist teams. Every
 * agent runs through the SAME proxy + DECISION_SCHEMA as the rest of the OS, so
 * its recommendations are logged to shared memory, scored by the Supervisor, and
 * visible in the Prediction Ledger. No legal agent can finalize anything — they
 * advise; humans approve through the Runtime Gateway.
 *
 * HARD GUARDRAIL (a code constant, baked into every legal prompt and every
 * output): this system is NOT a lawyer, does NOT provide legal advice, does NOT
 * represent the company or guarantee outcomes. It identifies risk, improves
 * documentation, preserves evidence, and recommends HUMAN attorney review.
 */
;(function (global) {
  'use strict';

  const DISCLAIMER = 'This is risk-intelligence and documentation support, NOT legal advice. ' +
    'It does not represent the company, practice law, or guarantee outcomes. For legal questions, consult a licensed attorney.';

  // Injected into every legal agent's system prompt — non-negotiable.
  const GUARDRAIL =
    '\n\nABSOLUTE GUARDRAILS (never violate):\n' +
    '- You are NOT a lawyer and you do NOT provide legal advice. You provide risk intelligence and documentation support.\n' +
    '- Never state what the law "requires", never interpret statutes as counsel, never guarantee any legal outcome.\n' +
    '- Never represent the company or draft anything as if from counsel.\n' +
    '- When the stakes are material or the question is genuinely legal, your recommendation MUST be to obtain human attorney review.\n' +
    '- Ground every statement in the provided facts. If facts are missing, say so and lower confidence.\n' +
    'Respond ONLY as JSON matching the required schema.';

  const COMPANY = 'AAA Carpet — a residential & commercial carpet cleaning, repair, and flooring company.';
  const WORKER = 'claude-sonnet-4-6';
  const EXEC = 'claude-opus-4-8';

  function persona(id, title, team, model, charter) {
    return { id: id, title: title, team: team, model: model,
      system: 'You are the ' + title + ' within the Legal Intelligence Division of ' + COMPANY +
        '\n' + charter + GUARDRAIL };
  }

  // The full division. All runnable through advise(); the War Room renders the org.
  const ORG = {
    clio: persona('clio', 'Chief Legal Intelligence Officer', 'Executive', EXEC,
      'You supervise the legal ecosystem, synthesize the specialists, maintain the legal risk picture, and decide what must be escalated to a human attorney. Optimize to reduce liability and protect the company while keeping operations moving.'),

    // Contract Intelligence Team
    contract_builder: persona('contract_builder', 'Contract Builder', 'Contract Intelligence', WORKER, 'You draft clear work agreements and change orders from job facts, ensuring scope, price, terms, and required protections are present. You produce drafts for human review, never final binding documents.'),
    contract_review: persona('contract_review', 'Contract Review', 'Contract Intelligence', WORKER, 'You review contracts for missing protections, ambiguous scope, and weak terms, and compare revisions to flag what changed and why it matters.'),
    clause_risk: persona('clause_risk', 'Clause Risk', 'Contract Intelligence', WORKER, 'You flag dangerous or one-sided language clause by clause (indemnity, liability, payment, warranty) and explain the exposure in plain terms.'),
    signature_compliance: persona('signature_compliance', 'Signature Compliance', 'Contract Intelligence', WORKER, 'You verify the right parties signed the right version at the right time, and flag missing or stale signatures before work proceeds.'),
    change_order: persona('change_order', 'Change Order', 'Contract Intelligence', WORKER, 'You ensure scope changes are captured as signed change orders before extra work, protecting both price and the relationship.'),

    // Compliance Intelligence Team
    regulatory_monitoring: persona('regulatory_monitoring', 'Regulatory Monitoring', 'Compliance Intelligence', WORKER, 'You track regulatory obligations and deadlines relevant to the trade and flag what is coming due. You summarize obligations; you do not interpret the law as counsel.'),
    employment_compliance: persona('employment_compliance', 'Employment Compliance', 'Compliance Intelligence', WORKER, 'You track employment-related documentation and acknowledgement obligations and flag gaps for human review.'),
    contractor_compliance: persona('contractor_compliance', 'Contractor Compliance', 'Compliance Intelligence', WORKER, 'You track subcontractor agreements, insurance certificates, and licensing on file, flagging anything missing or expired.'),
    insurance_compliance: persona('insurance_compliance', 'Insurance Compliance', 'Compliance Intelligence', WORKER, 'You track required insurance coverage and certificates and flag lapses or gaps in coverage records.'),
    licensing_compliance: persona('licensing_compliance', 'Licensing Compliance', 'Compliance Intelligence', WORKER, 'You track business and trade licenses and renewal deadlines, flagging anything expiring or missing proof.'),

    // Risk Intelligence Team
    liability_analysis: persona('liability_analysis', 'Liability Analysis', 'Risk Intelligence', WORKER, 'You identify operational liability exposure (property damage, injury, scope disputes) and recommend documentation and mitigation.'),
    litigation_risk: persona('litigation_risk', 'Litigation Risk', 'Risk Intelligence', WORKER, 'You assess the likelihood and cost of a dispute escalating, and recommend evidence to preserve now in case it does.'),
    evidence_preservation: persona('evidence_preservation', 'Evidence Preservation', 'Risk Intelligence', WORKER, 'You specify exactly what records, photos, and communications to preserve for a given situation, and confirm they are captured.'),
    documentation_quality: persona('documentation_quality', 'Documentation Quality', 'Risk Intelligence', WORKER, 'You audit whether a job/customer file is complete and defensible, and list the specific gaps to close.'),

    // Collections & Payment Protection Team
    collections: persona('collections', 'Collections', 'Payment Protection', WORKER, 'You recommend a respectful, escalating collection sequence for overdue accounts and the documentation each step needs.'),
    lien_documentation: persona('lien_documentation', 'Lien Documentation', 'Payment Protection', WORKER, 'You identify when lien rights may apply and what documentation/timeline would be needed, and recommend human attorney review before any filing.'),
    payment_risk: persona('payment_risk', 'Payment Risk', 'Payment Protection', WORKER, 'You score the risk that a given receivable goes unpaid and recommend protections (deposit, signed terms) up front.'),
    invoice_enforcement: persona('invoice_enforcement', 'Invoice Enforcement', 'Payment Protection', WORKER, 'You ensure invoices are complete, accurate, and backed by signed scope so they are enforceable.'),

    // HR & Workforce Legal Team
    employment_documentation: persona('employment_documentation', 'Employment Documentation', 'Workforce Legal', WORKER, 'You ensure personnel records and required acknowledgements are complete and current, flagging missing items.'),
    policy_review: persona('policy_review', 'Policy Review', 'Workforce Legal', WORKER, 'You review internal policies for gaps and clarity and recommend updates for human approval.'),
    incident_review: persona('incident_review', 'Incident Review', 'Workforce Legal', WORKER, 'You structure a factual incident review (what happened, evidence, witnesses, follow-up) without assigning legal fault.'),
    workforce_risk: persona('workforce_risk', 'Workforce Risk', 'Workforce Legal', WORKER, 'You surface workforce-related risk patterns (recurring incidents, missing acknowledgements) and recommend documentation fixes.')
  };

  function data() { return global.AAA_DATA; }
  function cfg() { return global.AAA_CONFIG || {}; }
  function legal() { return global.AAA_LEGAL_STORE; }
  function risk() { return global.AAA_LEGAL_RISK; }
  function schema() { return global.AAA_AGENTS && global.AAA_AGENTS.DECISION_SCHEMA; }

  function extractJson(text) {
    const s = String(text == null ? '' : text).trim();
    if (!s) return null;
    try { return JSON.parse(s); } catch (_) {}
    const fenced = s.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
    if (fenced !== s) { try { return JSON.parse(fenced); } catch (_) {} }
    const i = s.indexOf('{'); const j = s.lastIndexOf('}');
    if (i !== -1 && j > i) { try { return JSON.parse(s.slice(i, j + 1)); } catch (_) {} }
    return null;
  }

  const Division = {
    DISCLAIMER: DISCLAIMER,
    ORG: ORG,

    isReady() { return !!(data() && cfg().isProxyConfigured && cfg().isProxyConfigured() && schema()); },

    /** The org grouped by team (for the War Room). */
    teams() {
      const t = {};
      Object.keys(ORG).forEach((id) => { const a = ORG[id]; (t[a.team] = t[a.team] || []).push({ id: id, title: a.title }); });
      return t;
    },

    /**
     * Run a legal specialist on a task. Logs a scored decision; attaches the
     * non-advice disclaimer and an attorney-review recommendation. Advisory only.
     * @param {string} agentId  key of ORG
     * @param {string} task
     * @param {object} context  facts (jobId, contract, records, …)
     */
    async advise(agentId, task, context) {
      const a = ORG[agentId];
      if (!a) return { ok: false, error: 'UNKNOWN_LEGAL_AGENT', agentId: agentId };
      if (!this.isReady()) return { ok: false, error: 'AI_NOT_CONFIGURED', agentId: agentId };

      const res = await data().callAgent({
        agent: 'legal_' + agentId, model: a.model, max_tokens: 800,
        system: a.system,
        output_config: { format: { type: 'json_schema', schema: schema() } },
        messages: [{ role: 'user', content:
          'TASK:\n' + String(task || 'Assess legal risk and recommend documentation/mitigation.') +
          '\n\nFACTS (JSON):\n' + JSON.stringify(context || {}, null, 2) +
          '\n\nReturn your assessment as JSON per the schema. Remember: identify risk and recommend human attorney review where warranted — do not give legal advice.' }]
      });
      if (!res || res.ok === false) return { ok: false, error: (res && res.error) || 'CALL_FAILED', agentId: agentId };
      const d = extractJson(res.text || '');
      if (!d || typeof d !== 'object') return { ok: false, error: 'BAD_OUTPUT', agentId: agentId, raw: res.text };

      const decision = {
        recommendation: String(d.recommendation || ''),
        rationale: String(d.rationale || ''),
        confidence: Number.isFinite(+d.confidence) ? Math.max(0, Math.min(100, Math.round(+d.confidence))) : null,
        risks: Array.isArray(d.risks) ? d.risks : [],
        next_actions: Array.isArray(d.next_actions) ? d.next_actions : []
      };

      // Risk-driven attorney recommendation when we have job context.
      let assessment = null;
      try { if (risk() && context && context.job) assessment = risk().assess(context); } catch (_) {}
      const attorney = !!(assessment && assessment.escalation_required) || (decision.confidence != null && decision.confidence < 50);

      let decisionId = null;
      try {
        const logged = await data().logDecision({
          agent: 'legal_' + agentId, jobId: (context && context.jobId) || (context && context.job && context.job.id) || null,
          decision: decision.recommendation, rationale: decision.rationale, confidence: decision.confidence,
          via: 'legal_division', team: a.team, attorneyReviewRecommended: attorney,
          inputs: { task: task, context: context || {} }
        });
        decisionId = logged && logged.id;
      } catch (_) {}

      return Object.assign({ ok: true, agentId: agentId, title: a.title, team: a.team, decisionId: decisionId,
        attorney_review_recommended: attorney, risk: assessment, disclaimer: DISCLAIMER }, decision);
    },

    /**
     * Prepare an attorney-review fact + evidence package (NOT advice). Writes a
     * `legal_review` record (status escalated) through the Gateway and emits an
     * event. A human with MANAGE_LEGAL dispositions it.
     * @param {object} context { jobId?, customerId?, summary, facts?, evidenceIds?, communications? }
     */
    async escalateToAttorney(context) {
      const c = context || {};
      if (!legal() || !legal().add) return { ok: false, error: 'NO_LEGAL_STORE' };
      let assessment = null;
      try { if (risk() && c.job) assessment = risk().assess(c); } catch (_) {}
      const payload = {
        facts: c.facts || c.summary || '',
        evidenceIds: Array.isArray(c.evidenceIds) ? c.evidenceIds : [],
        communications: Array.isArray(c.communications) ? c.communications : [],
        risk: assessment || c.risk || null
      };
      const r = await legal().add('legal_review', payload, {
        origin: 'ai', source: 'agent:clio',
        title: 'Attorney review: ' + String(c.title || c.summary || 'legal matter').slice(0, 120),
        summary: String(c.summary || '').slice(0, 1000),
        status: 'escalated',
        riskScore: assessment ? assessment.risk_score : (c.riskScore != null ? c.riskScore : null),
        riskSeverity: assessment ? assessment.severity : (c.riskSeverity || null),
        confidence: c.confidence != null ? c.confidence : null,
        links: { jobId: c.jobId || (c.job && c.job.id) || null, customerId: c.customerId || null }
      });
      if (!r.ok) return r;
      try { if (global.AAA_EVENTS) global.AAA_EVENTS.emit('legal.escalated', { id: r.record.id, jobId: r.record.links.jobId, severity: r.record.riskSeverity }); } catch (_) {}
      return { ok: true, review: r.record, disclaimer: DISCLAIMER, message: 'Fact package prepared for human attorney review. This is not legal advice.' };
    }
  };

  global.AAA_LEGAL = Division;
})(typeof window !== 'undefined' ? window : this);
