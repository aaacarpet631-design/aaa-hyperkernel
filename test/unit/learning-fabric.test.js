/* Learning Fabric — job memory ingest, recall, explainable recommendFor, insights. */
'use strict';
const { makeRunner, setupEnv, load } = require('../helpers/harness');

module.exports = async function run() {
  const t = makeRunner('learning-fabric');
  const { G, data } = setupEnv();
  load('js/intelligence/learning-fabric.js');
  const F = G.AAA_LEARNING_FABRIC;

  // seed resolved quotes — a strong carpet_install/90210 segment + a weak one
  const mk = (id, st, zip, lead, total, margin, status, sent, resolved) => ({ id: id, quoteId: id, workspaceId: 'ws_test', serviceType: [st], zip: zip, leadSource: lead, customerTotal: total, marginPct: margin, status: status, sentAt: sent, resolvedAt: resolved });
  await data.put('quotes', 'q1', mk('q1', 'carpet_install', '90210', 'referral', 1500, 30, 'won', '2026-01-01', '2026-01-03'));
  await data.put('quotes', 'q2', mk('q2', 'carpet_install', '90210', 'referral', 1600, 28, 'won', '2026-01-01', '2026-01-02'));
  await data.put('quotes', 'q3', mk('q3', 'carpet_install', '90210', 'referral', 1400, 32, 'won', '2026-01-01', '2026-01-04'));
  await data.put('quotes', 'q4', mk('q4', 'carpet_install', '90210', 'referral', 1550, 26, 'lost', '2026-01-01', '2026-01-09'));
  await data.put('quotes', 'q5', mk('q5', 'repair', '11111', 'google', 400, 10, 'lost', '2026-01-01', '2026-01-08'));
  await data.put('quotes', 'q6', mk('q6', 'repair', '11111', 'google', 420, 12, 'lost', '2026-01-01', '2026-01-07'));
  await data.put('quotes', 'q7', mk('q7', 'repair', '11111', 'google', 410, 11, 'lost', '2026-01-01', '2026-01-06'));
  await data.put('quotes', 'q8', mk('q8', 'repair', '11111', 'google', 430, 9, 'won', '2026-01-01', '2026-01-02'));
  await data.put('quotes', 'draft', { id: 'draft', quoteId: 'draft', workspaceId: 'ws_test', status: 'sent' }); // not resolved → ignored

  // ===== ingest builds job memory (idempotent) =====
  const ing = await F.ingest();
  t.eq('memory built from resolved quotes only', ing.added, 8);
  t.eq('ingest is idempotent', (await F.ingest()).added, 0);
  t.eq('unresolved quotes are not remembered', (await F.memory()).length, 8);

  // ===== recall summarizes a matching segment =====
  const r = await F.recall({ serviceType: 'carpet_install', zip: '90210', leadSource: 'referral' });
  t.ok('recall matches the segment', r.sample === 4 && r.wins === 3 && r.losses === 1);
  t.eq('recall computes win rate', r.winRate, 75);
  t.eq('recall computes avg margin (wins)', r.avgMargin, 30);
  t.ok('recall computes timing (wins faster than losses)', r.avgDaysToWin === 2 && r.avgDaysToLoss === 8);
  t.eq('recall of an unseen segment is empty', (await F.recall({ zip: 'nowhere' })).sample, 0);

  // ===== recommendFor is explainable + grounded in evidence =====
  const rec = await F.recommendFor({ serviceType: 'carpet_install', zip: '90210', leadSource: 'referral' });
  t.ok('strong segment → prioritize recommendation', /Strong segment/.test(rec.recommendation) && rec.confidence > 40);
  t.ok('recommendation cites evidence (sample + win rate)', rec.evidence.sample === 4 && rec.evidence.winRate === 75);
  t.ok('timing tip suggests a fast follow-up window', rec.tips.some((x) => /Follow up within/.test(x)));
  const weak = await F.recommendFor({ serviceType: 'repair', zip: '11111', leadSource: 'google' });
  t.ok('weak segment → qualify-harder recommendation', /Weak segment/.test(weak.recommendation));
  const thin = await F.recommendFor({ serviceType: 'carpet_install', zip: '90210', leadSource: 'angi' });
  t.ok('thin/unseen segment is honest about low evidence', /Not enough history/.test(thin.recommendation) && thin.evidence.sample < 3);

  // ===== insights surface the strongest learnings =====
  const ins = await F.insights();
  t.ok('best service identified', ins.bestService && ins.bestService.key === 'carpet_install' && ins.bestService.winRate === 75);
  t.ok('best-margin neighborhood identified', ins.bestMarginNeighborhood && ins.bestMarginNeighborhood.key === '90210');
  t.ok('ideal follow-up window learned (not hardcoded)', typeof ins.idealFollowUpDays === 'number' && ins.idealFollowUpDays >= 1);
  t.ok('memory size reported', ins.memorySize === 8);

  // ===== no business mutation =====
  const before = JSON.stringify(data._store.quotes);
  await F.refresh();
  t.eq('the fabric mutates no quote', JSON.stringify(data._store.quotes), before);

  return t.report();
};
