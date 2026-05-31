/*
 * Intelligence layer smoke test (no browser, no network).
 *
 * Loads the js/intelligence/* modules (which are browser IIFEs) into a vm
 * sandbox with an in-memory store and a MOCK Claude proxy, seeds real-looking
 * data, then drives the whole 6-layer org: collectors → pipeline → debate →
 * council → meetings → rankings → evolution. Asserts the deterministic pieces
 * (collectors + rankings math) and that the model-gated pieces wire end-to-end.
 *
 * Run: node test/intelligence-smoke.mjs
 */
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

let failures = 0;
function ok(cond, msg) { if (cond) { console.log('  ✓ ' + msg); } else { failures++; console.log('  ✗ ' + msg); } }
function section(t) { console.log('\n' + t); }

// ---- in-memory store + data layer ----------------------------------------
const mem = {};
let proxyOn = true;
let idN = 0;

const store = {
  async get(c, k) { return (mem[c] && mem[c][k]) || null; },
  async put(c, k, v) { (mem[c] = mem[c] || {})[k] = v; return v; },
  async getAll(c) { return Object.values(mem[c] || {}); },
  async remove(c, k) { if (mem[c]) delete mem[c][k]; return true; }
};

// MOCK proxy: return canned JSON shaped to whichever schema is requested.
function cannedFor(schema, payload) {
  const req = (schema && schema.required) || [];
  const has = (k) => req.includes(k);
  if (has('opportunities') && has('recommendation')) return { summary: 'Real-data read.', findings: ['win rate is 50%'], opportunities: ['Upsell repairs to cleaning customers'], risks: ['Price sensitivity'], recommendation: 'Raise repair pricing 8%', confidence: 62, forecast: 'Flat unless we act.', metrics_cited: ['winRate', 'avgTicket'] };
  if (has('critique')) return { critique: 'Sample is thin.', weaknesses: ['few decided deals'], assumptions_challenged: ['demand is inelastic'], revised_recommendation: 'Pilot a 5% increase first', confidence: 55 };
  if (has('severity') && has('blocking')) return { risks: ['Possible win-rate dip'], severity: 'MEDIUM', mitigations: ['A/B test'], blocking: false };
  if (has('verdict')) return { verdict: 'accept', final_recommendation: 'Pilot a 5% repair price increase', calibrated_confidence: 64, rationale: 'Evidence supports a small test.', conditions: ['Watch win rate weekly'] };
  if (has('vote')) return { vote: 'approve', rationale: 'Margin upside outweighs risk.', confidence: 70, key_concern: 'Win-rate erosion' };
  if (has('gaps')) return { summary: 'One blind spot.', gaps: [{ area: 'Customer lifetime value not tracked', evidence: 'No LTV metric in any report', severity: 'HIGH', proposalType: 'metric', proposedName: 'LTV Tracker', description: 'Track repeat revenue per customer', expectedValue: 'Better retention targeting' }] };
  if (has('action_items')) return { summary: 'Week in review.', wins: ['Win rate steady'], failures: ['Callbacks up'], decisions: ['Pilot price test'], action_items: [{ action: 'Launch 5% repair price test', owner: 'pricing', priority: 'HIGH' }], confidence: 60 };
  return {};
}

const data = {
  async list(c) { return store.getAll(c); },
  async get(c, k) { return store.get(c, k); },
  async put(c, k, v) { return store.put(c, k, v); },
  async listJobs() { return store.getAll('jobs'); },
  async listCustomers() { return store.getAll('customers'); },
  cloudReady() { return false; },
  async recordOutcome(jobId, result, extra) { const id = 'out_' + (idN++); const rec = Object.assign({ id, jobId, result, recordedAt: Date.now() }, extra || {}); await store.put('outcomes', id, rec); return rec; },
  async logDecision(d) { const id = 'dec_' + (idN++); const rec = Object.assign({ id, createdAt: Date.now() }, d); await store.put('agent_decisions', id, rec); return rec; },
  async logAgent(agent, message, ctx) { const id = 'log_' + (idN++); const rec = { id, agent, message, context: ctx || {}, createdAt: Date.now() }; await store.put('agent_logs', id, rec); return rec; },
  async saveKpiSnapshot() { return {}; },
  async callAgent(payload) {
    if (!proxyOn) return { ok: false, error: 'PROXY_NOT_CONFIGURED' };
    const schema = payload && payload.output_config && payload.output_config.format && payload.output_config.format.schema;
    return { ok: true, text: JSON.stringify(cannedFor(schema, payload)) };
  }
};

