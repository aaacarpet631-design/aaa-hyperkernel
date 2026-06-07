/* Knowledge Graph — entity nodes, technician/invoice edges, path queries, tech margin. */
'use strict';
const { makeRunner, setupEnv, load } = require('../helpers/harness');

module.exports = async function run() {
  const t = makeRunner('knowledge-graph');
  const { G, data } = setupEnv();
  load('js/core/knowledge-graph.js');
  const GR = G.AAA_GRAPH;

  // seed a small but complete business: customer → job (crew-worked) → outcome/review/invoice
  await data.put('customers', 'c1', { id: 'c1', name: 'Acme Apts', source: 'referral' });
  await data.put('crew_members', 't1', { id: 't1', name: 'Dana' });
  await data.put('crew_members', 't2', { id: 't2', name: 'Lee' });
  await data.put('jobs', 'j1', { id: 'j1', customerId: 'c1', customerName: 'Acme Apts', assigneeIds: ['t1'], estimates: [{ type: 'carpet', marginPct: 40 }] });
  await data.put('jobs', 'j2', { id: 'j2', customerId: 'c1', customerName: 'Acme Apts', assigneeIds: ['t1', 't2'], estimates: [{ type: 'tile', marginPct: 20 }] });
  await data.put('outcomes', 'o1', { id: 'o1', jobId: 'j1', result: 'won', finalAmount: 1000 });
  await data.put('outcomes', 'o2', { id: 'o2', jobId: 'j2', result: 'lost' });
  await data.put('review_requests', 'r1', { id: 'r1', jobId: 'j1', status: 'sent' });
  await data.put('invoices', 'inv1', { id: 'inv1', jobId: 'j1', customerId: 'c1', amount: 1000, status: 'paid' });

  // ===== new entity node types appear in the graph =====
  const st = await GR.stats();
  t.eq('technician nodes built from crew_members', st.byType.technician, 2);
  t.eq('invoice node built from invoices', st.byType.invoice, 1);
  t.ok('customer/job/outcome/review nodes still present', st.byType.customer === 1 && st.byType.job === 2 && st.byType.outcome === 2 && st.byType.review === 1);

  // ===== new relationships are real edges =====
  const techNode = await GR.node('tech:t1');
  t.ok('technician → worked_job edges', techNode.groups.worked_job && techNode.groups.worked_job.length === 2);
  const jobNode = await GR.node('job:j1');
  t.ok('job → has_invoice edge', jobNode.groups.has_invoice && jobNode.groups.has_invoice.length === 1);
  const custNode = await GR.node('cust:c1');
  t.ok('customer → billed_customer (invoice) edge', custNode.groups.billed_customer && custNode.groups.billed_customer.length === 1);

  // ===== relationships are QUERYABLE end to end (path/BFS) =====
  const p = await GR.path('cust:c1', 'rev:r1');
  t.ok('Customer → Job → Review path is queryable', Array.isArray(p) && p[0].id === 'cust:c1' && p[p.length - 1].id === 'rev:r1');
  t.ok('path reports node types along the chain', p.some((h) => h.type === 'job') && p[p.length - 1].type === 'review');
  const p2 = await GR.path('tech:t1', 'out:o1');
  t.ok('Technician → Job → Outcome path is queryable', Array.isArray(p2) && p2.map((h) => h.type).join('>') === 'technician>job>outcome');
  t.eq('no path returns null', await GR.path('tech:t1', 'tech:t2', 1), null);
  t.eq('unknown node returns null', await GR.path('cust:nope', 'rev:r1'), null);

  // ===== Technician → Job → Margin analytic =====
  const perf = await GR.technicianPerformance();
  const dana = perf.find((x) => x.id === 't1');
  t.eq('technician job count from assignments', dana.jobs, 2);
  t.eq('technician win count from outcomes', dana.won, 1);
  t.eq('technician win rate', dana.winRate, 50);
  t.eq('technician avg margin from estimates (40,20)', dana.avgMargin, 30);
  t.eq('technician realized revenue from won outcome', dana.revenue, 1000);
  t.ok('ranked by avg margin (best first)', perf[0].avgMargin >= (perf[perf.length - 1].avgMargin || 0));

  // ===== null-tolerant: no crew/invoices collections at all =====
  const env2 = setupEnv();
  load('js/core/knowledge-graph.js');
  await env2.data.put('jobs', 'jx', { id: 'jx', customerId: 'cx' });
  const st2 = await G.AAA_GRAPH.stats();
  t.ok('graph builds with no crew/invoice data (no throw)', st2.nodeCount >= 1 && (st2.byType.technician || 0) === 0);
  t.eq('technicianPerformance empty when no crew', (await G.AAA_GRAPH.technicianPerformance()).length, 0);

  return t.report();
};
