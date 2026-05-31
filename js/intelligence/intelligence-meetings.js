/*
 * AAA Intelligence Meetings — the cadence that keeps the org reviewing itself.
 *
 *   Daily      Operations Briefing      — today's execution & pipeline
 *   Weekly     Executive Intelligence   — revenue, pricing, customer, marketing
 *   Monthly    Strategic Planning       — trends, what's working, what to change
 *   Quarterly  Business Evolution       — structural changes, new analysts/metrics
 *
 * Each meeting gathers the relevant REAL collectors + recent accepted reports +
 * learning metrics, asks a chair to synthesize, and produces dated, owned action
 * items. Outcomes are stored in `meetings` so the next meeting can review whether
 * the last one's action items actually moved the numbers.
 *
 * due(cadence) reports whether enough time has passed since the last meeting, so
 * a scheduler (or the dashboard) can prompt the owner — nothing fires silently.
 */
;(function (global) {
  'use strict';

  function div() { return global.AAA_ANALYSIS_DIVISION; }
  function collectors() { return global.AAA_INTEL_COLLECTORS; }
  function pipeline() { return global.AAA_INTEL_PIPELINE; }
  function data() { return global.AAA_DATA; }
  function ids() { return global.AAA_ID_FACTORY; }
  function clock() { return global.AAA_RUNTIME_CLOCK; }

  function newId(p) { return ids() ? ids().createId(p) : (p + '_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8)); }
  function now() { return clock() ? clock().now() : Date.now(); }

  const DAY = 24 * 60 * 60 * 1000;
  const CADENCES = {
    daily: { id: 'daily', name: 'Operations Briefing', everyMs: DAY, domains: ['operations', 'pricing'],
      charter: 'Brief the owner on today\'s field execution and open pipeline. Surface anything blocking jobs from getting done well today.' },
    weekly: { id: 'weekly', name: 'Executive Intelligence Meeting', everyMs: 7 * DAY, domains: ['revenue', 'pricing', 'customer', 'marketing'],
      charter: 'Review the week across revenue, pricing, customers, and marketing. Decide the 1-3 things that most move the business next week.' },
    monthly: { id: 'monthly', name: 'Strategic Planning Meeting', everyMs: 30 * DAY, domains: ['revenue', 'customer', 'marketing', 'operations', 'ai'],
      charter: 'Step back to the month. What trend is forming? What is working, what is failing, and what should we change structurally?' },
    quarterly: { id: 'quarterly', name: 'Business Evolution Summit', everyMs: 91 * DAY, domains: ['revenue', 'pricing', 'customer', 'operations', 'marketing', 'ai'],
      charter: 'Evolve the business. Propose structural changes: new analysts, new metrics, new workflows, and which low-value efforts to stop.' }
  };

  const AGENDA_SCHEMA = {
    type: 'object',
    properties: {
      summary: { type: 'string', description: 'The state of the business for this cadence, grounded in the numbers.' },
      wins: { type: 'array', items: { type: 'string' } },
      failures: { type: 'array', items: { type: 'string' } },
      decisions: { type: 'array', items: { type: 'string' }, description: 'Decisions made in this meeting.' },
      action_items: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            action: { type: 'string' },
            owner: { type: 'string', description: 'Which team or role owns it (revenue/pricing/customer/operations/marketing/ai/owner).' },
            priority: { type: 'string', enum: ['LOW', 'MEDIUM', 'HIGH'] }
          },
          required: ['action', 'owner', 'priority'],
          additionalProperties: false
        }
      },
      confidence: { type: 'integer', description: '0-100 confidence in this read given the data depth.' }
    },
    required: ['summary', 'wins', 'failures', 'decisions', 'action_items', 'confidence'],
    additionalProperties: false
  };

  const Meetings = {
    CADENCES: CADENCES,
    isReady: function () { return !!(div() && div().isReady()); },

    /** Has enough time elapsed since the last meeting of this cadence? */
    async due(cadenceId) {
      const c = CADENCES[cadenceId];
      if (!c) return { ok: false, error: 'UNKNOWN_CADENCE' };
      const last = await this.last(cadenceId);
      const since = last ? (now() - (last.createdAt || 0)) : Infinity;
      return { ok: true, due: since >= c.everyMs, lastAt: last ? last.createdAt : null, everyMs: c.everyMs, sinceMs: since === Infinity ? null : since };
    },

    /**
     * Hold a meeting now.
     * @param {string} cadenceId daily|weekly|monthly|quarterly
     */
    async run(cadenceId) {
      const D = div();
      if (!D) return { ok: false, error: 'DIVISION_MISSING' };
      const c = CADENCES[cadenceId];
      if (!c) return { ok: false, error: 'UNKNOWN_CADENCE' };
      if (!this.isReady()) return { ok: false, error: 'AI_NOT_CONFIGURED' };

      // Gather the real numbers for this cadence's domains + recent accepted reports.
      const domainData = {};
      for (const dom of c.domains) domainData[dom] = await collectors().forTeam(dom);
      const recentReports = pipeline() ? (await pipeline().list()).slice(0, 8).map(function (r) {
        return { team: r.team, status: r.status, recommendation: r.recommendation, confidence: r.confidence, at: r.createdAt };
      }) : [];
      const lastMeeting = await this.last(cadenceId);
      const priorActions = lastMeeting && lastMeeting.actionItems ? lastMeeting.actionItems : [];

      const chair = { id: 'meeting_chair', model: D.EXEC,
        system: 'You chair the ' + c.name + ' for ' + D.COMPANY + '\n' + c.charter +
          '\nGround everything in the JSON numbers and recent analyses you are given. If you reference last meeting\'s action items, say honestly whether the data shows they worked. ' +
          'Produce specific, owned, dated action items — not platitudes. Respond ONLY as JSON matching the schema.' };

      const res = await D.runRole(chair,
        'CADENCE: ' + c.name +
        '\n\nREAL DOMAIN DATA (JSON):\n' + JSON.stringify(domainData, null, 2) +
        '\n\nRECENT ANALYSES (JSON):\n' + JSON.stringify(recentReports, null, 2) +
        '\n\nLAST MEETING\'S ACTION ITEMS (JSON):\n' + JSON.stringify(priorActions, null, 2) +
        '\n\nRun the meeting. Respond ONLY as JSON matching the schema.',
        AGENDA_SCHEMA, { agent: 'meeting_' + cadenceId, maxTokens: 1200 });
      if (!res.ok) return { ok: false, error: res.error, raw: res.raw };
      const a = res.data;

      const record = {
        id: newId('meeting'), cadence: cadenceId, name: c.name,
        summary: a.summary, wins: a.wins || [], failures: a.failures || [],
        decisions: a.decisions || [], actionItems: a.action_items || [],
        confidence: typeof a.confidence === 'number' ? a.confidence : null,
        domains: c.domains, reviewedReports: recentReports.length,
        createdAt: now()
      };
      await this._persist(record);
      try { if (data().logAgent) data().logAgent('meeting', c.name + ' — ' + (record.actionItems.length) + ' action item(s)', { meetingId: record.id, cadence: cadenceId }); } catch (_) {}
      return Object.assign({ ok: true }, record);
    },

    async _persist(rec) {
      try { await data().put('meetings', rec.id, rec); } catch (_) {}
      try { if (data().cloudReady && data().cloudReady() && global.AAA_CLOUD) await global.AAA_CLOUD.upsertEntity('meetings', rec.id, rec); } catch (_) {}
      return rec;
    },

    async list() { return data() ? (await data().list('meetings')).slice().sort(function (a, b) { return (b.createdAt || 0) - (a.createdAt || 0); }) : []; },
    async last(cadenceId) {
      const all = await this.list();
      return all.find(function (m) { return m.cadence === cadenceId; }) || null;
    }
  };

  global.AAA_MEETINGS = Meetings;
})(typeof window !== 'undefined' ? window : this);
