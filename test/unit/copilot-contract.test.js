/* Copilot Contract v1 — the HyperKernel × Custonllm wire contract (Slice B).
 *
 * Guards: the generated schemas/copilot-contract-v1.json can never drift from
 * the module; all 10 golden fixtures round-trip validation + groundedness;
 * structural mutants are rejected with named issues (missing ids, bad enums,
 * fact-without-sourceRef, sendable drafts, contract-foreign fields); and the
 * groundedness rule catches numbers without evidence. Pure + DOM-free. */
'use strict';
const fs = require('fs');
const path = require('path');
const { makeRunner, setupEnv, load, srcPath } = require('../helpers/harness');

module.exports = async function run() {
  const t = makeRunner('copilot-contract');
  const { G } = setupEnv();
  load('js/copilot/copilot-contract.js');
  const C = G.AAA_COPILOT_CONTRACT;

  // ===== generated schema file can never drift from the module =====
  const onDisk = JSON.parse(fs.readFileSync(srcPath('schemas/copilot-contract-v1.json'), 'utf8'));
  t.ok('schemas/copilot-contract-v1.json matches the module byte-for-byte',
    JSON.stringify(onDisk, null, 2) === JSON.stringify(C.schema(), null, 2));
  t.eq('contract version is 1.0', C.VERSION, '1.0');
  t.eq('all five phase-one jobs are in the contract', C.JOBS.length, 5);

  // ===== the 10 golden fixtures validate + ground =====
  const dir = srcPath('test/fixtures/copilot');
  const files = fs.readdirSync(dir).filter((f) => /\.(request|response)\.json$/.test(f)).sort();
  t.eq('exactly 10 golden fixtures exist (request+response per job)', files.length, 10);
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'MANIFEST.json'), 'utf8'));
  const sha = (f) => require('crypto').createHash('sha256').update(fs.readFileSync(path.join(dir, f))).digest('hex');
  t.ok('every golden fixture matches its MANIFEST sha256 (cross-repo parity anchor)',
    files.every((f) => manifest[f] === sha(f)));
  let allValid = true, allGrounded = true;
  const byName = {};
  files.forEach((f) => {
    const obj = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    byName[f] = obj;
    const v = f.endsWith('.request.json') ? C.validateRequest(obj) : C.validateResponse(obj);
    if (!v.ok) { allValid = false; console.log('   fixture invalid:', f, v.issues); }
    if (f.endsWith('.response.json') && C.groundednessIssues(obj).length) { allGrounded = false; console.log('   ungrounded:', f); }
  });
  t.ok('every fixture validates against the contract', allValid);
  t.ok('every response fixture passes groundedness', allGrounded);

  const draftRes = byName['draft-followup.response.json'];
  t.ok('the draft job requires approval with APPROVE_ASSISTED_MSG',
    draftRes.approval.required === true && draftRes.approval.approvalPackage.actionType === 'APPROVE_ASSISTED_MSG');
  t.ok('draft bodies carry {{placeholders}}, not PII', /\{\{customer_name\}\}/.test(draftRes.cards[0].body));
  const attReq = byName['attention-today.request.json'];
  t.ok('customer free-text sections are marked untrusted',
    attReq.contextPacket.sections[0].items.some((i) => i.untrusted === true));

  // ===== structural mutants are rejected with named issues =====
  const goodReq = byName['followups.request.json'];
  const goodRes = byName['followups.response.json'];
  const mutate = (obj, fn) => { const c = JSON.parse(JSON.stringify(obj)); fn(c); return c; };

  let m = C.validateRequest(mutate(goodReq, (r) => { delete r.requestId; }));
  t.ok('missing requestId is rejected by name', !m.ok && m.issues.some((i) => /requestId/.test(i)));
  m = C.validateRequest(mutate(goodReq, (r) => { r.job = 'take_over_the_world'; }));
  t.ok('an off-contract job is rejected', !m.ok && m.issues.some((i) => /job/.test(i)));
  m = C.validateRequest(mutate(goodReq, (r) => { r.contextPacket.sections[0].items[0].sourceRef = undefined; }));
  t.ok('a context item without a sourceRef is rejected', !m.ok);
  m = C.validateRequest(mutate(goodReq, (r) => { r.selfDestruct = true; }));
  t.ok('contract-foreign fields are rejected (additionalProperties:false)', !m.ok && m.issues.some((i) => /selfDestruct/.test(i)));

  m = C.validateResponse(mutate(goodRes, (r) => { r.cards[0].items[0].sourceRef = undefined; }));
  t.ok('a card fact without a sourceRef is invalid — grounding by construction', !m.ok);
  m = C.validateResponse(mutate(goodRes, (r) => { r.cards.push({ cardType: 'mind_control' }); }));
  t.ok('an unknown card type is rejected', !m.ok && m.issues.some((i) => /cardType/.test(i)));
  m = C.validateResponse(mutate(goodRes, (r) => { r.confidence = 150; }));
  t.ok('confidence above 100 is rejected', !m.ok);
  m = C.validateResponse(mutate(goodRes, (r) => { r.evidence[0].sourceRefs = []; }));
  t.ok('evidence with zero sourceRefs is rejected (minItems 1)', !m.ok);

  const sendable = mutate(byName['draft-followup.response.json'], (r) => { r.cards[0].sendBlocked = false; });
  t.ok('a draft claiming to be SENDABLE is invalid on its face', C.validateResponse(sendable).ok === false);

  // ===== groundedness rule: no business number without a source ref =====
  const bare = { contractVersion: '1.0', requestId: 'x', answer: 'Revenue was $4,200 last week.', cards: [], evidence: [], confidence: 40, unknowns: [], approval: { required: false } };
  t.ok('a schema-valid response can still fail groundedness', C.validateResponse(bare).ok === true);
  t.ok('digits without evidence are flagged', C.groundednessIssues(bare).some((i) => /NUMBER_WITHOUT_EVIDENCE/.test(i)));
  const placeholders = Object.assign({}, bare, { answer: 'Draft ready: {{estimate_total}} quoted.', confidence: 40 });
  t.ok('template placeholders do not count as business numbers', C.groundednessIssues(placeholders).length === 0);
  const cocky = Object.assign({}, bare, { answer: 'All good.', confidence: 95 });
  t.ok('high confidence with no cards and no evidence is flagged', C.groundednessIssues(cocky).some((i) => /CONFIDENCE_WITHOUT_EVIDENCE/.test(i)));

  // ===== v1 additive machinery: thread, usage, error envelope, formats =====
  const dReq = byName['draft-followup.request.json'];
  const dRes = byName['draft-followup.response.json'];
  t.ok('the draft fixture pair exercises conversation threading',
    dReq.thread.conversationId === 'thread_fx_1' && dRes.conversationId === 'thread_fx_1');
  t.ok('optional usage accounting validates', dRes.usage.latencyMs === 180 && C.validateResponse(dRes).ok);
  const errOk = C.validateError({ contractVersion: '1.0', requestId: 'r1', error: { code: 'workspace_mismatch', message: 'packet workspace differs' } });
  t.ok('the error envelope validates the agreed unhappy path', errOk.ok === true);
  t.ok('an off-enum error code is rejected', C.validateError({ contractVersion: '1.0', error: { code: 'oops', message: 'x' } }).ok === false);
  m = C.validateRequest(mutate(goodReq, (r) => { r.contextPacket.assembledAt = 'yesterday at noon'; }));
  t.ok('non-ISO timestamps are rejected by pattern', !m.ok && m.issues.some((i) => /format/.test(i)));
  m = C.validateRequest(mutate(goodReq, (r) => { r.message = 'x'.repeat(4001); }));
  t.ok('oversized messages are rejected (maxLength 4000)', !m.ok && m.issues.some((i) => /maxLength/.test(i)));
  m = C.validateRequest(mutate(goodReq, (r) => { r.contextPacket.sections[0].items = Array.from({ length: 51 }, (_, k) => r.contextPacket.sections[0].items[0] || { sourceRef: { collection: 'x', id: 'i' + k }, data: {} }); }));
  t.ok('oversized sections are rejected (maxItems 50)', !m.ok && m.issues.some((i) => /maxItems/.test(i)));
  const schemaDoc = C.schema();
  t.ok('published card union is standard oneOf (usable by any 2020-12 validator)',
    Array.isArray(schemaDoc.$defs.responseEnvelope.properties.cards.items.oneOf) &&
    schemaDoc.$defs.responseEnvelope.properties.cards.items.oneOf.length === 6);

  // ===== evidence referential integrity =====
  t.ok('golden pairs pass evidence integrity', C.evidenceIntegrityIssues(goodReq, goodRes).length === 0);
  const fabricated = mutate(goodRes, (r) => { r.evidence.push({ claim: 'made up', sourceRefs: [{ collection: 'quotes', id: 'quote_999' }] }); });
  t.ok('a schema-valid response citing a record the packet never carried is flagged',
    C.validateResponse(fabricated).ok === true &&
    C.evidenceIntegrityIssues(goodReq, fabricated).some((i) => /EVIDENCE_NOT_IN_PACKET.*quotes:quote_999/.test(i)));
  const skewed = mutate(goodRes, (r) => { r.evidence[0].sourceRefs[0].asOf = '2020-01-01T00:00:00.000Z'; });
  t.ok('an asOf that disagrees with the packet is flagged',
    C.evidenceIntegrityIssues(goodReq, skewed).some((i) => /ASOF_MISMATCH/.test(i)));
  t.ok('evidence integrity never throws on garbage', Array.isArray(C.evidenceIntegrityIssues(null, null)));

  // ===== null tolerance =====
  t.ok('null request is handled honestly', C.validateRequest(null).ok === false);
  t.ok('null card is handled honestly', C.validateCard(null).ok === false);
  t.ok('groundedness of garbage never throws', Array.isArray(C.groundednessIssues(null)));

  return t.report();
};
