/* Decision Inbox UI — the feed-first executive home surface.
 *
 * Guards the re-composition contract: the hero comes from the Command Deck's
 * pulse (Revenue + Active Jobs + AI Confidence, no invented delta), the feed
 * comes from AAA_DECISION_INBOX.listDecisions with each row carrying its FULL
 * card (tap → AAA_DECISION_CARD.open with THAT card — never rebuilt), the
 * Supervisor strip condenses deck priorities into honest risk/opportunity
 * counts, agent chips route to AAA_COMMAND_DECK.openTeam, count 0 renders the
 * honest all-clear, every missing engine degrades without a throw, mount() is
 * DOM-guarded, and everything in the DOM goes through esc(). */
'use strict';
const { makeRunner, setupEnv, load } = require('../helpers/harness');

// ---- minimal DOM stub (same shape the command-deck suite uses) --------------
function makeEl() {
  const e = {
    _text: '', style: {}, className: '', value: '', children: [], innerHTML: '',
    disabled: false, type: '',
    classList: { _s: {}, add(c) { this._s[c] = true; }, remove(c) { delete this._s[c]; }, contains(c) { return !!this._s[c]; }, toggle(c, on) { const v = on === undefined ? !this._s[c] : !!on; if (v) this._s[c] = true; else delete this._s[c]; return v; } },
    setAttribute() {}, getAttribute() { return null; },
    addEventListener() {}, removeEventListener() {},
    appendChild(c) { e.children.push(c); return c; },
    insertBefore(c) { e.children.unshift(c); return c; },
    removeChild(c) { const i = e.children.indexOf(c); if (i >= 0) e.children.splice(i, 1); return c; },
    remove() {}, querySelector() { return null; }, querySelectorAll() { return []; }, focus() {}
  };
  Object.defineProperty(e, 'textContent', { get() { return e._text; }, set(v) { e._text = v; } });
  Object.defineProperty(e, 'firstChild', { get() { return e.children[0] || null; } });
  Object.defineProperty(e, 'parentNode', { get() { return null; } });
  return e;
}
function installDom() {
  const byId = {};
  global.document = {
    createElement: () => makeEl(),
    getElementById: (id) => (byId[id] || (byId[id] = makeEl())),
    body: makeEl(),
    _byId: byId
  };
  return global.document;
}

// ---- tree helpers ------------------------------------------------------------
function walk(n, fn) { if (!n) return; fn(n); (n.children || []).forEach((c) => walk(c, fn)); }
function htmlOf(root) { let h = ''; walk(root, (n) => { if (n.innerHTML) h += n.innerHTML; if (n._text) h += n._text; }); return h; }

// schema-v1.0 card factory (shape matches decision-inbox.js exactly)
function makeCard(id, name, ev, conf, quoteId) {
  return {
    decisionId: id, schemaVersion: '1.0',
    trigger: { event: 'quote.follow_up_due', timestamp: '2026-06-10T12:00:00Z', payload: { quoteId: quoteId, customerId: null, customerName: name } },
    agent: 'SalesDirectorAI',
    proposal: {
      actionType: 'SEND_COMMUNICATION', channel: 'SMS', templateId: 'followup_sms_v1',
      metrics: { expectedValueUSD: ev, confidenceScore: conf, rationale: 'Company win rate ' + Math.round(conf * 100) + '%' },
      payload: { recipient: '+17025557788', body: 'Hi ' + name + ' — just checking in.' }
    },
    governance: { status: 'AWAITING_APPROVAL', policy: 'MANUAL_REVIEW_REQUIRED' }
  };
}

