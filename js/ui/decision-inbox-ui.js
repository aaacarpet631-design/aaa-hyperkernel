/*
 * AAA Decision Inbox UI — the feed-first Executive Mode home surface.
 *
 * Re-composition, not new intelligence: a compact pulse hero (Revenue + Active
 * Jobs + AI Confidence straight from AAA_COMMAND_DECK.renderModel().pulse), a
 * feed of approve-able decisions — BUNDLE rows first (Stage 2 compression via
 * AAA_DECISION_INBOX.listBundles: ≥2 same-family decisions collapse into one
 * "Approve All" row that opens AAA_DECISION_BUNDLE.open, whose Approve-All
 * path is DRY-RUN only), then loose individual rows (full schema-v1.0 cards
 * ranked by expected value; tapping a row opens AAA_DECISION_CARD.open with
 * THAT card, also DRY-RUN only). If listBundles is absent (older engine /
 * load-order drift) the feed falls back to the flat listDecisions rows.
 * Then two condensed one-line strips: Supervisor (risk/opportunity counts
 * derived from the deck's priorities) and Agent Network (team chips →
 * AAA_COMMAND_DECK.openTeam).
 *
 * Visual contract: DECLUTTERED. One hero surface (no card chrome), hairline
 * rows instead of boxes, numbers loudest. Every figure comes from an engine
 * read model; any missing engine degrades to an honest empty/omitted block —
 * no invented deltas, no fabricated trends, never a throw. renderModel() is
 * pure/DOM-free; mount() is DOM-guarded; everything rendered through esc().
 */
