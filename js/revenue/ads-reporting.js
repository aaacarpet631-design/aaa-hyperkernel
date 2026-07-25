/*
 * AAA Ads Reporting — the read-only join between ad spend context and business
 * truth: attribution (which click) × conversion ladder (what happened) × Lead
 * OS (pipeline stage, won/lost revenue) × Quote Store (gross margin on WON
 * quotes, joined via quote.leadId → attribution campaign — the click → margin
 * loop). Margin coverage is explicit: `marginKnownWon` counts the won jobs
 * whose margin is actually knowable through that join.
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
  function quotes() { return global.AAA_QUOTES; }
  function num(v) { const n = Number(v); return isFinite(n) ? n : 0; }
  function round2(n) { return Math.round(n * 100) / 100; }
  function fin(v) { if (v == null) return null; const n = Number(v); return isFinite(n) ? n : null; }

  /**
   * Gross margin of a WON quote — honest or null. Prefer recomputing from
   * finalPrice minus internal cost (actual jobCost when recorded, else the
   * drafted internalCost.total); fall back to the stored grossMargin. Never
   * invented: when neither side is knowable the answer is null.
   */
  function wonMargin(q) {
    const finalPrice = fin(q.finalPrice);
    const cost = q.jobCost != null ? fin(q.jobCost) : fin(q.internalCost && q.internalCost.total);
    if (finalPrice != null && cost != null) return round2(finalPrice - cost);
    return fin(q.grossMargin) != null ? round2(fin(q.grossMargin)) : null;
  }

  const LADDER_COLUMNS = {
    LEAD_CREATED: 'leads', QUALIFIED_LEAD: 'qualified', ESTIMATE_SCHEDULED: 'estimatesScheduled',
    ESTIMATE_SENT: 'estimatesSent', JOB_WON: 'won', JOB_COMPLETED: 'completed',
    HIGH_MARGIN_JOB: 'highMargin', BAD_LEAD: 'badLeads', REFUND: 'refunds', COMPLAINT: 'complaints'
  };

  function emptyRow(key) {
    return { campaign: key, leads: 0, qualified: 0, estimatesScheduled: 0, estimatesSent: 0,
      won: 0, completed: 0, highMargin: 0, badLeads: 0, refunds: 0, complaints: 0,
      revenueUSD: 0, grossMarginUSD: 0, marginKnownWon: 0, spendUSD: null,
      costPerWonJob: null, revenuePerAdDollar: null, marginPerAdDollar: null,
      costPerMarginDollar: null, closeRatePct: null };
  }

  const Reporting = {
    /**
     * Campaign scorecard: one row per campaign (unattributed leads roll into
     * '(unattributed)'), ladder counts + revenue truth + gross margin joined
     * from WON quotes via quote.leadId (grossMarginUSD / marginKnownWon).
     * opts.spendByCampaign { [campaign]: USD } unlocks costPerWonJob /
     * revenuePerAdDollar / marginPerAdDollar / costPerMarginDollar.
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

      // Ladder counts + event-carried value. Only REVENUE-carrying primary
      // signals sum into revenueUSD: HIGH_MARGIN_JOB's valueUSD is a DERIVED
      // margin on the same dollars as JOB_COMPLETED — counting it as revenue
      // would inflate every high-margin job by its margin.
      (await conv.list()).forEach(function (e) {
        const r = row(leadCampaign[e.leadId] || '(unattributed)');
        const col = LADDER_COLUMNS[e.type];
        if (col) r[col]++;
        if (e.primarySignal && e.valueUSD != null && e.type !== 'HIGH_MARGIN_JOB') r.revenueUSD += num(e.valueUSD);
      });

      // Lead OS outcomes: WON revenue recorded on the lead itself (when the
      // conversion event didn't carry a value). Never double-count: only add
      // when no primary event carried value for that lead.
      const valuedLeads = {};
      (await conv.list({ primaryOnly: true })).forEach(function (e) {
        // HIGH_MARGIN_JOB carries margin, not revenue — it must not suppress
        // the lead-outcome revenue join for a lead with no revenue event.
        if (e.valueUSD != null && e.type !== 'HIGH_MARGIN_JOB') valuedLeads[e.leadId] = true;
      });
      if (leadsOS() && leadsOS().listLeads) {
        (await leadsOS().listLeads()).forEach(function (l) {
          if (l && l.outcome && l.outcome.result === 'WON' && l.outcome.revenue != null && !valuedLeads[l.leadId]) {
            row(leadCampaign[l.leadId] || '(unattributed)').revenueUSD += num(l.outcome.revenue);
          }
        });
      }

      // Margin join: WON quotes carrying a leadId reveal TRUE gross margin per
      // campaign. Margin is recomputed from finalPrice minus internal cost
      // (jobCost when recorded, else the drafted internalCost.total); the stored
      // grossMargin is the fallback. Quotes without a leadId contribute nothing —
      // `marginKnownWon` makes that coverage gap visible instead of hiding it.
      if (quotes() && quotes().list) {
        (await quotes().list()).forEach(function (q) {
          if (!q || q.status !== 'won' || !q.leadId) return;
          const m = wonMargin(q);
          if (m == null) return;
          const r = row(leadCampaign[q.leadId] || '(unattributed)');
          r.grossMarginUSD += m;
          r.marginKnownWon++;
        });
      }

      const spend = o.spendByCampaign || null;
      const out = Object.keys(rows).map(function (k) {
        const r = rows[k];
        r.revenueUSD = round2(r.revenueUSD);
        r.grossMarginUSD = round2(r.grossMarginUSD);
        const s = spend && spend[k] != null ? num(spend[k]) : null;
        r.spendUSD = s;
        r.costPerWonJob = (s != null && r.won > 0) ? round2(s / r.won) : null;
        r.revenuePerAdDollar = (s != null && s > 0) ? round2(r.revenueUSD / s) : null;
        // Margin-adjusted north stars — only when BOTH sides are known (spend
        // supplied AND at least one won job's margin is visible via the join).
        r.marginPerAdDollar = (s != null && s > 0 && r.marginKnownWon > 0) ? round2(r.grossMarginUSD / s) : null;
        r.costPerMarginDollar = (s != null && r.grossMarginUSD > 0) ? round2(s / r.grossMarginUSD) : null;
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
