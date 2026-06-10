/* Agent Command — the Phase 2 drill-down that turns agent swarms from
 * statistics into visible workers.
 *
 * Guards the contract: agents come from the REAL registry grouped into the
 * SAME swarms as the Command Deck; per-agent stats come from the real
 * Supervisor metrics (avgScore 0–1 scaled to 0–100); lastAction normalizes the
 * MIXED createdAt types in shared memory (ISO string from the estimator agent,
 * epoch ms from logDecision); and every missing engine degrades honestly —
 * no registry → "No agents registered yet.", no supervisor → 'warming_up'
 * with null stats. renderModel() is pure/DOM-free; mount() is DOM-guarded,
 * so we install the same minimal document stub the other UI suites use. */
'use strict';
const { makeRunner, setupEnv, load } = require('../helpers/harness');

// ---- minimal DOM stub (enough to mount the screen) ---------------------------
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
  const t = makeRunner('agent-command');
  const { G, data } = setupEnv();
  installDom();
  try {
    load('js/ui/agent-command-ui.js');
    const AC = G.AAA_AGENT_COMMAND;

    // ===== null-safety: no registry, no supervisor, even no data layer =====
    const savedData = G.AAA_DATA; delete G.AAA_DATA;
    let bare = null, threw = null;
    try { bare = await AC.renderModel(); } catch (e) { threw = e; }
    G.AAA_DATA = savedData;
    t.ok('renderModel survives with every store absent (no throw)', threw === null);
    t.ok('no registry → honest empty roster, not a fabricated org',
      bare !== null && bare.empty === true && bare.teams.length === 0 && /no agents registered yet/i.test(bare.emptyLabel));

    // ===== registry present, supervisor absent → warming up with null stats =====
    load('js/agents/agent-registry.js');
    const noSup = await AC.renderModel();
    t.ok('registry agents group into the deck\'s six swarms',
      noSup.teams.length === 6 && noSup.teams.map((x) => x.label).join(',') === 'Sales,Marketing,Operations,Finance,Intelligence,Governance');
    t.ok('Sales swarm holds sales + customer_success, Governance holds ceo/supervisor/compliance',
      noSup.teams.find((x) => x.id === 'sales').agents.length === 2 &&
      noSup.teams.find((x) => x.id === 'governance').agents.length === 3);
    const everyAgent = noSup.teams.reduce((a, x) => a.concat(x.agents), []);
    t.ok('without a supervisor every agent is honestly warming_up with null stats',
      everyAgent.length === 10 && everyAgent.every((a) => a.status === 'warming_up' && a.avgConfidence === null && a.avgScore === null && a.lastAction === null));
    t.ok('without a supervisor close rate is honestly null', noSup.teams.every((x) => x.closeRatePct === null));

    // ===== wire the REAL supervisor + seed shared memory =====
    load('js/agents/supervisor.js');
    // 3 outcomes (2 won / 1 lost) → metrics status 'ok', closeRate 2/3
    await data.put('outcomes', 'o1', { id: 'o1', jobId: 'j1', result: 'won' });
    await data.put('outcomes', 'o2', { id: 'o2', jobId: 'j2', result: 'won' });
    await data.put('outcomes', 'o3', { id: 'o3', jobId: 'j3', result: 'lost' });
    // mixed createdAt: ISO string (estimator-agent style) + epoch ms (logDecision style)
    await data.put('agent_decisions', 'd1', { id: 'd1', agent: 'sales', recommendation: 'Quote Marina Bay at $800', confidence: 80, score: 0.7, createdAt: '2026-06-10T09:05:00' });
    await data.put('agent_decisions', 'd2', { id: 'd2', agent: 'sales', recommendation: 'Follow up Henderson', confidence: 60, score: 0.9, createdAt: Date.parse('2026-06-10T16:00:00') });
    await data.put('agent_decisions', 'd3', { id: 'd3', agent: 'marketing', recommendation: 'Shift budget to LSA', confidence: 55, createdAt: '2026-06-10T11:30:00' });
    // agent_logs carry epoch ms + .message
    await data.put('agent_logs', 'l1', { id: 'l1', agent: 'supervisor', message: 'Scored 2 decisions', createdAt: Date.parse('2026-06-10T15:30:00') });
    // a runtime custom agent must land in Operations like the deck
    G.AAA_AGENTS.registerCustom({ id: 'dispatch', title: 'Dispatch', spec: {} });

    const m = await AC.renderModel();
    const salesTeam = m.teams.find((x) => x.id === 'sales');
    const sales = salesTeam.agents.find((a) => a.id === 'sales');
    t.ok('agent with decisions is active', sales.status === 'active');
    t.eq('decisions count from supervisor perAgent', sales.decisions, 2);
    t.eq('avgConfidence mapped 0–100 (mean of 80,60)', sales.avgConfidence, 70);
    t.eq('avgScore scaled 0–1 → 0–100 int (mean of 0.7,0.9)', sales.avgScore, 80);
    t.ok('lastAction picks the NEWER epoch-ms decision over the older ISO one',
      sales.lastAction !== null && sales.lastAction.text === 'Follow up Henderson' && sales.lastAction.time === '16:00');
    const mkt = m.teams.find((x) => x.id === 'marketing').agents.find((a) => a.id === 'marketing');
    t.ok('ISO-string createdAt normalizes to a real HH:MM lastAction',
      mkt.lastAction !== null && mkt.lastAction.time === '11:30' && mkt.lastAction.text === 'Shift budget to LSA');
    t.ok('unscored agent keeps an honest null score but a real confidence', mkt.avgScore === null && mkt.avgConfidence === 55);
    const supAgent = m.teams.find((x) => x.id === 'governance').agents.find((a) => a.id === 'supervisor');
    t.ok('agent_logs feed lastAction too (supervisor log line)',
      supAgent.lastAction !== null && supAgent.lastAction.time === '15:30' && /scored 2/i.test(supAgent.lastAction.text) && supAgent.status === 'warming_up');
    t.eq('close rate from real won/lost outcomes (2/3)', salesTeam.closeRatePct, 67);
    t.eq('team totalDecisions sums its agents', salesTeam.totalDecisions, 2);
    t.ok('custom agent lands in Operations like the deck',
      m.teams.find((x) => x.id === 'operations').agents.some((a) => a.id === 'dispatch' && a.title === 'Dispatch'));

    // ===== teamId filtering (openTeam's model param) =====
    const one = await AC.renderModel({ teamId: 'sales' });
    t.ok('teamId filters the model to a single swarm',
      one.teams.length === 1 && one.teams[0].id === 'sales' && one.teams[0].agents.length === 2);

    // ===== mount: DOM-guarded, never throws into a stub element =====
    const el = makeEl();
    let mountErr = null, mounted = null;
    try { mounted = await AC.mount(el); } catch (e) { mountErr = e; }
    t.ok('mount() into a stub element does not throw and reports mounted', mountErr === null && mounted && mounted.mounted === true);
    t.ok('mount() appended the agent-command root', el.children.length === 1 && el.children[0].className === 'ac-root');

    const el2 = makeEl();
    const opened = await AC.openTeam('sales', el2);
    t.ok('openTeam(teamId) mounts the filtered swarm', opened.mounted === true && el2.children.length === 1);

    const savedDoc = global.document; delete global.document;
    const noDom = await AC.mount(null);
    global.document = savedDoc;
    t.ok('mount() without a document honestly reports no_dom', noDom.mounted === false && noDom.reason === 'no_dom');

    return t.report();
  } finally {
    delete global.document; // hygiene (suite is process-isolated anyway)
  }
};
