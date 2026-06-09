/* Knowledge OS — index, permission-aware search, intent answers, audit log. */
'use strict';
const { makeRunner, setupEnv, load } = require('../helpers/harness');

module.exports = async function run() {
  const t = makeRunner('knowledge-fabric');
  const { G, data } = setupEnv();
  load('js/core/aaa-rbac.js');
  load('js/intelligence/knowledge-fabric.js');
  const K = G.AAA_KNOWLEDGE;
  const RB = G.AAA_RBAC;
  RB.setRole('owner');

  // seed knowledge: apartment turns + carpet repair for pet damage + margins by zip
  const q = (id, st, zip, total, margin, status, day, extra) => data.put('quotes', id, Object.assign({ id: id, quoteId: id, workspaceId: 'ws_test', serviceType: [st], zip: zip, leadSource: 'referral', customerTotal: total, marginPct: margin, status: status, resolvedAt: '2026-01-0' + day + 'T00:00:00Z', createdAt: '2026-01-0' + day + 'T00:00:00Z' }, extra || {}));
  await q('q1', 'apartment_turn', '90210', 1200, 35, 'won', 1);
  await q('q2', 'apartment_turn', '90210', 1300, 38, 'won', 2);
  await q('q3', 'apartment_turn', '11111', 1100, 20, 'lost', 3);
  await q('q4', 'pet_damage_repair', '90210', 600, 40, 'won', 4);
  await q('q5', 'pet_damage_repair', '90210', 650, 42, 'won', 5);
  await q('q6', 'pet_damage_repair', '11111', 500, 15, 'lost', 6);
  await q('q7', 'carpet_clean', '33333', 300, 22, 'won', 7);
  await q('q8', 'carpet_clean', '33333', 320, 24, 'won', 8);
  await data.put('communications', 'm1', { id: 'm1', workspaceId: 'ws_test', category: 'review', channel: 'sms', body: 'How did we do?', status: 'sent', createdAt: '2026-01-09' });
  await data.put('legal_records', 'lr1', { id: 'lr1', workspaceId: 'ws_test', type: 'incident', summary: 'water damage claim', version: 1, createdAt: '2026-01-10' });

  // ===== index =====
  const idx = await K.index();
  t.ok('builds a knowledge index across sources', idx.ok === true && idx.total >= 10);
  t.eq('index is idempotent', (await K.index()).added, 0);

  // ===== permission-aware search =====
  const owner = await K.search('apartment_turn', { role: 'owner' });
  t.ok('owner search returns financial quote nodes', owner.length >= 2 && owner.some((h) => h.kind === 'quote'));
  const crew = await K.search('water damage', { role: 'crew' });
  t.ok('crew CANNOT see legal nodes', !crew.some((h) => h.kind === 'legal'));
  const mgr = await K.search('water damage', { role: 'manager' });
  t.ok('manager CAN see legal nodes', mgr.some((h) => h.kind === 'legal'));
  t.ok('search explains why it matched', owner[0].why && /matched|recent/.test(owner[0].why));

  // ===== ask: last N apartment turns =====
  const a1 = await K.ask('last 10 apartment turns');
  t.ok('answers "last N apartment turns" with evidence', a1.ok === true && a1.intent === 'last_n' && a1.sample === 3 && a1.evidence.length === 3);

  // ===== ask: what closes best for pet damage =====
  const a2 = await K.ask('what repair method closes best for pet damage');
  t.ok('answers "closes best for pet damage"', a2.ok === true && a2.intent === 'closes_best' && /pet_damage_repair/.test(a2.answer));

  // ===== ask: highest-margin neighborhoods (financial → owner) =====
  const a3 = await K.ask('which neighborhoods produce the highest margins');
  t.ok('answers margin-by-neighborhood for owner', a3.ok === true && a3.intent === 'margin_by_zip' && /90210/.test(a3.answer) && a3.data.ranked[0].zip === '90210');
  RB.setRole('crew');
  const a3c = await K.ask('which neighborhoods produce the highest margins');
  t.eq('crew is denied the financial answer', a3c.error, 'FORBIDDEN');
  RB.setRole('owner');

  // ===== ask: review response rate =====
  const a4 = await K.ask('which review requests generate the highest response rate');
  t.ok('answers review response intent', a4.ok === true && a4.intent === 'review_response' && a4.sample >= 1);

  // ===== ask: keyword fallback =====
  const a5 = await K.ask('carpet_clean');
  t.ok('falls back to keyword search', a5.intent === 'keyword' && a5.sample >= 1);

  // ===== queries are audited =====
  t.ok('every ask is logged (audit trail)', (await K.queries()).length >= 5 && (await K.queries()).some((x) => x.intent === 'margin_by_zip'));

  return t.report();
};
