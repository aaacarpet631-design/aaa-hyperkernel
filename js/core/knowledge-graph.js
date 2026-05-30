/*
 * AAA Knowledge Graph — "everything is a node; everything connects."
 *
 * Builds a real relationship graph from shared memory (no fabrication): every
 * customer, job, estimate, outcome, review, lead source, agent, and agent
 * decision becomes a node, linked by real foreign-key relationships. Supports
 * stats, neighbor traversal, and honest pattern detection (best lead source,
 * repeat customers, coverage gaps, top agents) for discovery and insight.
 */
;(function (global) {
  'use strict';

  function data() { return global.AAA_DATA; }

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

      return { nodes: nodes, edges: edges, adj: adj,
        list: Object.keys(nodes).map((k) => nodes[k]),
        customers: customers, jobs: jobs, outcomes: outcomes, decisions: decisions };
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
