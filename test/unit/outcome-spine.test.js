/*
 * Outcome Spine — normalize across sources + overlay gap-fill (read-only).
 * Pure measurement; never mutates source records; no network.
 */
'use strict';
const { makeRunner, setupEnv, load } = require('../helpers/harness');

module.exports = async function run() {
  const t = makeRunner('outcome-spine');
  const { G, data } = setupEnv({});
  load('js/intelligence/outcome-spine.js');
  const S = G.AAA_OUTCOME_SPINE;

  // ---- pure classify + normalizers ---------------------------------------
  t.eq('won → success', S.classify('won'), 'success');
  t.eq('lost → failure', S.classify('LOST'), 'failure');
  t.eq('callback → neutral', S.classify('callback'), 'neutral');

  const fq = S.fromQuote({ quoteId: 'q1', status: 'won', customerTotal: 1400, finalPrice: 1450, marginPct: 22, leadSource: 'referral', serviceType: 'stairs', zip: '770xx', wonLostReason: null, updatedAt: 10 });
  t.ok('fromQuote maps est/final/class', fq.entityType === 'quote' && fq.estimated === 1400 && fq.final === 1450 && fq.resultClass === 'success');
  t.eq('fromQuote ignores unresolved', S.fromQuote({ quoteId: 'q2', status: 'draft' }), null);
  const fl = S.fromLead({ leadId: 'L1', stage: 'LOST', outcome: { result: 'LOST', lostReason: 'price', at: 5 }, source: 'lsa', serviceType: 'repair' });
  t.ok('fromLead maps result/reason', fl.entityType === 'lead' && fl.result === 'lost' && fl.reason === 'price' && fl.resultClass === 'failure');

  // ---- missingFields requires est+final for quote/job --------------------
  t.ok('quote needs estimated+final', S.missingFields({ entityType: 'quote', entityId: 'x', result: 'won', resultClass: 'success', recordedAt: 1 }).join(',') === 'estimated,final');
  t.eq('lead complete without $', S.missingFields({ entityType: 'lead', entityId: 'x', result: 'lost', resultClass: 'failure', recordedAt: 1 }).length, 0);

  // ---- list() de-dups a quote present in BOTH quotes + outcomes ----------
  await data.put('quotes', 'q1', { quoteId: 'q1', status: 'won', customerTotal: 1400, finalPrice: 1450, marginPct: 22, leadSource: 'referral', serviceType: 'stairs', updatedAt: 10 });
  await data.put('outcomes', 'o1', { id: 'o1', quoteId: 'q1', result: 'won', finalAmount: 1450, source: 'quote_lifecycle', recordedAt: 11 });
  await data.put('leads', 'L1', { leadId: 'L1', stage: 'LOST', outcome: { result: 'LOST', lostReason: 'price', at: 5 }, source: 'lsa' });
  // a quote missing final (the gap MAPE cares about)
  await data.put('quotes', 'q3', { quoteId: 'q3', status: 'won', customerTotal: 900, leadSource: 'website', serviceType: 'clean', updatedAt: 20 });

  let all = await S.list();
  t.eq('one row per entity (q1 deduped)', all.filter((o) => o.entityId === 'q1').length, 1);
  const q1 = all.filter((o) => o.entityId === 'q1')[0];
  t.ok('q1 complete + labeled', q1.labeled === true && q1.estimated === 1400 && q1.final === 1450);

  // ---- unlabeled() surfaces the gap; coverage() math ----------------------
  const gaps = await S.unlabeled();
  t.ok('q3 surfaced as unlabeled (missing final)', gaps.some((o) => o.entityId === 'q3' && o.missing.indexOf('final') !== -1));
  const cov = await S.coverage();
  t.ok('coverage counts labeled vs total', cov.total >= 3 && cov.labeled >= 2 && cov.byEntityType.quote.total === 2);

  // ---- label() fills the gap via overlay, WITHOUT mutating the source ------
  const beforeSource = await data.get('quotes', 'q3');
  const lab = await S.label('quote', 'q3', { final: 950, reason: 'accepted' });
  t.ok('label ok', lab.ok === true);
  const q3 = await S.forEntity('quote', 'q3');
  t.ok('overlay fills final → now labeled', q3.final === 950 && q3.labeled === true && q3.reason === 'accepted');
  const afterSource = await data.get('quotes', 'q3');
  t.ok('SOURCE RECORD UNCHANGED', afterSource.finalPrice === undefined && JSON.stringify(afterSource) === JSON.stringify(beforeSource));
  t.ok('overlay stored separately', !!(await data.get('outcome_labels', 'outcome_labels:quote:q3')));

  // re-label merges
  await S.label('quote', 'q3', { marginPct: 18 });
  const q3b = await S.forEntity('quote', 'q3');
  t.ok('re-label merges (keeps final, adds margin)', q3b.final === 950 && q3b.marginPct === 18);

  // ---- owner gate on label (financial correction) ------------------------
  load('js/core/aaa-rbac.js');
  G.AAA_CONFIG.set({ role: 'manager' });
  t.eq('manager cannot label financials', (await S.label('quote', 'q1', { final: 1 })).error, 'FORBIDDEN');
  G.AAA_CONFIG.set({ role: 'owner' });
  t.ok('owner can label', (await S.label('quote', 'q1', { reason: 'verified' })).ok === true);

  return t.report();
};
