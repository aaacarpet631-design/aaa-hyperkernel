/* Exercise the actual screen handlers against the real quote engine/store. */
'use strict';
const { makeRunner, setupEnv, load } = require('../helpers/harness');
function node(tag, opts, children) {
  const n = { tag, opts: opts || {}, children: children || [], listeners: {}, value: '', disabled: false, classList: { add() {} }, style: {} };
  n.appendChild = (c) => { n.children.push(c); return c; };
  n.addEventListener = (event, fn) => { n.listeners[event] = fn; };
  Object.defineProperty(n, 'innerHTML', { set(v) { if (v === '') n.children = []; } });
  return n;
}
function all(n) { return [n, ...(n.children || []).flatMap(all)]; }
function byLabel(root, label) { return all(root).find((n) => n.opts.label === label || n.opts.attrs && n.opts.attrs['aria-label'] === label); }
function fill(root, label, value) { const n = byLabel(root, label); if (!n) throw new Error('Missing control: ' + label); n.value = value; n.listeners.input(); }
async function click(root, label) { const n = byLabel(root, label); if (!n || n.disabled) throw new Error('Unavailable action: ' + label); await n.opts.onClick(); }
module.exports = async function () {
  const t = makeRunner('quote-builder-ui');
  const { G, data } = setupEnv();
  ['js/core/backup-format.js', 'js/quotes/quote-conflicts.js', 'js/core/aaa-rbac.js', 'js/core/aaa-runtime-gateway.js', 'js/quotes/integrations/measurement-to-quote.js', 'js/quotes/quote-store.js', 'js/quotes/quote-builder.js'].forEach(load);
  const sheets = [];
  G.document = { body: node('body') };
  G.location = { href: '' };
  G.AAA_LOCAL_FIRST_STORAGE = { put: data.put, get: data.get, getAll: data.list };
  G.AAA_UI = {
    el: node, button: (o) => { const n = node('button', o); n.disabled = !!o.disabled; return n; },
    sheet: (o) => { const s = { overlay: node('overlay'), body: node('body'), close() { if (!s.closed) { s.closed = true; if (o.onClose) o.onClose(); } }, opts: o }; sheets.push(s); return s; },
    confirm: async () => ({ reason: '' })
  };
  load('js/ui/quote-builder-ui.js');
  const UI = G.AAA_QUOTE_BUILDER_UI, Q = G.AAA_QUOTES;
  await UI.open();
  const form = sheets[0].body;
  fill(form, 'Name', 'Quote Test'); fill(form, 'Phone', '7135550123');
  await click(form, 'Add service line'); fill(form, 'Number of rooms', '3');
  await click(form, 'Continue to pricing');
  t.ok('pricing screen renders customer receipt', all(form).some((n) => n.opts.text === '$135.00'));
  t.eq('approval disabled before saving', byLabel(form, 'Review & approve').disabled, true);
  await click(form, 'Save draft');
  let q = (await Q.list())[0];
  t.ok('save button persists named quote', q.customerName === 'Quote Test' && q.customerTotal === 135);
  t.eq('approval enabled after saving', byLabel(form, 'Review & approve').disabled, false);
  fill(form, 'Cleaning minimum / room ($)', '60');
  t.eq('changing price disables approval until re-saved', byLabel(form, 'Review & approve').disabled, true);
  await click(form, 'Save draft');
  q = await Q.get(q.id);
  t.eq('price control remains connected after first save', q.customerTotal, 180);
  t.eq('second save updates same quote', (await Q.list()).length, 1);
  await click(form, 'Review & approve');
  // openShare is entered by the reviewed screen and has only local async reads.
  await Promise.resolve(); await Promise.resolve();
  q = await Q.get(q.id);
  t.eq('review button creates reviewed state', q.status, 'reviewed');
  const share = sheets[sheets.length - 1].body;
  t.ok('share screen has actual message action', !!byLabel(share, 'Open text message'));
  t.ok('only customer receipt text is offered', !/rateSnapshot|margin|_labor|waste/i.test(byLabel(share, 'Customer quote text').value));
  await click(share, 'Open text message');
  t.ok('message action opens encoded device composer', G.location.href.startsWith('sms:7135550123?body='));
  t.eq('opening composer leaves state reviewed', (await Q.get(q.id)).status, 'reviewed');
  await click(share, 'I sent this quote');
  t.eq('explicit sent confirmation changes status', (await Q.get(q.id)).status, 'sent');
  t.ok('share panel closes after confirmation', sheets[sheets.length - 1].closed);
  await UI.openShare(q.id, (await Q.get(q.id)).revision);
  t.eq('sent quote sharing has no duplicate send confirmation', !!byLabel(sheets[sheets.length - 1].body, 'I sent this quote'), false);

  await UI.open();
  t.eq('reopening after sending starts with an empty customer', byLabel(sheets[sheets.length - 1].body, 'Name').value, '');
  t.eq('reopening does not create a duplicate quote', (await Q.list()).length, 1);

  const B = G.AAA_QUOTE_BUILDER;
  const input = Object.assign(B.fresh(), { customer: { name: 'Resume Test' }, lines: [{ serviceId: 'carpet_shampoo', rooms: 3 }] });
  const initial = (await B.save(input)).quote;
  sheets[sheets.length - 1].close();
  await B.saveWorking({ input: initial.builderInput, id: initial.id, revision: initial.revision, dirty: false });
  const updated = JSON.parse(JSON.stringify(initial.builderInput));
  updated.customer.name = 'Latest saved customer';
  const latest = (await B.save(updated, { id: initial.id, expectedRevision: initial.revision })).quote;
  await UI.open();
  const resumed = sheets[sheets.length - 1].body;
  t.eq('clean working copy loads the latest saved quote', byLabel(resumed, 'Name').value, 'Latest saved customer');
  await click(resumed, 'Continue to pricing');
  await click(resumed, 'Save draft');
  t.eq('restored quote uses the current revision for saving', (await Q.get(initial.id)).revision, latest.revision + 1);

  const unsaved = JSON.parse(JSON.stringify(initial.builderInput));
  unsaved.customer.name = 'My unsaved changes'; unsaved.lines[0].rooms = 4;
  sheets[sheets.length - 1].close();
  await B.saveWorking({ input: unsaved, id: initial.id, revision: initial.revision, dirty: true });
  await UI.open();
  const conflict = sheets[sheets.length - 1].body;
  t.eq('conflicting work cannot proceed directly to pricing', !!byLabel(conflict, 'Continue to pricing'), false);
  t.ok('conflicting work offers the current saved version', !!byLabel(conflict, 'Open latest saved version'));
  await click(conflict, 'Keep my changes as a new quote');
  t.eq('recovery preserves the unsaved customer', byLabel(conflict, 'Name').value, 'My unsaved changes');
  t.eq('recovery preserves unsaved service quantities', byLabel(conflict, 'Number of rooms').value, 4);
  await click(conflict, 'Continue to pricing');
  t.eq('recovered copy requires saving and new approval', byLabel(conflict, 'Review & approve').disabled, true);
  await click(conflict, 'Save draft');
  const recovered = (await Q.list()).find((row) => row.customerName === 'My unsaved changes');
  t.ok('recovery creates a separate draft with recalculated totals', recovered && recovered.id !== initial.id && recovered.status === 'draft' && recovered.customerTotal === 180);
  t.eq('recovery does not overwrite the latest saved customer', (await Q.get(initial.id)).customerName, 'Latest saved customer');

  sheets[sheets.length - 1].close();
  await B.saveWorking({ input: unsaved, id: initial.id, revision: initial.revision, dirty: true });
  await UI.open();
  const latestChoice = sheets[sheets.length - 1].body;
  await click(latestChoice, 'Open latest saved version');
  t.eq('choosing the latest version restores its saved customer', byLabel(latestChoice, 'Name').value, 'Latest saved customer');
  t.eq('choosing the latest version records its current revision', (await B.loadWorking()).revision, (await Q.get(initial.id)).revision);
  t.eq('choosing the latest version clears unsaved work only after confirmation', (await B.loadWorking()).dirty, false);

  sheets[sheets.length - 1].close();
  await B.saveWorking({ input: unsaved, id: q.id, revision: 1, dirty: true });
  await UI.open();
  const locked = sheets[sheets.length - 1].body;
  t.eq('unsaved work on a sent quote cannot overwrite it', !!byLabel(locked, 'Continue to pricing'), false);
  t.ok('unsaved work on a sent quote is recoverable separately', !!byLabel(locked, 'Keep my changes as a new quote'));

  sheets[sheets.length - 1].close();
  await B.saveWorking({ input: null });
  await UI.open();
  t.ok('an invalid working copy still provides a new quote form', !!byLabel(sheets[sheets.length - 1].body, 'Name'));
  const unfinished = Object.assign(B.fresh(), { customer: { name: 'First unfinished customer' } });
  await UI.open({ input: unfinished });
  const firstSheet = sheets[sheets.length - 1];
  const firstKey = (await B.loadWorking()).workingKey;
  await UI.open({ input: input });
  t.eq('opening another form closes the previous editor', firstSheet.closed, true);
  t.eq('opening another form preserves incomplete work without requiring a price', (await B.loadWorking(firstKey)).input.customer.name, 'First unfinished customer');
  t.ok('previous unfinished work appears in the recovery list', (await B.listWorking()).some((entry) => entry.key === firstKey));
  await click(sheets[sheets.length - 1].body, 'Resume unfinished work');
  const unfinishedPicker = sheets[sheets.length - 1].body;
  const firstCard = all(unfinishedPicker).find((n) => n.tag === 'section' && all(n).some((child) => child.opts.text === 'First unfinished customer'));
  await click(firstCard, 'Resume form');
  let firstRestored = sheets[sheets.length - 1].body;
  t.eq('recovered unfinished work restores the original customer', byLabel(firstRestored, 'Name').value, 'First unfinished customer');
  await click(firstRestored, 'New quote');
  firstRestored = sheets[sheets.length - 1].body;
  t.eq('new quote starts with an empty customer', byLabel(firstRestored, 'Name').value, '');
  t.eq('new quote keeps the unfinished previous form', (await B.loadWorking(firstKey)).input.customer.name, 'First unfinished customer');
  const realSaveWorking = B.saveWorking;
  B.saveWorking = async () => { throw new Error('Device storage is full'); };
  const beforeFailedSwitch = sheets.length;
  await UI.open({ input: input });
  t.eq('failed working-form save prevents switching away and losing inputs', sheets.length, beforeFailedSwitch);
  t.ok('storage error is visible beside the form actions', all(firstRestored).some((n) => n.opts.className === 'qb-action-status' && /could not be saved/.test(n.textContent)));
  B.saveWorking = realSaveWorking;

  const conflictQuote = (await B.save(input)).quote;
  await UI.open({ id: conflictQuote.id });
  const live = sheets[sheets.length - 1].body;
  fill(live, 'Name', 'Keep this local customer');
  await click(live, 'Continue to pricing');
  const external = JSON.parse(JSON.stringify(input)); external.customer.name = 'Changed in the pipeline';
  await B.save(external, { id: conflictQuote.id, expectedRevision: 1 });
  await click(live, 'Save draft');
  t.ok('a conflict while saving offers recovery immediately', !!byLabel(live, 'Keep my changes as a new quote'));
  t.eq('conflicting local changes do not overwrite the stored quote', (await Q.get(conflictQuote.id)).customerName, 'Changed in the pipeline');
  await click(live, 'Keep my changes as a new quote');
  t.eq('immediate recovery retains the conflicting local customer', byLabel(live, 'Name').value, 'Keep this local customer');
  const resolveQuote = (await B.save(input)).quote;
  await UI.open({ id: resolveQuote.id });
  const resolveForm = sheets[sheets.length - 1].body;
  fill(resolveForm, 'Name', 'Local resolution');
  fill(resolveForm, 'Phone', '7135559999');
  await click(resolveForm, 'Continue to pricing');
  const remoteInput = JSON.parse(JSON.stringify(input));
  remoteInput.customer.name = 'Remote resolution'; remoteInput.customer.address = 'Remote address';
  await B.save(remoteInput, { id: resolveQuote.id, expectedRevision: 1 });
  await click(resolveForm, 'Save draft');
  const resolving = click(resolveForm, 'Compare & resolve changes');
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
  const diffForm = sheets[sheets.length - 1].body;
  t.eq('unresolved conflict cannot apply', byLabel(diffForm, 'Use resolved draft').disabled, true);
  const choice = byLabel(diffForm, 'Keep which value?'); choice.value = 'local'; choice.listeners.change();
  await click(diffForm, 'Use resolved draft'); await resolving;
  const resolvedForm = sheets[sheets.length - 1].body;
  t.eq('field resolution keeps chosen local customer', byLabel(resolvedForm, 'Name').value, 'Local resolution');
  t.eq('field resolution includes disjoint remote address', byLabel(resolvedForm, 'Job address').value, 'Remote address');
  t.eq('resolving alone never overwrites the saved quote', (await Q.get(resolveQuote.id)).customerName, 'Remote resolution');
  const originalForms = await Promise.all((await B.listWorking()).map(f => B.loadWorking(f.key)));
  t.ok('original local form remains recoverable', originalForms.some(f => f.input.customer.name === 'Local resolution' && f.revision === 1));
  await click(resolvedForm, 'Continue to pricing'); await click(resolvedForm, 'Save draft');
  t.eq('resolved quote saves against latest revision', (await Q.get(resolveQuote.id)).revision, 3);
  t.eq('resolved quote requires fresh approval', (await Q.get(resolveQuote.id)).status, 'draft');
  const before = sheets.length;
  G.AAA_RBAC.setRole('crew');
  await UI.open();
  t.eq('crew cannot open pricing workspace', sheets.length, before);
  delete G.document; delete G.location;
  return t.report();
};
