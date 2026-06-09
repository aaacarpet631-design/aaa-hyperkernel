/*
 * AAA Legal Risk Engine — six-category legal risk scoring over REAL data.
 *
 * Produces the exact contract the directive specifies:
 *   { risk_score, severity, contributing_factors[], mitigation_actions[],
 *     escalation_required, categories{ contract,payment,compliance,employment,
 *     documentation,reputation } }
 *
 * Pure and deterministic. Grounded only in shared memory + the legal memory
 * layer — absent data scores LOW, never invented. `escalation_required` is the
 * seam into the existing Escalation Policy / Challenge Protocol, so high legal
 * risk gets the same adversarial review as any other high-stakes decision.
 *
 * This is risk *intelligence*, not legal advice. It surfaces exposure and
 * recommends mitigation + human attorney review; it never opines on the law.
 */
;(function (global) {
  'use strict';

  function data() { return global.AAA_DATA; }
  function legal() { return global.AAA_LEGAL_STORE; }
  function contractsApi() { return global.AAA_CONTRACTS; }

  const HIGH_VALUE = 1500;     // mirrors the Escalation Policy default
  const MATERIAL = 750;

  function quoteMid(range) {
    if (range == null) return null;
    const nums = String(range).replace(/,/g, '').match(/\d+(?:\.\d+)?/g);
    if (!nums || !nums.length) return null;
    return nums.map(Number).reduce((a, b) => a + b, 0) / nums.length;
  }
  function jobValue(job) {
    const ests = job && Array.isArray(job.estimates) ? job.estimates : [];
    let max = null; ests.forEach((e) => { const m = quoteMid(e && e.estimatedQuoteRange); if (m != null && (max == null || m > max)) max = m; });
    return max;
  }
  function clamp(n) { return Math.max(0, Math.min(100, Math.round(n))); }
  function severityOf(score) { return score >= 75 ? 'critical' : score >= 50 ? 'high' : score >= 25 ? 'medium' : 'low'; }

  // Score one job across the per-job categories. Returns { categories, factors:[{category,detail,severity}] }.
  function assessJob(job, ctx) {
    const c = ctx || {};
    const contracts = c.contracts || [];
    const records = c.legalRecords || [];
    const outcome = c.outcome || null;
    const value = jobValue(job);
    const hasSigned = contracts.some((x) => x && x.status === 'signed');
    const cats = { contract: 0, payment: 0, compliance: 0, employment: 0, documentation: 0, reputation: 0 };
    const factors = [];
    const add = (cat, amt, detail, severity) => { cats[cat] = Math.min(100, cats[cat] + amt); factors.push({ category: cat, detail: detail, severity: severity || severityOf(amt), jobId: job.id }); };

    // ---- Contract ----
    if (!hasSigned && value != null && value >= HIGH_VALUE) add('contract', 65, 'High-value job (~$' + Math.round(value) + ') with no signed contract on file.', 'high');
    else if (!hasSigned && value != null && value >= MATERIAL) add('contract', 35, 'Material job (~$' + Math.round(value) + ') with no signed contract on file.', 'medium');
    const unsignedCO = records.filter((r) => r.type === 'change_order' && r.status !== 'signed').length;
    if (unsignedCO) add('contract', Math.min(40, unsignedCO * 20), unsignedCO + ' unsigned change order(s) on this job.', 'medium');

    // ---- Payment ----
    const openCollections = records.filter((r) => r.type === 'collection' && r.status !== 'resolved').length;
    if (openCollections) add('payment', Math.min(70, openCollections * 40), openCollections + ' open collection action(s) — receivable at risk.', 'high');
    const liens = records.filter((r) => r.type === 'lien').length;
    if (liens) add('payment', 20, liens + ' lien record(s) — protect the receivable with documentation.', 'medium');

    // ---- Employment ----
    const openIncidents = records.filter((r) => r.type === 'incident' && r.status !== 'resolved').length;
    if (openIncidents) add('employment', Math.min(80, openIncidents * 50), openIncidents + ' open incident(s) tied to this job.', 'high');

    // ---- Documentation ----
    const docGaps = [];
    if (!hasSigned) docGaps.push('no signed contract');
    if (!(Array.isArray(job.estimates) && job.estimates.length)) docGaps.push('no estimate');
    if (job.currentState === 'CLOSED' && !(Array.isArray(job.photos) && job.photos.length)) docGaps.push('no job photos');
    if (docGaps.length) add('documentation', Math.min(60, docGaps.length * 20), 'Documentation gaps: ' + docGaps.join(', ') + '.', docGaps.length >= 2 ? 'medium' : 'low');

    // ---- Reputation ----
    if (outcome && outcome.result === 'lost') add('reputation', 10, 'Lost outcome — monitor for dispute or negative review.', 'low');
    const flagged = records.filter((r) => r.riskSeverity === 'high' || r.riskSeverity === 'critical').length;
    if (flagged) add('reputation', Math.min(40, flagged * 20), flagged + ' high-severity legal record(s) on this job.', 'high');

    return { categories: cats, factors: factors, value: value };
  }

  // Build the standard contract from a categories map + factors.
  function compose(categories, factors, extraMitigations) {
    const score = Math.max(0, ...Object.keys(categories).map((k) => categories[k] || 0));
    const severity = severityOf(score);
    const contributing = factors.slice().sort((a, b) => (categories[b.category] || 0) - (categories[a.category] || 0)).map((f) => f.detail);
    const mitig = {
      contract: 'Get a signed contract / change order before more work is performed.',
      payment: 'Document the receivable and start the collection workflow; consider a lien filing window.',
      compliance: 'Resolve overdue obligations and record proof (license, insurance, filing).',
      employment: 'Complete the incident review and capture written acknowledgements.',
      documentation: 'Capture photos, measurements, and signatures; attach them to the job record.',
      reputation: 'Open a service-recovery follow-up and preserve communications as evidence.'
    };
    const actions = [];
    Object.keys(categories).forEach((k) => { if (categories[k] >= 40 && mitig[k]) actions.push(mitig[k]); });
    (extraMitigations || []).forEach((m) => { if (actions.indexOf(m) === -1) actions.push(m); });
    return {
      risk_score: clamp(score),
      severity: severity,
      contributing_factors: contributing,
      mitigation_actions: actions,
      escalation_required: severity === 'critical' || score >= 65,
      categories: {
        contract: clamp(categories.contract || 0), payment: clamp(categories.payment || 0),
        compliance: clamp(categories.compliance || 0), employment: clamp(categories.employment || 0),
        documentation: clamp(categories.documentation || 0), reputation: clamp(categories.reputation || 0)
      }
    };
  }

  const Engine = {
    severityOf: severityOf,

    /**
     * Standard risk assessment for one action/job. Synchronous given a context.
     * @param {object} context { job, contracts?, legalRecords?, outcome?, compliance? }
     * @returns the directive's standard risk object.
     */
    assess(context) {
      const c = context || {};
      const job = c.job || {};
      const r = assessJob(job, c);
      const cats = Object.assign({}, r.categories);
      // Company-level compliance can be injected for a job-in-context assessment.
      if (c.compliance && typeof c.compliance.score === 'number') {
        cats.compliance = Math.max(cats.compliance, clamp(c.compliance.score));
        if (c.compliance.score >= 40) r.factors.push({ category: 'compliance', detail: (c.compliance.overdue || 0) + ' overdue compliance obligation(s).', severity: 'high' });
      }
      return compose(cats, r.factors);
    },

    /** Company-wide compliance posture from the legal memory layer. */
    async complianceStatus() {
      if (!legal() || !legal().obligations) return { score: 0, overdue: 0, dueSoon: 0, total: 0, obligations: [] };
      const obs = await legal().obligations(30);
      const overdue = obs.filter((o) => o.overdue).length;
      const dueSoon = obs.filter((o) => o.dueSoon).length;
      // Each overdue obligation is a real exposure; due-soon is a warning.
      const score = clamp(overdue * 30 + dueSoon * 10);
      return { score: score, overdue: overdue, dueSoon: dueSoon, total: obs.length, obligations: obs };
    },

    /**
     * Company-wide legal risk dashboard. Scans jobs + legal memory + contracts.
     * Returns the standard object PLUS drill-down lists for the War Room.
     */
    async companyRisk() {
      if (!data()) return Object.assign(compose({ contract: 0, payment: 0, compliance: 0, employment: 0, documentation: 0, reputation: 0 }, []), { activeRisks: [], compliance: { score: 0, overdue: 0, dueSoon: 0, obligations: [] }, documentationGaps: [], scanned: 0 });
      const jobs = await data().listJobs();
      const outcomes = await data().list('outcomes');
      const outByJob = {}; outcomes.forEach((o) => { if (o.jobId) outByJob[o.jobId] = o; });
      const allRecords = legal() ? await legal().list() : [];
      const recsByJob = {}; allRecords.forEach((r) => { const jid = r.links && r.links.jobId; if (jid) (recsByJob[jid] = recsByJob[jid] || []).push(r); });
      let contractsByJob = {};
      try {
        if (contractsApi() && contractsApi().list) {
          const cs = await contractsApi().list();
          cs.forEach((c) => { if (c.jobId) (contractsByJob[c.jobId] = contractsByJob[c.jobId] || []).push(c); });
        }
      } catch (_) {}

      const agg = { contract: 0, payment: 0, compliance: 0, employment: 0, documentation: 0, reputation: 0 };
      const factors = [];
      const activeRisks = [];
      const documentationGaps = [];
      jobs.forEach((job) => {
        const r = assessJob(job, { contracts: contractsByJob[job.id] || [], legalRecords: recsByJob[job.id] || [], outcome: outByJob[job.id] || null });
        Object.keys(agg).forEach((k) => { agg[k] = Math.max(agg[k], r.categories[k] || 0); });
        r.factors.forEach((f) => {
          factors.push(f);
          if ((r.categories[f.category] || 0) >= 40) activeRisks.push({ jobId: job.id, customer: job.customerName || job.customerId || '', category: f.category, severity: f.severity, detail: f.detail });
          if (f.category === 'documentation') documentationGaps.push({ jobId: job.id, customer: job.customerName || '', detail: f.detail });
        });
      });

      const compliance = await this.complianceStatus();
      agg.compliance = Math.max(agg.compliance, compliance.score);
      if (compliance.overdue) { const det = compliance.overdue + ' overdue compliance obligation(s).'; factors.push({ category: 'compliance', detail: det, severity: 'high' }); activeRisks.push({ jobId: null, customer: '', category: 'compliance', severity: 'high', detail: det }); }

      const out = compose(agg, factors);
      activeRisks.sort((a, b) => (agg[b.category] || 0) - (agg[a.category] || 0));
      return Object.assign(out, { activeRisks: activeRisks, documentationGaps: documentationGaps, compliance: compliance, scanned: jobs.length });
    }
  };

  global.AAA_LEGAL_RISK = Engine;
})(typeof window !== 'undefined' ? window : this);
