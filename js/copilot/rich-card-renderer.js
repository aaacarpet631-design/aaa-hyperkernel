/*
 * AAA Rich Card Renderer — turn a card model into safe, mobile-first HTML.
 *
 * Central, escape-safe rendering for every card type (executive_briefing,
 * simulation, goal, software_factory, governance_approval, text). Pure: model
 * in, HTML string out. It renders only what the model contains, and shows
 * insufficient_data / missing-data honestly.
 */
;(function (global) {
  'use strict';

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]); }); }
  function pct(n) { return n == null ? '—' : Math.round(n * 100) + '%'; }
  function li(items, fn) { return (items || []).map(function (x) { return '<li>' + esc(fn(x)) + '</li>'; }).join(''); }

  const Renderer = {
    /** Render any card model → HTML string (safe to inject). */
    html(card) {
      if (!card) return '';
      switch (card.type) {
        case 'business_copilot_home': return this._home(card);
        case 'executive_briefing': return this._briefing(card);
        case 'simulation': return this._sim(card);
        case 'goal': return this._goal(card);
        case 'software_factory': return this._factory(card);
        case 'governance_approval': return this._gov(card);
        default: return '<div class="cp-card cp-text">' + esc(card.summary || card.note || '') + '</div>';
      }
    },

    _missing(card) { return (card.missingData && card.missingData.length) ? '<div class="cp-missing">Missing: ' + esc(card.missingData.join(', ')) + '</div>' : ''; },
    _conf(card) { return card.confidence == null ? '' : '<div class="cp-meta">confidence ' + pct(card.confidence) + '</div>'; },

    _home(c) {
      const actions = (c.actions || []).map(function (a) { return '<button class="cp-suggest" type="button" data-prompt="' + esc(a) + '">' + esc(a) + '</button>'; }).join('');
      return '<div class="cp-card cp-home"><h3>' + esc(c.title || 'AAA Business Copilot') + '</h3>' +
        '<p class="cp-summary">' + esc(c.summary || '') + '</p>' +
        (actions ? '<div class="cp-suggestions">' + actions + '</div>' : '') +
        this._conf(c) + this._missing(c) + '</div>';
    },

    _briefing(c) {
      return '<div class="cp-card cp-briefing"><h3>' + esc(c.title) + '</h3>' +
        '<p class="cp-summary">' + esc(c.summary) + '</p>' +
        (c.threats && c.threats.length ? '<div class="cp-sec"><b>Threats</b><ul>' + li(c.threats, function (x) { return x.scenario || x.metric || JSON.stringify(x); }) + '</ul></div>' : '') +
        (c.opportunities && c.opportunities.length ? '<div class="cp-sec"><b>Opportunities</b><ul>' + li(c.opportunities, function (x) { return x.what || x.opportunity || JSON.stringify(x); }) + '</ul></div>' : '') +
        (c.bottlenecks && c.bottlenecks.length ? '<div class="cp-sec"><b>Bottlenecks</b><ul>' + li(c.bottlenecks, function (x) { return (x.metric || x.signal || '') + (x.gap != null ? ' (' + x.gap + ')' : ''); }) + '</ul></div>' : '') +
        this._conf(c) + this._missing(c) + '</div>';
    },
    _sim(c) {
      if (c.status !== 'simulated') return '<div class="cp-card cp-sim"><h3>' + esc(c.title) + '</h3><div class="cp-missing">' + esc(c.note || 'insufficient_data') + '</div></div>';
      var k = c.cases;
      return '<div class="cp-card cp-sim"><h3>' + esc(c.title) + '</h3>' +
        '<table class="cp-cases"><tr><th>Worst</th><th>Expected</th><th>Best</th></tr><tr>' +
        '<td>' + esc(k.worst.revenue) + '</td><td>' + esc(k.expected.revenue) + '</td><td>' + esc(k.best.revenue) + '</td></tr></table>' +
        '<p class="cp-rec">' + esc(c.recommendation) + '</p>' + this._conf(c) +
        (c.approvalRequired ? '<div class="cp-gov">⚖️ Requires approval to act</div>' : '') + '</div>';
    },
    _goal(c) {
      if (c.status !== 'planned') return '<div class="cp-card cp-goal"><h3>' + esc(c.title) + '</h3><div class="cp-missing">' + esc(c.note || 'insufficient_data') + '</div></div>';
      return '<div class="cp-card cp-goal"><h3>' + esc(c.title) + '</h3>' +
        '<div class="cp-meta">delta ' + esc(c.currentDelta) + '</div>' +
        (c.capabilityGaps && c.capabilityGaps.length ? '<div class="cp-sec"><b>Capability gaps</b><ul>' + li(c.capabilityGaps, function (g) { return (g.requirement ? (g.requirement.action + ' ' + g.requirement.entity) : 'gap') + (g.gap ? ' — missing' : ' — covered'); }) + '</ul></div>' : '') +
        (c.recommendedExperiments && c.recommendedExperiments.length ? '<div class="cp-sec"><b>Experiments</b><ul>' + li(c.recommendedExperiments, function (x) { return x; }) + '</ul></div>' : '') +
        '<div class="cp-gov">⚖️ Acting on this goal requires approval</div></div>';
    },
    _factory(c) {
      return '<div class="cp-card cp-factory"><h3>' + esc(c.title) + '</h3>' +
        '<div class="cp-sec"><b>Spec</b> ' + esc(c.spec && c.spec.artifact) + '</div>' +
        '<div class="cp-sec"><b>Files</b> ' + esc(c.files && c.files.status) + ' · <b>Tests</b> ' + esc(c.tests && c.tests.status) + ' · <b>PR</b> ' + esc(c.prStatus) + '</div>' +
        '<div class="cp-gov">⚖️ ' + esc(c.nextStep || 'Requires approval') + '</div></div>';
    },
    _gov(c) {
      if (c.status === 'nothing_pending') return '<div class="cp-card cp-gov-card"><h3>' + esc(c.title) + '</h3><p>' + esc(c.note) + '</p></div>';
      return '<div class="cp-card cp-gov-card"><h3>' + esc(c.title) + '</h3>' +
        '<p>' + esc(c.action) + '</p>' + (c.rationale ? '<p class="cp-meta">' + esc(c.rationale) + '</p>' : '') +
        '<div class="cp-gov">⚖️ ' + esc(c.note) + '</div>' +
        '<div class="cp-actions" data-rec="' + esc(c.recId) + '"><button class="cp-approve">Approve…</button><button class="cp-reject">Reject</button></div></div>';
    }
  };

  global.AAA_RICH_CARD_RENDERER = Renderer;
})(typeof window !== 'undefined' ? window : this);
