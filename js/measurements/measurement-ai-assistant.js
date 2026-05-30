/*
 * AAA Measurement AI Assistant — optional review, never an autopilot.
 *
 * Sends the captured measurement sessions (real data) through the existing
 * Claude proxy (AAA_DATA.callAgent) and returns structured flags: missing
 * rooms, unrealistic square footage, stair pricing risk, install waste, repair-
 * vs-replacement, a quote confidence score, and a field-notes summary.
 *
 * Hard rule: it returns advisory output ONLY. It never writes a price and never
 * applies an estimate — a human reviews and confirms. Gated on the proxy; if AI
 * isn't configured it degrades to local heuristic checks so the field still
 * gets duplicate/unrealistic warnings with zero network.
 */
;(function (global) {
  'use strict';

  function data() { return global.AAA_DATA; }
  function cfg() { return global.AAA_CONFIG || {}; }
  function models() { return global.AAA_MEASUREMENT_MODELS; }

  const REVIEW_SCHEMA = {
    type: 'object',
    properties: {
      missingRooms: { type: 'array', items: { type: 'string' }, description: 'Rooms a typical job like this usually includes but that are absent here.' },
      unrealistic: { type: 'array', items: { type: 'string' }, description: 'Measurements that look physically implausible, with the room named.' },
      stairRisk: { type: 'string', description: 'Stair pricing risk note, or empty if none.' },
      wasteWarning: { type: 'string', description: 'Carpet install waste/seam-direction concern, or empty.' },
      repairVsReplace: { type: 'string', description: 'If repair was measured, whether replacement may be the better call, or empty.' },
      quoteConfidence: { type: 'integer', description: '0-100 confidence that these measurements are complete and quote-ready.' },
      fieldNotesSummary: { type: 'string', description: 'One short paragraph summarizing the field notes across rooms.' },
      reviewRequired: { type: 'boolean', description: 'Always true — a human must confirm pricing.' }
    },
    required: ['missingRooms', 'unrealistic', 'stairRisk', 'wasteWarning', 'repairVsReplace', 'quoteConfidence', 'fieldNotesSummary', 'reviewRequired'],
    additionalProperties: false
  };

  const SYSTEM = 'You are a measurement-review assistant for AAA Carpet, a carpet cleaning/repair/install company. ' +
    'You are given room measurement sessions captured in the field. Review them for completeness and plausibility and ' +
    'return structured flags. You do NOT set prices and you do NOT approve anything — a human estimator confirms ' +
    'pricing. Ground every flag in the supplied data; if something is fine, return empty. Respond ONLY as JSON per schema.';

  const Assistant = {
    isReady() { return !!(data() && cfg().isProxyConfigured && cfg().isProxyConfigured()); },

    /**
     * Review sessions. Uses Claude when configured; otherwise local heuristics.
     * @param {MeasurementSession[]} sessions
     * @param {Object} [context] { jobType?, customerName? }
     */
    async review(sessions, context) {
      const list = Array.isArray(sessions) ? sessions : [];
      const local = this._localChecks(list);
      if (!this.isReady()) {
        return { ok: true, mode: 'local', review: local, note: 'AI not configured — showing local checks only.' };
      }
      const res = await data().callAgent({
        agent: 'measurement_assistant', model: 'claude-opus-4-8', max_tokens: 900,
        system: SYSTEM,
        output_config: { format: { type: 'json_schema', schema: REVIEW_SCHEMA } },
        messages: [{ role: 'user', content:
          'JOB CONTEXT: ' + JSON.stringify(context || {}) +
          '\n\nMEASUREMENT SESSIONS (JSON):\n' + JSON.stringify(list.map(slim), null, 2) +
          '\n\nReview for missing rooms, unrealistic sizes, stair pricing risk, install waste, repair-vs-replacement, ' +
          'a quote confidence score, and a field-notes summary. Return JSON per schema.' }]
      });
      if (!res || res.ok === false) {
        return { ok: true, mode: 'local', review: local, note: 'AI review failed (' + ((res && res.error) || 'unknown') + ') — showing local checks.' };
      }
      const parsed = parseJson(res.text);
      if (!parsed) return { ok: true, mode: 'local', review: local, note: 'AI output unparseable — showing local checks.' };
      parsed.reviewRequired = true; // enforce, regardless of model output
      // Fold in local hard-warnings so nothing the deterministic checks caught is lost.
      parsed.unrealistic = dedupe((parsed.unrealistic || []).concat(local.unrealistic));
      return { ok: true, mode: 'ai', review: parsed };
    },

    /** Deterministic, offline checks — always run, no network needed. */
    _localChecks(list) {
      const unrealistic = [];
      const m = models();
      list.forEach((s) => {
        const v = m ? m.validateSession(s, { existing: list }) : { warnings: [] };
        (v.warnings || []).forEach((w) => unrealistic.push((s.roomName || 'Room') + ': ' + w));
      });
      const totalSq = list.reduce((sum, s) => sum + (s.squareFeet || 0), 0);
      const stairs = list.reduce((sum, s) => sum + (s.stairsCount || 0), 0);
      return {
        missingRooms: [],
        unrealistic: dedupe(unrealistic),
        stairRisk: stairs > 0 ? stairs + ' stairs measured — confirm stair pricing is included.' : '',
        wasteWarning: totalSq > 0 ? 'Confirm ~10% material waste is included for cuts/seams.' : '',
        repairVsReplace: '',
        quoteConfidence: list.length ? Math.max(20, 80 - unrealistic.length * 15) : 0,
        fieldNotesSummary: list.map((s) => s.notes).filter(Boolean).join(' ') || 'No field notes.',
        reviewRequired: true
      };
    }
  };

  function slim(s) {
    return { roomName: s.roomName, length: s.length, width: s.width, squareFeet: s.squareFeet,
      linearFeet: s.linearFeet, stairsCount: s.stairsCount, source: s.source, notes: s.notes };
  }
  function parseJson(text) {
    const s = String(text == null ? '' : text).trim();
    try { return JSON.parse(s); } catch (_) {}
    const i = s.indexOf('{'), j = s.lastIndexOf('}');
    if (i !== -1 && j > i) { try { return JSON.parse(s.slice(i, j + 1)); } catch (_) {} }
    return null;
  }
  function dedupe(arr) { return Array.from(new Set((arr || []).filter(Boolean))); }

  global.AAA_MEASUREMENT_AI = Assistant;
})(typeof window !== 'undefined' ? window : this);
