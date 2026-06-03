/*
 * Research Brain proxy (Netlify) — the secure seam to a SEPARATE AI-Q service.
 *
 * NVIDIA AI-Q Blueprint (or any research backend) runs as its own hosted service
 * — Python/Docker, NVIDIA_API_KEY, NIM models — NOT inside this PWA. The browser
 * must never hold that service's URL/token, so this function is the only thing
 * that talks to it: it takes a research question from the app, forwards it to
 * AIQ_RESEARCH_URL with a server-side bearer token, and returns the report +
 * citations.
 *
 * READ-ONLY BY CONTRACT: this proxy only relays a research question and returns
 * text + citations. It has no access to and never touches jobs, quotes, invoices,
 * payments, bookkeeping, or customer records. That boundary is the whole point of
 * running AI-Q as a separate "research brain" until it is independently secured.
 *
 * Pure helpers (validate/normalize/map) are exported for unit tests; Netlify only
 * consumes `default` + `config`.
 */

// Cap the question size so we never forward an abusive payload upstream.
export const MAX_QUESTION_CHARS = 4000;

/** Validate the inbound research request. */
export function validateRequest(body) {
  if (!body || typeof body !== 'object') return { ok: false, code: 'INVALID_JSON', message: 'Expected a JSON body.' };
  const q = typeof body.message === 'string' ? body.message
    : (typeof body.question === 'string' ? body.question : '');
  const question = q.trim();
  if (!question) return { ok: false, code: 'NO_QUESTION', message: 'Provide a research question in "message".' };
  if (question.length > MAX_QUESTION_CHARS) return { ok: false, code: 'QUESTION_TOO_LONG', message: 'Question exceeds ' + MAX_QUESTION_CHARS + ' characters.' };
  return { ok: true, question: question, topic: typeof body.topic === 'string' ? body.topic : null };
}

/**
 * Normalize an AI-Q response into the client shape. AI-Q variants return the
 * report under different keys (report / answer / content / message.content) and
 * citations under sources / citations / references — accept them all.
 * @returns {{ report:string, citations:Array, raw:object }}
 */
export function normalizeResearch(json) {
  const j = json || {};
  const report = String(
    j.report || j.answer || j.content ||
    (j.message && (typeof j.message === 'string' ? j.message : j.message.content)) || ''
  ).trim();
  const rawCites = j.citations || j.sources || j.references || (j.metadata && j.metadata.citations) || [];
  const citations = (Array.isArray(rawCites) ? rawCites : []).map((c) => {
    if (typeof c === 'string') return { title: c, url: c };
    return {
      title: String((c && (c.title || c.name || c.source)) || (c && c.url) || 'Source'),
      url: String((c && (c.url || c.link || c.href)) || ''),
      snippet: c && c.snippet ? String(c.snippet) : ''
    };
  }).filter((c) => c.title || c.url);
  return { report: report, citations: citations, raw: j };
}

/** Map a provider/HTTP error to a stable code + safe message (no secrets, no URL). */
export function mapResearchError(statusOrErr) {
  const status = typeof statusOrErr === 'number' ? statusOrErr
    : (statusOrErr && (statusOrErr.status || statusOrErr.statusCode)) || 0;
  if (status === 401 || status === 403) return { code: 'RESEARCH_AUTH_FAILED', message: 'Research service rejected the credentials.' };
  if (status === 404) return { code: 'RESEARCH_NOT_FOUND', message: 'Research endpoint not found — check AIQ_RESEARCH_URL.' };
  if (status === 429) return { code: 'RESEARCH_RATE_LIMITED', message: 'Research service is busy; try again shortly.' };
  if (status >= 500 || status === 0) return { code: 'RESEARCH_UNAVAILABLE', message: 'Research service is unavailable right now.' };
  return { code: 'RESEARCH_FAILED', message: 'Research request failed (' + status + ').' };
}

export function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

export default async (req) => {
  if (req.method !== 'POST') return json({ ok: false, error: 'METHOD_NOT_ALLOWED' }, 405);

  // The separate AI-Q service's address + token live ONLY in the site env.
  const url = process.env.AIQ_RESEARCH_URL;
  const token = process.env.AIQ_RESEARCH_TOKEN || '';
  if (!url) {
    // Honest "not configured": the client shows a clear setup state, no fabrication.
    return json({ ok: false, error: 'RESEARCH_NOT_CONFIGURED', message: 'Set AIQ_RESEARCH_URL (and AIQ_RESEARCH_TOKEN) in the Netlify site environment to enable the Research Brain.' }, 503);
  }

  let body;
  try { body = await req.json(); } catch { return json({ ok: false, error: 'INVALID_JSON' }, 400); }
  const v = validateRequest(body);
  if (!v.ok) return json({ ok: false, error: v.code, message: v.message }, 400);

  try {
    const headers = { 'content-type': 'application/json' };
    if (token) headers.authorization = 'Bearer ' + token;
    const upstream = await fetch(url, {
      method: 'POST',
      headers: headers,
      body: JSON.stringify({ message: v.question })
    });
    if (!upstream.ok) {
      const mapped = mapResearchError(upstream.status);
      console.error('Research proxy upstream error', upstream.status);
      return json({ ok: false, error: mapped.code, message: mapped.message }, upstream.status >= 400 && upstream.status <= 599 ? upstream.status : 502);
    }
    const data = await upstream.json();
    const out = normalizeResearch(data);
    if (!out.report) return json({ ok: false, error: 'EMPTY_REPORT', message: 'The research service returned no report.' }, 200);
    return json({ ok: true, report: out.report, citations: out.citations });
  } catch (err) {
    const mapped = mapResearchError(err);
    console.error('Research proxy error', err);
    return json({ ok: false, error: mapped.code, message: mapped.message }, 502);
  }
};

export const config = { path: '/api/research' };
