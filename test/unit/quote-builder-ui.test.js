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
  ['js/core/aaa-rbac.js', 'js/core/aaa-runtime-gateway.js', 'js/quotes/integrations/measurement-to-quote.js', 'js/quotes/quote-store.js', 'js/quotes/quote-builder.js'].forEach(load);
  const sheets = [];
  G.document = { body: node('body') };
  G.location = { href: '' };
  G.AAA_LOCAL_FIRST_STORAGE = { put: data.put, get: data.get };
  G.AAA_UI = {
    el: node, button: (o) => { const n = node('button', o); n.disabled = !!o.disabled; return n; },
    sheet: (o) => { const s = { overlay: node('overlay'), body: node('body'), close() { s.closed = true; }, opts: o }; sheets.push(s); return s; },
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
  const before = sheets.length;
  G.AAA_RBAC.setRole('crew');
  await UI.open();
  t.eq('crew cannot open pricing workspace', sheets.length, before);
  delete G.document; delete G.location;
  return t.report();
};
