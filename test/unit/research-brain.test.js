/*
 * Research Brain — read-only client + proxy pure-helpers.
 *
 * Covers: the /api/research helpers (validate / normalize / error mapping) and
 * the AAA_RESEARCH client, including the SAFETY BOUNDARY — it must persist ONLY
 * to research_reports and never write to jobs/quotes/invoices/customers, even
 * when the backend returns a report. The proxy .mjs is imported (Netlify ESM);
 * fetch is faked per scenario.
 */
'use strict';
const path = require('path');
const { makeRunner, setupEnv, load, ROOT } = require('../helpers/harness');

module.exports = async function run() {
  const t = makeRunner('research');

  // ---- proxy pure helpers -------------------------------------------------
  const lib = await import(path.join(ROOT, 'netlify/functions/research.mjs'));

  t.eq('validate: no message → NO_QUESTION', lib.validateRequest({}).code, 'NO_QUESTION');
  t.eq('validate: blank → NO_QUESTION', lib.validateRequest({ message: '   ' }).code, 'NO_QUESTION');
  t.ok('validate: accepts message', lib.validateRequest({ message: 'competitors in Houston' }).ok === true);
  t.ok('validate: accepts legacy "question" field', lib.validateRequest({ question: 'x' }).ok === true);
  t.eq('validate: oversize → QUESTION_TOO_LONG', lib.validateRequest({ message: 'x'.repeat(lib.MAX_QUESTION_CHARS + 1) }).code, 'QUESTION_TOO_LONG');

  // normalize across AI-Q response shapes
  const n1 = lib.normalizeResearch({ report: 'R1', citations: [{ title: 'A', url: 'http://a' }] });
  t.eq('normalize: report from .report', n1.report, 'R1');
  t.eq('normalize: citation kept', n1.citations[0].url, 'http://a');
  t.eq('normalize: report from .answer', lib.normalizeResearch({ answer: 'R2' }).report, 'R2');
  t.eq('normalize: report from message.content', lib.normalizeResearch({ message: { content: 'R3' } }).report, 'R3');
  t.eq('normalize: sources[] aliased to citations', lib.normalizeResearch({ report: 'r', sources: ['http://s'] }).citations[0].url, 'http://s');
  t.eq('normalize: string citation → title+url', lib.normalizeResearch({ report: 'r', citations: ['Doc'] }).citations[0].title, 'Doc');

  // error mapping (no secrets/URLs leak)
  t.eq('map 401 → RESEARCH_AUTH_FAILED', lib.mapResearchError(401).code, 'RESEARCH_AUTH_FAILED');
  t.eq('map 404 → RESEARCH_NOT_FOUND', lib.mapResearchError(404).code, 'RESEARCH_NOT_FOUND');
  t.eq('map 429 → RESEARCH_RATE_LIMITED', lib.mapResearchError(429).code, 'RESEARCH_RATE_LIMITED');
  t.eq('map 500 → RESEARCH_UNAVAILABLE', lib.mapResearchError(500).code, 'RESEARCH_UNAVAILABLE');
  t.eq('map network throw → RESEARCH_UNAVAILABLE', lib.mapResearchError(new Error('boom')).code, 'RESEARCH_UNAVAILABLE');
  t.ok('error messages carry no secrets', !/token|bearer|http:\/\//i.test(JSON.stringify([401, 404, 500].map((s) => lib.mapResearchError(s)))));

  // ---- read-only client ---------------------------------------------------
  const { G, data } = setupEnv();
  let lastFetch = null;
  // Fake the proxy: capture the request, return a citation-backed report.
  G.fetch = async (url, opts) => {
    lastFetch = { url: url, body: JSON.parse(opts.body) };
    return { ok: true, status: 200, async json() { return { report: 'Top 3 competitors: ...', citations: [{ title: 'Yelp Houston', url: 'http://yelp/x' }] }; } };
  };
  load('js/agents/research-brain.js');
  const R = G.AAA_RESEARCH;

  t.ok('client exposes carpet/flooring templates', R.templateIds().indexOf('competitors') !== -1 && R.templateIds().indexOf('seo') !== -1);
  t.ok('isConfigured true when endpoint exists', R.isConfigured() === true);

  const res = await R.research('competitors', 'Houston');
  t.ok('research() ok', res.ok === true);
  t.ok('templated prompt sent (mentions competitors + Houston)', /competitor/i.test(lastFetch.body.message) && /Houston/.test(lastFetch.body.message));
  t.eq('report stored', res.report.report.slice(0, 3), 'Top');
  t.eq('citations stored', res.report.citations[0].title, 'Yelp Houston');
  t.ok('report flagged review-only', res.report.reviewOnly === true);

  // SAFETY BOUNDARY: only research_reports was written — nothing else.
  const written = Object.keys(data._store);
  t.eq('only research_reports collection written', written.filter((c) => c !== 'agent_logs').join(','), 'research_reports');
  t.ok('did NOT write jobs', !data._store.jobs);
  t.ok('did NOT write quotes/estimates', !data._store.quotes && !data._store.estimates);
  t.ok('did NOT write invoices/payments/ledger', !data._store.invoices && !data._store.payments && !data._store.ledger);
  t.ok('did NOT write customers', !data._store.customers);
  // The client must not even reference mutation APIs on the data layer.
  const src = require('fs').readFileSync(path.join(ROOT, 'js/agents/research-brain.js'), 'utf8');
  t.ok('source never calls put on non-research collections', !/put\(\s*['"](?!research_reports)/.test(src));
  t.ok('source references no job/quote/invoice mutators', !/recordOutcome|createInvoice|pushInvoice|saveQuote|setState|currentState\s*=/.test(src));

  // free-form ask() also works and stores read-only
  const f = await R.ask('Compare nylon vs polyester carpet for rentals');
  t.ok('ask() ok', f.ok === true && f.report.citations.length === 1);

  // ---- honest "not configured" path --------------------------------------
  G.fetch = async () => ({ ok: false, status: 503, async json() { return { ok: false, error: 'RESEARCH_NOT_CONFIGURED', message: 'set AIQ_RESEARCH_URL' }; } });
  const nc = await R.ask('anything');
  t.eq('not-configured surfaced honestly', nc.error, 'RESEARCH_NOT_CONFIGURED');
  t.ok('not-configured is not ok (no fabricated report)', nc.ok === false);

  return t.report();
};
