/*
 * AAA Automation Discovery Engine — turn human tasks into scored automation
 * candidates (and, where it fits, into Genesis capabilities).
 *
 * For a described task it computes annual labor savings (frequency × minutes ×
 * loaded rate) and an automation score that rewards savings and penalizes risk
 * and complexity. It computes only from supplied inputs — a task with no
 * frequency/duration is unscored (insufficient_data). Deterministic.
 *
 * Score dimensions: labor savings · risk · complexity · expected ROI.
 */
;(function (global) {
  'use strict';

  function cfg() { return global.AAA_CONFIG || {}; }
  function num(v, d) { const n = Number(v); return isFinite(n) ? n : (d == null ? null : d); }
  function flag(k, d) { return cfg().flag ? num(cfg().flag(k, d), d) : d; }
  function clamp01(x) { return Math.max(0, Math.min(1, x)); }

  const Engine = {
    /**
     * @param task { name, timesPerWeek, minutesEach, risk 0..1, complexity 0..1,
     *               automationCost?, loadedHourlyRate? }
     */
    analyze(task) {
      const t = task || {};
      const perWeek = num(t.timesPerWeek);
      const minutes = num(t.minutesEach);
      if (perWeek == null || minutes == null) return { task: t.name || 'unnamed', status: 'insufficient_data', note: 'need timesPerWeek + minutesEach' };
      const rate = num(t.loadedHourlyRate, flag('loadedHourlyRate', 35));
      const risk = clamp01(num(t.risk, 0.2));
      const complexity = clamp01(num(t.complexity, 0.4));
      const annualHours = (perWeek * minutes * 52) / 60;
      const annualSavings = Math.round(annualHours * rate);
      const automationCost = num(t.automationCost, flag('defaultAutomationCost', 500));
      const roi = automationCost > 0 ? Math.round(((annualSavings - automationCost) / automationCost) * 1000) / 1000 : null;
      // Score: savings (normalized) discounted by risk + complexity.
      const savingsNorm = clamp01(annualSavings / 10000);
      const score = Math.round(clamp01(savingsNorm * (1 - 0.5 * risk) * (1 - 0.4 * complexity)) * 1000) / 1000;
      let recommendation;
      if (risk >= 0.7) recommendation = 'Do not auto-run — high risk; keep human-in-the-loop or defer.';
      else if (score >= 0.5 && roi != null && roi >= 1) recommendation = 'Strong automation candidate — propose to the Genesis Foundry.';
      else if (score >= 0.25) recommendation = 'Pilot a low-risk slice and measure.';
      else recommendation = 'Low payoff — leave manual.';
      return { task: t.name || 'unnamed', annualHours: Math.round(annualHours * 10) / 10, annualSavings: annualSavings, roi: roi, risk: risk, complexity: complexity, score: score, recommendation: recommendation, status: 'derived' };
    },

    /** Rank a set of tasks by automation score. */
    discover(tasks) {
      return (Array.isArray(tasks) ? tasks : []).map((t) => this.analyze(t)).filter((r) => r.status === 'derived').sort((a, b) => b.score - a.score);
    }
  };

  global.AAA_AUTOMATION_DISCOVERY_ENGINE = Engine;
})(typeof window !== 'undefined' ? window : this);