module.exports = async function run() {
  const t = makeRunner('decision-inbox-ui');
  const { G } = setupEnv();
  try {
    installDom();
    load('js/ui/decision-inbox-ui.js');
    const UI = G.AAA_DECISION_INBOX_UI;

    // ===== stub the composition sources (known deck model + known decisions) =
    const teamOpens = [];
    G.AAA_COMMAND_DECK = {
      renderModel: async () => ({
        pulse: { tiles: [
          { id: 'revenue_today', label: 'Revenue (paid)', kind: 'currency', value: 5400, display: '$5,400', note: null },
          { id: 'revenue_month', label: 'Revenue MTD', kind: 'currency', value: 1200, display: '$1,200', note: null },
          { id: 'pipeline', label: 'Pipeline', kind: 'currency', value: 1250, display: '$1,250', note: null },
          { id: 'active_jobs', label: 'Active Jobs', kind: 'count', value: 2, display: '2', note: null },
          { id: 'close_rate', label: 'Close Rate', kind: 'percent', value: 50, display: '50%', note: null },
          { id: 'ai_confidence', label: 'AI Confidence', kind: 'percent', value: 72, display: '72%', note: null }
        ] },
        supervisor: {
          status: 'ok', confidencePct: 72, confidenceLabel: '72% calibrated', headline: '2 follow-up(s) due',
          priorities: [
            { kind: 'incident', icon: '🚨', label: 'overdue job' },
            { kind: 'cash', icon: '💵', label: 'invoice unpaid' },
            { kind: 'followup', icon: '📨', label: '2 follow-up(s) due' }
          ],
          empty: false
        },
        feed: { items: [], empty: true },
        network: {
          teams: [
            { id: 'sales', label: 'Sales', count: 12, avgConfidence: 80 },
            { id: 'marketing', label: 'Marketing', count: 4, avgConfidence: null },
            { id: 'operations', label: 'Operations', count: 8, avgConfidence: 70 }
          ],
          totalAgents: 24, empty: false
        },
        radar: { items: [], empty: true }
      }),
      openTeam: (id) => { teamOpens.push(id); return { opened: true, via: 'sheet' }; }
    };
    const c1 = makeCard('dec_1', 'Marina Bay', 1000, 0.5, 'q1');
    const c2 = makeCard('dec_2', 'Henderson', 169, 0.375, 'q2');
    let listResult = { ok: true, decisions: [c1, c2], totalImpactUSD: 1169, count: 2 };
    G.AAA_DECISION_INBOX = { listDecisions: async () => listResult };
    const cardOpens = [];
    G.AAA_DECISION_CARD = { open: (card) => { cardOpens.push(card); return { opened: true, sheet: {} }; } };

    // ===== renderModel composes hero + inbox + supervisor + network ==========
    const m = await UI.renderModel();
    t.ok('hero picks Revenue from the deck pulse (revenue_today preferred)',
      m.hero.revenue && m.hero.revenue.id === 'revenue_today' && m.hero.revenue.display === '$5,400' && m.hero.empty === false);
    t.ok('hero inline stats are Active Jobs + AI Confidence (label + display, no invented delta)',
      m.hero.stats.length === 2 && m.hero.stats[0].id === 'active_jobs' && m.hero.stats[0].display === '2' &&
      m.hero.stats[1].id === 'ai_confidence' && m.hero.stats[1].display === '72%' && !('delta' in m.hero));
    t.ok('inbox rows come straight from listDecisions, ranked order preserved',
      m.inbox.count === 2 && m.inbox.empty === false &&
      m.inbox.rows[0].customer === 'Marina Bay' && m.inbox.rows[0].expectedValue === 1000 &&
      m.inbox.rows[1].customer === 'Henderson' && m.inbox.rows[1].expectedValue === 169);
    t.ok('each row carries its FULL card object (the UI never rebuilds one)',
      m.inbox.rows[0].card === c1 && m.inbox.rows[1].card === c2 && m.inbox.rows[0].decisionId === 'dec_1');
    t.ok('row facts derive from the card: probabilityPct + an action label',
      m.inbox.rows[0].probabilityPct === 50 && m.inbox.rows[1].probabilityPct === 38 &&
      typeof m.inbox.rows[0].actionLabel === 'string' && m.inbox.rows[0].actionLabel.length > 0);
    t.eq('totalImpactDisplay formats the engine total', m.inbox.totalImpactDisplay, '+$1,169');
    t.ok('supervisor strip condenses priorities honestly: incident+cash → risk, the rest → opportunity',
      m.supervisor.available === true && m.supervisor.riskCount === 2 && m.supervisor.oppCount === 1 &&
      /Supervisor · 72% · 2 risk · 1 opportunities/.test(m.supervisor.line));
    t.ok('network strip: top teams by headcount {id,label,count} (Sales 12 first)',
      m.network.empty === false && m.network.teams.length === 3 &&
      m.network.teams[0].id === 'sales' && m.network.teams[0].count === 12 && m.network.teams[1].id === 'operations');

    // ===== mount ===============================================================
    const el = makeEl();
    let mountErr = null, mounted = null;
    try { mounted = await UI.mount(el); } catch (e) { mountErr = e; }
    t.ok('mount() into a stub element does not throw and reports mounted',
      mountErr === null && mounted && mounted.mounted === true && el.children.length === 1 && el.children[0].className === 'di-root');
    const html = htmlOf(el);
    t.ok('the impact header shows "2 Actions · Potential Impact +$1,169"',
      html.indexOf('2 Actions') !== -1 && html.indexOf('Potential Impact +$1,169') !== -1);
    t.ok('decision rows render customer + green EV + "NN% close · action" sub-line',
      html.indexOf('Marina Bay') !== -1 && html.indexOf('+$1,000') !== -1 && html.indexOf('50% close ·') !== -1 &&
      html.indexOf('Henderson') !== -1 && html.indexOf('38% close ·') !== -1);
    t.ok('hero revenue + condensed strips render on one screen',
      html.indexOf('$5,400') !== -1 && html.indexOf('Supervisor · 72%') !== -1 && html.indexOf('Sales 12') !== -1);

    // ===== taps ================================================================
    UI.openDecision(m.inbox.rows[0]);
    t.ok('a decision row tap opens AAA_DECISION_CARD.open with THAT row\'s card',
      cardOpens.length === 1 && cardOpens[0] === c1);
    UI.openTeam('sales');
    t.ok('an agent chip tap calls AAA_COMMAND_DECK.openTeam(id)',
      teamOpens.length === 1 && teamOpens[0] === 'sales');
    let switched = null;
    G.AAA_JOB_LIST_UI = { _switchTab: (tab) => { switched = tab; } };
    const sup = UI.openSupervisor();
    t.ok('the supervisor strip deep-links to chat', sup.routed === true && switched === 'chat');
    delete G.AAA_JOB_LIST_UI;
    t.ok('without the job list host, the supervisor strip is inert (no throw)', UI.openSupervisor().routed === false);

    // ===== honest empty state ==================================================
    listResult = { ok: true, decisions: [], totalImpactUSD: 0, count: 0 };
    const me = await UI.renderModel();
    t.ok('count 0 → honest empty inbox with the all-clear label',
      me.inbox.empty === true && me.inbox.count === 0 && me.inbox.rows.length === 0 &&
      me.inbox.emptyLabel === 'No decisions right now — all clear.');
    const el2 = makeEl();
    await UI.mount(el2);
    const emptyHtml = htmlOf(el2);
    t.ok('the empty state renders the all-clear (no fabricated rows, no impact header)',
      emptyHtml.indexOf('all clear') !== -1 && emptyHtml.indexOf('di-row') === -1 && emptyHtml.indexOf('Potential Impact') === -1);

    // ===== everything is esc()'d ===============================================
    listResult = { ok: true, decisions: [makeCard('dec_x', '<script>alert(1)</script>', 500, 0.5, 'qx')], totalImpactUSD: 500, count: 1 };
    const el3 = makeEl();
    await UI.mount(el3);
    const evilHtml = htmlOf(el3);
    t.ok('hostile customer name is escaped in the DOM html',
      evilHtml.indexOf('&lt;script&gt;') !== -1 && evilHtml.indexOf('<script>') === -1);
    listResult = { ok: true, decisions: [c1, c2], totalImpactUSD: 1169, count: 2 };

    // ===== null-safety: every engine missing ==================================
    const sd = G.AAA_COMMAND_DECK, si = G.AAA_DECISION_INBOX;
    delete G.AAA_COMMAND_DECK; delete G.AAA_DECISION_INBOX;
    let bare = null, threw = null;
    try { bare = await UI.renderModel(); } catch (e) { threw = e; }
    t.ok('every engine missing → honest empties everywhere, never a throw',
      threw === null && bare.hero.empty === true && bare.inbox.empty === true &&
      bare.inbox.count === 0 && bare.supervisor.available === false && bare.network.empty === true);
    let bareMountErr = null, bareMounted = null;
    try { bareMounted = await UI.mount(makeEl()); } catch (e) { bareMountErr = e; }
    t.ok('mount() with every engine missing still mounts the empty surface',
      bareMountErr === null && bareMounted && bareMounted.mounted === true);
    t.ok('chip/row taps without their engines are inert, not throws',
      UI.openTeam('sales').opened === false && UI.openDecision(null).opened === false);
    G.AAA_COMMAND_DECK = sd; G.AAA_DECISION_INBOX = si;

    // ===== no-DOM guard ========================================================
    const savedDoc = global.document; delete global.document;
    const noDom = await UI.mount(null);
    global.document = savedDoc;
    t.ok('mount() without a document honestly reports no_dom', noDom.mounted === false && noDom.reason === 'no_dom');

    return t.report();
  } finally {
    delete global.document; // hygiene (suite is process-isolated anyway)
  }
};
