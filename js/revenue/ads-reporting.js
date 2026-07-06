/*
 * AAA Ads Reporting — the read-only join between ad spend context and business
 * truth: attribution (which click) × conversion ladder (what happened) × Lead
 * OS (pipeline stage, won/lost revenue).
 *
 * READ-ONLY BY CONSTRUCTION: this module holds no collection of its own and
 * never calls put() — it can be pointed at production data with zero risk.
 *
 * PII-MINIMAL: every row is keyed by campaign / channel / service line. Names,
 * phones and addresses never enter a scorecard; leads appear as counts, gap
 * rows carry ids only.
 *
 * HONEST: raw leads are never presented as won jobs — the scorecard separates
 * the ladder (leads / qualified / estimates / won / completed) column by
 * column, and revenue comes only from primary-signal events and recorded
 * WON outcomes. Spend is never invented: pass spendByCampaign to get CPA/ROAS,
 * otherwise those cells are null.
 */
;(function (global) {
  'use strict';

  function data() { return global.AAA_DATA; }
  function attribution() { return global.AAA_AD_ATTRIBUTION; }
  function conversions() { return global.AAA_ADS_CONVERSIONS; }
  function leadsOS() { return global.AAA_LEADS; }
  function num(v) { const n = Number(v); return isFinite(n) ? n : 0; }
  function round2(n) { return Math.round(n * 100) / 100; }

  const LADDER_COLUMNS = {
    LEAD_CREATED: 'leads', QUALIFIED_LEAD: 'qualified', ESTIMATE_SCHEDULED: 'estimatesScheduled',
    ESTIMATE_SENT: 'estimatesSent', JOB_WON: 'won', JOB_COMPLETED: 'completed',
    HIGH_MARGIN_JOB: 'highMargin', BAD_LEAD: 'badLeads', REFUND: 'refunds', COMPLAINT: 'complaints'
  };

  function emptyRow(key) {
    return { campaign: key, leads: 0, qualified: 0, estimatesScheduled: 0, estimatesSent: 0,
      won: 0, completed: 0, highMargin: 0, badLeads: 0, refunds: 0, complaints: 0,
      revenueUSD: 0, spendUSD: null, costPerWonJob: null, revenuePerAdDollar: null, closeRatePct: null };
  }

  const Reporting = {
    /**
     * Campaign scorecard: one row per campaign (unattributed leads roll into
     * '(unattributed)'), ladder counts + revenue truth. opts.spendByCampaign
     * { [campaign]: USD } unlocks costPerWonJob / revenuePerAdDollar.
     */
    async campaignScorecard(opts) {
      const o = opts || {};
      const attr = attribution();
      const conv = conversions();
      if (!data()) return { ok: false, error: 'NO_STORE' };
      if (!attr || !conv) return { ok: false, error: 'MISSING_MODULES' };

      // leadId → campaign key
      const leadCampaign = {};
      (await attr.list()).forEach(function (a) {
        leadCampaign[a.leadId] = a.campaign || '(unattributed)';
      });

      const rows = {};
      function row(key) { return rows[key] || (rows[key] = emptyRow(key)); }

      // Ladder counts + event-carried value (primary signals only count as revenue).
      (await conv.list()).forEach(function (e) {
        const r = row(leadCampaign[e.leadId] || '(unattributed)');
        const col = LADDER_COLUMNS[e.type];
        if (col) r[col]++;
        if (e.primarySignal && e.valueUSD != null) r.revenueUSD += num(e.valueUSD);
      });

      // Lead OS outcomes: WON revenue recorded on the lead itself (when the
      // conversion event didn't carry a value). Never double-count: only add
      // when no primary event carried value for that lead.
      const valuedLeads = {};
      (await conv.list({ primaryOnly: true })).forEach(function (e) {
        if (e.valueUSD != null) valuedLeads[e.leadId] = true;
      });
      if (leadsOS() && leadsOS().listLeads) {
        (await leadsOS().listLeads()).forEach(function (l) {
          if (l && l.outcome && l.outcome.result === 'WON' && l.outcome.revenue != null && !valuedLeads[l.leadId]) {
            row(leadCampaign[l.leadId] || '(unattributed)').revenueUSD += num(l.outcome.revenue);
          }
        });
      }

      const spend = o.spendByCampaign || null;
      const out = Object.keys(rows).map(function (k) {
        const r = rows[k];
        r.revenueUSD = round2(r.revenueUSD);
        const s = spend && spend[k] != null ? num(spend[k]) : null;
        r.spendUSD = s;
        r.costPerWonJob = (s != null && r.won > 0) ? round2(s / r.won) : null;
        r.revenuePerAdDollar = (s != null && s > 0) ? round2(r.revenueUSD / s) : null;
        r.closeRatePct = r.estimatesSent > 0 ? Math.round((r.won / r.estimatesSent) * 100) : null;
        return r;
      });
      out.sort(function (a, b) { return b.revenueUSD - a.revenueUSD; });
      return { ok: true, rows: out };
    },

    /**
     * Measurement diagnostics: is the foundation trustworthy yet?
     * Surfaces paid leads with no attribution, attributed leads with no
     * consent state, and conversion events that cannot be uploaded (and why).
     */
    async diagnostics() {
      const attr = attribution();
      const conv = conversions();
      if (!attr || !conv) return { ok: false, error: 'MISSING_MODULES' };
      const missing = leadsOS() && leadsOS().missingAttribution ? await leadsOS().missingAttribution() : [];
      const attrs = await attr.list();
      const consentUnknown = attrs.filter(function (a) { return a.consent !== 'granted' && a.consent !== 'denied'; })
        .map(function (a) { return a.leadId; });
      const queue = await conv.uploadQueue();
      return {
        ok: true,
        attributedLeads: attrs.length,
        missingAttribution: missing,
        consentUnknownLeadIds: consentUnknown,
        uploadable: queue.payloads.length,
        blockedUploads: queue.skipped
      };
    },

    /**
     * Owner brief: the scorecard as plain sentences. No PII, no invented
     * numbers — cells we don't know stay "unknown".
     */
    async ownerBrief(opts) {
      const sc = await this.campaignScorecard(opts);
      if (!sc.ok) return { ok: false, error: sc.error };
      const lines = sc.rows.map(function (r) {
        const spendTxt = r.spendUSD != null ? ('$' + r.spendUSD + ' spend') : 'spend unknown';
        return r.campaign + ': ' + r.leads + ' leads → ' + r.qualified + ' qualified → ' +
          r.estimatesSent + ' estimates → ' + r.won + ' won ($' + r.revenueUSD + ' revenue, ' + spendTxt + ')' +
          (r.badLeads + r.refunds + r.complaints > 0 ? ' — ' + (r.badLeads + r.refunds + r.complaints) + ' negative signal(s)' : '');
      });
      const diag = await this.diagnostics();
      if (diag.ok && diag.missingAttribution.length) {
        lines.push('MEASUREMENT GAP: ' + diag.missingAttribution.length + ' paid lead(s) with no attribution record.');
      }
      return { ok: true, lines: lines };
    }
  };

  global.AAA_ADS_REPORTING = Reporting;
})(typeof window !== 'undefined' ? window : this);
