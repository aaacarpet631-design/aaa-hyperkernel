/*
 * AAA Job Notes Agent — turns a raw voice/manual transcript into structured,
 * REVIEW-ONLY suggestions for a carpet-cleaning/flooring job.
 *
 * Given a transcript, it extracts: customer request, work performed, materials
 * needed, rooms mentioned, measurements mentioned, follow-up tasks, urgency, and
 * whether the note is accounting/receipt-relevant, plus crew action items.
 *
 * SAFETY (hard rule, enforced by construction): this agent ONLY produces
 * suggestions attached to the note's `intelligence` field. It does not, and
 * cannot from here, change job status, create/modify quotes or invoices, post
 * accounting entries, or send customer messages. A human must review and act.
 *
 * Honest by construction: gated on the Claude proxy via AAA_DATA.callAgent; with
 * no proxy configured it returns { ok:false, error:'AI_NOT_CONFIGURED' } and the
 * transcript is still saved verbatim — extraction is additive, never required.
 */
;(function (global) {
  'use strict';

  function data() { return global.AAA_DATA; }
  function cfg() { return global.AAA_CONFIG || {}; }
  function notes() { return global.AAA_VOICE_NOTES; }

  const MODEL = 'claude-sonnet-4-6';

  const STRLIST = { type: 'array', items: { type: 'string' } };
  const SCHEMA = {
    type: 'object',
    properties: {
      customerRequest: { type: 'string', description: 'What the customer asked for, in one line. Empty if none.' },
      workPerformed: STRLIST,
      materialsNeeded: STRLIST,
      rooms: { type: 'array', items: { type: 'string' }, description: 'Rooms/areas mentioned (e.g. master bedroom, stairs, hallway).' },
      measurements: { type: 'array', items: { type: 'string' }, description: 'Any measurements mentioned, verbatim (e.g. "12x14 ft", "20 stairs").' },
      followUpTasks: STRLIST,
      crewActionItems: STRLIST,
      urgency: { type: 'string', enum: ['low', 'medium', 'high'] },
      accountingRelevant: { type: 'boolean', description: 'True if it mentions money, pricing, payment, or costs.' },
      receiptRelevant: { type: 'boolean', description: 'True if it mentions a receipt, purchase, or expense to record.' },
      summary: { type: 'string', description: 'One-sentence neutral summary of the note.' }
    },
    required: ['customerRequest', 'workPerformed', 'materialsNeeded', 'rooms', 'measurements',
      'followUpTasks', 'crewActionItems', 'urgency', 'accountingRelevant', 'receiptRelevant', 'summary'],
    additionalProperties: false
  };

  const SYSTEM =
    'You are the Job Notes Agent for AAA Carpet — a carpet cleaning, repair, stretching, installation, ' +
    'apartment-turn, and flooring company. You read a short field note (spoken or typed by the owner or a ' +
    'crew member on a job) and extract structured details. Ground every field ONLY in the transcript; if ' +
    'something is not mentioned, return an empty string/array or false — never invent. These are SUGGESTIONS ' +
    'for a human to review; you are not taking any action. Respond ONLY as JSON matching the schema.';

  function parseJson(text) {
    const s = String(text == null ? '' : text).trim();
    if (!s) return null;
    try { return JSON.parse(s); } catch (_) {}
    const fenced = s.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
    if (fenced !== s) { try { return JSON.parse(fenced); } catch (_) {} }
    const a = s.indexOf('{'); const b = s.lastIndexOf('}');
    if (a !== -1 && b > a) { try { return JSON.parse(s.slice(a, b + 1)); } catch (_) {} }
    return null;
  }

  const Agent = {
    isReady() {
      return !!(data() && data().callAgent && cfg().isProxyConfigured && cfg().isProxyConfigured());
    },

    /**
     * Extract suggestions from a transcript. Returns { ok, intelligence } or an
     * honest error. Does NOT persist by itself — caller decides (analyze() does).
     */
    async extract(transcript) {
      const text = String(transcript || '').trim();
      if (!text) return { ok: false, error: 'EMPTY_TRANSCRIPT' };
      if (!this.isReady()) return { ok: false, error: 'AI_NOT_CONFIGURED' };

      const system = global.AAA_PROMPT_REGISTRY ? await global.AAA_PROMPT_REGISTRY.resolve('job_notes', SYSTEM) : SYSTEM;
      const res = await data().callAgent({
        agent: 'job_notes', model: MODEL, max_tokens: 800,
        system: system,
        output_config: { format: { type: 'json_schema', schema: SCHEMA } },
        messages: [{ role: 'user', content: 'FIELD NOTE TRANSCRIPT:\n"""\n' + text + '\n"""\n\nExtract per the schema. Suggestions only.' }]
      });
      if (!res || res.ok === false) return { ok: false, error: (res && res.error) || 'TRANSCRIPTION_FAILED' };
      const parsed = parseJson(res.text || '');
      if (!parsed) return { ok: false, error: 'BAD_OUTPUT', raw: res.text };

      return {
        ok: true,
        intelligence: {
          status: 'suggested',        // review-only; never 'applied'
          reviewRequired: true,
          extractedAt: (global.AAA_RUNTIME_CLOCK ? global.AAA_RUNTIME_CLOCK.nowISO() : new Date().toISOString()),
          data: parsed
        }
      };
    },

    /**
     * Convenience: extract from a saved note and attach the suggestions to it.
     * Pure suggestion attachment — the note's transcript/status are untouched
     * except to store `intelligence`. Returns the updated note or an error.
     */
    async analyze(noteId) {
      if (!notes() || !notes().get) return { ok: false, error: 'NO_NOTE_STORE' };
      const note = await notes().get(noteId);
      if (!note) return { ok: false, error: 'NOT_FOUND' };
      const r = await this.extract(note.transcript);
      if (!r.ok) {
        try { if (global.AAA_VOICE_DIAGNOSTICS) await global.AAA_VOICE_DIAGNOSTICS.log('TRANSCRIPTION_FAILED', { jobId: note.jobId, source: 'job_notes_agent', detail: r.error }); } catch (_) {}
        return r;
      }
      const upd = await notes().update(noteId, { intelligence: r.intelligence });
      try { if (data().logAgent) data().logAgent('job_notes', 'Extracted review-only suggestions from a voice note', { jobId: note.jobId, noteId: noteId }); } catch (_) {}
      return upd.ok ? { ok: true, note: upd.note, intelligence: r.intelligence } : upd;
    }
  };

  global.AAA_JOB_NOTES_AGENT = Agent;
})(typeof window !== 'undefined' ? window : this);
