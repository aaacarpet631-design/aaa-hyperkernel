/*
 * AAA Governance Integrity — on-device verification + self-audit of the audit
 * ledger. Combines the three integrity layers (FNV checksum chain, SHA-256
 * cryptographic chain, HMAC signatures) into one check, and — when it fails —
 * raises a critical governance escalation (which flows to the email channel),
 * complementing the daily server-side sweep with continuous on-device detection.
 *
 * Read-only: it never edits the ledger except to record the escalation of a
 * detected break (itself an append-only event).
 */
;(function (global) {
  'use strict';

  function ledger() { return global.AAA_AUDIT_LEDGER; }
  function escalation() { return global.AAA_GOVERNANCE_ESCALATION; }

  const Integrity = {
    /** Run all three verification layers. Returns a combined status. */
    async check() {
      const led = ledger();
      if (!led) return { ok: false, error: 'NO_LEDGER' };
      const fnv = await led.verify();
      const sha = await led.verifySha();
      const sig = await led.verifySig();
      const chain = await led.chain();
      const writers = {};
      chain.forEach(function (e) { writers[e.writerId || 'default'] = true; });
      const firstBreak = !fnv.ok ? fnv : (!sha.ok ? sha : (!sig.ok ? sig : null));
      return {
        ok: fnv.ok && sha.ok && sig.ok,
        fnv: fnv, sha: sha, sig: sig,
        signed: !sig.skipped,
        entries: chain.length, writers: Object.keys(writers).length,
        reason: firstBreak ? firstBreak.reason : null,
        brokenAt: firstBreak ? firstBreak.brokenAt : null,
        writerId: firstBreak ? firstBreak.writerId : null
      };
    },

    /**
     * Verify, and if the ledger is compromised raise a critical escalation
     * (cooldown-deduped → email). Best-effort; returns the check result.
     */
    async selfAudit(opts) {
      const r = await this.check();
      if (!r.ok && escalation() && escalation().escalateBreach) {
        try {
          await escalation().escalateBreach({
            kind: 'ledger_integrity', domain: 'governance', category: 'audit_ledger',
            metric: 'ledger_verification', value: r.reason, threshold: 0, severity: 'critical',
            detail: 'On-device ledger integrity check FAILED: ' + r.reason + ' (writer ' + (r.writerId || '?') + ', seq ' + (r.brokenAt != null ? r.brokenAt : '?') + ').',
            recommendedAction: 'A governance_audit record was altered outside the append-only flow. Investigate immediately and restore from a verified copy.'
          });
        } catch (_) { /* additive */ }
      }
      return r;
    }
  };

  global.AAA_GOVERNANCE_INTEGRITY = Integrity;
})(typeof window !== 'undefined' ? window : this);
