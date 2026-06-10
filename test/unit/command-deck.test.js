/* Executive Command Deck — the mission-control landing for Executive Mode.
 *
 * Guards the contract the deck makes with the owner: every number on screen
 * comes from a REAL store (financial intelligence, owner copilot, quotes,
 * supervisor, outcome learning, agent registry) and every missing engine
 * degrades to an honest empty state ("Warming up", "No open opportunities
 * yet") instead of a fabricated figure. renderModel() is pure/DOM-free;
 * mount() is DOM-guarded. The UI layer is DOM-gated, so we install the same
 * minimal document stub the other UI suites use. */
'use strict';
const { makeRunner, setupEnv, load } = require('../helpers/harness');

// ---- minimal DOM stub (enough to mount the deck) ----------------------------
function makeEl() {
  const e = {
    _text: '', style: {}, className: '', value: '', children: [],
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

module.exports = async function run() {
  const t = makeRunner('command-deck');
  const { G, data } = setupEnv();
  installDom();
  try {
    load('js/ui/command-deck-ui.js');
    const DECK = G.AAA_COMMAND_DECK;
    const SECTIONS = ['pulse', 'supervisor', 'feed', 'network', 'radar'];

    // ===== null-safety: NO engines, even no data layer — must not throw =====
    const savedData = G.AAA_DATA; delete G.AAA_DATA;
    let bare = null, threw = null;
    try { bare = await DECK.renderModel(); } catch (e) { threw = e; }
    G.AAA_DATA = savedData;
    t.ok('renderModel survives with every store absent (no throw)', threw === null);
    t.ok('all five sections present even with no stores', bare !== null && SECTIONS.every((s) => bare[s] != null));

    // ===== honest empty states with an empty data layer =====
    const empty = await DECK.renderModel();
    t.ok('pulse renders six tiles', empty.pulse.tiles.length === 6);
    const conf = empty.pulse.tiles.find((x) => x.id === 'ai_confidence');
    t.ok('AI confidence is honestly "Warming up" with no supervisor data', conf.value === null && /warming up/i.test(conf.display));
    t.ok('no fabricated revenue — missing books show an honest fallback, not $0',
      empty.pulse.tiles.find((x) => x.id === 'revenue_today').value === null);
    t.ok('supervisor report falls back to "All systems healthy."', empty.supervisor.empty === true && /healthy/i.test(empty.supervisor.emptyLabel));
    t.ok('mission feed is honestly empty', empty.feed.empty === true && empty.feed.items.length === 0);
    t.ok('opportunity radar says "No open opportunities yet."', empty.radar.empty === true && /no open opportunities yet/i.test(empty.radar.emptyLabel));

    // ===== wire the REAL engines + seed real records =====
    load('js/agents/agent-registry.js');
    load('js/agents/supervisor.js');
    load('js/quotes/quote-store.js');
    load('js/intelligence/outcome-learning-store.js');
    G.AAA_FINANCIAL_INTELLIGENCE = { pnl: async () => ({ ok: true, revenue: 5400, billed: 6000, expenses: 1000, netProfit: 4400, netMargin: 81 }) };
    G.AAA_OWNER_COPILOT = {
      briefing: async () => ({ ok: true, headline: '2 follow-up(s) due', attentionItems: 1, sections: { revenueThisMonth: { count: 1200 } }, priorities: [{ kind: 'followup', label: '2 follow-up(s) due', weight: 3 }] }),
      attentionSummary: async () => ({ ok: true, headline: '2 follow-up(s) due', attentionItems: 1, top: [{ kind: 'followup', label: '2 follow-up(s) due', weight: 3 }], revenueThisMonth: 1200, date: '2026-06-10' })
    };

    await data.put('jobs', 'j1', { id: 'j1', customerName: 'Smith', currentState: 'IN_PROGRESS' });
    await data.put('jobs', 'j2', { id: 'j2', customerName: 'Jones', currentState: 'SCHEDULED' });
    await data.put('jobs', 'j3', { id: 'j3', customerName: 'Old', currentState: 'CLOSED' });
    // open pipeline: $800 sent + $450 follow_up_due · resolved: 1 won / 1 lost → 50% close
    await data.put('quotes', 'q1', { id: 'q1', quoteId: 'q1', status: 'sent', customerTotal: 800, customerName: 'Marina Bay', serviceType: ['carpet_clean'], createdAt: '2026-06-09T10:00:00Z' });
    await data.put('quotes', 'q2', { id: 'q2', quoteId: 'q2', status: 'follow_up_due', customerTotal: 450, customerName: 'Henderson', createdAt: '2026-06-08T10:00:00Z' });
    await data.put('quotes', 'q3', { id: 'q3', quoteId: 'q3', status: 'won', customerTotal: 600, finalPrice: 600, createdAt: '2026-06-01T10:00:00Z' });
    await data.put('quotes', 'q4', { id: 'q4', quoteId: 'q4', status: 'lost', customerTotal: 300, wonLostReason: 'price', createdAt: '2026-06-02T10:00:00Z' });
    // mission feed: an ISO-stamped decision (estimator-style) + an ms-stamped log
    await data.put('agent_decisions', 'd1', { id: 'd1', agent: 'estimator', kind: 'estimate', recommendation: 'carpet_clean — $750–$850', confidence: 72, createdAt: '2026-06-10T14:05:00' });
    await data.put('agent_logs', 'l1', { id: 'l1', agent: 'supervisor', message: 'Scored 1 decision', createdAt: Date.parse('2026-06-10T15:30:00') });

    const m = await DECK.renderModel();
    t.eq('Revenue (paid) tile shows the real P&L number', m.pulse.tiles.find((x) => x.id === 'revenue_today').display, '$5,400');
    t.eq('Revenue MTD comes from the owner copilot', m.pulse.tiles.find((x) => x.id === 'revenue_month').value, 1200);
    t.eq('pipeline value sums the OPEN quotes only', m.pulse.tiles.find((x) => x.id === 'pipeline').value, 1250);
    t.eq('active jobs excludes CLOSED', m.pulse.tiles.find((x) => x.id === 'active_jobs').value, 2);
    t.eq('close rate from real won/lost outcomes', m.pulse.tiles.find((x) => x.id === 'close_rate').value, 50);

    t.ok('supervisor report surfaces the briefing priorities with icons',
      m.supervisor.empty === false && m.supervisor.priorities.length === 1 && m.supervisor.priorities[0].icon === '📨' && /follow-up/.test(m.supervisor.priorities[0].label));

    t.ok('mission feed merges decisions + logs, newest first, with HH:MM times',
      m.feed.items.length === 2 && m.feed.items[0].kind === 'log' && m.feed.items[1].kind === 'decision' && /^\d{2}:\d{2}$/.test(m.feed.items[0].time));
    t.eq('feed actors resolve through the agent registry', m.feed.items[0].actor, 'Supervisor');

    t.ok('agent network groups the full roster into swarms',
      m.network.totalAgents === 10 && m.network.teams.length === 6 && m.network.teams.find((x) => x.label === 'Sales').count === 2);

    t.ok('radar ranks open quotes by expected value with an honest probability',
      m.radar.items.length === 2 && m.radar.items[0].amount === 800 && m.radar.items[0].probabilityPct === 50 && /win rate|close rate/.test(m.radar.items[0].probabilitySource));
    t.ok('radar line reads "$X,XXX — who — NN% close probability"', /^\$800 — Marina Bay — 50% close probability$/.test(m.radar.items[0].display));

    // ===== mount: DOM-guarded, never throws into a stub element =====
    const el = makeEl();
    let mountErr = null, mounted = null;
    try { mounted = await DECK.mount(el); } catch (e) { mountErr = e; }
    t.ok('mount() into a stub element does not throw and reports mounted', mountErr === null && mounted && mounted.mounted === true);
    t.ok('mount() appended the deck root', el.children.length === 1 && el.children[0].className === 'cd-root');

    const savedDoc = global.document; delete global.document;
    const noDom = await DECK.mount(null);
    global.document = savedDoc;
    t.ok('mount() without a document honestly reports no_dom', noDom.mounted === false && noDom.reason === 'no_dom');

    return t.report();
  } finally {
    delete global.document; // hygiene (suite is process-isolated anyway)
  }
};
