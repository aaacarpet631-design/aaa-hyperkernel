/* Confirmation dismissal must release callers without approving an action. */
'use strict';
const { makeRunner, setupEnv, load } = require('../helpers/harness');

function node(tag) {
  const n = { tag, children: [], attrs: {}, listeners: {}, style: {}, value: '', classList: { add() {}, remove() {} } };
  n.appendChild = (child) => { n.children.push(child); return child; };
  n.setAttribute = (key, value) => { n.attrs[key] = value; };
  n.addEventListener = (event, fn) => { n.listeners[event] = fn; };
  n.remove = () => {}; n.focus = () => {};
  return n;
}
function all(n) { return [n, ...n.children.flatMap(all)]; }

module.exports = async function () {
  const t = makeRunner('ui-confirm');
  const { G } = setupEnv();
  const keys = new Set();
  G.document = {
    body: node('body'), createElement: node,
    addEventListener: (event, fn) => { if (event === 'keydown') keys.add(fn); },
    removeEventListener: (event, fn) => { if (event === 'keydown') keys.delete(fn); }
  };
  G.requestAnimationFrame = (fn) => fn();
  load('js/ui/ui-kit.js');
  const U = G.AAA_UI;
  function start(options) {
    const result = { value: 'pending' };
    U.confirm(Object.assign({ title: 'Approve quote?', confirmLabel: 'Approve quote' }, options)).then((v) => { result.value = v; });
    result.overlay = G.document.body.children[G.document.body.children.length - 1];
    result.button = (label) => all(result.overlay).find((n) => n.innerHTML === '<span>' + label + '</span>');
    return result;
  }
  for (const exit of ['close', 'escape', 'backdrop', 'cancel']) {
    const result = start();
    if (exit === 'close') all(result.overlay).find((n) => n.attrs['aria-label'] === 'Close').listeners.click();
    if (exit === 'escape') [...keys].forEach((fn) => fn({ key: 'Escape' }));
    if (exit === 'backdrop') result.overlay.listeners.click({ target: result.overlay });
    if (exit === 'cancel') result.button('Cancel').listeners.click();
    await Promise.resolve();
    t.eq(exit + ' resolves as cancellation instead of leaving the caller busy', result.value, null);
  }
  const approve = start();
  approve.button('Approve quote').listeners.click();
  await Promise.resolve();
  t.ok('explicit approval still returns the confirmation result', approve.value && approve.value.reason === '');
  const reason = start({ requireReason: true });
  reason.button('Approve quote').listeners.click();
  await Promise.resolve();
  t.eq('empty required reason keeps confirmation pending', reason.value, 'pending');
  all(reason.overlay).find((n) => n.tag === 'textarea').value = '  Rates verified  ';
  reason.button('Approve quote').listeners.click();
  await Promise.resolve();
  t.eq('confirmed reason is preserved', reason.value && reason.value.reason, 'Rates verified');
  t.eq('closed confirmations release their keyboard listeners', keys.size, 0);
  let parentClosed = 0;
  const parent = U.sheet({ title: 'Build a quote', onClose: () => { parentClosed++; } });
  G.document.body.appendChild(parent.overlay);
  const nested = start();
  [...keys].forEach((fn) => fn({ key: 'Escape' }));
  await Promise.resolve();
  t.eq('Escape cancels only the approval dialog', nested.value, null);
  t.eq('Escape leaves the underlying quote editor open', parentClosed, 0);
  t.eq('underlying quote editor retains its keyboard listener', keys.size, 1);
  parent.close(); parent.close();
  t.eq('closing a sheet twice invokes its cleanup once', parentClosed, 1);
  t.eq('nested sheet cleanup leaves no keyboard listeners', keys.size, 0);
  delete G.document; delete G.requestAnimationFrame;
  return t.report();
};