;(function (global) {
  'use strict';

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]); }); }
  function num(v) { const n = Number(v); return isFinite(n) ? n : 0; }
  function fmtMoney(n) { return '$' + Math.round(num(n)).toLocaleString('en-US'); }
  async function quiet(fn, d) { try { const r = await fn(); return r == null ? d : r; } catch (_) { return d; } }

  // Supervisor priority kinds that read as RISK; everything else is an
  // opportunity to act on (followup / proposal / council / executive / …).
  const RISK_KINDS = { incident: true, risk: true, cash: true };

  /** Honest action label derived from the card's own proposal — never invented. */
  function actionLabelFor(card) {
    const p = card && card.proposal;
    if (p && p.actionType === 'SEND_COMMUNICATION' && p.channel === 'SMS') {
      return card.trigger && card.trigger.event === 'quote.follow_up_due'
        ? 'Approve follow-up SMS' : 'Approve check-in SMS';
    }
    return 'Review decision';
  }

  const InboxUI = {
    /**
     * Pure, DOM-free read model for the Decision Inbox home.
     * @returns {{hero, inbox, supervisor, network}} — each block null-safe:
     *   a missing engine yields an honest empty/unavailable block, never a throw.
     */
    async renderModel(opts) {
      const deckEngine = global.AAA_COMMAND_DECK;
      const deck = await quiet(function () {
        return deckEngine && typeof deckEngine.renderModel === 'function' ? deckEngine.renderModel(opts) : null;
      }, null);

      // ---- hero: 3-up from the deck pulse (no delta — the pulse exposes
      // none, and we never invent a trend arrow) ---------------------------
      const tiles = deck && deck.pulse && Array.isArray(deck.pulse.tiles) ? deck.pulse.tiles : [];
      function tile(id) { return tiles.filter(function (x) { return x && x.id === id; })[0] || null; }
      const revToday = tile('revenue_today'), revMonth = tile('revenue_month');
      const revT = (revToday && revToday.value != null) ? revToday
        : ((revMonth && revMonth.value != null) ? revMonth : (revToday || revMonth));
      const stats = [];
      [tile('active_jobs'), tile('ai_confidence')].forEach(function (s) {
        if (s) stats.push({ id: s.id, label: s.label, display: s.display });
      });
      const hero = {
        revenue: revT ? { id: revT.id, label: revT.label, display: revT.display, value: revT.value != null ? revT.value : null } : null,
        stats: stats,
        empty: !revT && stats.length === 0
      };

      // ---- inbox: bundles (Stage 2 compression) above the loose feed -------
      // Preferred source is listBundles (≥2 same-family decisions collapse
      // into one "Approve All" row); when the engine predates listBundles we
      // fall back to the original flat listDecisions feed, so load order can
      // never break the surface.
      const inboxEngine = global.AAA_DECISION_INBOX;
      function rowFor(card) {
        const m = (card && card.proposal && card.proposal.metrics) || {};
        const probability = num(m.confidenceScore);
        const ev = num(m.expectedValueUSD);
        return {
          decisionId: card.decisionId,
          customer: (card.trigger && card.trigger.payload && card.trigger.payload.customerName) || 'Customer',
          // EV = probability × amount, so the quote amount is the exact inverse.
          amount: probability > 0 ? Math.round(ev / probability) : null,
          probabilityPct: Math.round(probability * 100),
          actionLabel: actionLabelFor(card),
          expectedValue: ev,
          card: card // full card — the row opens it without rebuilding
        };
      }
      let bundles = [], looseCards = [], totalImpactUSD = 0, decisionCount = 0;
      if (inboxEngine && typeof inboxEngine.listBundles === 'function') {
        const lb = await quiet(function () { return inboxEngine.listBundles(opts); }, null);
        if (lb && lb.ok) {
          bundles = (Array.isArray(lb.bundles) ? lb.bundles : []).map(function (b) {
            return {
              id: b.id,
              key: b.key,
              label: b.label,
              count: num(b.count),
              totalImpactUSD: num(b.totalImpactUSD),
              totalImpactDisplay: '+' + fmtMoney(b.totalImpactUSD),
              avgConfidencePct: Math.round(num(b.avgConfidencePct)),
              bundle: b // full engine bundle — the row opens it without rebuilding
            };
          });
          looseCards = Array.isArray(lb.loose) ? lb.loose : [];
          totalImpactUSD = num(lb.totalImpactUSD);
          decisionCount = num(lb.count);
        }
      } else {
        const ld = await quiet(function () {
          return inboxEngine && typeof inboxEngine.listDecisions === 'function' ? inboxEngine.listDecisions(opts) : null;
        }, null);
        looseCards = ld && ld.ok && Array.isArray(ld.decisions) ? ld.decisions : [];
        totalImpactUSD = ld && ld.ok ? num(ld.totalImpactUSD) : 0;
        decisionCount = looseCards.length;
      }
      const rows = looseCards.map(rowFor);
      const inbox = {
        bundles: bundles,
        rows: rows,
        count: decisionCount,
        totalImpactUSD: totalImpactUSD,
        totalImpactDisplay: '+' + fmtMoney(totalImpactUSD),
        empty: bundles.length === 0 && rows.length === 0,
        emptyLabel: 'No decisions right now — all clear.'
      };

      // ---- supervisor: condensed one-liner from the deck model -------------
      let supervisor = { available: false, riskCount: 0, oppCount: 0, headline: null, confidencePct: null, confidenceLabel: null, line: null };
      if (deck && deck.supervisor) {
        const s = deck.supervisor;
        const pr = Array.isArray(s.priorities) ? s.priorities : [];
        const riskCount = pr.filter(function (p) { return p && RISK_KINDS[p.kind]; }).length;
        const oppCount = pr.length - riskCount;
        supervisor = {
          available: true,
          riskCount: riskCount,
          oppCount: oppCount,
          headline: s.headline || null,
          confidencePct: s.confidencePct != null ? s.confidencePct : null,
          confidenceLabel: s.confidenceLabel || null,
          line: 'Supervisor · ' + (s.confidencePct != null ? s.confidencePct + '%' : 'warming up') +
            ' · ' + riskCount + ' risk · ' + oppCount + ' opportunities'
        };
      }

      // ---- network: top teams as a one-line chip strip ----------------------
      let network = { teams: [], empty: true };
      if (deck && deck.network && Array.isArray(deck.network.teams)) {
        const teams = deck.network.teams.slice()
          .sort(function (a, b) { return num(b.count) - num(a.count); })
          .slice(0, 4)
          .map(function (tm) { return { id: tm.id, label: tm.label, count: num(tm.count) }; });
        network = { teams: teams, empty: teams.length === 0 };
      }

      return { hero: hero, inbox: inbox, supervisor: supervisor, network: network };
    },

    /** Open a feed bundle row's "Approve All" sheet (it appends its own overlay). */
    openBundle(entry) {
      const bundle = entry && entry.bundle ? entry.bundle : entry;
      const bundleUI = global.AAA_DECISION_BUNDLE;
      if (!bundle || !bundleUI || typeof bundleUI.open !== 'function') return { opened: false, reason: 'no_bundle_ui' };
      try { return bundleUI.open(bundle, {}); } catch (_) { return { opened: false, reason: 'open_failed' }; }
    },

    /** Open a feed row's Decision Card (the card sheet appends its own overlay). */
    openDecision(row) {
      const card = row && row.card ? row.card : row;
      const cardUI = global.AAA_DECISION_CARD;
      if (!card || !cardUI || typeof cardUI.open !== 'function') return { opened: false, reason: 'no_card_ui' };
      try { return cardUI.open(card, {}); } catch (_) { return { opened: false, reason: 'open_failed' }; }
    },

    /** Supervisor strip tap → the chat copilot; inert when the tab host is absent. */
    openSupervisor() {
      const jl = global.AAA_JOB_LIST_UI;
      if (jl && typeof jl._switchTab === 'function') { jl._switchTab('chat'); return { routed: true, via: 'chat' }; }
      return { routed: false };
    },

    /** Agent chip tap → the existing Agent Command drill-down sheet. */
    openTeam(teamId) {
      const deck = global.AAA_COMMAND_DECK;
      if (deck && typeof deck.openTeam === 'function') return deck.openTeam(teamId);
      return { opened: false, reason: 'no_deck' };
    },

    /** Render the Decision Inbox home into a DOM element (DOM-guarded). */
    async mount(el, opts) {
      if (typeof document === 'undefined') return { mounted: false, reason: 'no_dom' };
      const root = el || document.body;
      const m = await this.renderModel(opts);
      const wrap = document.createElement('div');
      wrap.className = 'di-root';

      let html = '';

      // 1. slim hero strip — one quiet surface; the revenue number is the
      // loudest thing on screen.
      if (m.hero && (m.hero.revenue || m.hero.stats.length)) {
        html += '<div class="di-hero">';
        if (m.hero.revenue) {
          html += '<div class="di-hero__label">' + esc(m.hero.revenue.label) + '</div>' +
            '<div class="di-hero__value' + (m.hero.revenue.value == null ? ' di-hero__value--dim' : '') + '">' +
            esc(m.hero.revenue.display) + '</div>';
        }
        if (m.hero.stats.length) {
          html += '<div class="di-hero__stats">' + m.hero.stats.map(function (s) {
            return '<span class="di-stat"><span class="di-stat__v">' + esc(s.display) + '</span> ' + esc(s.label) + '</span>';
          }).join('<span class="di-stat__sep">·</span>') + '</div>';
        }
        html += '</div>';
      }

      // 2. the Decision Inbox feed
      html += '<div class="di-sec"><span class="di-sec__t">Decision Inbox</span>' +
        (m.inbox.empty ? '' :
          '<span class="di-sec__m">' + esc(m.inbox.count) + ' Action' + (m.inbox.count === 1 ? '' : 's') +
          ' · Potential Impact ' + esc(m.inbox.totalImpactDisplay) + '</span>') +
        '</div>';
      if (m.inbox.empty) {
        html += '<div class="di-empty">' + esc(m.inbox.emptyLabel) + '</div>';
      } else {
        // bundle rows FIRST — N homogeneous decisions compressed to one tap
        if (m.inbox.bundles.length) {
          html += '<div class="di-bundles">' + m.inbox.bundles.map(function (b, i) {
            return '<button class="di-bundle" type="button" data-bundle="' + i + '">' +
              '<span class="di-bundle__top">' +
                '<span class="di-bundle__label">' + esc(b.label) + '</span>' +
                '<span class="di-bundle__ev">' + esc(b.totalImpactDisplay) + '</span>' +
              '</span>' +
              '<span class="di-bundle__sub">' + esc(b.count) + ' actions · ' + esc(b.avgConfidencePct) + '% avg · ' +
                '<span class="di-bundle__cta">Approve All ▶</span></span>' +
              '</button>';
          }).join('') + '</div>';
        }
        // then the loose individual rows
        html += '<div class="di-feed">' + m.inbox.rows.map(function (r, i) {
          return '<button class="di-row" type="button" data-row="' + i + '">' +
            '<span class="di-row__top">' +
              '<span class="di-row__who">' + esc(r.customer) + '</span>' +
              '<span class="di-row__ev">+' + esc(fmtMoney(r.expectedValue)) + '</span>' +
            '</span>' +
            '<span class="di-row__sub">' + esc(r.probabilityPct) + '% close · ' + esc(r.actionLabel) + '</span>' +
            '</button>';
        }).join('') + '</div>';
      }

      // 3. condensed Supervisor strip
      if (m.supervisor.available) {
        html += '<button class="di-strip" type="button" data-act="supervisor">' + esc(m.supervisor.line) + '</button>';
      }

      // 4. condensed Agent Network strip
      if (!m.network.empty) {
        html += '<div class="di-net">' + m.network.teams.map(function (tm) {
          return '<button class="di-chip" type="button" data-team="' + esc(tm.id) + '">' +
            esc(tm.label) + ' ' + esc(tm.count) + '</button>';
        }).join('') + '</div>';
      }

      wrap.innerHTML = html;

      // taps (the bundle/card sheets append their own overlays to document.body)
      wrap.querySelectorAll('.di-bundle').forEach(function (b) {
        b.onclick = function () { InboxUI.openBundle(m.inbox.bundles[Number(b.getAttribute('data-bundle'))]); };
      });
      wrap.querySelectorAll('.di-row').forEach(function (b) {
        b.onclick = function () { InboxUI.openDecision(m.inbox.rows[Number(b.getAttribute('data-row'))]); };
      });
      wrap.querySelectorAll('.di-strip').forEach(function (b) {
        b.onclick = function () { InboxUI.openSupervisor(); };
      });
      wrap.querySelectorAll('.di-chip').forEach(function (b) {
        b.onclick = function () { InboxUI.openTeam(b.getAttribute('data-team')); };
      });

      root.appendChild(wrap);
      return { mounted: true };
    }
  };

  global.AAA_DECISION_INBOX_UI = InboxUI;
})(typeof window !== 'undefined' ? window : this);
