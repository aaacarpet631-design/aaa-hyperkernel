/*
 * Copilot eval-gate mutant generator (Slice F).
 *
 * PURE functions: given a VALID golden fixture object, produce a systematic
 * corpus of labeled mutants. Never mutates its input (deep-clones first),
 * never touches storage/network/DOM, deterministic for a given fixture.
 *
 * Every mutant is { id, expect, mutant } where expect is:
 *   'schema'    — AAA_COPILOT_CONTRACT.validateResponse/validateRequest MUST
 *                 reject the mutant (the schema-validity gate);
 *   'integrity' — the mutant is schema-VALID on purpose, but
 *                 evidenceIntegrityIssues(request, mutant) MUST flag it (the
 *                 groundedness/anti-fabrication gate).
 *
 * The Python mirror in /workspace/custonllm/tests/test_copilot_eval_gate.py
 * regenerates the SAME classes with the SAME ids — if you add a class here,
 * add it there (the shared invalid/ fixture dir keeps the named corpus in
 * lockstep across repos).
 */
'use strict';

// responseEnvelope / requestEnvelope required keys, mirroring the contract.
const RESPONSE_REQUIRED = ['contractVersion', 'requestId', 'answer', 'cards', 'evidence', 'confidence', 'unknowns', 'approval'];
const REQUEST_REQUIRED = ['contractVersion', 'requestId', 'workspaceId', 'identity', 'job', 'message', 'contextPacket'];

function clone(o) { return JSON.parse(JSON.stringify(o)); }
function make(base, id, expect, fn) {
  const m = clone(base);
  fn(m);
  return { id: id, expect: expect, mutant: m };
}

/**
 * Systematic mutants of a VALID response fixture. Classes:
 *  - drop:$.<key>                    each required top-level field, one at a time
 *  - drop-sourceref:cards[i].*       every card item / factor / quoteRef / customerRef
 *  - sendable-draft:cards[i]         sendBlocked flipped to false where present
 *  - foreign-field:$ / :cards[i]     a contract-foreign field (additionalProperties:false)
 *  - confidence:150 / confidence:-5  out-of-range confidence
 *  - version:2.0                     off-enum contractVersion
 *  - fabricated-evidence             schema-valid ref (quotes:mutant_999) the
 *                                    packet never carried — expect 'integrity'
 */
function generateResponseMutants(response) {
  const out = [];
  if (!response || typeof response !== 'object' || Array.isArray(response)) return out;

  RESPONSE_REQUIRED.forEach(function (k) {
    out.push(make(response, 'drop:$.' + k, 'schema', function (r) { delete r[k]; }));
  });

  const cards = Array.isArray(response.cards) ? response.cards : [];
  cards.forEach(function (card, i) {
    if (!card || typeof card !== 'object') return;
    (Array.isArray(card.items) ? card.items : []).forEach(function (_, j) {
      out.push(make(response, 'drop-sourceref:cards[' + i + '].items[' + j + ']', 'schema', function (r) { delete r.cards[i].items[j].sourceRef; }));
    });
    (Array.isArray(card.factors) ? card.factors : []).forEach(function (_, j) {
      out.push(make(response, 'drop-sourceref:cards[' + i + '].factors[' + j + ']', 'schema', function (r) { delete r.cards[i].factors[j].sourceRef; }));
    });
    if (card.quoteRef) out.push(make(response, 'drop-sourceref:cards[' + i + '].quoteRef', 'schema', function (r) { delete r.cards[i].quoteRef; }));
    if (card.customerRef) out.push(make(response, 'drop-sourceref:cards[' + i + '].customerRef', 'schema', function (r) { delete r.cards[i].customerRef; }));
    if (card.sendBlocked === true) out.push(make(response, 'sendable-draft:cards[' + i + ']', 'schema', function (r) { r.cards[i].sendBlocked = false; }));
    out.push(make(response, 'foreign-field:cards[' + i + ']', 'schema', function (r) { r.cards[i].mutantForeignField = true; }));
  });

  out.push(make(response, 'foreign-field:$', 'schema', function (r) { r.mutantForeignField = true; }));
  out.push(make(response, 'confidence:150', 'schema', function (r) { r.confidence = 150; }));
  out.push(make(response, 'confidence:-5', 'schema', function (r) { r.confidence = -5; }));
  out.push(make(response, 'version:2.0', 'schema', function (r) { r.contractVersion = '2.0'; }));

  // Schema-valid by construction; the referential guard alone must catch it.
  out.push(make(response, 'fabricated-evidence', 'integrity', function (r) {
    if (!Array.isArray(r.evidence)) r.evidence = [];
    r.evidence.push({
      claim: 'A figure citing a record the packet never carried',
      sourceRefs: [{ collection: 'quotes', id: 'mutant_999' }]
    });
  }));

  return out;
}

/**
 * Systematic mutants of a VALID request fixture (all expect 'schema' — the
 * validator, and the live Custonllm endpoint, must refuse every one):
 *  - drop:$.<key>            each required top-level field, one at a time
 *  - oversize-message        4001 chars (maxLength 4000)
 *  - off-enum-job            a job the contract never defined
 *  - non-iso-assembledAt     a zoneless human timestamp (DATETIME pattern)
 *  - oversize-section        51 items in one section (maxItems 50)
 */
function generateRequestMutants(request) {
  const out = [];
  if (!request || typeof request !== 'object' || Array.isArray(request)) return out;

  REQUEST_REQUIRED.forEach(function (k) {
    out.push(make(request, 'drop:$.' + k, 'schema', function (r) { delete r[k]; }));
  });

  out.push(make(request, 'oversize-message', 'schema', function (r) { r.message = new Array(4002).join('x'); }));
  out.push(make(request, 'off-enum-job', 'schema', function (r) { r.job = 'take_over_the_world'; }));

  const packet = request.contextPacket;
  if (packet && typeof packet === 'object') {
    out.push(make(request, 'non-iso-assembledAt', 'schema', function (r) { r.contextPacket.assembledAt = 'yesterday at noon'; }));
    if (Array.isArray(packet.sections) && packet.sections.length) {
      out.push(make(request, 'oversize-section', 'schema', function (r) {
        const sec = r.contextPacket.sections[0];
        const template = (sec.items && sec.items[0]) || { sourceRef: { collection: 'quotes', id: 'seed' }, data: {} };
        sec.items = [];
        for (let k = 0; k < 51; k++) {
          const item = clone(template);
          item.sourceRef = Object.assign({}, item.sourceRef, { id: 'mut_item_' + k });
          sec.items.push(item);
        }
      }));
    }
  }

  return out;
}

module.exports = {
  RESPONSE_REQUIRED: RESPONSE_REQUIRED.slice(),
  REQUEST_REQUIRED: REQUEST_REQUIRED.slice(),
  generateResponseMutants: generateResponseMutants,
  generateRequestMutants: generateRequestMutants
};
