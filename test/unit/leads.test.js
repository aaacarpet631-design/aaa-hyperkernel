/*
 * AAA_LEADS — lead pipeline unit tests (no network).
 * Covers creation + validation, the ported 9-stage transition table,
 * append-only stage history, WON/LOST outcomes, duplicate no-op, events,
 * deduped follow-up templates, and healthCheck.
 */
'use strict';
const { makeRunner, setupEnv, load } = require('../helpers/harness');

module.exports = async function run() {
  const t = makeRunner('leads');
  const { G } = setupEnv({});
  const emitted = [];
  G.AAA_EVENTS.on('*', (p, type) => emitted.push({ type, p }));
  load('js/leads/lead-store.js');
  const L = G.AAA_LEADS;

  // ---- boot + static design data ------------------------------------------
  t.ok('boot ok', (await L.boot()).ok === true);
  t.ok('9 stages ported', L.STAGES.length === 9 && L.STAGES[0] === 'NEW_LEAD' && L.STAGES.indexOf('WON') !== -1 && L.STAGES.indexOf('LOST') !== -1);

  // templates: deduped to ONE '7_touch_standard' set with 7 touches
  const tpl = L.listFollowupTemplates();
  t.ok('one deduped template set', tpl.length === 1 && tpl[0].name === '7_touch_standard');
  t.ok('seven touches in order', tpl[0].touches.length === 7 && tpl[0].touches.every((x, i) => x.touch === i + 1));
  t.ok('touch fields ported (channel/dayOffset/objective)', tpl[0].touches[4].channel === 'sms' && tpl[0].touches[6].dayOffset === 30 && !!tpl[0].touches[2].emailSubject);
  tpl[0].touches[0].sms = 'MUTATED';
  t.ok('templates are copies (immutable source)', L.listFollowupTemplates()[0].touches[0].sms !== 'MUTATED');

  // ---- createLead -----------------------------------------------------------
  let r = await L.createLead({ name: '  Jane Doe ', phone: '555-111-2222', source: 'website', serviceType: 'install', notes: 'stairs too' });
  t.ok('create lead ok', r.ok === true && !!r.lead.leadId);
  t.eq('starts at NEW_LEAD', r.lead.stage, 'NEW_LEAD');
  t.eq('name trimmed', r.lead.name, 'Jane Doe');
  t.ok('history seeded with creation entry', r.lead.stageHistory.length === 1 && r.lead.stageHistory[0].stage === 'NEW_LEAD');
  const id = r.lead.leadId;

  // required-field validation
  const miss = await L.createLead({ name: 'X' });
  t.eq('missing fields rejected', miss.error, 'MISSING_FIELDS');
  t.ok('missing list names the gaps', miss.missing.indexOf('phone') !== -1 && miss.missing.indexOf('source') !== -1);
  t.eq('invalid source rejected', (await L.createLead({ name: 'Y', phone: '1', source: 'facebook', serviceType: 'clean' })).error, 'INVALID_SOURCE');

  // duplicate (same phone+name, formatting differs) = no-op returning existing
  r = await L.createLead({ name: 'JANE DOE', phone: '(555) 111 2222', source: 'referral', serviceType: 'clean' });
  t.ok('duplicate create is a no-op', r.ok === true && r.reused === true && r.lead.leadId === id);
  t.eq('only one lead stored', (await L.listLeads()).length, 1);

  // ---- stage transitions ----------------------------------------------------
  t.eq('unknown stage rejected', (await L.updateStage(id, 'PARTY_TIME')).error, 'UNKNOWN_STAGE');
  const bad = await L.updateStage(id, 'WON'); // NEW_LEAD → WON is not allowed
  t.eq('invalid transition rejected with code', bad.error, 'INVALID_TRANSITION');
  t.ok('invalid transition names from/to', bad.from === 'NEW_LEAD' && bad.to === 'WON');
  t.eq('missing lead rejected', (await L.updateStage('nope', 'CONTACTED')).error, 'LEAD_NOT_FOUND');

  r = await L.updateStage(id, 'CONTACTED', 'left voicemail');
  t.ok('valid transition ok', r.ok === true && r.lead.stage === 'CONTACTED');
  t.ok('history appended, not rewritten', r.lead.stageHistory.length === 2 && r.lead.stageHistory[0].stage === 'NEW_LEAD' && r.lead.stageHistory[1].note === 'left voicemail');
  await L.updateStage(id, 'ESTIMATE_SENT');
  await L.updateStage(id, 'FOLLOWUP_ACTIVE');
  t.eq('history keeps appending', (await L.getLead(id)).stageHistory.length, 4);

  // ---- outcomes -------------------------------------------------------------
  t.eq('bad result rejected', (await L.recordOutcome(id, { result: 'MAYBE' })).error, 'INVALID_RESULT');
  r = await L.recordOutcome(id, { result: 'WON', revenue: 1450 });
  t.ok('WON recorded with revenue', r.ok === true && r.lead.stage === 'WON' && r.lead.outcome.revenue === 1450);

  // LOST with reason on a second lead (CONTACTED → LOST is valid)
  const r2 = await L.createLead({ name: 'Bob', phone: '555-999-0000', source: 'lsa', serviceType: 'repair' });
  await L.updateStage(r2.lead.leadId, 'CONTACTED');
  r = await L.recordOutcome(r2.lead.leadId, { result: 'LOST', lostReason: 'went with competitor' });
  t.ok('LOST recorded with reason', r.ok === true && r.lead.stage === 'LOST' && r.lead.outcome.lostReason === 'went with competitor');
  // outcome respects the transition table: WON lead → LOST is allowed (cancel), LOST → WON is not
  t.eq('outcome obeys transition table', (await L.recordOutcome(r2.lead.leadId, { result: 'WON' })).error, 'INVALID_TRANSITION');

  // ---- filters --------------------------------------------------------------
  t.eq('filter by stage', (await L.listLeads({ stage: 'WON' })).length, 1);
  t.eq('filter by source', (await L.listLeads({ source: 'lsa' })).length, 1);

  // ---- events (ids only — no PII) ------------------------------------------
  const types = emitted.map((e) => e.type);
  t.ok('LEAD_CREATED emitted', types.indexOf('LEAD_CREATED') !== -1);
  t.ok('LEAD_STAGE_CHANGED emitted with from/to', emitted.some((e) => e.type === 'LEAD_STAGE_CHANGED' && e.p.from === 'NEW_LEAD' && e.p.to === 'CONTACTED'));
  t.ok('LEAD_OUTCOME emitted with revenue', emitted.some((e) => e.type === 'LEAD_OUTCOME' && e.p.result === 'WON' && e.p.revenue === 1450));
  t.ok('event payloads carry no PII', emitted.every((e) => {
    const s = JSON.stringify(e.p || {});
    return s.indexOf('Jane') === -1 && s.indexOf('555') === -1 && s.indexOf('Bob') === -1;
  }));

  // ---- healthCheck ----------------------------------------------------------
  const h = await L.healthCheck();
  t.ok('healthCheck ok with real counts', h.ok === true && h.leads === 2 && h.stages === 9 && h.templates === 1);

  return t.report();
};
