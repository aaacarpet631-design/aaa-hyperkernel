/*
 * AAA Copilot Memory Retriever — what does the company already KNOW about this?
 *
 * Pulls relevant established knowledge for a question from the Belief Registry
 * (theories + supported beliefs) and the Learning Fabric / Vector Memory when
 * present, so answers cite what the organization has learned rather than
 * guessing. Honest: with no matching knowledge it returns an empty set, not a
 * confident-sounding fabrication. Read-only.
 */
;(function (global) {
  'use strict';

  function beliefs() { return global.AAA_BELIEF_REGISTRY; }
  function fabric() { return global.AAA_LEARNING_FABRIC; }
  function tokens(s) { return String(s == null ? '' : s).toLowerCase().match(/[a-z0-9]+/g) || []; }

  const Retriever = {
    /** Relevant theories/beliefs (keyword overlap) + fabric recall if available. */
    async retrieve(query, opts) {
      const o = opts || {};
      const qt = tokens(query);
      const out = { theories: [], beliefs: [], recall: null };
      if (beliefs()) {
        const claims = await beliefs().list();
        const score = function (c) { const st = tokens(c.statement); return st.filter(function (w) { return qt.indexOf(w) !== -1; }).length; };
        out.theories = claims.filter(function (c) { return c.type === 'theory'; }).map(function (c) { return { statement: c.statement, confidence: c.confidence, relevance: score(c) }; }).filter(function (c) { return c.relevance > 0 || qt.length === 0; }).sort(function (a, b) { return b.relevance - a.relevance; }).slice(0, o.limit || 5);
        out.beliefs = claims.filter(function (c) { return c.type === 'belief' && c.status === 'supported'; }).map(function (c) { return { statement: c.statement, confidence: c.confidence, relevance: score(c) }; }).filter(function (c) { return c.relevance > 0; }).sort(function (a, b) { return b.relevance - a.relevance; }).slice(0, o.limit || 5);
      }
      if (fabric() && fabric().recall && o.context) { try { out.recall = await fabric().recall(o.context); } catch (_) {} }
      out.status = (out.theories.length || out.beliefs.length || out.recall) ? 'found' : 'insufficient_data';
      return out;
    }
  };

  global.AAA_COPILOT_MEMORY = Retriever;
})(typeof window !== 'undefined' ? window : this);