// ---- sandbox ---------------------------------------------------------------
const sandbox = {
  console, JSON, Math, Date, Promise, Object, Array, String, Number, Boolean, isNaN, parseInt, parseFloat, setTimeout,
  AAA_ID_FACTORY: { createId: (p) => p + '_' + (idN++) },
  AAA_RUNTIME_CLOCK: { now: () => Date.now() },
  AAA_CONFIG: { isProxyConfigured: () => proxyOn, workspaceId: null },
  AAA_LOCAL_FIRST_STORAGE: store,
  AAA_DATA: data
};
vm.createContext(sandbox);

function load(rel) {
  const code = fs.readFileSync(path.join(root, rel), 'utf8');
  vm.runInContext(code, sandbox, { filename: rel });
}

// Real supervisor (rankings re-scoring depends on it), then the intelligence layer.
load('js/agents/supervisor.js');
load('js/intelligence/analysis-division.js');
load('js/intelligence/intelligence-collectors.js');
load('js/intelligence/debate-engine.js');
load('js/intelligence/intelligence-pipeline.js');
load('js/intelligence/supervisor-council.js');
load('js/intelligence/intelligence-meetings.js');
load('js/intelligence/analyst-rankings.js');
load('js/intelligence/evolution-engine.js');

// ---- seed realistic data ---------------------------------------------------
async function seed() {
  const cust = [
    { id: 'c1', name: 'Alice', source: 'referral' },
    { id: 'c2', name: 'Bob', source: 'google' },
    { id: 'c3', name: 'Cara', source: 'referral' }
  ];
  for (const c of cust) await store.put('customers', c.id, c);
  const jobs = [
    { id: 'j1', customerId: 'c1', currentState: 'CLOSED', closedAt: Date.now(), estimates: [{ type: 'repair', estimatedQuoteRange: '$200-$400', estimatedTimeMins: 120 }] },
    { id: 'j2', customerId: 'c1', currentState: 'CLOSED', closedAt: Date.now(), estimates: [{ type: 'cleaning', estimatedQuoteRange: '$150-$250', estimatedTimeMins: 90 }] },
    { id: 'j3', customerId: 'c2', currentState: 'CLOSED', closedAt: Date.now(), estimates: [{ type: 'repair', estimatedQuoteRange: '$300-$500', estimatedTimeMins: 150 }] },
    { id: 'j4', customerId: 'c3', currentState: 'OPEN', estimates: [{ type: 'install', estimatedQuoteRange: '$1000-$1500', estimatedTimeMins: 480 }] }
  ];
  for (const j of jobs) await store.put('jobs', j.id, j);

  // Decisions by a couple of analysts, then outcomes that score them.
  await data.logDecision({ agent: 'sales', jobId: 'j1', decision: 'Quote $300', confidence: 80 });
  await data.logDecision({ agent: 'sales', jobId: 'j2', decision: 'Quote $200', confidence: 75 });
  await data.logDecision({ agent: 'sales', jobId: 'j3', decision: 'Quote $400', confidence: 40 });
  await data.logDecision({ agent: 'pricing', jobId: 'j1', decision: 'Hold price', confidence: 60 });

  await data.recordOutcome('j1', 'won', { finalAmount: 320 });
  await data.recordOutcome('j2', 'won', { finalAmount: 210 });
  await data.recordOutcome('j3', 'lost', { finalAmount: 0, reason: 'price' });
}

