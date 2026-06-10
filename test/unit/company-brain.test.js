/* Company Brain — deterministic, evidence-citing business Q&A over real stores. */
'use strict';
const { makeRunner, setupEnv, load } = require('../helpers/harness');

module.exports = async function run() {
  const t = makeRunner('company-brain');
  const { G, data } = setupEnv({ fixedISO: '2026-06-07T09:00:00Z' });
  load('js/quotes/quote-store.js');
  load('js/intelligence/outcome-learning-store.js');
  load('js/intelligence/intelligence-collectors.js');
  load('js/intelligence/financial-intelligence.js');
  load('js/intelligence/company-brain.js');
  const Brain = G.AAA_COMPANY_BRAIN;

  // ===== intents() for UI hint chips =====
  const ids = Brain.intents();
  t.ok('intents() lists 5+ intents with id + example',
    Array.isArray(ids) && ids.length >= 5 && ids.every((i) => i.id && typeof i.example === 'string'));

  // ===== seed resolved quotes (Outcome Learning + Quote Store stats) =====
  // stretching: 8 resolved (6 won, 2 lost) → winRate 0.75, margin 35%, referral leads, $500–1k band
  // cleaning:  10 resolved (4 won, 6 lost) → winRate 0.40, margin 20%, google leads
  // repair:     2 resolved (1 won, 1 lost) → thin segment for the insufficient-data caveat
  let n = 0;
  async function quote(svc, status, total, finalPrice, marginPct, leadSource) {
    const id = 'q' + (++n);
    await data.put('quotes', id, {
      id, quoteId: id, workspaceId: 'ws_test', status, serviceType: [svc],
      customerTotal: total, finalPrice: status === 'won' ? finalPrice : null,
      marginPct, leadSource, zip: '98101',
      wonLostReason: status === 'won' ? 'good fit' : 'too expensive',
      resolvedAt: '2026-05-20T00:00:00Z', createdAt: '2026-05-0' + ((n % 9) + 1) + 'T00:00:00Z'
    });
  }
  for (let i = 0; i < 6; i++) await quote('stretching', 'won', 500, 520, 35, 'referral');
  for (let i = 0; i < 2; i++) await quote('stretching', 'lost', 500, null, 35, 'referral');
  for (let i = 0; i < 4; i++) await quote('cleaning', 'won', 300, 310, 20, 'google');
  for (let i = 0; i < 6; i++) await quote('cleaning', 'lost', 300, null, 20, 'google');
  await quote('repair', 'won', 250, 260, 25, 'yard_sign');
  await quote('repair', 'lost', 250, null, 25, 'yard_sign');
  // open pipeline quotes
  await data.put('quotes', 'qp1', { id: 'qp1', quoteId: 'qp1', workspaceId: 'ws_test', status: 'sent', customerTotal: 600, createdAt: '2026-06-01T00:00:00Z' });
  await data.put('quotes', 'qp2', { id: 'qp2', quoteId: 'qp2', workspaceId: 'ws_test', status: 'reviewed', customerTotal: 400, createdAt: '2026-06-02T00:00:00Z' });

  // ===== seed jobs + outcomes (Intelligence Collectors revenue/trend) =====
  await data.put('jobs', 'j1', { id: 'j1', estimates: [{ type: 'stretching' }] });
  await data.put('jobs', 'j2', { id: 'j2', estimates: [{ type: 'stretching' }] });
  await data.put('jobs', 'j3', { id: 'j3', estimates: [{ type: 'cleaning' }] });
  await data.put('jobs', 'j4', { id: 'j4', estimates: [{ type: 'cleaning' }] });
  await data.put('outcomes', 'o1', { id: 'o1', result: 'won', jobId: 'j1', finalAmount: 1200, recordedAt: '2026-04-10T00:00:00Z' });
  await data.put('outcomes', 'o2', { id: 'o2', result: 'won', jobId: 'j2', finalAmount: 700, recordedAt: '2026-05-10T00:00:00Z' });
  await data.put('outcomes', 'o3', { id: 'o3', result: 'won', jobId: 'j3', finalAmount: 800, recordedAt: '2026-04-12T00:00:00Z' });
  await data.put('outcomes', 'o4', { id: 'o4', result: 'won', jobId: 'j4', finalAmount: 500, recordedAt: '2026-05-15T00:00:00Z' });
  // month totals: 2026-04 = $2000, 2026-05 = $1200 → delta -800 (stretching -500, cleaning -300)
  // byService revenue: stretching $1900, cleaning $1300

  // ===== why_winning: segment vs overall, with real numbers =====
  const w = await Brain.ask('Why are stretching jobs winning so much?');
  t.ok('why_winning routed', w.ok === true && w.intent === 'why_winning');
  t.ok('segment win rate cited with correct value + sample',
    w.answer.findings[0].evidence.value === 0.75 && w.answer.findings[0].evidence.sample === 8);
  t.ok('claim compares segment (75%) vs overall (55%)',
    /75%/.test(w.answer.findings[0].claim) && /55%/.test(w.answer.findings[0].claim));
  t.ok('margin finding cites 35% segment margin',
    w.answer.findings.some((f) => f.evidence.metric === 'avgMarginPct' && f.evidence.value === 35));
  t.ok('an over-indexing lead-source/price-band segment is noted (n>=3)',
    w.answer.findings.some((f) => /over-index/.test(f.claim) && f.evidence.sample >= 3));
  t.ok('every why_winning finding carries source + numeric value',
    w.answer.findings.length >= 3 && w.answer.findings.every((f) => typeof f.evidence.source === 'string' && f.evidence.source && typeof f.evidence.value === 'number'));
  t.eq('confidence medium for 8 underlying records', w.confidence, 'medium');

  // ===== insufficient data: thin segment → honest caveat, never invented =====
  const thin = await Brain.ask('Why are repair jobs closing higher?');
  t.ok('thin segment answered ok with caveat', thin.ok === true && thin.intent === 'why_winning' && typeof thin.answer.caveat === 'string');
  t.ok('caveat says 2 outcomes is not enough', /Only 2 recorded outcomes for repair/.test(thin.answer.caveat) && /not enough/.test(thin.answer.caveat));
  t.eq('thin segment → low confidence', thin.confidence, 'low');

  // ===== most_profitable: correct ranking from real revenue =====
  const p = await Brain.ask('What should I advertise — what is most profitable?');
  t.ok('most_profitable routed', p.ok === true && p.intent === 'most_profitable');
  t.ok('top revenue value cited ($1900 stretching)', p.answer.findings[0].evidence.value === 1900);
  const rankClaim = p.answer.findings[0].claim;
  t.ok('ranking orders stretching before cleaning',
    rankClaim.indexOf('stretching') !== -1 && rankClaim.indexOf('cleaning') !== -1 && rankClaim.indexOf('stretching') < rankClaim.indexOf('cleaning'));
  t.ok('best-margin segment cited from outcome learning',
    p.answer.findings.some((f) => f.evidence.metric === 'avgMarginPct' && f.evidence.value === 35 && /stretching/.test(f.claim)));
  t.ok('headline recommends the top earner', /[Ss]tretching/.test(p.answer.headline));

  // ===== revenue_change: right month delta + service attribution =====
  const r = await Brain.ask('Why did revenue drop?');
  t.ok('revenue_change routed', r.ok === true && r.intent === 'revenue_change');
  t.ok('month delta computed correctly (-800)', r.answer.findings[0].evidence.value === -800);
  t.ok('claim names both months', /2026-04/.test(r.answer.findings[0].claim) && /2026-05/.test(r.answer.findings[0].claim));
  t.ok('biggest service contributor attributed (stretching -500)',
    r.answer.findings.some((f) => f.evidence.metric === 'serviceRevenueDelta' && f.evidence.value === -500 && /[Ss]tretching/.test(f.claim)));

  // ===== pipeline_state: quote store stats =====
  const pl = await Brain.ask("How's the pipeline — where's the money?");
  t.ok('pipeline_state routed', pl.ok === true && pl.intent === 'pipeline_state');
  t.ok('pipeline value cited ($1000)', pl.answer.findings[0].evidence.metric === 'pipelineValue' && pl.answer.findings[0].evidence.value === 1000);
  t.ok('close rate cited (55%)', pl.answer.findings.some((f) => f.evidence.metric === 'closeRatePct' && f.evidence.value === 55));
  t.ok('won revenue cited ($4620)', pl.answer.findings.some((f) => f.evidence.metric === 'wonRevenue' && f.evidence.value === 4620));
  t.eq('pipeline confidence high (22 quotes)', pl.confidence, 'high');

  // ===== win_rate: overall + best/worst segments =====
  const wr = await Brain.ask("What's our close rate?");
  t.ok('win_rate routed', wr.ok === true && wr.intent === 'win_rate');
  t.ok('overall win rate 0.55 over 20 resolved', wr.answer.findings[0].evidence.value === 0.55 && wr.answer.findings[0].evidence.sample === 20);
  t.ok('best segment is stretching', wr.answer.findings.some((f) => /Best segment/.test(f.claim) && /stretching/.test(f.claim) && f.evidence.value === 0.75));
  t.ok('weakest segment is cleaning', wr.answer.findings.some((f) => /Weakest segment/.test(f.claim) && /cleaning/.test(f.claim) && f.evidence.value === 0.4));
  t.eq('win_rate confidence high (20 records)', wr.confidence, 'high');

  // ===== unknown: honest fallback =====
  const u = await Brain.ask('Can you mow my lawn tomorrow?');
  t.ok('unknown question → ok:true honest fallback', u.ok === true && u.intent === 'unknown');
  t.ok('fallback names what it CAN answer', /win rates/.test(u.answer.headline) && /pipeline/.test(u.answer.headline));
  t.ok('fallback lists example questions + low confidence', /Try for example/.test(u.answer.caveat) && u.confidence === 'low');

  // ===== global evidence rule: every finding everywhere is source-linked =====
  const all = [w, thin, p, r, pl, wr];
  t.ok('EVERY finding across all answers has evidence.source + numeric value',
    all.every((a) => a.answer.findings.every((f) => f.evidence && typeof f.evidence.source === 'string' && f.evidence.source.length > 0 && typeof f.evidence.value === 'number')));

  // ===== null safety: all stores absent → ok:true, caveat, no throw =====
  G.AAA_QUOTES = null; G.AAA_OUTCOME_LEARNING = null; G.AAA_INTEL_COLLECTORS = null;
  G.AAA_FINANCIAL_INTELLIGENCE = null; G.AAA_DATA = null;
  const n1 = await Brain.ask("How's the pipeline?");
  t.ok('no stores: pipeline ok + caveat names AAA_QUOTES', n1.ok === true && /AAA_QUOTES/.test(n1.answer.caveat) && n1.answer.findings.length === 0);
  const n2 = await Brain.ask('Why are stretching jobs winning?');
  t.ok('no stores: why_winning ok + caveat names AAA_OUTCOME_LEARNING', n2.ok === true && /AAA_OUTCOME_LEARNING/.test(n2.answer.caveat));
  const n3 = await Brain.ask('Why did revenue drop?');
  t.ok('no stores: revenue_change ok + caveat names AAA_INTEL_COLLECTORS', n3.ok === true && /AAA_INTEL_COLLECTORS/.test(n3.answer.caveat) && n3.confidence === 'low');

  return t.report();
};
