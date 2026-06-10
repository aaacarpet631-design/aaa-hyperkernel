/*
 * AAA Copilot Governance Gate — the Copilot may PROPOSE, never PERFORM.
 *
 * Classifies a requested action: a protected action (pricing, customer
 * messages, ad spend, schedule/dispatch, refunds, payroll, legal, contracts,
 * tax, bank movement, capability promotion, production config) can never be
 * executed by the Copilot. It is halted with HUMAN_APPROVAL_REQUIRED and turned
 * into an approval package routed through Council Governance (append-only,
 * audited). Unprotected analysis flows through untouched.
 */
;(function (global) {
  'use strict';

  function governance() { return global.AAA_COUNCIL_GOVERNANCE; }

  // verb/keyword → protected category
  const PROTECTED = [
    ['pricing', ['price', 'pricing', 'rate card', 'discount']],
    ['customer_message', ['text the customer', 'email the customer', 'send to customer', 'message customer', 'reach out to']],
    ['ad_spend', ['ad spend', 'ad budget', 'campaign budget', 'bid up', 'increase spend']],
    ['schedule', ['schedule the', 'reschedule', 'book the crew']],
    ['dispatch', ['dispatch', 'send the crew', 'route the crew']],
    ['refund', ['refund', 'issue a credit']],
    ['payroll', ['payroll', 'pay the crew', 'wages', 'bonus']],
    ['legal', ['legal action', 'lawsuit', 'demand letter', 'lien']],
    ['contract', ['contract', 'sign agreement', 'terms']],
    ['tax', ['tax', 'file taxes', 'irs']],
    ['bank', ['transfer money', 'move money', 'bank', 'wire ']],
    ['capability_promotion', ['promote capability', 'promote agent', 'make permanent']],
    ['production_config', ['change config', 'production setting', 'deploy', 'flip the flag']]
  ];

  const Gate = {
    PROTECTED_CATEGORIES: PROTECTED.map(function (p) { return p[0]; }),

    /** Is this text/action a protected action? → { protected, category }. */
    classify(text) {
      const t = String(text == null ? '' : text).toLowerCase();
      for (const pair of PROTECTED) { if (pair[1].some(function (k) { return t.indexOf(k) !== -1; })) return { protected: true, category: pair[0] }; }
      return { protected: false, category: null };
    },

    /**
     * Gate a requested action. A protected action returns
     * HUMAN_APPROVAL_REQUIRED + an approval package (a pending governance
     * recommendation); it is never performed. Unprotected → { allowed:true }.
     */
    async gate(text, opts) {
      const o = opts || {};
      const c = this.classify(text);
      if (!c.protected) return { allowed: true, protected: false };
      let approvalPackage = null;
      if (governance()) {
        const pr = await governance().propose('strategy', { council: 'executive_copilot', action: o.action || ('owner request: ' + String(text).slice(0, 120)), rationale: o.rationale || 'Proposed by the Executive Copilot on the owner\'s behalf.', confidence: o.confidence == null ? null : o.confidence });
        approvalPackage = pr.recommendation || null;
      }
      return { allowed: false, protected: true, category: c.category, interruptSignal: 'HUMAN_APPROVAL_REQUIRED', approvalPackage: approvalPackage };
    }
  };

  global.AAA_COPILOT_GOVERNANCE_GATE = Gate;
})(typeof window !== 'undefined' ? window : this);
