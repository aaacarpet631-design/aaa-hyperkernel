/*
 * AAA Governance Approval Card — a protected action rendered as an explicit
 * approve/reject decision, never an auto-mutation.
 *
 * Builds from a pending governance recommendation (an approval package). The
 * card carries `requiresApproval:true` and `approved:false` — the action does
 * NOT happen until approve() is called, which routes through Council Governance
 * (RBAC + a written reason enforced there). The card blocks; the human decides.
 */
;(function (global) {
  'use strict';

  function governance() { return global.AAA_COUNCIL_GOVERNANCE; }

  const Card = {
    /** Build from an approval package, or fall back to the latest pending rec. */
    async build(approvalPackage) {
      let pkg = approvalPackage || null;
      if (!pkg && governance()) { const pend = (await governance().list({ status: 'pending_governance' })) || []; pkg = pend[0] || null; }
      if (!pkg) return { type: 'governance_approval', title: 'Approval', status: 'nothing_pending', note: 'No pending action to approve.' };
      return {
        type: 'governance_approval', title: 'Approve: ' + (pkg.action || 'change'), status: 'pending_approval',
        recId: pkg.id, domain: pkg.domain || null, action: pkg.action, rationale: pkg.rationale || null,
        requiresApproval: true, approved: false,
        note: 'This will not happen until you approve it with a reason.'
      };
    },

    /** Explicit approval — routed through governance (RBAC + reason enforced there). */
    async approve(recId, reason) {
      if (!governance()) return { ok: false, error: 'GOVERNANCE_UNAVAILABLE' };
      return governance().approve(recId, { reason: reason });
    },
    async reject(recId, reason) {
      if (!governance()) return { ok: false, error: 'GOVERNANCE_UNAVAILABLE' };
      return governance().reject(recId, { reason: reason });
    }
  };

  global.AAA_GOVERNANCE_APPROVAL_CARD = Card;
})(typeof window !== 'undefined' ? window : this);
