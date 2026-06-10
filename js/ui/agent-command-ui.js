/*
 * AAA Agent Command — Phase 2 drill-down for the Command Deck's Agent Network.
 *
 * Turns agent swarms from statistics into visible workers: every registered
 * agent (plus runtime customs) is grouped into the SAME swarms as the Command
 * Deck and rendered as a live roster row — status dot, decisions count,
 * calibrated confidence, outcome score, and the agent's most recent action
 * pulled from shared memory (agent_decisions + agent_logs, whose createdAt is
 * mixed ISO-string / epoch-ms — both normalized here).
 *
 * Every number comes from a real store (AAA_AGENTS, AAA_SUPERVISOR.metrics(),
 * AAA_DATA) and every missing engine degrades honestly: no registry → empty
 * teams + "No agents registered yet."; no supervisor → agents listed as
 * 'warming_up' with null stats; no actions → "No actions yet — warming up."
 *
 * renderModel() is a pure, DOM-free read model (testable); mount() renders the
 * mobile screen only when a document exists. openTeam(teamId) filters the
 * mount to a single swarm — the Command Deck wires its swarm taps here.
 */
;(function (global) {
  'use strict';

  function data() { return global.AAA_DATA; }
  function has(name) { return !!global['AAA_' + name]; }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]); }); }
  async function quiet(fn, d) { try { const r = await fn(); return r == null ? d : r; } catch (_) { return d; } }

  // ---- timestamp normalization (agent_decisions createdAt is MIXED TYPE:
  // ISO string from the estimator agent, epoch ms from logDecision) ----------
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

  // agent id → swarm — copied verbatim from the Command Deck so deck swarm ids
  // ('sales', 'marketing', …) route 1:1 into openTeam(teamId). Custom agents
  // land in Operations, exactly like the deck.
  const TEAM_OF = {
    sales: 'Sales', customer_success: 'Sales',
    marketing: 'Marketing',
    operations: 'Operations',
    accounting: 'Finance', kpi: 'Finance',
    data_scientist: 'Intelligence',
    ceo: 'Governance', supervisor: 'Governance', compliance: 'Governance'
  };
  const TEAM_ORDER = ['Sales', 'Marketing', 'Operations', 'Finance', 'Intelligence', 'Governance'];

  const AgentCommand = {
    /** Pure render model — swarms of visible workers, no DOM. opts.teamId filters to one swarm. */
    async renderModel(opts) {
      const o = opts || {};

      // ---- real reads (each null-safe; missing engines fall back honestly) --
      const sup = await quiet(function () { return has('SUPERVISOR') && global.AAA_SUPERVISOR.metrics ? global.AAA_SUPERVISOR.metrics() : null; }, null);
      const decisions = await quiet(function () { return data() && data().list ? data().list('agent_decisions') : []; }, []);
      const logs = await quiet(function () { return data() && data().list ? data().list('agent_logs') : []; }, []);

      const supOk = !!(sup && sup.ok);
      const perAgent = (supOk && sup.perAgent) ? sup.perAgent : {};
      const closeRatePct = supOk && sup.closeRate != null ? Math.round(sup.closeRate * 100) : null;

      // most recent action per agent id (decisions + logs, timestamps normalized)
      const lastByAgent = {};
      (decisions || []).forEach(function (d) {
        if (!d) return;
        note(d.agent, toTs(d.createdAt || d.ts), d.recommendation || d.title || d.decision || (d.kind ? d.kind + ' decision' : 'Agent decision'));
      });
      (logs || []).forEach(function (l) {
        if (!l) return;
        note(l.agent, toTs(l.createdAt || l.ts), l.message || '');
      });
      function note(agent, ts, text) {
        if (!agent || !text) return;
        const cur = lastByAgent[agent];
        if (!cur || ts >= cur.ts) lastByAgent[agent] = { ts: ts, text: text };
      }

      // ---- group the live roster into the deck's swarms ----------------------
      const reg = global.AAA_AGENTS;
      let teams = [];
      if (reg && reg.ids) {
        const ids = reg.ids().concat(reg.customIds ? reg.customIds() : []);
        const byTeam = {};
        ids.forEach(function (id) {
          const a = reg.get ? reg.get(id) : null;
          const team = TEAM_OF[id] || 'Operations';
          const per = perAgent[id];
          const last = lastByAgent[id] || null;
          (byTeam[team] = byTeam[team] || []).push({
            id: id,
            title: a && a.title ? a.title : id,
            status: per && per.decisions > 0 ? 'active' : 'warming_up',
            decisions: per ? (per.decisions || 0) : 0,
            avgConfidence: per && per.avgConfidence != null ? Math.round(per.avgConfidence) : null,
            avgScore: per && per.avgScore != null ? Math.round(per.avgScore * 100) : null,
            lastAction: last ? { ts: last.ts, time: hhmm(last.ts), text: last.text } : null
          });
        });
        teams = TEAM_ORDER.filter(function (t) { return byTeam[t]; }).map(function (t) {
          const members = byTeam[t];
          return {
            id: t.toLowerCase(),
            label: t,
            agents: members,
            closeRatePct: closeRatePct,
            totalDecisions: members.reduce(function (s, m) { return s + m.decisions; }, 0)
          };
        });
      }

      if (o.teamId != null) {
        const want = String(o.teamId).toLowerCase();
        teams = teams.filter(function (t) { return t.id === want; });
      }

      return {
        generatedAt: Date.now(),
        teamId: o.teamId != null ? String(o.teamId).toLowerCase() : null,
        teams: teams,
        empty: teams.length === 0,
        emptyLabel: 'No agents registered yet.'
      };
    },

    /** Render Agent Command into a DOM element (DOM-guarded). opts.teamId filters to one swarm. */
    async mount(el, opts) {
      if (typeof document === 'undefined') return { mounted: false, reason: 'no_dom' };
      const root = el || document.body;
      const m = await this.renderModel(opts);
      const wrap = document.createElement('div'); wrap.className = 'ac-root';

      wrap.innerHTML =
        // hero header + back affordance
        '<div class="ac-hero">' +
          '<button class="ac-back" type="button" data-back aria-label="Back">‹ Back</button>' +
          '<div>' +
            '<div class="ac-hero__title">AGENT COMMAND</div>' +
            '<div class="ac-hero__sub">' + esc(m.teams.length === 1 ? m.teams[0].label + ' swarm' : 'The AI org, live') + '</div>' +
          '</div>' +
        '</div>' +
        (m.empty
          ? '<div class="ac-empty">' + esc(m.emptyLabel) + '</div>'
          : m.teams.map(function (t) {
              return '<section class="ac-team" data-team="' + esc(t.id) + '">' +
                '<div class="ac-team__head">' +
                  '<h3 class="ac-team__label">' + esc(t.label) + '</h3>' +
                  '<span class="ac-team__meta">' + esc(t.agents.length) + ' agent' + (t.agents.length === 1 ? '' : 's') +
                    ' · ' + esc(t.totalDecisions) + ' decision' + (t.totalDecisions === 1 ? '' : 's') +
                    (t.closeRatePct != null ? ' · ' + esc(t.closeRatePct) + '% close' : '') +
                  '</span>' +
                '</div>' +
                t.agents.map(function (a) {
                  return '<div class="ac-agent" data-agent="' + esc(a.id) + '">' +
                    '<span class="ac-dot ' + (a.status === 'active' ? 'ac-dot--active' : 'ac-dot--warm') + '"></span>' +
                    '<div class="ac-agent__body">' +
                      '<div class="ac-agent__top">' +
                        '<span class="ac-agent__title">' + esc(a.title) + '</span>' +
                        '<span class="ac-agent__stats">' +
                          esc(a.decisions) + ' dec' +
                          (a.avgConfidence != null ? ' · ' + esc(a.avgConfidence) + '% conf' : '') +
                          (a.avgScore != null ? ' · ' + esc(a.avgScore) + '% score' : '') +
                        '</span>' +
                      '</div>' +
                      (a.lastAction
                        ? '<div class="ac-agent__last">' + esc(a.lastAction.time) + ' — ' + esc(a.lastAction.text) + '</div>'
                        : '<div class="ac-agent__last ac-agent__last--empty">No actions yet — warming up.</div>') +
                    '</div>' +
                  '</div>';
                }).join('') +
              '</section>';
            }).join(''));

      // back → Executive home tab. Null-safe on stubs.
      wrap.querySelectorAll('.ac-back').forEach(function (b) {
        b.onclick = function () { if (global.AAA_JOB_LIST_UI && global.AAA_JOB_LIST_UI._switchTab) global.AAA_JOB_LIST_UI._switchTab('focus'); };
      });

      root.appendChild(wrap);
      return { mounted: true };
    },

    /** Drill into one swarm — the Command Deck routes swarm taps here. */
    async openTeam(teamId, el) {
      return this.mount(el || null, { teamId: teamId });
    }
  };

  global.AAA_AGENT_COMMAND = AgentCommand;
})(typeof window !== 'undefined' ? window : this);