// ---- run -------------------------------------------------------------------
(async function main() {
  await seed();
  const I = sandbox;

  section('Collectors (Layer 1 — deterministic, no model)');
  const rev = await I.AAA_INTEL_COLLECTORS.revenue();
  ok(rev.totalRevenue === 530, 'revenue totals realized won amounts ($320+$210=$530), got ' + rev.totalRevenue);
  ok(rev.avgTicket === 265, 'avg ticket = $265, got ' + rev.avgTicket);
  const pr = await I.AAA_INTEL_COLLECTORS.pricing();
  ok(pr.winRate === 0.667, 'win rate = 2/3 ≈ 0.667, got ' + pr.winRate);
  ok(pr.avgEstimateAccuracy != null, 'estimate accuracy computed from estimate vs final');
  const cu = await I.AAA_INTEL_COLLECTORS.customer();
  ok(cu.repeatCustomers === 1, 'one repeat customer (Alice has 2 jobs), got ' + cu.repeatCustomers);
  ok(cu.referralCount === 2, 'two referral customers, got ' + cu.referralCount);
  const opp = await I.AAA_INTEL_COLLECTORS.operations();
  ok(opp.closedJobs === 3 && opp.openJobs === 1, 'ops: 3 closed / 1 open, got ' + opp.closedJobs + '/' + opp.openJobs);

  section('Rankings (deterministic math + Supervisor re-scoring)');
  const ref = await I.AAA_RANKINGS.refresh();
  ok(ref.ok, 'rankings.refresh ok');
  ok(ref.rescored > 0, 'historical decisions were re-scored against outcomes, got ' + ref.rescored);
  const sales = ref.analysts.find(a => a.analyst === 'sales');
  ok(sales && sales.accuracy != null, 'sales analyst has an Accuracy score from real calibration');
  ok(sales && sales.riskDetection != null, 'sales has Risk Detection (it doubted the lost deal at 40%)');
  ok(sales && sales.businessImpactUsd === 530, 'sales business impact = $530 of won revenue it weighed in on, got ' + (sales && sales.businessImpactUsd));
  ok(sales && sales.overall != null, 'sales has an Overall score');

  section('Pipeline (all 6 layers, mock proxy)');
  const rep = await I.AAA_INTEL_PIPELINE.runTeam('revenue');
  ok(rep.ok, 'pipeline.runTeam ok');
  ok(rep.layers.length === 6, 'report records all 6 layers, got ' + rep.layers.length);
  ok(rep.accepted === true && rep.verdict === 'accept', 'analysis accepted via debate verdict');
  ok(rep.decisionId, 'an arbitrated decision was logged for future scoring');
  ok(rep.executive && rep.executive.headline, 'Layer 5 produced an executive headline');

  section('Pipeline honesty when proxy is OFF');
  proxyOn = false;
  const repOff = await I.AAA_INTEL_PIPELINE.runTeam('pricing');
  ok(repOff.status === 'collected_only', 'with no proxy, pipeline returns collected_only (real data, no fabricated analysis)');
  ok(repOff.layers.length === 1, 'only Layer 1 ran without a proxy');
  proxyOn = true;

  section('Debate engine (Recommendation → Critic → Risk → Supervisor)');
  const deb = await I.AAA_DEBATE.run({ topic: 'Raise repair pricing', context: { winRate: 0.667 }, recommendation: { recommendation: 'Raise 8%', rationale: 'margin', confidence: 62 } });
  ok(deb.ok && deb.transcript.length === 4, 'debate produced a 4-stage transcript, got ' + (deb.transcript && deb.transcript.length));
  ok(deb.verdict === 'accept' && typeof deb.confidence === 'number', 'supervisor returned a calibrated verdict');

  section('Supervisor Council (5-member vote)');
  const vote = await I.AAA_COUNCIL.convene({ topic: 'Invest in a second crew', context: { openJobs: 1 } });
  ok(vote.ok && vote.tally.cast === 5, 'all 5 supervisors voted, got ' + (vote.tally && vote.tally.cast));
  ok(vote.decision === 'approved', 'unanimous approve resolves to approved, got ' + vote.decision);
  const link = await I.AAA_COUNCIL.linkOutcome(vote.voteId, { result: 'won' });
  ok(link.ok && link.vote.wasCorrect === true, 'linked outcome scores the council call correct');

  section('Intelligence Meetings');
  const due = await I.AAA_MEETINGS.due('weekly');
  ok(due.ok && due.due === true, 'weekly meeting is due when none has run');
  const meet = await I.AAA_MEETINGS.run('weekly');
  ok(meet.ok && meet.actionItems.length >= 1, 'meeting produced action items, got ' + (meet.actionItems && meet.actionItems.length));
  const due2 = await I.AAA_MEETINGS.due('weekly');
  ok(due2.due === false, 'weekly meeting is no longer due right after running');

  section('Evolution engine');
  const evo = await I.AAA_EVOLUTION.scan();
  ok(evo.ok && evo.gaps.length >= 1, 'evolution scan identified a gap, got ' + (evo.gaps && evo.gaps.length));
  ok(evo.gaps[0].proposalType && evo.gaps[0].severity, 'gap is a structured proposal');

  console.log('\n' + (failures ? ('FAILED: ' + failures + ' assertion(s)') : 'ALL PASSED'));
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error('\nTEST CRASHED:', e); process.exit(1); });
