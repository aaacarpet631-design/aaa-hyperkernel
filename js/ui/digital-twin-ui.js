/*
 * AAA Digital Twin Surface — Phase 4 mission-control "living model" screen.
 *
 * A live virtual model of the business: CURRENT STATE (customers, active
 * leads, open estimates, scheduled jobs, crews, paid revenue), the PIPELINE
 * FLOW funnel (Leads → Estimates → Jobs → Completed, real counts only), the
 * FORWARD LOOK (the twin engine's baseline run-rate — monthly revenue /
 * profit / jobs modeled by AAA_DIGITAL_TWIN.baseline() from recorded
 * outcomes, with its basis stated), and a MODEL HEALTH badge derived from
 * real data coverage.
 *
 * Honesty contract (same as the Command Deck): every number comes from a real
 * store or the real twin engine; any missing store degrades to an honest
 * empty state; the forward look is shown ONLY when the engine has recorded
 * history to model from — nothing is invented, and renderModel never throws.
 *
 * This screen complements js/ui/business-digital-twin-ui.js (the owner-only
 * scenario-planning sheet: levers, simulations, assumptions). That module
 * also publishes AAA_DIGITAL_TWIN_UI, so we MERGE into the existing object —
 * load this file AFTER business-digital-twin-ui.js and both surfaces coexist:
 * { render, renderResult, open } (planner) + { renderModel, mount } (this).
 *
 * renderModel() is a pure, DOM-free read model (testable); mount() renders
 * the mobile glass screen only when a document exists.
 */
