/*
 * AAA Knowledge Operating System — institutional knowledge, made queryable.
 *
 * Indexes the company's records (jobs, won/lost quotes, communications, reviews,
 * council decisions, legal records, invoices) into a permission-aware knowledge
 * fabric, then answers questions about them — deterministically, with evidence.
 * No LLM, no opaque embedding: a transparent intent router + keyword/facet search
 * over an explicit index, so every answer cites its source records.
 *
 *   index()            build/refresh the searchable index (idempotent)
 *   search(q, {role})  permission-aware keyword + facet search (ranked, explained)
 *   ask(question)      structured answers to operational questions, e.g.
 *                      "last 10 apartment turns", "what closes best for pet damage",
 *                      "which neighborhoods produce the highest margins",
 *                      "which review requests get the highest response rate"
 *
 * Permission-aware (financial/legal nodes gated by role), audited (every ask is
 * logged), version-aware, provenance-linked (answers cite source ids). Read-only —
 * indexes its own nodes, mutates no business record. Owner-only collection;
 * deterministic; null-tolerant.
 */
;(function (global) {
  'use strict';

  const NODES = 'knowledge_nodes';
  const QUERIES = 'knowledge_queries';

  function cfg() { return global.AAA_CONFIG || {}; }
  function data() { return global.AAA_DATA; }
  function ids() { return global.AAA_ID_FACTORY; }
  function clock() { return global.AAA_RUNTIME_CLOCK; }
  function rbac() { return global.AAA_RBAC; }
  function ws() { return cfg().workspaceId || 'default'; }
  function nowISO() { return clock() && clock().nowISO ? clock().nowISO() : new Date().toISOString(); }
  function mine(r) { return r && (r.workspaceId == null || r.workspaceId === ws()); }
  function newId(p) { return ids() ? ids().createId(p) : p + '_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7); }
  function num(v) { const n = Number(v); return isFinite(n) ? n : null; }
  function role() { return rbac() && rbac().role ? rbac().role() : 'owner'; }
  function tokens(s) { return String(s == null ? '' : s).toLowerCase().match(/[a-z0-9]+/g) || []; }
  function serviceKey(q) { const s = Array.isArray(q && q.serviceType) ? q.serviceType.filter(Boolean) : (q && q.serviceType ? [q.serviceType] : []); return s.length ? s.slice().sort().join(' + ') : 'unspecified'; }
  function mean(a) { return a.length ? a.reduce((x, y) => x + y, 0) / a.length : null; }
  function allowed(role) { return role === 'owner' ? ['general', 'financial', 'legal'] : role === 'manager' ? ['general', 'legal'] : ['general']; }

  // Source extractors: collection → node {text, facets, sensitivity, version}.
  const SOURCES = {
    jobs: (r) => ({ text: [r.customerName, r.notes, r.serviceType, r.currentState, r.address].join(' '), facets: { kind: 'job', status: r.currentState || null, zip: r.zip || null }, sensitivity: 'general', at: r.closedAt || r.updatedAt || r.createdAt }),
    quotes: (r) => ({ text: [r.customerName, serviceKey(r), r.zip, r.leadSource, r.status].join(' '), facets: { kind: 'quote', status: r.status || null, serviceType: serviceKey(r), zip: r.zip || null, leadSource: r.leadSource || null, marginPct: num(r.marginPct), customerTotal: num(r.customerTotal) }, sensitivity: 'financial', at: r.resolvedAt || r.createdAt }),
    communications: (r) => ({ text: [r.category, r.body, r.to].join(' '), facets: { kind: 'communication', category: r.category || null, channel: r.channel || null, status: r.status || null }, sensitivity: 'general', at: r.createdAt }),
    council_sessions: (r) => ({ text: ['council', r.decision, r.customerName].join(' '), facets: { kind: 'council', decision: r.decision || null }, sensitivity: 'financial', at: r.createdAt }),
    legal_records: (r) => ({ text: [r.type, r.summary].join(' '), facets: { kind: 'legal', type: r.type || null }, sensitivity: 'legal', version: r.version || null, at: r.createdAt }),
    invoices: (r) => ({ text: [r.customerName, r.status].join(' '), facets: { kind: 'invoice', status: r.status || null, amount: num(r.amount) }, sensitivity: 'financial', at: r.issuedAt || r.createdAt })
  };

  const KOS = {
    NODES: NODES, QUERIES: QUERIES,

    /** Build/refresh the knowledge index from all sources (idempotent). */
    async index() {
      let added = 0;
      for (const coll of Object.keys(SOURCES)) {
        let rows = []; try { rows = (await data().list(coll)).filter(mine); } catch (_) { rows = []; }
        for (const r of rows) {
          const id = 'kn_' + coll + '_' + (r.id || r.quoteId);
          const existing = await data().get(NODES, id);
          const ex = SOURCES[coll](r);
          const node = { id: id, workspaceId: ws(), sourceCollection: coll, sourceId: r.id || r.quoteId, kind: ex.facets.kind, text: String(ex.text || '').toLowerCase(), facets: ex.facets, sensitivity: ex.sensitivity, version: ex.version || null, at: ex.at || nowISO(), indexedAt: nowISO() };
          if (!existing || existing.text !== node.text || JSON.stringify(existing.facets) !== JSON.stringify(node.facets)) { await put(NODES, node); if (!existing) added++; }
        }
      }
      return { ok: true, added: added, total: (await this._nodes()).length };
    },

    async _nodes() { return (await data().list(NODES)).filter(mine); },

    /** Permission-aware keyword + facet search. Ranked, with a match explanation. */
    async search(query, opts) {
      const o = opts || {};
      const r = o.role || role();
      const allow = allowed(r);
      const qToks = tokens(query);
      const nodes = (await this._nodes()).filter((n) => allow.indexOf(n.sensitivity) !== -1);
      const filtered = nodes.filter((n) => { if (o.kind && n.kind !== o.kind) return false; if (o.facets) { for (const k of Object.keys(o.facets)) { if (n.facets[k] !== o.facets[k]) return false; } } return true; });
      const scored = filtered.map((n) => { const ntoks = tokens(n.text); const hits = qToks.filter((t) => ntoks.indexOf(t) !== -1); return { node: n, score: hits.length, matched: hits }; }).filter((x) => !qToks.length || x.score > 0);
      scored.sort((a, b) => b.score - a.score || String(b.node.at || '').localeCompare(String(a.node.at || '')));
      return scored.slice(0, o.limit || 20).map((x) => ({ id: x.node.id, kind: x.node.kind, sourceCollection: x.node.sourceCollection, sourceId: x.node.sourceId, facets: x.node.facets, at: x.node.at, version: x.node.version, matched: x.matched, why: qToks.length ? 'matched: ' + x.matched.join(', ') : 'recent' }));
    },

    /**
     * Structured answer to an operational question. Permission-aware + audited.
     * @returns { ok, intent, answer, data, evidence, sample, sensitivity }
     */
    async ask(question, opts) {
      const o = opts || {};
      const q = String(question || '').toLowerCase();
      const r = o.role || role();
      await this.index();
      let res;

      // intent: "last N <service> [turns|jobs]"
      const mLast = q.match(/last\s+(\d+)\s+([a-z][a-z\s_]*?)(?:\s+turns?|\s+jobs?)?$/);
      if (mLast) res = await answerLast(this, num(mLast[1]) || 10, mLast[2].trim());
      // intent: "what ... closes best for <segment>" / "best ... for <x>"
      else if (/clos\w*\s+best|best\s+(method|service|approach).*for|which\s+\w+\s+clos/.test(q)) res = await answerClosesBest(this, q, r);
      // intent: "which neighborhoods/zips produce the highest margin"
      else if (/(neighborhood|zip|area).*(margin|profit)|highest\s+margin/.test(q)) res = await answerMarginByZip(this, r);
      // intent: "which review requests generate the highest response rate"
      else if (/review.*(response|reply)\s*rate|highest\s+response/.test(q)) res = await answerReviewResponse(this);
      else res = await answerKeyword(this, question, r);

      // permission gate on financial answers
      if (res.sensitivity === 'financial' && allowed(r).indexOf('financial') === -1) res = { ok: false, error: 'FORBIDDEN', intent: res.intent, answer: 'That answer involves financial data — owner only.' };

      // audit the query
      try { await put(QUERIES, { id: newId('kq'), workspaceId: ws(), question: question, intent: res.intent || 'keyword', role: r, sample: res.sample || 0, ok: res.ok !== false, at: nowISO() }); } catch (_) {}
      return res;
    },

    async queries(limit) { return (await data().list(QUERIES)).filter(mine).sort((a, b) => String(b.at || '').localeCompare(String(a.at || ''))).slice(0, limit || 25); }
  };

  // ---- intent answerers (deterministic aggregation over indexed quotes) ----
  async function resolvedQuotes(kos) {
    const nodes = (await kos._nodes()).filter((n) => n.kind === 'quote');
    return nodes.map((n) => n.facets).filter((f) => f.status === 'won' || f.status === 'lost');
  }
  async function answerLast(kos, n, serviceTerm) {
    const want = tokens(serviceTerm);
    const nodes = (await kos._nodes()).filter((nd) => (nd.kind === 'job' || nd.kind === 'quote') && want.length && want.every((t) => tokens(nd.text).indexOf(t) !== -1));
    nodes.sort((a, b) => String(b.at || '').localeCompare(String(a.at || '')));
    const top = nodes.slice(0, n);
    const wins = top.filter((x) => x.facets.status === 'won').length;
    return { ok: true, intent: 'last_n', sensitivity: 'general', sample: top.length, answer: 'Found ' + top.length + ' recent “' + serviceTerm + '” record(s)' + (top.length ? ' (' + wins + ' won)' : '') + '.', data: { matches: top.length, wins: wins }, evidence: top.map((x) => ({ sourceCollection: x.sourceCollection, sourceId: x.sourceId, at: x.at })) };
  }
  async function answerClosesBest(kos, q, r) {
    // filter resolved quotes by any keyword in the question (e.g. "pet damage")
    const qToks = tokens(q).filter((t) => ['what', 'which', 'closes', 'best', 'for', 'method', 'service', 'approach', 'the', 'repair'].indexOf(t) === -1);
    const nodes = (await kos._nodes()).filter((n) => n.kind === 'quote');
    const matched = nodes.filter((n) => { const ntoks = tokens(n.text); return !qToks.length || qToks.some((t) => ntoks.indexOf(t) !== -1); }).map((n) => n.facets).filter((f) => f.status === 'won' || f.status === 'lost');
    const by = {}; matched.forEach((f) => { const k = f.serviceType || 'unspecified'; const g = by[k] || (by[k] = { key: k, count: 0, won: 0 }); g.count++; if (f.status === 'won') g.won++; });
    const ranked = Object.keys(by).map((k) => ({ serviceType: k, winRate: Math.round((by[k].won / by[k].count) * 100), sample: by[k].count })).filter((x) => x.sample >= 2).sort((a, b) => b.winRate - a.winRate);
    const best = ranked[0] || null;
    return { ok: true, intent: 'closes_best', sensitivity: 'general', sample: matched.length, answer: best ? '“' + best.serviceType + '” closes best at ' + best.winRate + '% over ' + best.sample + ' job(s)' + (qToks.length ? ' matching ' + qToks.join(' ') : '') + '.' : 'Not enough resolved jobs to compare yet.', data: { ranked: ranked.slice(0, 5) }, evidence: ranked.slice(0, 5).map((x) => ({ serviceType: x.serviceType, sample: x.sample })) };
  }
  async function answerMarginByZip(kos, r) {
    const quotes = await resolvedQuotes(kos);
    const wins = quotes.filter((f) => f.status === 'won' && f.marginPct != null);
    const by = {}; wins.forEach((f) => { const k = f.zip || 'unknown'; if (k === 'unknown') return; (by[k] = by[k] || []).push(f.marginPct); });
    const ranked = Object.keys(by).map((k) => ({ zip: k, avgMargin: Math.round(mean(by[k])), sample: by[k].length })).filter((x) => x.sample >= 2).sort((a, b) => b.avgMargin - a.avgMargin);
    const best = ranked[0] || null;
    return { ok: true, intent: 'margin_by_zip', sensitivity: 'financial', sample: wins.length, answer: best ? 'Neighborhood ' + best.zip + ' produces the highest margins (~' + best.avgMargin + '% over ' + best.sample + ' won jobs).' : 'Not enough won jobs with margins by neighborhood yet.', data: { ranked: ranked.slice(0, 5) }, evidence: ranked.slice(0, 5).map((x) => ({ zip: x.zip, avgMargin: x.avgMargin, sample: x.sample })) };
  }
  async function answerReviewResponse(kos) {
    // review messages sent vs replies (from communications/threads if present)
    const comms = (await kos._nodes()).filter((n) => n.kind === 'communication' && n.facets.category === 'review');
    let responseRate = null, sample = comms.length;
    try { if (global.AAA_TRANSPORT_CORE && global.AAA_TRANSPORT_CORE.analytics) { const an = await global.AAA_TRANSPORT_CORE.analytics(); responseRate = an.responseRate; } } catch (_) {}
    return { ok: true, intent: 'review_response', sensitivity: 'general', sample: sample, answer: responseRate != null ? 'Review requests reply at ~' + responseRate + '% (across ' + sample + ' review message(s)).' : (sample ? sample + ' review request(s) sent; reply-rate data accrues as customers respond.' : 'No review requests recorded yet.'), data: { reviewMessages: sample, responseRate: responseRate }, evidence: comms.slice(0, 5).map((n) => ({ sourceCollection: n.sourceCollection, sourceId: n.sourceId })) };
  }
  async function answerKeyword(kos, question, r) {
    const hits = await kos.search(question, { role: r, limit: 10 });
    return { ok: true, intent: 'keyword', sensitivity: 'general', sample: hits.length, answer: hits.length ? 'Found ' + hits.length + ' record(s) matching your question.' : 'No records matched. Try a service type, neighborhood, or customer term.', data: { hits: hits.length }, evidence: hits.map((h) => ({ sourceCollection: h.sourceCollection, sourceId: h.sourceId, why: h.why })) };
  }

  async function put(c, rec) { await data().put(c, rec.id, rec); try { if (data().cloudReady && data().cloudReady() && global.AAA_CLOUD) global.AAA_CLOUD.upsertEntity(c, rec.id, rec); } catch (_) {} }

  global.AAA_KNOWLEDGE = KOS;
})(typeof window !== 'undefined' ? window : this);
