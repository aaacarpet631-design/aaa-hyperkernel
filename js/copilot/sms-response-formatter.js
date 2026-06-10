/*
 * AAA SMS Response Formatter — turn a Copilot answer into a short, plain-text
 * reply that fits a text message.
 *
 * No markdown, no raw dumps. Protected actions become a clear "approval needed"
 * line (SMS never performs them). Missing data is stated honestly. Output is
 * capped to a sane SMS length with a graceful "(open the app for detail)" when
 * truncated. Pure; deterministic.
 */
;(function (global) {
  'use strict';

  function num(v, d) { const n = Number(v); return isFinite(n) ? n : d; }
  function cap(s, max) { s = String(s == null ? '' : s); return s.length <= max ? s : s.slice(0, Math.max(0, max - 18)).trim() + '… (open the app)'; }

  const Formatter = {
    DEFAULT_MAX: 480,

    /** Format a Copilot answer (the object returned by AAA_EXECUTIVE_COPILOT.ask). */
    format(answer, opts) {
      const o = opts || {};
      const max = num(o.maxLen, this.DEFAULT_MAX);
      if (!answer || answer.ok === false) return cap('Sorry — I could not process that right now.', max);

      // Protected action → approval message; SMS never performs it.
      if (answer.governanceRequired && answer.approvalPackage) {
        const act = (answer.approvalPackage.action) || 'the requested change';
        return cap('⚠️ Needs your approval: ' + act + '. Approve in the app (ref ' + String(answer.approvalPackage.id || '').slice(-6) + ').', max);
      }

      const a = answer.answer || {};
      let lines = [a.summary || 'Done.'];

      // One compact metric line for analysis answers.
      if (a.keyMetrics) {
        const km = a.keyMetrics; const bits = [];
        if (km.grossMargin != null) bits.push('margin ' + Math.round(km.grossMargin * 100) + '%');
        if (km.closeRate != null) bits.push('close ' + Math.round(km.closeRate * 100) + '%');
        if (km.reviewsPerWeek != null) bits.push(km.reviewsPerWeek + ' reviews/wk');
        if (bits.length) lines.push(bits.join(' · '));
      }
      // Simulation answers: expected revenue range.
      if (a.simulation && a.simulation.status === 'simulated') {
        const e = a.simulation.expected || {}; const w = a.simulation.worst || {}; const b = a.simulation.best || {};
        if (e.revenue != null) lines.push('Revenue ~' + Math.round(e.revenue) + ' (worst ' + Math.round(w.revenue) + ', best ' + Math.round(b.revenue) + '). Needs approval to act.');
      }
      // Goal answers.
      if (a.goal && a.goal.status === 'planned') lines.push('Delta ' + a.goal.currentDelta + '. ' + (a.goal.capabilityGaps && a.goal.capabilityGaps.length && a.goal.capabilityGaps[0].gap ? 'Capability gap found.' : 'No capability gap.') + ' Needs approval to act.');

      if (answer.governanceRequired && !answer.approvalPackage) lines.push('(Acting on this needs your approval.)');
      if (Array.isArray(answer.missingData) && answer.missingData.length) lines.push('Missing: ' + answer.missingData.slice(0, 3).join(', ') + '.');

      return cap(lines.join('\n'), max);
    }
  };

  global.AAA_SMS_RESPONSE_FORMATTER = Formatter;
})(typeof window !== 'undefined' ? window : this);
