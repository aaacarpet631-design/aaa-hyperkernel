/*
 * AAA Promotion Scorer — the six-rule gate that decides which temporary
 * capabilities deserve permanence.
 *
 * A capability is PROMOTABLE only if all six hold (computed from the reputation
 * store + ROI engine + failure detector — never asserted):
 *   1. spawned ≥ MIN_SPAWNS (5)
 *   2. success rate ≥ MIN_SUCCESS (80%)
 *   3. rollback rate ≤ MAX_ROLLBACK (5%)
 *   4. average risk score ≤ RISK_THRESHOLD (default 1.5 on low=1/med=2/high=3)
 *   5. measurable benefit (time / money / revenue / error avoided)
 *   6. no unresolved governance violations (failure detector clean)
 *
 * score(signature) returns a transparent checklist so a human sees exactly why
 * a capability did or didn't clear the bar. This is the brain; the
 * promotion-engine remains the governed hand (propose → human approval →
 * permanent registry mutation). Pure, deterministic, thresholds config-tunable.
 */
;(function (global) {
  'use strict';

  function cfg() { return global.AAA_CONFIG || {}; }
  function reputation() { return global.AAA_CAPABILITY_REPUTATION; }
  function banned() { return global.AAA_BANNED_CAPABILITIES; }
  function num(v, d) { const n = Number(v); return isFinite(n) ? n : d; }
  function flag(k, d) { return cfg().flag ? num(cfg().flag(k, d), d) : d; }

  const Scorer = {
    get MIN_SPAWNS() { return flag('capMinSpawns', 5); },
    get MIN_SUCCESS() { return flag('capMinSuccess', 0.8); },
    get MAX_ROLLBACK() { return flag('capMaxRollback', 0.05); },
    get RISK_THRESHOLD() { return flag('capRiskThreshold', 1.5); },

    /**
     * Score a capability signature against the six rules.
     * → { eligible, checks:{...}, failed:[], reputation, score }
     */
    async score(signature) {
      const rep = await reputation().reputation(signature);
      const isBanned = banned() ? await banned().isBanned(signature) : false;
      const checks = {
        spawns: { pass: rep.spawns >= this.MIN_SPAWNS, value: rep.spawns, need: this.MIN_SPAWNS },
        successRate: { pass: rep.successRate != null && rep.successRate >= this.MIN_SUCCESS, value: rep.successRate, need: this.MIN_SUCCESS },
        rollbackRate: { pass: rep.rollbackRate != null && rep.rollbackRate <= this.MAX_ROLLBACK, value: rep.rollbackRate, need: this.MAX_ROLLBACK },
        avgRisk: { pass: rep.avgRiskScore != null && rep.avgRiskScore <= this.RISK_THRESHOLD, value: rep.avgRiskScore, need: this.RISK_THRESHOLD },
        measurableBenefit: { pass: !!(rep.roi && rep.roi.measurableBenefit), value: rep.roi ? rep.roi.score : null },
        noViolations: { pass: (rep.openViolations || 0) === 0 && !isBanned, value: rep.openViolations || 0, banned: isBanned }
      };
      const failed = [];
      if (!checks.spawns.pass) failed.push('spawned ' + rep.spawns + '/' + this.MIN_SPAWNS + ' times');
      if (!checks.successRate.pass) failed.push('success rate ' + Math.round((rep.successRate || 0) * 100) + '% < ' + Math.round(this.MIN_SUCCESS * 100) + '%');
      if (!checks.rollbackRate.pass) failed.push('rollback rate ' + Math.round((rep.rollbackRate || 0) * 100) + '% > ' + Math.round(this.MAX_ROLLBACK * 100) + '%');
      if (!checks.avgRisk.pass) failed.push('avg risk ' + (rep.avgRiskScore == null ? 'n/a' : rep.avgRiskScore.toFixed(2)) + ' > ' + this.RISK_THRESHOLD);
      if (!checks.measurableBenefit.pass) failed.push('no measurable time/money/revenue/error benefit');
      if (!checks.noViolations.pass) failed.push(isBanned ? 'capability is banned' : (rep.openViolations + ' unresolved governance violation(s)'));

      const passed = Object.keys(checks).filter((k) => checks[k].pass).length;
      return { signature: signature, eligible: failed.length === 0, checks: checks, failed: failed, reputation: rep, score: passed / 6 };
    },

    /** Eligible candidates (best first) across all seen signatures. */
    async candidates() {
      const reps = await reputation().all();
      const out = [];
      for (const r of reps) { const s = await this.score(r.signature); if (s.eligible) out.push(Object.assign({ name: r.name, dna: r.dna }, s)); }
      return out.sort((a, b) => (b.reputation.roi ? b.reputation.roi.score : 0) - (a.reputation.roi ? a.reputation.roi.score : 0));
    }
  };

  global.AAA_PROMOTION_SCORER = Scorer;
})(typeof window !== 'undefined' ? window : this);
