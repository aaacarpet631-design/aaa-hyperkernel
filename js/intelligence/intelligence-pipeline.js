/*
 * AAA Intelligence Pipeline — the 6-layer gate every team analysis runs through.
 *
 *   Layer 1  Collection    → real numbers from shared memory (deterministic)
 *   Layer 2  Analysis      → the team's analyst reasons over those numbers
 *   Layer 3  Validation    → Critic + Risk challenge it (via the Debate engine)
 *   Layer 4  Supervisor    → arbitrated verdict + calibrated confidence (gates accept)
 *   Layer 5  Executive     → an executive-ready summary entry
 *   Layer 6  Learning      → the report is stored and a scorable decision logged
 *
 * "No analysis is accepted without passing through all layers." A report records
 * exactly which layers ran and what each produced, so the system is auditable.
 *
 * Honest by construction: if the proxy is not configured, the pipeline still runs
 * Layer 1 and returns the real data with status 'collected_only' — it never
 * pretends an analyst ran. Layer 1 always reflects real memory.
 */
;(function (global) {
  'use strict';

  function div() { return global.AAA_ANALYSIS_DIVISION; }
  function collectors() { return global.AAA_INTEL_COLLECTORS; }
  function debate() { return global.AAA_DEBATE; }
  function data() { return global.AAA_DATA; }
  function ids() { return global.AAA_ID_FACTORY; }
  function clock() { return global.AAA_RUNTIME_CLOCK; }

  function newId(p) { return ids() ? ids().createId(p) : (p + '_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8)); }
  function now() { return clock() ? clock().now() : Date.now(); }

  const Pipeline = {
    isReady: function () { return !!(div() && div().isReady()); },

    /**
     * Run one team through all six layers.
     * @param {string} teamId  one of div().teamIds()
     * @param {object} [opts]  { skipDebate?:boolean }  // skipDebate runs analysis only (Layer 2)
     * @returns {Promise<object>} the stored report
     */
    async runTeam(teamId, opts) {
      const D = div();
      if (!D) return { ok: false, error: 'DIVISION_MISSING' };
      const team = D.team(teamId);
      if (!team) return { ok: false, error: 'UNKNOWN_TEAM', teamId: teamId };
      opts = opts || {};

      const layers = [];

      // --- Layer 1: Collection (always runs) -----------------------------
      const collected = await collectors().forTeam(team.collector || teamId);
      layers.push({ layer: 1, name: 'Data Collection', status: 'ran', data: collected });

      const base = {
        id: newId('intel'), teamId: teamId, team: team.name,
        createdAt: now(), source: opts.source || 'manual',
        collected: collected
      };

      // If the proxy is not live, stop honestly after Layer 1.
      if (!this.isReady()) {
        const report = Object.assign(base, {
          status: 'collected_only', accepted: false,
          note: 'AI proxy not configured — collected real data only; no analyst ran.',
          layers: layers
        });
        await this._persist(report);
        return Object.assign({ ok: true }, report);
      }

      // --- Layer 2: Analysis ---------------------------------------------
      const dataThin = collected && collected.status === 'warming_up';
      const analysisR = await D.runRole(team,
        'You are the ' + team.name + ' team. Analyze ONLY these real numbers from the business.\n\n' +
        'DOMAIN: ' + team.purpose + '\nYOU TRACK: ' + team.tracks.join(', ') + '\nYOU OUTPUT: ' + team.outputs.join(', ') +
        (dataThin ? '\n\nNOTE: this domain is still warming up (thin data). Be explicit about that and keep confidence low.' : '') +
        '\n\nREAL DATA (JSON):\n' + JSON.stringify(collected, null, 2) +
        '\n\nProduce your analysis as JSON matching the schema. Cite the specific numbers you used in metrics_cited.',
        D.ANALYSIS_SCHEMA, { agent: 'team_' + teamId, maxTokens: 1000 });
      if (!analysisR.ok) {
        const report = Object.assign(base, { status: 'analysis_failed', accepted: false, error: analysisR.error, layers: layers });
        await this._persist(report);
        return Object.assign({ ok: false, error: analysisR.error }, report);
      }
      const analysis = analysisR.data;
      layers.push({ layer: 2, name: 'Analysis', status: 'ran', analyst: team.name, output: analysis });

      // Analysis-only mode (e.g. quick refresh) stops here but is still stored.
      if (opts.skipDebate) {
        const report = Object.assign(base, {
          status: 'analyzed', accepted: false, analysis: analysis,
          recommendation: analysis.recommendation, confidence: analysis.confidence,
          opportunities: analysis.opportunities, risks: analysis.risks, forecast: analysis.forecast,
          layers: layers
        });
        await this._persist(report);
        return Object.assign({ ok: true }, report);
      }

      // --- Layers 3 & 4: Validation + Supervisor (via Debate) ------------
      const deb = await debate().run({
        topic: team.name + ' — ' + analysis.recommendation,
        context: { domain: team.purpose, data: collected, analysis: analysis },
        recommendation: { recommendation: analysis.recommendation, rationale: analysis.summary, confidence: analysis.confidence, analysis: analysis },
        meta: { teamId: teamId, source: 'pipeline' }
      });
      if (!deb.ok) {
        const report = Object.assign(base, { status: 'validation_failed', accepted: false, analysis: analysis, error: deb.error, layers: layers });
        await this._persist(report);
        return Object.assign({ ok: false, error: deb.error }, report);
      }
      const validation = deb.transcript.find(function (t) { return t.role === 'critic'; });
      const risk = deb.transcript.find(function (t) { return t.role === 'risk'; });
      layers.push({ layer: 3, name: 'Validation', status: 'ran', critic: validation ? validation.output : null, risk: risk ? risk.output : null });
      layers.push({ layer: 4, name: 'Supervisor Review', status: 'ran', verdict: deb.verdict, confidence: deb.confidence, conditions: deb.conditions, debateId: deb.debateId });

      // --- Layer 5: Executive rollup -------------------------------------
      const executive = {
        headline: deb.finalRecommendation,
        verdict: deb.verdict,
        confidence: deb.confidence,
        topOpportunities: (analysis.opportunities || []).slice(0, 3),
        topRisks: (analysis.risks || []).slice(0, 3),
        forecast: analysis.forecast,
        conditions: deb.conditions
      };
      layers.push({ layer: 5, name: 'Executive Intelligence', status: 'ran', executive: executive });

      // --- Layer 6: Learning (persist + the debate already logged a decision)
      layers.push({ layer: 6, name: 'Learning & Evolution', status: 'ran', debateId: deb.debateId, decisionId: deb.decisionId });

      const report = Object.assign(base, {
        status: deb.accepted ? 'accepted' : 'needs_revision',
        accepted: deb.accepted,
        verdict: deb.verdict,
        analysis: analysis,
        recommendation: deb.finalRecommendation,
        confidence: deb.confidence,
        opportunities: analysis.opportunities,
        risks: analysis.risks,
        forecast: analysis.forecast,
        conditions: deb.conditions,
        debateId: deb.debateId,
        decisionId: deb.decisionId,
        executive: executive,
        layers: layers
      });
      await this._persist(report);
      try { if (data().logAgent) data().logAgent('intel_pipeline', team.name + ': ' + report.status + ' (' + (deb.confidence != null ? deb.confidence + '%' : '—') + ')', { reportId: report.id }); } catch (_) {}
      return Object.assign({ ok: true }, report);
    },

    /** Run every team. Returns per-team results (sequential to respect rate limits). */
    async runAll(opts) {
      const D = div();
      if (!D) return { ok: false, error: 'DIVISION_MISSING' };
      const results = [];
      for (const id of D.teamIds()) results.push(await this.runTeam(id, opts));
      return { ok: true, results: results, accepted: results.filter(function (r) { return r.accepted; }).length };
    },

    async _persist(report) {
      try { await data().put('intel_reports', report.id, report); } catch (_) {}
      try { if (data().cloudReady && data().cloudReady() && global.AAA_CLOUD) await global.AAA_CLOUD.upsertEntity('intel_reports', report.id, report); } catch (_) {}
      return report;
    },

    async list() { return data() ? (await data().list('intel_reports')).slice().sort(function (a, b) { return (b.createdAt || 0) - (a.createdAt || 0); }) : []; },
    async latestByTeam() {
      const all = await this.list();
      const map = {};
      all.forEach(function (r) { if (!map[r.teamId]) map[r.teamId] = r; });
      return map;
    }
  };

  global.AAA_INTEL_PIPELINE = Pipeline;
})(typeof window !== 'undefined' ? window : this);
