/*
 * AAA Command Deck — the Executive Mode landing: mission control, not a CRM.
 *
 * Surfaces DECISIONS and MONEY from the real engines: Company Pulse (revenue /
 * pipeline / close rate / AI confidence), the Supervisor Report (top priorities
 * from the Owner Copilot briefing), a live Mission Feed (agent decisions +
 * logs), the Agent Network (the AI org grouped into swarms), and the
 * Opportunity Radar (open quotes ranked by expected value). Every number comes
 * from a real store and every missing engine degrades to an honest empty state
 * ("Warming up", "No open opportunities yet") — nothing is fabricated.
 *
 * renderModel() is a pure, DOM-free read model (testable); mount() renders the
 * mobile screen only when a document exists. Counters tween 0→value via
 * requestAnimationFrame when available; in tests they render the final value.
 */
;(function (global) {
  'use strict';

  function data() { return global.AAA_DATA; }
  function clock() { return global.AAA_RUNTIME_CLOCK; }
  function nowMs() { return clock() && clock().now ? clock().now() : Date.now(); }
  function has(name) { return !!global['AAA_' + name]; }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]); }); }
  function num(v) { const n = Number(v); return isFinite(n) ? n : 0; }
  async function quiet(fn, d) { try { const r = await fn(); return r == null ? d : r; } catch (_) { return d; } }

  // ---- formatting ---------------------------------------------------------
  function fmtMoney(n) { return '$' + Math.round(num(n)).toLocaleString('en-US'); }
  function fmtValue(value, kind) {
    if (value == null) return '—';
    if (kind === 'currency') return fmtMoney(value);
    if (kind === 'percent') return Math.round(num(value)) + '%';
    return String(Math.round(num(value)));
  }
  function toTs(v) {
    if (v == null) return 0;
    if (typeof v === 'number') return isFinite(v) ? v : 0;
    const t = Date.parse(v); return isFinite(t) ? t : 0;
  }
  function hhmm(ts) {
    if (!ts) return '--:--';
    const d = new Date(ts);
    return ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2);
  }

  // priority kind → icon (Supervisor Report rows)
  const KIND_ICON = { incident: '🚨', executive: '🏛', proposal: '🧪', cash: '💵', followup: '📨', council: '🗳', risk: '⚠️', pricing: '🏷' };

  // agent id → swarm (custom agents land in Operations)
  const TEAM_OF = {
    sales: 'Sales', customer_success: 'Sales',
    marketing: 'Marketing',
    operations: 'Operations',
    accounting: 'Finance', kpi: 'Finance',
    data_scientist: 'Intelligence',
    ceo: 'Governance', supervisor: 'Governance', compliance: 'Governance'
  };
  const TEAM_ORDER = ['Sales', 'Marketing', 'Operations', 'Finance', 'Intelligence', 'Governance'];

  const OPEN_STATUSES = ['sent', 'reviewed', 'follow_up_due', 'draft'];
  function serviceKey(q) { const s = Array.isArray(q && q.serviceType) ? q.serviceType.filter(Boolean) : []; return s.length ? s.slice().sort().join(' + ') : null; }

  /** Tween a counter 0→value via rAF; without rAF (tests) just set the final value. */
  function countUp(el, value, kind) {
    const setVal = function (v) { el.textContent = fmtValue(v, kind); };
    if (typeof requestAnimationFrame !== 'function') { setVal(value); return; }
    const dur = 900;
    const start = Date.now();
    function step() {
      const p = Math.min(1, (Date.now() - start) / dur);
      const eased = 1 - Math.pow(1 - p, 3);
      setVal(value * eased);
      if (p < 1) requestAnimationFrame(step);
    }
    requestAnimationFrame(step);
  }

  const Deck = {
    /** Pure render model for the Command Deck — all five sections, no DOM. */
    async renderModel(opts) {
      const o = opts || {};

      // ---- real reads (each null-safe; missing engines fall back honestly) --
      const pnl = await quiet(function () { return has('FINANCIAL_INTELLIGENCE') && global.AAA_FINANCIAL_INTELLIGENCE.pnl ? global.AAA_FINANCIAL_INTELLIGENCE.pnl() : null; }, null);
      const briefing = await quiet(function () { return has('OWNER_COPILOT') && global.AAA_OWNER_COPILOT.briefing ? global.AAA_OWNER_COPILOT.briefing() : null; }, null);
      const attention = await quiet(function () { return has('OWNER_COPILOT') && global.AAA_OWNER_COPILOT.attentionSummary ? global.AAA_OWNER_COPILOT.attentionSummary() : null; }, null);
      const qstats = await quiet(function () { return has('QUOTES') && global.AAA_QUOTES.stats ? global.AAA_QUOTES.stats() : null; }, null);
      const quotes = await quiet(function () { return has('QUOTES') && global.AAA_QUOTES.list ? global.AAA_QUOTES.list() : []; }, []);
      const jobs = await quiet(function () { return data() && data().listJobs ? data().listJobs() : []; }, []);
      const sup = await quiet(function () { return has('SUPERVISOR') && global.AAA_SUPERVISOR.metrics ? global.AAA_SUPERVISOR.metrics() : null; }, null);
      const agg = await quiet(function () { return has('OUTCOME_LEARNING') && global.AAA_OUTCOME_LEARNING.aggregate ? global.AAA_OUTCOME_LEARNING.aggregate() : null; }, null);
      const decisions = await quiet(function () { return data() && data().list ? data().list('agent_decisions') : []; }, []);
      const logs = await quiet(function () { return data() && data().list ? data().list('agent_logs') : []; }, []);

      // ---- 1. Company Pulse -------------------------------------------------
      const activeJobs = (jobs || []).filter(function (j) { const s = String(j.currentState || j.status || '').toUpperCase(); return s !== 'CLOSED' && s !== 'LOST'; }).length;
      const closeRatePct = qstats && qstats.closeRatePct != null ? qstats.closeRatePct
        : (sup && sup.closeRate != null ? Math.round(sup.closeRate * 100) : null);

      // AI confidence: honest "Warming up" until the Supervisor has real samples.
      let aiConfidence = null;
      if (sup && sup.ok && sup.status !== 'warming_up') {
        if (sup.avgCalibration != null) aiConfidence = Math.round(sup.avgCalibration * 100);
        else {
          const scores = Object.keys(sup.perAgent || {}).map(function (a) { return sup.perAgent[a].avgScore; }).filter(function (s) { return typeof s === 'number'; });
          if (scores.length) aiConfidence = Math.round((scores.reduce(function (a, b) { return a + b; }, 0) / scores.length) * 100);
        }
      }
      function tile(id, label, kind, value, note) { return { id: id, label: label, kind: kind, value: value, display: value == null ? (note || '—') : fmtValue(value, kind), note: note || null }; }
      const pulse = {
        tiles: [
          tile('revenue_today', 'Revenue (paid)', 'currency', pnl && pnl.ok ? pnl.revenue : null, pnl ? null : 'No books yet'),
          tile('revenue_month', 'Revenue MTD', 'currency', attention && attention.ok ? attention.revenueThisMonth : null, attention ? null : 'No data yet'),
          tile('pipeline', 'Pipeline', 'currency', qstats ? qstats.pipelineValue : null, qstats ? null : 'No quotes yet'),
          tile('active_jobs', 'Active Jobs', 'count', activeJobs),
          tile('close_rate', 'Close Rate', 'percent', closeRatePct, closeRatePct == null ? 'No outcomes yet' : null),
          tile('ai_confidence', 'AI Confidence', 'percent', aiConfidence, aiConfidence == null ? 'Warming up' : null)
        ]
      };

      // ---- 2. Supervisor Report ----------------------------------------------
      const rawPriorities = (briefing && briefing.ok && Array.isArray(briefing.priorities)) ? briefing.priorities
        : ((attention && Array.isArray(attention.top)) ? attention.top : []);
      const supervisor = {
        status: sup ? (sup.status || 'unknown') : 'unavailable',
        confidencePct: aiConfidence,
        confidenceLabel: aiConfidence == null ? 'Warming up — needs more data' : aiConfidence + '% calibrated',
        headline: briefing && briefing.headline ? briefing.headline : (attention && attention.headline ? attention.headline : null),
        priorities: rawPriorities.slice(0, 5).map(function (p) { return { kind: p.kind || 'item', icon: KIND_ICON[p.kind] || '🛰', label: p.label || '', weight: p.weight != null ? p.weight : null }; }),
        empty: rawPriorities.length === 0,
        emptyLabel: 'All systems healthy.'
      };

      // ---- 3. Mission Feed ----------------------------------------------------
      const feedItems = (decisions || []).map(function (d) {
        return { ts: toTs(d.createdAt || d.ts), actor: actorLabel(d.agent), text: d.recommendation || d.title || d.decision || (d.kind ? d.kind + ' decision' : 'Agent decision'), kind: 'decision' };
      }).concat((logs || []).map(function (l) {
        return { ts: toTs(l.createdAt || l.ts), actor: actorLabel(l.agent), text: l.message || '', kind: 'log' };
      })).filter(function (e) { return e.text; })
        .sort(function (a, b) { return b.ts - a.ts; })
        .slice(0, 8)
        .map(function (e) { return { ts: e.ts, time: hhmm(e.ts), actor: e.actor, text: e.text, kind: e.kind }; });
      const feed = { items: feedItems, empty: feedItems.length === 0, emptyLabel: 'No agent activity yet — the feed fills as the AI team works.' };

      // ---- 4. Agent Network ---------------------------------------------------
      const reg = global.AAA_AGENTS;
      let teams = [], totalAgents = 0;
      if (reg && reg.ids) {
        const ids = reg.ids().concat(reg.customIds ? reg.customIds() : []);
        const byTeam = {};
        ids.forEach(function (id) {
          const a = reg.get ? reg.get(id) : null;
          const team = TEAM_OF[id] || 'Operations';
          const per = sup && sup.perAgent && sup.perAgent[id];
          (byTeam[team] = byTeam[team] || []).push({ id: id, title: a ? a.title : id, confidence: per && per.avgConfidence != null ? per.avgConfidence : null });
        });
        totalAgents = ids.length;
        teams = TEAM_ORDER.filter(function (t) { return byTeam[t]; }).map(function (t) {
          const members = byTeam[t];
          const confs = members.map(function (m) { return m.confidence; }).filter(function (c) { return c != null; });
          return { id: t.toLowerCase(), label: t, count: members.length, agents: members, avgConfidence: confs.length ? Math.round(confs.reduce(function (a, b) { return a + b; }, 0) / confs.length) : null };
        });
      }
      const network = { teams: teams, totalAgents: totalAgents, empty: teams.length === 0, emptyLabel: 'Agent roster not loaded.' };

      // ---- 5. Opportunity Radar -----------------------------------------------
      // Per-quote decision objects from the entity scorer when it's loaded;
      // without it, fall back to the aggregate proxy (segment or company rate).
      const open = (quotes || []).filter(function (q) { return q && OPEN_STATUSES.indexOf(q.status) !== -1; });
      const byQuoteId = {};
      open.forEach(function (q) { byQuoteId[q.quoteId || q.id] = q; });
      const scored = await quiet(function () { return has('OPPORTUNITY_SCORER') && global.AAA_OPPORTUNITY_SCORER.scoreAll ? global.AAA_OPPORTUNITY_SCORER.scoreAll() : null; }, null);
      let oppItems, probabilityNote;
      if (scored && scored.ok && scored.items && scored.items.length) {
        const METHOD_LABEL = { segment_blend: 'this quote’s outcome history (segment blend)', overall_rate: 'company win rate', uninformed_prior: 'an uninformed prior — record outcomes to calibrate' };
        const methods = {};
        oppItems = scored.items.slice(0, 3).map(function (d) {
          const q = byQuoteId[d.quoteId] || {};
          const key = serviceKey(q);
          const label = q.customerName || key || 'Quote';
          const method = (d.basis && d.basis.method) || 'unknown';
          methods[method] = true;
          // A prior is a placeholder, not a measurement — mark it on the card
          // itself so a zero-history quote can never wear a confident "50%".
          const uninformed = method === 'uninformed_prior';
          const probLine = d.probabilityPct == null ? 'close probability unknown'
            : (uninformed ? '≈' + d.probabilityPct + '% — no outcome history yet' : d.probabilityPct + '% close probability');
          return {
            quoteId: d.quoteId, amount: d.amount, customer: q.customerName || null,
            service: key, label: label, status: q.status || null,
            probabilityPct: d.probabilityPct, uninformed: uninformed,
            probabilitySource: METHOD_LABEL[method] || 'outcome history',
            probabilityLine: probLine,
            expectedValue: d.expectedValue,
            action: d.recommendedAction ? d.recommendedAction.label : null,
            urgency: d.urgency || null, scoreConfidence: d.confidence || null,
            display: fmtMoney(d.amount) + ' — ' + label + ' — ' + probLine
          };
        });
        // Footnote covers every method on screen, not just the top item's.
        const noteParts = [];
        if (methods.segment_blend) noteParts.push('per-quote outcome history (segment blend)');
        if (methods.overall_rate) noteParts.push('company win rate');
        probabilityNote = noteParts.length ? 'Probability from ' + noteParts.join(' and ') + '.' : null;
        if (methods.uninformed_prior) probabilityNote = (probabilityNote ? probabilityNote + ' ' : '') + '≈ marks quotes with no outcome history yet — record outcomes to calibrate.';
        const radar = { items: oppItems, empty: false, emptyLabel: 'No open opportunities yet.', probabilityNote: probabilityNote };
        return this._assembleModel(pulse, supervisor, feed, network, radar);
      }
      const overallWin = agg && agg.ok && agg.overall && agg.overall.winRate != null ? Math.round(agg.overall.winRate * 100) : null;
      oppItems = open.map(function (q) {
        const amount = num(q.customerTotal);
        const key = serviceKey(q);
        let prob = null, source = null;
        const svc = key && agg && agg.ok ? (agg.byServiceType || []).filter(function (g) { return g.key === key && g.count >= 1 && g.winRate != null; })[0] : null;
        if (svc) { prob = Math.round(svc.winRate * 100); source = 'win history for ' + key; }
        else if (overallWin != null) { prob = overallWin; source = 'company win rate'; }
        else if (qstats && qstats.closeRatePct != null) { prob = qstats.closeRatePct; source = 'company close rate'; }
        return {
          quoteId: q.quoteId || q.id, amount: amount, customer: q.customerName || null,
          service: key, label: q.customerName || key || 'Quote', status: q.status,
          probabilityPct: prob, probabilitySource: source,
          expectedValue: prob != null ? Math.round(amount * prob / 100) : amount,
          display: fmtMoney(amount) + ' — ' + (q.customerName || key || 'Quote') + ' — ' + (prob != null ? prob + '% close probability' : 'close probability unknown')
        };
      }).sort(function (a, b) { return b.expectedValue - a.expectedValue; }).slice(0, 3);
      const radar = { items: oppItems, empty: oppItems.length === 0, emptyLabel: 'No open opportunities yet.', probabilityNote: oppItems.length && oppItems[0].probabilitySource ? 'Probability from ' + oppItems[0].probabilitySource + '.' : null };
      return this._assembleModel(pulse, supervisor, feed, network, radar);
    },

    /** Assemble the five sections into the deck model. */
    _assembleModel(pulse, supervisor, feed, network, radar) {
      return { generatedAt: nowMs(), pulse: pulse, supervisor: supervisor, feed: feed, network: network, radar: radar };
    },

    /** Open the Agent Command drill-down for a swarm in a bottom sheet. */
    openTeam(teamId) {
      if (typeof document === 'undefined') return { opened: false, reason: 'no_dom' };
      const ac = global.AAA_AGENT_COMMAND, kit = global.AAA_UI;
      if (ac && ac.mount && kit && kit.sheet) {
        const s = kit.sheet({ title: 'Agent Command' });
        document.body.appendChild(s.overlay);
        ac.mount(s.body, { teamId: teamId, onClose: s.close });
        return { opened: true, via: 'sheet' };
      }
      if (global.AAA_JOB_LIST_UI && global.AAA_JOB_LIST_UI._switchTab) { global.AAA_JOB_LIST_UI._switchTab('agents'); return { opened: true, via: 'agents_tab' }; }
      return { opened: false, reason: 'no_target' };
    },

    /**
     * Run a Supervisor Report priority. For a follow-up, build a governed
     * Decision Card (DRY-RUN — Approve runs the safety gate + audit log but
     * sends nothing) when the Decision Inbox is loaded and its flag is on.
     * Every other kind, a disabled flag, or any build/validate miss → the
     * existing chat route, so behavior never regresses.
     */
    async executePriority(kind) {
      const inbox = global.AAA_DECISION_INBOX, card = global.AAA_DECISION_CARD;
      if (kind === 'followup' && inbox && inbox.FLAGS && inbox.FLAGS.cardsEnabled && card && card.open && typeof document !== 'undefined') {
        try {
          const r = await inbox.buildFollowUpDecision({});
          if (r && r.ok && inbox.validateDecisionSchema(r.card).valid && card.open(r.card, {}).opened) return { routed: true, via: 'decision_card' };
        } catch (_) { /* fall through to chat */ }
      }
      if (global.AAA_JOB_LIST_UI && global.AAA_JOB_LIST_UI._switchTab) { global.AAA_JOB_LIST_UI._switchTab('chat'); return { routed: true, via: 'chat' }; }
      return { routed: false };
    },

    /** Open the Digital Twin living-model surface in a bottom sheet. */
    openTwin() {
      if (typeof document === 'undefined') return { opened: false, reason: 'no_dom' };
      const twin = global.AAA_DIGITAL_TWIN_UI, kit = global.AAA_UI;
      if (twin && typeof twin.mount === 'function' && kit && kit.sheet) {
        const s = kit.sheet({ title: 'Digital Twin' });
        document.body.appendChild(s.overlay);
        twin.mount(s.body);
        return { opened: true, via: 'sheet' };
      }
      return { opened: false, reason: 'no_target' };
    },

    /** Render the Command Deck into a DOM element (DOM-guarded). */
    async mount(el, opts) {
      if (typeof document === 'undefined') return { mounted: false, reason: 'no_dom' };
      const root = el || document.body;
      const m = await this.renderModel(opts);
      const wrap = document.createElement('div'); wrap.className = 'cd-root';

      const maxTeam = m.network.teams.reduce(function (mx, t) { return Math.max(mx, t.count); }, 1);
      wrap.innerHTML =
        // gradient status header
        '<div class="cd-hero">' +
          '<div class="cd-hero__title">COMMAND DECK</div>' +
          '<div class="cd-hero__sub">' + esc(m.supervisor.headline || 'Live company telemetry') + '</div>' +
        '</div>' +
        // 1. Company Pulse
        '<h3 class="cd-sec">Company Pulse</h3>' +
        '<div class="cd-pulse">' + m.pulse.tiles.map(function (t) {
          return '<div class="cd-tile" data-tile="' + esc(t.id) + '">' +
            '<div class="cd-tile__label">' + esc(t.label) + '</div>' +
            '<div class="cd-tile__value' + (t.value == null ? ' cd-tile__value--dim' : '') + '"' +
              (t.value != null ? ' data-count="' + esc(t.value) + '" data-kind="' + esc(t.kind) + '"' : '') + '>' +
              esc(t.display) + '</div>' +
            '</div>';
        }).join('') + '</div>' +
        // 2. Supervisor Report
        '<h3 class="cd-sec">Supervisor Report</h3>' +
        '<div class="cd-panel">' +
          '<div class="cd-conf"><span class="cd-conf__dot"></span>AI confidence: ' + esc(m.supervisor.confidenceLabel) + '</div>' +
          (m.supervisor.empty
            ? '<div class="cd-empty">' + esc(m.supervisor.emptyLabel) + '</div>'
            : m.supervisor.priorities.map(function (p) {
                return '<div class="cd-rec"><span class="cd-rec__icon">' + esc(p.icon) + '</span>' +
                  '<span class="cd-rec__label">' + esc(p.label) + '</span>' +
                  '<button class="cd-rec__exec" type="button" data-exec data-kind="' + esc(p.kind || '') + '" aria-label="Execute">▶</button></div>';
              }).join('')) +
        '</div>' +
        // 3. Mission Feed
        '<h3 class="cd-sec">Mission Feed</h3>' +
        '<div class="cd-feed">' +
          (m.feed.empty
            ? '<div class="cd-empty">' + esc(m.feed.emptyLabel) + '</div>'
            : m.feed.items.map(function (e) {
                return '<div class="cd-evt"><span class="cd-evt__dot"></span>' +
                  '<span class="cd-evt__time">' + esc(e.time) + '</span>' +
                  '<span class="cd-evt__actor">' + esc(e.actor) + '</span>' +
                  '<span class="cd-evt__text">' + esc(e.text) + '</span></div>';
              }).join('')) +
        '</div>' +
        // 4. Agent Network
        '<h3 class="cd-sec">Agent Network</h3>' +
        '<div class="cd-swarms">' +
          (m.network.empty
            ? '<div class="cd-empty">' + esc(m.network.emptyLabel) + '</div>'
            : m.network.teams.map(function (t) {
                return '<button class="cd-swarm" type="button" data-team="' + esc(t.id) + '">' +
                  '<span class="cd-swarm__label">' + esc(t.label) + '</span>' +
                  '<span class="cd-swarm__bar"><span class="cd-swarm__fill" style="width:' + Math.round((t.count / maxTeam) * 100) + '%"></span></span>' +
                  '<span class="cd-swarm__count">' + esc(t.count) + (t.avgConfidence != null ? ' · ' + esc(t.avgConfidence) + '%' : '') + '</span>' +
                  '</button>';
              }).join('')) +
        '</div>' +
        // 5. Opportunity Radar
        '<h3 class="cd-sec">Opportunity Radar</h3>' +
        '<div class="cd-opps">' +
          (m.radar.empty
            ? '<div class="cd-empty">' + esc(m.radar.emptyLabel) + '</div>'
            : m.radar.items.map(function (i) {
                return '<div class="cd-opp" data-quote="' + esc(i.quoteId) + '">' +
                  '<div class="cd-opp__amount">' + esc(fmtMoney(i.amount)) + '</div>' +
                  '<div class="cd-opp__who">' + esc(i.label) + '</div>' +
                  '<div class="cd-opp__prob">' + esc(i.probabilityLine || (i.probabilityPct != null ? i.probabilityPct + '% close probability' : 'close probability unknown')) + '</div>' +
                  (i.action ? '<div class="cd-opp__action">' + (i.urgency === 'now' ? '🔥 ' : '') + esc(i.action) + '</div>' : '') +
                  '</div>';
              }).join('') + (m.radar.probabilityNote ? '<div class="cd-note">' + esc(m.radar.probabilityNote) + '</div>' : '')) +
        '</div>';

      // animated counters (final values already rendered; tween when rAF exists)
      wrap.querySelectorAll('.cd-tile__value[data-count]').forEach(function (v) {
        const raw = Number(v.getAttribute('data-count'));
        if (isFinite(raw)) countUp(v, raw, v.getAttribute('data-kind'));
      });
      // Execute → for a follow-up priority, build a governed Decision Card
      // (dry-run; nothing is sent) when the inbox is loaded and the flag is on;
      // anything else, or any failure, falls back to the existing chat route.
      wrap.querySelectorAll('.cd-rec__exec').forEach(function (b) {
        b.onclick = function () { Deck.executePriority(b.getAttribute('data-kind')); };
      });
      wrap.querySelectorAll('.cd-swarm').forEach(function (b) {
        b.onclick = function () { Deck.openTeam(b.getAttribute('data-team')); };
      });
      // Digital Twin entry — only when the living-model surface is loaded
      // (business-digital-twin-ui's planner sheet alone has no mount()).
      if (global.AAA_DIGITAL_TWIN_UI && typeof global.AAA_DIGITAL_TWIN_UI.mount === 'function' && global.AAA_UI && global.AAA_UI.sheet) {
        const tw = document.createElement('button');
        tw.className = 'cd-twin'; tw.type = 'button';
        tw.textContent = '🧬 Digital Twin — live model & forecast';
        tw.onclick = function () { Deck.openTwin(); };
        wrap.appendChild(tw);
      }

      root.appendChild(wrap);
      return { mounted: true };
    }
  };

  function actorLabel(agent) {
    if (!agent) return 'System';
    const reg = global.AAA_AGENTS;
    const rec = reg && reg.get ? reg.get(agent) : null;
    if (rec && rec.title) return rec.title;
    const s = String(agent);
    return s.charAt(0).toUpperCase() + s.slice(1);
  }

  global.AAA_COMMAND_DECK = Deck;
})(typeof window !== 'undefined' ? window : this);
