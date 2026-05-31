/*
 * AAA Evolution Engine — the org that grows itself (Layer 6, the "Evolution" half).
 *
 * "When patterns emerge, analysis teams may request new analysts, workflows,
 * metrics, reports, or dashboards. The system should evolve, not remain static."
 *
 * scan() reads REAL signals of where the org is blind: domains where accepted
 * analyses keep landing at low confidence, debates that keep getting rejected,
 * recurring risks no one owns, and rankings showing an axis the team can't cover.
 * It then asks an architect to name concrete gaps and propose how to fill each —
 * a new analyst, workflow, metric, report, or dashboard. Proposals are stored in
 * `evolution_proposals`.
 *
 * createAnalyst() turns an approved "analyst" gap into a real, runnable agent
 * through the existing Prompt Architect — closing the loop from "we have a blind
 * spot" to "a new specialist now exists and will be scored like everyone else".
 *
 * Honest by construction: gated on the proxy; the evidence handed to the model is
 * real memory; new analysts are created only on request (or explicit autoCreate),
 * never silently — spawning agents is consequential.
 */
;(function (global) {
  'use strict';

  function div() { return global.AAA_ANALYSIS_DIVISION; }
  function pipeline() { return global.AAA_INTEL_PIPELINE; }
  function debate() { return global.AAA_DEBATE; }
  function rankings() { return global.AAA_RANKINGS; }
  function architect() { return global.AAA_PROMPT_ARCHITECT; }
  function data() { return global.AAA_DATA; }
  function ids() { return global.AAA_ID_FACTORY; }
  function clock() { return global.AAA_RUNTIME_CLOCK; }

  function newId(p) { return ids() ? ids().createId(p) : (p + '_' + Date.now()); }
  function now() { return clock() ? clock().now() : Date.now(); }
  function mean(a) { return a.length ? a.reduce(function (x, y) { return x + y; }, 0) / a.length : null; }

  const GAP_SCHEMA = {
    type: 'object',
    properties: {
      summary: { type: 'string', description: 'Where the analysis org is currently blind, grounded in the evidence.' },
      gaps: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            area: { type: 'string', description: 'The blind spot or unmet need.' },
            evidence: { type: 'string', description: 'The specific signal in the data that shows this gap (cite numbers).' },
            severity: { type: 'string', enum: ['LOW', 'MEDIUM', 'HIGH'] },
            proposalType: { type: 'string', enum: ['analyst', 'workflow', 'metric', 'report', 'dashboard'] },
            proposedName: { type: 'string' },
            description: { type: 'string', description: 'What to build, concretely.' },
            expectedValue: { type: 'string', description: 'What improves if we build it.' }
          },
          required: ['area', 'evidence', 'severity', 'proposalType', 'proposedName', 'description', 'expectedValue'],
          additionalProperties: false
        }
      }
    },
    required: ['summary', 'gaps'],
    additionalProperties: false
  };

  // Build the real evidence packet the architect reasons over — no fabrication.
  async function gatherSignals() {
    const reports = pipeline() ? await pipeline().list() : [];
    const debates = debate() ? await debate().list() : [];

    // Per-domain accepted-but-low-confidence + rejection signals.
    const byTeam = {};
    reports.forEach(function (r) {
      const t = byTeam[r.teamId] || (byTeam[r.teamId] = { team: r.team || r.teamId, reports: 0, confidences: [], warmingUp: 0, needsRevision: 0 });
      t.reports++;
      if (typeof r.confidence === 'number') t.confidences.push(r.confidence);
      if (r.collected && r.collected.status === 'warming_up') t.warmingUp++;
      if (r.status === 'needs_revision') t.needsRevision++;
    });
    const domainSignals = Object.keys(byTeam).map(function (k) {
      const t = byTeam[k];
      return { team: t.team, reports: t.reports, avgConfidence: t.confidences.length ? Math.round(mean(t.confidences)) : null, thinDataReports: t.warmingUp, needsRevision: t.needsRevision };
    });

    const rejected = debates.filter(function (dx) { return dx.verdict === 'reject'; }).length;
    const blocked = debates.filter(function (dx) { return dx.blocking; }).length;

    // Coverage gaps from rankings: axes the team rarely covers.
    let rankTable = null;
    if (rankings()) { try { rankTable = await rankings().compute(); } catch (_) {} }
    const lowCoverage = rankTable && rankTable.ok
      ? rankTable.analysts.filter(function (a) { return a.coverage <= 2 && a.decisions >= 3; }).map(function (a) { return a.analyst; })
      : [];

    return {
      teamsDefined: div() ? div().teamIds() : [],
      domainSignals: domainSignals,
      debate: { total: debates.length, rejected: rejected, blocked: blocked },
      lowCoverageAnalysts: lowCoverage,
      reportCount: reports.length
    };
  }

  const Evolution = {
    isReady: function () { return !!(div() && div().isReady()); },

    /** Identify expertise gaps from real signals and store proposals. */
    async scan() {
      const D = div();
      if (!D) return { ok: false, error: 'DIVISION_MISSING' };
      if (!this.isReady()) return { ok: false, error: 'AI_NOT_CONFIGURED' };
      const signals = await gatherSignals();

      const role = { id: 'evolution_architect', model: D.EXEC,
        system: 'You are the Evolution Architect for the analysis division of ' + D.COMPANY +
          '\nYou decide how the analysis ORG should grow. Given real signals (per-domain analysis confidence, thin-data domains, ' +
          'rejected/blocked debates, and rankings coverage), name the concrete blind spots and propose how to fill each: a new ' +
          'analyst, workflow, metric, report, or dashboard. Only propose what the evidence supports — if the org is adequately ' +
          'covered, return an empty gaps array. Do not duplicate an existing team. Respond ONLY as JSON matching the schema.' };

      const res = await D.runRole(role,
        'EXISTING TEAMS: ' + signals.teamsDefined.join(', ') +
        '\n\nREAL SIGNALS (JSON):\n' + JSON.stringify(signals, null, 2) +
        '\n\nIdentify expertise gaps and propose how to evolve the org. Respond ONLY as JSON matching the schema.',
        GAP_SCHEMA, { agent: 'evolution_architect', maxTokens: 1200 });
      if (!res.ok) return { ok: false, error: res.error, raw: res.raw };

      const rec = {
        id: newId('evo'), createdAt: now(),
        summary: res.data.summary,
        gaps: (res.data.gaps || []).map(function (g) { return Object.assign({ status: 'proposed' }, g); }),
        signals: signals
      };
      try { await data().put('evolution_proposals', rec.id, rec); } catch (_) {}
      try { if (data().cloudReady && data().cloudReady() && global.AAA_CLOUD) await global.AAA_CLOUD.upsertEntity('evolution_proposals', rec.id, rec); } catch (_) {}
      try { if (data().logAgent) data().logAgent('evolution', (rec.gaps.length) + ' gap(s) identified', { proposalId: rec.id }); } catch (_) {}
      return Object.assign({ ok: true, proposalId: rec.id }, rec);
    },

    /**
     * Turn an "analyst" gap into a real runnable agent via the Prompt Architect.
     * @param {object} gap a gap object with proposalType==='analyst'
     */
    async createAnalyst(gap) {
      if (!architect() || !architect().design) return { ok: false, error: 'NO_ARCHITECT' };
      if (!gap || gap.proposalType !== 'analyst') return { ok: false, error: 'NOT_AN_ANALYST_GAP' };
      const desc = 'An analyst named "' + (gap.proposedName || 'Specialist') + '" to fill this gap in our analysis division: ' +
        gap.area + '. ' + (gap.description || '') + ' Expected value: ' + (gap.expectedValue || '') + '.';
      const designed = await architect().design(desc);
      if (!designed.ok) return { ok: false, error: designed.error || 'DESIGN_FAILED' };
      const saved = await architect().saveAgent(designed.spec);
      if (!saved.ok) return { ok: false, error: saved.error || 'SAVE_FAILED' };
      try { if (data().logAgent) data().logAgent('evolution', 'Spawned new analyst "' + (saved.agent && saved.agent.title) + '"', { agentId: saved.agent && saved.agent.id }); } catch (_) {}
      return { ok: true, agent: saved.agent };
    },

    /**
     * Scan and (optionally) auto-spawn analysts for HIGH-severity analyst gaps.
     * autoCreate defaults to false — spawning agents is consequential.
     */
    async evolve(opts) {
      opts = opts || {};
      const scan = await this.scan();
      if (!scan.ok) return scan;
      const created = [];
      if (opts.autoCreate) {
        for (const g of scan.gaps) {
          if (g.proposalType === 'analyst' && g.severity === 'HIGH') {
            const r = await this.createAnalyst(g);
            if (r.ok) { g.status = 'created'; g.agentId = r.agent && r.agent.id; created.push(r.agent); }
          }
        }
        // Persist the updated statuses.
        try { await data().put('evolution_proposals', scan.proposalId, { id: scan.proposalId, createdAt: scan.createdAt, summary: scan.summary, gaps: scan.gaps, signals: scan.signals }); } catch (_) {}
      }
      return { ok: true, proposalId: scan.proposalId, gaps: scan.gaps, created: created };
    },

    async list() { return data() ? (await data().list('evolution_proposals')).slice().sort(function (a, b) { return (b.createdAt || 0) - (a.createdAt || 0); }) : []; }
  };

  global.AAA_EVOLUTION = Evolution;
})(typeof window !== 'undefined' ? window : this);
