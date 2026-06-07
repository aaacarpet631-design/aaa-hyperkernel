/* Owner Copilot — daily briefing aggregation, attention summary, priorities, persistence. */
'use strict';
const { makeRunner, setupEnv, load } = require('../helpers/harness');

module.exports = async function run() {
  const t = makeRunner('owner-copilot');
  const { G, data } = setupEnv({ fixedISO: '2026-06-07T09:00:00Z' });
  load('js/intelligence/owner-copilot.js');
  const CP = G.AAA_OWNER_COPILOT;

  // ===== empty: all clear, never throws =====
  const b0 = await CP.briefing();
  t.ok('briefing degrades gracefully', b0.ok === true && /All clear/.test(b0.headline) && b0.attentionItems === 0);

  // ===== seed across systems =====
  // revenue: payments yesterday + this month
  await data.put('payments', 'p1', { id: 'p1', workspaceId: 'ws_test', amount: 1200, receivedAt: '2026-06-06T10:00:00Z' }); // yesterday
  await data.put('payments', 'p2', { id: 'p2', workspaceId: 'ws_test', amount: 800, receivedAt: '2026-06-02T10:00:00Z' });  // this month
  // open quotes + follow-up due + at risk
  await data.put('quotes', 'q1', { id: 'q1', quoteId: 'q1', workspaceId: 'ws_test', status: 'sent', customerName: 'Jane', sentAt: '2026-06-01T00:00:00Z', risk: 20 }); // due (6 days > 3)
  await data.put('quotes', 'q2', { id: 'q2', quoteId: 'q2', workspaceId: 'ws_test', status: 'reviewed', customerName: 'Bob', risk: 70 }); // at risk (risk 70)
  await data.put('quotes', 'q3', { id: 'q3', quoteId: 'q3', workspaceId: 'ws_test', status: 'won' });
  // modules
  G.AAA_PROPOSAL_ENGINE = { list: async () => [{ id: 'prop1', title: 'Follow up faster', status: 'pending' }] };
  G.AAA_EXECUTIVE_COUNCIL = { list: async () => [{ id: 'exr1', status: 'pending_approval' }] };
  G.AAA_AGENT_COUNCIL = { list: async () => [{ id: 'cs1', status: 'pending_approval' }] };
  G.AAA_RELIABILITY = { incidents: async () => [{ id: 'inc1', title: 'Transport failure critical', severity: 'crit' }] };
  G.AAA_FINANCIAL_INTELLIGENCE = { anomalies: async () => ({ anomalies: [{ kind: 'expense_spike', month: '2026-05', value: 5000 }] }), arAging: async () => ({ overdue: 800 }), snapshots: async () => [{ netMargin: 30, dso: 20 }, { netMargin: 25, dso: 18 }] };

  // ===== full briefing aggregates every section =====
  const b = await CP.briefing();
  t.eq('revenue yesterday', b.sections.revenueYesterday.count, 1200);
  t.eq('revenue this month', b.sections.revenueThisMonth.count, 2000);
  t.ok('open quotes counted (excludes won)', b.sections.openQuotes.count === 2);
  t.ok('follow-ups due detected', b.sections.followUpsDue.count === 1 && b.sections.followUpsDue.items[0].customer === 'Jane');
  t.ok('jobs at risk detected', b.sections.jobsAtRisk.count >= 1);
  t.ok('cash-flow alerts include anomaly + overdue A/R', b.sections.cashFlowAlerts.count === 2 && b.sections.cashFlowAlerts.items.some((x) => x.kind === 'overdue_ar'));
  t.ok('KPI changes from snapshots', b.sections.kpiChanges.count >= 1 && b.sections.kpiChanges.items.some((x) => x.kpi === 'net margin'));
  t.eq('council decisions awaiting approval (council + exec)', b.sections.councilDecisions.count, 2);
  t.eq('learning proposals awaiting review', b.sections.learningProposals.count, 1);
  t.eq('critical operational issues', b.sections.criticalIssues.count, 1);
  t.ok('every section is source-linked + explainable', Object.keys(b.sections).every((k) => b.sections[k].source && b.sections[k].explain));

  // ===== priorities are ranked (critical first) =====
  t.ok('priorities rank the critical incident first', b.priorities[0].kind === 'incident');
  t.ok('headline names the top item + flags critical', /Transport failure critical/.test(b.headline) && /critical/.test(b.headline));
  t.ok('read-only disclaimer present', /surfaces decisions, it makes none/.test(b.note));

  // ===== 60-second attention summary =====
  const sum = await CP.attentionSummary();
  t.ok('attention summary gives headline + top 3', sum.ok === true && sum.top.length <= 3 && sum.top.length >= 1 && sum.attentionItems > 0 && sum.revenueThisMonth === 2000);

  // ===== generate persists a dated briefing (idempotent per day) =====
  const g1 = await CP.generate();
  t.ok('a dated briefing is persisted', g1.ok === true && (await CP.list()).some((x) => x.date === '2026-06-07'));
  await CP.generate();
  t.eq('generation is idempotent per day', (await CP.list()).filter((x) => x.date === '2026-06-07').length, 1);

  return t.report();
};