;(function (global) {
  'use strict';

  function data() { return global.AAA_DATA; }
  function has(name) { return !!global['AAA_' + name]; }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]); }); }
  function num(v) { const n = Number(v); return isFinite(n) ? n : 0; }
  async function quiet(fn, d) { try { const r = await fn(); return r == null ? d : r; } catch (_) { return d; } }
  function fmtMoney(n) { return '$' + Math.round(num(n)).toLocaleString('en-US'); }

  const OPEN_QUOTE_STATUSES = ['draft', 'reviewed', 'sent', 'follow_up_due'];
  const DONE_JOB_STATES = ['CLOSED', 'COMPLETED'];
  function jobState(j) { return String((j && (j.currentState || j.status)) || '').toUpperCase(); }
  function leadActive(l) { return l && l.stage !== 'WON' && l.stage !== 'LOST'; }

  const Surface = {
    /** Pure render model — current state, forward look, flows, health. No DOM. */
    async renderModel(opts) {
      // ---- real reads (each null-safe; a missing store yields null, never a fake 0)
      const customers = await quiet(function () {
        if (data() && data().listCustomers) return data().listCustomers();
        if (has('CUSTOMER_STORE') && global.AAA_CUSTOMER_STORE.list) return global.AAA_CUSTOMER_STORE.list();
        return null;
      }, null);
      const leads = await quiet(function () { return has('LEADS') && global.AAA_LEADS.listLeads ? global.AAA_LEADS.listLeads() : null; }, null);
      const qstats = await quiet(function () { return has('QUOTES') && global.AAA_QUOTES.stats ? global.AAA_QUOTES.stats() : null; }, null);
      const rawQuotes = await quiet(function () { return qstats ? null : (data() && data().list ? data().list('quotes') : null); }, null);
      const jobs = await quiet(function () { return data() && data().listJobs ? data().listJobs() : null; }, null);
      const crew = await quiet(function () { return has('CREW_STORE') && global.AAA_CREW_STORE.list ? global.AAA_CREW_STORE.list() : null; }, null);
      const pnl = await quiet(function () { return has('FINANCIAL_INTELLIGENCE') && global.AAA_FINANCIAL_INTELLIGENCE.pnl ? global.AAA_FINANCIAL_INTELLIGENCE.pnl() : null; }, null);
      // The twin engine's current-state model (real API: AAA_DIGITAL_TWIN.baseline()).
      const twinPresent = has('DIGITAL_TWIN') && typeof global.AAA_DIGITAL_TWIN.baseline === 'function';
      const base = await quiet(function () { return twinPresent ? global.AAA_DIGITAL_TWIN.baseline() : null; }, null);

      // ---- counts (null = source unavailable, shown as an honest dash) ----
      const customersN = customers ? customers.length : null;
      const activeLeadsN = leads ? leads.filter(leadActive).length : null;
      let openEstimatesN = null;
      if (qstats && qstats.counts) {
        const c = qstats.counts;
        openEstimatesN = num(c.draft) + num(c.reviewed) + num(c.sent) + num(c.follow_up_due);
      } else if (rawQuotes) {
        openEstimatesN = rawQuotes.filter(function (q) { return q && OPEN_QUOTE_STATUSES.indexOf(q.status) !== -1; }).length;
      }
      const scheduledN = jobs ? jobs.filter(function (j) { return jobState(j) === 'SCHEDULED'; }).length : null;
      const crewsN = crew ? crew.length : null;
      const revenue = pnl && pnl.ok && pnl.revenue != null ? pnl.revenue : null;

      function tile(id, label, value, money) {
        return { id: id, label: label, value: value, display: value == null ? '—' : (money ? fmtMoney(value) : String(value)) };
      }
      const current = {
        tiles: [
          tile('customers', 'Customers', customersN),
          tile('active_leads', 'Active Leads', activeLeadsN),
          tile('open_estimates', 'Open Estimates', openEstimatesN),
          tile('jobs_scheduled', 'Jobs Scheduled', scheduledN),
          tile('crews', 'Crews', crewsN),
          tile('revenue', 'Revenue (paid)', revenue, true)
        ]
      };

      // ---- forward look: ONLY what the twin engine actually computed ------
      // AAA_DIGITAL_TWIN.baseline() models monthly run-rate (monthlyRevenue /
      // monthlyProfit / monthlyWins) from `sample` resolved quotes over
      // `months` of history. With sample=0 its numbers are built-in defaults,
      // not a computation from this business — so we refuse to show them.
      let forecast;
      if (!twinPresent || !base) {
        forecast = { items: [], emptyLabel: 'Digital twin engine not loaded — no forward look available.' };
      } else if (!num(base.sample)) {
        forecast = { items: [], emptyLabel: 'Forecast needs more recorded history — win or lose a few quotes first.' };
      } else {
        const basis = 'Run-rate modeled from ' + base.sample + ' resolved quote' + (base.sample === 1 ? '' : 's') +
          ' over ' + base.months + ' month' + (base.months === 1 ? '' : 's') + ' of history.';
        forecast = {
          items: [
            { id: 'revenue_mo', label: 'Revenue / mo', value: base.monthlyRevenue, display: fmtMoney(base.monthlyRevenue), basis: basis },
            { id: 'profit_mo', label: 'Profit / mo', value: base.monthlyProfit, display: fmtMoney(base.monthlyProfit), basis: basis },
            { id: 'jobs_mo', label: 'Jobs / mo', value: base.monthlyWins, display: String(base.monthlyWins), basis: basis }
          ],
          emptyLabel: null
        };
      }

      // ---- pipeline flow funnel: Leads → Estimates → Jobs → Completed ------
      const leadsTotal = leads ? leads.length : 0;
      const estimatesTotal = qstats ? num(qstats.total) : (rawQuotes ? rawQuotes.length : 0);
      const jobsTotal = jobs ? jobs.length : 0;
      const completedTotal = jobs ? jobs.filter(function (j) { return DONE_JOB_STATES.indexOf(jobState(j)) !== -1; }).length : 0;
      const stages = [
        { id: 'leads', label: 'Leads', count: leadsTotal },
        { id: 'estimates', label: 'Estimates', count: estimatesTotal },
        { id: 'jobs', label: 'Jobs', count: jobsTotal },
        { id: 'completed', label: 'Completed', count: completedTotal }
      ];
      const flows = {
        stages: stages,
        emptyLabel: stages.some(function (s) { return s.count > 0; }) ? null : 'No pipeline activity recorded yet.'
      };

      // ---- model health: honest data coverage, never a vibe -----------------
      const sources = [customersN, activeLeadsN, openEstimatesN, scheduledN, crewsN, revenue];
      const live = sources.filter(function (v) { return v != null; }).length;
      const histOk = base != null && num(base.sample) >= 5;
      let health;
      if (live === 0) health = { label: 'No data sources connected yet.', tone: 'unknown' };
      else if (histOk && live >= 4) health = { label: 'Live model — ' + live + ' of ' + sources.length + ' data sources reporting.', tone: 'good' };
      else if (live < 4) health = { label: 'Partial coverage — ' + live + ' of ' + sources.length + ' data sources reporting.', tone: 'warn' };
      else health = { label: 'Stores connected — forecast needs more recorded outcomes.', tone: 'warn' };

      return { current: current, forecast: forecast, flows: flows, health: health };
    },

    /** Render the Digital Twin screen into a DOM element (DOM-guarded). */
    async mount(el, opts) {
      if (typeof document === 'undefined') return { mounted: false, reason: 'no_dom' };
      const root = el || document.body;
      const m = await this.renderModel(opts);
      const wrap = document.createElement('div'); wrap.className = 'dt-root';

      const maxFlow = m.flows.stages.reduce(function (mx, s) { return Math.max(mx, s.count); }, 1);
      const basisLines = m.forecast.items
        .map(function (i) { return i.basis; })
        .filter(function (b, idx, arr) { return b && arr.indexOf(b) === idx; });

      wrap.innerHTML =
        // hero + health badge
        '<div class="dt-hero">' +
          '<div class="dt-hero__title">DIGITAL TWIN</div>' +
          '<div class="dt-hero__sub">Live model of the business — current state + forward look</div>' +
          '<div class="dt-health dt-health--' + esc(m.health.tone) + '"><span class="dt-health__dot"></span>' + esc(m.health.label) + '</div>' +
        '</div>' +
        // current state tiles
        '<h3 class="dt-sec">Current State</h3>' +
        '<div class="dt-tiles">' + m.current.tiles.map(function (t) {
          return '<div class="dt-tile" data-tile="' + esc(t.id) + '">' +
            '<div class="dt-tile__label">' + esc(t.label) + '</div>' +
            '<div class="dt-tile__value' + (t.value == null ? ' dt-tile__value--dim' : '') + '">' + esc(t.display) + '</div>' +
            '</div>';
        }).join('') + '</div>' +
        // pipeline flow funnel
        '<h3 class="dt-sec">Pipeline Flow</h3>' +
        '<div class="dt-funnel">' +
          (m.flows.emptyLabel
            ? '<div class="dt-empty">' + esc(m.flows.emptyLabel) + '</div>'
            : m.flows.stages.map(function (s) {
                const pct = Math.max(s.count > 0 ? 4 : 0, Math.round((s.count / maxFlow) * 100));
                return '<div class="dt-flow" data-stage="' + esc(s.id) + '">' +
                  '<span class="dt-flow__label">' + esc(s.label) + '</span>' +
                  '<span class="dt-flow__bar"><span class="dt-flow__fill" style="width:' + pct + '%"></span></span>' +
                  '<span class="dt-flow__count">' + esc(s.count) + '</span>' +
                  '</div>';
              }).join('')) +
        '</div>' +
        // forward look
        '<h3 class="dt-sec">Forward Look</h3>' +
        '<div class="dt-forecast">' +
          (m.forecast.emptyLabel
            ? '<div class="dt-empty">' + esc(m.forecast.emptyLabel) + '</div>'
            : m.forecast.items.map(function (i) {
                return '<div class="dt-fc" data-fc="' + esc(i.id) + '">' +
                  '<span class="dt-fc__label">' + esc(i.label) + '</span>' +
                  '<span class="dt-fc__value">' + esc(i.display) + '</span>' +
                  '</div>';
              }).join('') +
              basisLines.map(function (b) { return '<div class="dt-basis">' + esc(b) + '</div>'; }).join('')) +
        '</div>';

      root.appendChild(wrap);
      return { mounted: true };
    }
  };

  // Merge: js/ui/business-digital-twin-ui.js (scenario planner) also publishes
  // AAA_DIGITAL_TWIN_UI; load this file after it so both API surfaces coexist.
  global.AAA_DIGITAL_TWIN_UI = Object.assign(global.AAA_DIGITAL_TWIN_UI || {}, {
    renderModel: Surface.renderModel.bind(Surface),
    mount: Surface.mount.bind(Surface)
  });
})(typeof window !== 'undefined' ? window : this);
