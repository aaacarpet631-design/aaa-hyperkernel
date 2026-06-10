/* Digital Twin surface — the Phase 4 "living model" screen.
 *
 * Guards its honesty contract: every Current State tile comes from a REAL
 * store (customers, leads, quotes, jobs, crew, financial P&L), the Pipeline
 * Flow funnel carries real counts, the Forward Look shows ONLY what the twin
 * engine (AAA_DIGITAL_TWIN.baseline()) actually modeled — with its basis
 * stated — and refuses to project without recorded history. renderModel() is
 * pure/DOM-free and never throws even with every store absent; mount() is
 * DOM-guarded. Uses the same minimal document stub as the command-deck suite. */
'use strict';
const { makeRunner, setupEnv, load } = require('../helpers/harness');

// ---- minimal DOM stub (enough to mount the screen) --------------------------
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
  const t = makeRunner('digital-twin-ui');
  const { G, data } = setupEnv();
  installDom();
  try {
    load('js/ui/digital-twin-ui.js');
    const UI = G.AAA_DIGITAL_TWIN_UI;
    const SECTIONS = ['current', 'forecast', 'flows', 'health'];
    const tileOf = (m, id) => m.current.tiles.find((x) => x.id === id);
    const stageOf = (m, id) => m.flows.stages.find((x) => x.id === id);

    // ===== null-safety: NO engines, even no data layer — must not throw =====
    const savedData = G.AAA_DATA; delete G.AAA_DATA;
    let bare = null, threw = null;
    try { bare = await UI.renderModel(); } catch (e) { threw = e; }
    G.AAA_DATA = savedData;
    t.ok('renderModel survives with every store + data layer absent (no throw)', threw === null);
    t.ok('all four sections present even with no stores', bare !== null && SECTIONS.every((s) => bare[s] != null));
    t.ok('all six tiles are honest nulls (—), nothing fabricated',
      bare.current.tiles.length === 6 && bare.current.tiles.every((x) => x.value === null && x.display === '—'));
    t.ok('forecast honestly empty when the twin engine is not loaded',
      bare.forecast.items.length === 0 && /not loaded|no forward look/i.test(bare.forecast.emptyLabel));
    t.ok('flows honestly empty with no records', bare.flows.emptyLabel != null);
    t.eq('health is unknown when nothing is connected', bare.health.tone, 'unknown');

    // ===== real stores + the real twin engine, but NO history yet ===========
    load('js/leads/lead-store.js');
    load('js/quotes/quote-store.js');
    load('js/crew/crew-store.js');
    load('js/intelligence/business-digital-twin.js');
    const noHist = await UI.renderModel();
    t.ok('forecast refuses to project without recorded history (honest emptyLabel)',
      noHist.forecast.items.length === 0 && /history/i.test(noHist.forecast.emptyLabel));
    t.ok('health is warn (not good) with stores online but no recorded outcomes',
      noHist.health.tone === 'warn' && /outcome|coverage/i.test(noHist.health.label));

    // ===== seed REAL records through the real store modules ==================
    G.AAA_FINANCIAL_INTELLIGENCE = { pnl: async () => ({ ok: true, revenue: 5400, expenses: 1000, netProfit: 4400, netMargin: 81 }) };
    await data.put('customers', 'c1', { id: 'c1', name: 'Smith' });
    await data.put('customers', 'c2', { id: 'c2', name: 'Jones' });
    // leads: 3 created via the real store, 1 marked LOST → 2 active
    const l1 = (await G.AAA_LEADS.createLead({ name: 'Ann', phone: '7025550001', source: 'website', serviceType: 'carpet_clean' })).lead;
    await G.AAA_LEADS.createLead({ name: 'Bob', phone: '7025550002', source: 'referral', serviceType: 'restretch' });
    const l3 = (await G.AAA_LEADS.createLead({ name: 'Cal', phone: '7025550003', source: 'lsa', serviceType: 'install' })).lead;
    await G.AAA_LEADS.updateStage(l3.leadId, 'LOST', 'went dark');
    t.ok('lead store seeded through its real API', l1 && l1.stage === 'NEW_LEAD');
    // quote history for the twin: 6 won + 4 lost across ~2 months, plus 2 open
    let qi = 0;
    const addQ = (status, sentAt, resolvedAt) => { qi++; return data.put('quotes', 'q' + qi, { id: 'q' + qi, quoteId: 'q' + qi, workspaceId: 'ws_test', status, customerTotal: 1500, marginPct: 30, sentAt, resolvedAt, createdAt: sentAt }); };
    for (let k = 0; k < 5; k++) await addQ('won', '2026-01-01', '2026-01-02');
    await addQ('won', '2026-03-01', '2026-03-02'); // spreads the history over ~2 months
    for (let k = 0; k < 4; k++) await addQ('lost', '2026-01-03', '2026-01-04');
    await data.put('quotes', 'open1', { id: 'open1', quoteId: 'open1', workspaceId: 'ws_test', status: 'sent', customerTotal: 800, createdAt: '2026-06-09' });
    await data.put('quotes', 'open2', { id: 'open2', quoteId: 'open2', workspaceId: 'ws_test', status: 'follow_up_due', customerTotal: 450, createdAt: '2026-06-08' });
    // jobs: 2 scheduled, 1 in progress, 1 closed
    await data.put('jobs', 'j1', { id: 'j1', customerName: 'Smith', currentState: 'SCHEDULED' });
    await data.put('jobs', 'j2', { id: 'j2', customerName: 'Jones', currentState: 'SCHEDULED' });
    await data.put('jobs', 'j3', { id: 'j3', customerName: 'Lee', currentState: 'IN_PROGRESS' });
    await data.put('jobs', 'j4', { id: 'j4', customerName: 'Done', currentState: 'CLOSED' });
    // crew via the real store
    await G.AAA_CREW_STORE.add({ name: 'Mike', role: 'installer' });
    await G.AAA_CREW_STORE.add({ name: 'Ray', kind: 'contractor', role: 'helper' });

    const m = await UI.renderModel();
    t.eq('Customers tile counts the real customer records', tileOf(m, 'customers').value, 2);
    t.eq('Active Leads excludes WON/LOST stages', tileOf(m, 'active_leads').value, 2);
    t.eq('Open Estimates counts draft/reviewed/sent/follow_up_due from quote stats', tileOf(m, 'open_estimates').value, 2);
    t.eq('Jobs Scheduled counts SCHEDULED jobs only', tileOf(m, 'jobs_scheduled').value, 2);
    t.eq('Crews tile counts the real crew roster', tileOf(m, 'crews').value, 2);
    t.eq('Revenue tile shows the real P&L number', tileOf(m, 'revenue').display, '$5,400');

    // funnel: Leads → Estimates → Jobs → Completed with real counts
    t.ok('funnel has the four pipeline stages in order',
      m.flows.emptyLabel === null && m.flows.stages.map((s) => s.id).join('>') === 'leads>estimates>jobs>completed');
    t.eq('funnel: leads count', stageOf(m, 'leads').count, 3);
    t.eq('funnel: estimates count (all quotes)', stageOf(m, 'estimates').count, 12);
    t.eq('funnel: jobs count', stageOf(m, 'jobs').count, 4);
    t.eq('funnel: completed count (CLOSED)', stageOf(m, 'completed').count, 1);

    // forward look mirrors EXACTLY what the engine's baseline() computed
    const base = await G.AAA_DIGITAL_TWIN.baseline();
    const fcRev = m.forecast.items.find((x) => x.id === 'revenue_mo');
    const fcProfit = m.forecast.items.find((x) => x.id === 'profit_mo');
    const fcJobs = m.forecast.items.find((x) => x.id === 'jobs_mo');
    t.ok('forecast present with history: revenue/profit/jobs rows', m.forecast.emptyLabel === null && fcRev && fcProfit && fcJobs);
    t.eq('forecast revenue is the twin engine\'s modeled run-rate', fcRev.value, base.monthlyRevenue);
    t.eq('forecast profit is the twin engine\'s modeled run-rate', fcProfit.value, base.monthlyProfit);
    t.eq('forecast jobs is the twin engine\'s modeled run-rate', fcJobs.value, base.monthlyWins);
    t.ok('forecast states its real basis (sample + months of history)',
      new RegExp(base.sample + ' resolved quotes').test(fcRev.basis) && /months? of history/.test(fcRev.basis));

    // health: full coverage + enough recorded outcomes → good
    t.ok('health is good with live sources + recorded history',
      m.health.tone === 'good' && /6 of 6/.test(m.health.label));

    // ===== mount: DOM-guarded, never throws into a stub element ==============
    const el = makeEl();
    let mountErr = null, mounted = null;
    try { mounted = await UI.mount(el); } catch (e) { mountErr = e; }
    t.ok('mount() into a stub element does not throw and reports mounted', mountErr === null && mounted && mounted.mounted === true);
    t.ok('mount() appended the twin root', el.children.length === 1 && el.children[0].className === 'dt-root');
    t.ok('mounted markup carries tiles, funnel, forecast + basis, health badge',
      /dt-tile/.test(el.children[0].innerHTML) && /dt-flow__fill/.test(el.children[0].innerHTML) &&
      /dt-basis/.test(el.children[0].innerHTML) && /dt-health--good/.test(el.children[0].innerHTML));

    const savedDoc = global.document; delete global.document;
    const noDom = await UI.mount(null);
    global.document = savedDoc;
    t.ok('mount() without a document honestly reports no_dom', noDom.mounted === false && noDom.reason === 'no_dom');

    // ===== shared-global merge survives either load order =====
    // business-digital-twin-ui (planner) and this surface share one global;
    // load the planner AFTER the surface (worst case) and prove no clobber.
    load('js/ui/business-digital-twin-ui.js');
    t.ok('planner + living-model surface coexist on the shared global (no clobber)',
      ['render', 'renderResult', 'open', 'renderModel', 'mount'].every((k) => typeof G.AAA_DIGITAL_TWIN_UI[k] === 'function'));

    return t.report();
  } finally {
    delete global.document; // hygiene (suite is process-isolated anyway)
  }
};
