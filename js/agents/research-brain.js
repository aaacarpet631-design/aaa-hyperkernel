/*
 * AAA Research Brain — read-only client for the separate AI-Q research service.
 *
 * NVIDIA AI-Q Blueprint (deep/shallow research agents, web search, citation-backed
 * reports) runs as its OWN hosted service. This module is the AAA-side client: it
 * sends a research question through the /api/research proxy (which holds the
 * service URL + token server-side) and stores the returned report + citations.
 *
 * SAFETY BOUNDARY (enforced by construction): the Research Brain is a read-only
 * strategy brain. It ONLY writes to its own `research_reports` collection. It does
 * NOT call — and has no reference to — anything that mutates jobs, quotes,
 * invoices, payments, accounting, or customer records. Per the integration plan,
 * AI-Q stays a read-only research/strategy advisor until it is independently
 * secured. Reports are advisory: a human reads them and decides.
 *
 * Honest by construction: if the backend isn't configured the proxy returns
 * RESEARCH_NOT_CONFIGURED and this client surfaces that plainly — it never
 * fabricates a report or citations.
 */
;(function (global) {
  'use strict';

  function cfg() { return global.AAA_CONFIG || {}; }
  function data() { return global.AAA_DATA; }
  function ids() { return global.AAA_ID_FACTORY; }
  function clock() { return global.AAA_RUNTIME_CLOCK; }

  function newId(p) { return ids() ? ids().createId(p) : (p + '_' + Date.now()); }
  function now() { return clock() ? clock().now() : Date.now(); }
  function nowISO() { return clock() && clock().nowISO ? clock().nowISO() : new Date().toISOString(); }

  function endpoint() {
    return (cfg().researchEndpoint) || (cfg().flag ? cfg().flag('researchEndpoint', '/api/research') : '/api/research');
  }

  // Carpet/flooring research templates — frame a focused brief for the deep
  // research agents. {q} is the owner's subject (a city, competitor, material…).
  const TEMPLATES = {
    competitors: {
      label: 'Competitor research',
      prompt: 'Research the top carpet cleaning, repair, and flooring competitors for: {q}. ' +
        'For each, summarize services, pricing signals, positioning, reviews/reputation, and visible weaknesses. ' +
        'Finish with concrete opportunities for an independent operator to win share. Cite sources.'
    },
    google_ads: {
      label: 'Google Ads strategy',
      prompt: 'Analyze Google Ads / paid-search strategy for carpet & flooring services in: {q}. ' +
        'Cover likely high-intent keywords, ad angles competitors run, rough CPC ranges, and budget/landing-page recommendations for a small operator. Cite sources.'
    },
    seo: {
      label: 'SEO opportunities',
      prompt: 'Find local SEO and content opportunities for a carpet cleaning/repair/flooring business in: {q}. ' +
        'Cover Google Business Profile, high-value local keywords, content gaps competitors miss, and citation/backlink ideas. Cite sources.'
    },
    market_report: {
      label: 'Market report',
      prompt: 'Build a concise market report for carpet & flooring services in: {q}. ' +
        'Cover demand drivers, seasonality, typical price ranges by service, customer segments, and 3-5 strategic recommendations. Cite sources.'
    },
    pricing_trends: {
      label: 'Pricing trends',
      prompt: 'Study current pricing trends for carpet cleaning, repair, stretching, and flooring installation relevant to: {q}. ' +
        'Give typical ranges, what drives premium pricing, and how a small operator should position. Cite sources.'
    },
    materials: {
      label: 'Product / material comparison',
      prompt: 'Compare carpet/flooring products and materials for: {q}. ' +
        'Cover durability, cost, install difficulty, best use cases, and what to recommend to residential vs commercial customers. Cite sources.'
    },
    tax_accounting: {
      label: 'Tax / accounting research',
      prompt: 'Summarize tax and accounting considerations relevant to a small carpet/flooring service business regarding: {q}. ' +
        'Cover common deductions, recordkeeping, and what to confirm with a CPA. This is general research, NOT tax advice. Cite sources.'
    }
  };

  const Research = {
    TEMPLATES: TEMPLATES,
    templateIds: function () { return Object.keys(TEMPLATES); },

    /** Configured when an endpoint exists. Actual backend readiness is reported
     *  by the proxy at call time (RESEARCH_NOT_CONFIGURED) — honest, not guessed. */
    isConfigured: function () { return !!endpoint(); },

    /**
     * Run a research query through the proxy and store the report. READ-ONLY:
     * persists only to `research_reports`; touches nothing else.
     * @param {string} question  free-text research question
     * @param {object} [opts]     { templateId, subject, topic }
     * @returns {Promise<object>} stored report record, or an honest error
     */
    async ask(question, opts) {
      opts = opts || {};
      const q = String(question || '').trim();
      if (!q) return { ok: false, error: 'NO_QUESTION' };
      if (typeof global.fetch !== 'function') return { ok: false, error: 'NO_FETCH' };

      let res, body;
      try {
        res = await global.fetch(endpoint(), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ message: q, topic: opts.topic || opts.templateId || null })
        });
      } catch (err) {
        return { ok: false, error: 'RESEARCH_UNAVAILABLE', message: (err && err.message) || 'Network error reaching the research service.' };
      }
      try { body = await res.json(); } catch (_) { body = null; }
      if (!res.ok || !body || body.ok === false) {
        return { ok: false, error: (body && body.error) || 'RESEARCH_FAILED', message: (body && body.message) || ('HTTP ' + res.status), status: res.status };
      }

      const rec = {
        id: newId('research'),
        question: q,
        templateId: opts.templateId || null,
        subject: opts.subject || null,
        report: String(body.report || ''),
        citations: Array.isArray(body.citations) ? body.citations : [],
        status: 'complete',          // advisory; a human reviews it
        reviewOnly: true,            // marker: never auto-applied anywhere
        createdAt: nowISO(),
        createdAtMs: now()
      };
      // READ-ONLY persistence: research_reports is this module's ONLY collection.
      try { if (data() && data().put) await data().put('research_reports', rec.id, rec); } catch (_) {}
      try {
        if (data() && data().cloudReady && data().cloudReady() && global.AAA_CLOUD) {
          await global.AAA_CLOUD.upsertEntity('research_reports', rec.id, rec);
        }
      } catch (_) {}
      try { if (data() && data().logAgent) data().logAgent('research_brain', 'Research report: ' + q.slice(0, 80), { reportId: rec.id, templateId: rec.templateId }); } catch (_) {}
      return { ok: true, report: rec };
    },

    /** Build a templated question, then run it. */
    async research(templateId, subject) {
      const tpl = TEMPLATES[templateId];
      if (!tpl) return { ok: false, error: 'UNKNOWN_TEMPLATE' };
      const subj = String(subject || '').trim();
      if (!subj) return { ok: false, error: 'NO_SUBJECT', message: 'Enter what to research (e.g. a city, competitor, or material).' };
      return this.ask(tpl.prompt.replace('{q}', subj), { templateId: templateId, subject: subj, topic: templateId });
    },

    async list() {
      if (!data() || !data().list) return [];
      return (await data().list('research_reports')).sort(function (a, b) { return (b.createdAtMs || 0) - (a.createdAtMs || 0); });
    },
    async get(id) { return data() && data().get ? data().get('research_reports', id) : null; }
  };

  global.AAA_RESEARCH = Research;
})(typeof window !== 'undefined' ? window : this);
