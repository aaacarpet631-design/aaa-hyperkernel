/*
 * AAA Knowledge Graph — "everything is a node; everything connects."
 *
 * Builds a real relationship graph from shared memory (no fabrication): every
 * customer, job, estimate, outcome, review, lead source, agent, agent decision,
 * technician (crew), and invoice becomes a node, linked by real foreign-key
 * relationships. Supports stats, neighbor traversal, arbitrary relationship-path
 * queries (path), honest pattern detection (best lead source, repeat customers,
 * coverage gaps, top agents), and technician profitability (Technician→Job→Margin).
 * The relationships the business reasons over are queryable end to end.
 */
;(function (global) {
  'use strict';

  function data() { return global.AAA_DATA; }

  // List a collection that may not exist yet; never throws, always an array.
  async function listSafe(d, coll) { try { return (await d.list(coll)) || []; } catch (_) { return []; } }
  // Stable slug for deriving a product node id from a free-text line description.
  function slug(s) { return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, ''); }

  function quoteMid(range) {
    if (range == null) return null;
    const nums = String(range).replace(/,/g, '').match(/\d+(?:\.\d+)?/g);
    if (!nums || !nums.length) return null;
    return nums.map(Number).reduce((a, b) => a + b, 0) / nums.length;
  }

  const Graph = {
    /** Build the full graph from current shared memory. */
    async build() {
      const d = data();
      const customers = await d.list('customers');
      const jobs = await d.list('jobs');
      const outcomes = await d.list('outcomes');
      const reviews = await d.list('review_requests');
      const decisions = await d.list('agent_decisions');
      // Newer entity sources (null-tolerant — empty/absent collections are fine).
      const crew = await listSafe(d, 'crew_members');
      const invoices = await listSafe(d, 'invoices');
      const expenses = await listSafe(d, 'expenses');
      const suppliers = await listSafe(d, 'suppliers');
      const campaigns = await listSafe(d, 'campaigns');

      const nodes = {};
      const edges = [];
      const adj = {};
      function addNode(id, type, label, dataObj) { if (!nodes[id]) { nodes[id] = { id: id, type: type, label: label, data: dataObj || {} }; adj[id] = []; } return id; }
      function addEdge(from, to, rel) {
        if (!nodes[from] || !nodes[to]) return;
        edges.push({ from: from, to: to, rel: rel });
        adj[from].push({ to: to, rel: rel, dir: 'out' });
        adj[to].push({ to: from, rel: rel, dir: 'in' });
      }

      customers.forEach((c) => {
        addNode('cust:' + c.id, 'customer', c.name || 'Customer', c);
        if (c.source) { addNode('src:' + c.source, 'source', c.source, { source: c.source }); addEdge('cust:' + c.id, 'src:' + c.source, 'from_source'); }
      });
      jobs.forEach((j) => {
        addNode('job:' + j.id, 'job', j.customerName || 'Job', j);
        if (j.customerId && nodes['cust:' + j.customerId]) addEdge('cust:' + j.customerId, 'job:' + j.id, 'has_job');
        (Array.isArray(j.estimates) ? j.estimates : []).forEach((e) => {
          const eid = 'est:' + (e.estimateId || (j.id + ':' + (e.type || '')));
          addNode(eid, 'estimate', e.type || 'Estimate', e);
          addEdge('job:' + j.id, eid, 'has_estimate');
        });
      });
      outcomes.forEach((o) => {
        addNode('out:' + o.id, 'outcome', o.result || 'outcome', o);
        if (o.jobId && nodes['job:' + o.jobId]) addEdge('job:' + o.jobId, 'out:' + o.id, 'has_outcome');
      });
      (reviews || []).forEach((r) => {
        addNode('rev:' + r.id, 'review', r.status || 'review', r);
        if (r.jobId && nodes['job:' + r.jobId]) addEdge('job:' + r.jobId, 'rev:' + r.id, 'has_review');
      });
      decisions.forEach((dec) => {
        addNode('dec:' + dec.id, 'decision', dec.agent || 'decision', dec);
        const aid = 'agent:' + (dec.agent || 'unknown');
        addNode(aid, 'agent', dec.agent || 'agent', { agent: dec.agent });
        addEdge('dec:' + dec.id, aid, 'by_agent');
        if (dec.jobId && nodes['job:' + dec.jobId]) addEdge('dec:' + dec.id, 'job:' + dec.jobId, 'about_job');
      });
      // Technicians (crew) → the jobs they worked (job.assigneeIds).
      crew.forEach((m) => { addNode('tech:' + m.id, 'technician', m.name || 'Technician', m); });
      jobs.forEach((j) => {
        (Array.isArray(j.assigneeIds) ? j.assigneeIds : []).forEach((aid) => {
          if (nodes['tech:' + aid]) addEdge('tech:' + aid, 'job:' + j.id, 'worked_job');
        });
      });
      // Invoices → their job and their customer; line items → product nodes.
      invoices.forEach((inv) => {
        addNode('inv:' + inv.id, 'invoice', inv.status || 'invoice', inv);
        if (inv.jobId && nodes['job:' + inv.jobId]) addEdge('job:' + inv.jobId, 'inv:' + inv.id, 'has_invoice');
        if (inv.customerId && nodes['cust:' + inv.customerId]) addEdge('cust:' + inv.customerId, 'inv:' + inv.id, 'billed_customer');
        (Array.isArray(inv.items) ? inv.items : []).forEach((it) => {
          const name = String((it && it.description) || '').trim(); if (!name) return;
          const pid = 'prod:' + slug(name);
          addNode(pid, 'product', name, { name: name });
          addEdge('inv:' + inv.id, pid, 'includes_product');
        });
      });
      // Expenses → their job; suppliers → the expenses they billed.
      expenses.forEach((e) => {
        addNode('exp:' + e.id, 'expense', e.category || 'expense', e);
        if (e.jobId && nodes['job:' + e.jobId]) addEdge('job:' + e.jobId, 'exp:' + e.id, 'has_expense');
      });
      suppliers.forEach((s) => { addNode('sup:' + s.id, 'supplier', s.name || 'Supplier', s); });
      expenses.forEach((e) => { if (e.supplierId && nodes['sup:' + e.supplierId]) addEdge('sup:' + e.supplierId, 'exp:' + e.id, 'supplied'); });
      // Campaigns → the customers they acquired.
      campaigns.forEach((c) => { addNode('camp:' + c.id, 'campaign', c.name || 'Campaign', c); });
      customers.forEach((c) => { if (c.campaignId && nodes['camp:' + c.campaignId]) addEdge('camp:' + c.campaignId, 'cust:' + c.id, 'acquired'); });

      return { nodes: nodes, edges: edges, adj: adj,
        list: Object.keys(nodes).map((k) => nodes[k]),
        customers: customers, jobs: jobs, outcomes: outcomes, decisions: decisions,
        crew: crew, invoices: invoices, expenses: expenses, suppliers: suppliers, campaigns: campaigns };
    },

    /** Node-type counts + edge count + most-connected nodes. */
    async stats() {
      const g = await this.build();
      const byType = {};
      g.list.forEach((n) => { byType[n.type] = (byType[n.type] || 0) + 1; });
      const connected = g.list
        .map((n) => ({ id: n.id, type: n.type, label: n.label, degree: (g.adj[n.id] || []).length }))
        .sort((a, b) => b.degree - a.degree).slice(0, 8);
      return { nodeCount: g.list.length, edgeCount: g.edges.length, byType: byType, mostConnected: connected };
    },

    /**
     * Shortest relationship PATH between two nodes (BFS over the graph), so any
     * chain the business reasons over is queryable end to end — e.g.
     *   path('cust:c1', 'rev:r1')  → Customer → Job → Review
     *   path('tech:t1', 'out:o1')  → Technician → Job → Outcome
     * Returns an ordered array of {id, type, label, rel} hops, or null if no
     * path within maxDepth (default 6).
     */
    async path(fromId, toId, maxDepth) {
      const g = await this.build();
      if (!g.nodes[fromId] || !g.nodes[toId]) return null;
      const max = maxDepth || 6;
      const seen = {}; seen[fromId] = true;
      const queue = [[{ id: fromId, rel: null }]];
      while (queue.length) {
        const p = queue.shift();
        const last = p[p.length - 1].id;
        if (last === toId) return p.map((h) => ({ id: h.id, type: g.nodes[h.id].type, label: g.nodes[h.id].label, rel: h.rel }));
        if (p.length > max) continue;
        (g.adj[last] || []).forEach((e) => { if (!seen[e.to]) { seen[e.to] = true; queue.push(p.concat([{ id: e.to, rel: e.rel }])); } });
      }
      return null;
    },

    /**
     * Technician → Job → Margin: per-crew-member productivity + profitability
     * derived from real assignments (job.assigneeIds), outcomes, and estimate
     * margins. Honest about thin data (null margin/winRate when none). Ranked by
     * average margin, best first.
     */
    async technicianPerformance() {
      const g = await this.build();
      const outByJob = {}; g.outcomes.forEach((o) => { if (o.jobId) outByJob[o.jobId] = o; });
      const perf = {};
      (g.crew || []).forEach((m) => { perf[m.id] = { id: m.id, name: m.name || 'Technician', jobs: 0, won: 0, revenue: 0, margins: [] }; });
      g.jobs.forEach((j) => {
        (Array.isArray(j.assigneeIds) ? j.assigneeIds : []).forEach((aid) => {
          const p = perf[aid]; if (!p) return;
          p.jobs++;
          const o = outByJob[j.id];
          if (o && o.result === 'won') { p.won++; const amt = Number(o.finalAmount); if (isFinite(amt)) p.revenue += amt; }
          const est = Array.isArray(j.estimates) && j.estimates.length ? j.estimates[0] : null;
          const m = est && est.marginPct != null ? Number(est.marginPct) : null;
          if (m != null && isFinite(m)) p.margins.push(m);
        });
      });
      return Object.values(perf).map((p) => ({
        id: p.id, name: p.name, jobs: p.jobs, won: p.won,
        winRate: p.jobs ? Math.round((p.won / p.jobs) * 100) : null,
        revenue: Math.round(p.revenue),
        avgMargin: p.margins.length ? Math.round(p.margins.reduce((a, b) => a + b, 0) / p.margins.length) : null
      })).sort((a, b) => (b.avgMargin || 0) - (a.avgMargin || 0) || b.jobs - a.jobs);
    },

    /** A node plus its neighbors grouped by relationship. */
    async node(id) {
      const g = await this.build();
      const n = g.nodes[id];
      if (!n) return null;
      const groups = {};
      (g.adj[id] || []).forEach((e) => {
        (groups[e.rel] = groups[e.rel] || []).push(g.nodes[e.to]);
      });
      return { node: n, groups: groups };
    },

    /** Honest, graph-derived business patterns. */
    async insights() {
      const g = await this.build();
      // best lead source by win rate
      const custSource = {}; g.customers.forEach((c) => { custSource[c.id] = c.source || 'unknown'; });
      const jobSource = {}; g.jobs.forEach((j) => { jobSource[j.id] = j.source || custSource[j.customerId] || 'unknown'; });
      const srcStats = {};
      g.outcomes.forEach((o) => {
        const s = jobSource[o.jobId] || 'unknown';
        const b = srcStats[s] || (srcStats[s] = { source: s, won: 0, lost: 0 });
        if (o.result === 'won') b.won++; else if (o.result === 'lost') b.lost++;
      });
      let bestSource = null;
      Object.values(srcStats).forEach((b) => {
        const wl = b.won + b.lost; if (!wl) return;
        const rate = b.won / wl;
        if (!bestSource || rate > bestSource.rate) bestSource = { source: b.source, rate: rate, won: b.won, total: wl };
      });
      // repeat customers (>1 job)
      const jobsPerCust = {}; g.jobs.forEach((j) => { if (j.customerId) jobsPerCust[j.customerId] = (jobsPerCust[j.customerId] || 0) + 1; });
      const repeatCustomers = Object.keys(jobsPerCust).filter((c) => jobsPerCust[c] > 1).length;
      // coverage gaps
      const jobsWithOutcome = {}; g.outcomes.forEach((o) => { if (o.jobId) jobsWithOutcome[o.jobId] = true; });
      const noEstimate = g.jobs.filter((j) => !(Array.isArray(j.estimates) && j.estimates.length)).length;
      const noOutcome = g.jobs.filter((j) => !jobsWithOutcome[j.id]).length;
      // top agent by avg supervisor score
      const agentScores = {};
      g.decisions.forEach((dec) => {
        if (typeof dec.score !== 'number') return;
        const a = agentScores[dec.agent] || (agentScores[dec.agent] = { agent: dec.agent, sum: 0, n: 0 });
        a.sum += dec.score; a.n++;
      });
      let topAgent = null;
      Object.values(agentScores).forEach((a) => { const avg = a.sum / a.n; if (!topAgent || avg > topAgent.avg) topAgent = { agent: a.agent, avg: avg, n: a.n }; });
      return { bestSource: bestSource, repeatCustomers: repeatCustomers, noEstimate: noEstimate, noOutcome: noOutcome, topAgent: topAgent };
    }
  };

  global.AAA_GRAPH = Graph;
})(typeof window !== 'undefined' ? window : this);
