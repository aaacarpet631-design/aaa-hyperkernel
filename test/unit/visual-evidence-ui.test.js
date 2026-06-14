/* Visual Evidence UI — the surface that makes the Visual Memory moat visible.
 * Verifies it composes from AAA_VISUAL_MEMORY (real store), degrades to honest
 * empty states with zero data, leaks no PII into the similar-jobs panel, opens
 * a sheet that actually attaches to the document (the invisible-sheet lesson),
 * and escapes hostile input. */
'use strict';
const { makeRunner, setupEnv, load } = require('../helpers/harness');

function makeEl() {
  const e = {
    _html: '', _text: '', style: {}, className: '', children: [],
    classList: { _s: {}, add(c) { this._s[c] = true; }, remove(c) { delete this._s[c]; }, contains(c) { return !!this._s[c]; }, toggle(c, on) { const v = on === undefined ? !this._s[c] : !!on; if (v) this._s[c] = true; else delete this._s[c]; return v; } },
    setAttribute() {}, getAttribute() { return null; }, addEventListener() {}, removeEventListener() {},
    appendChild(c) { e.children.push(c); return c; }, removeChild(c) { const i = e.children.indexOf(c); if (i >= 0) e.children.splice(i, 1); return c; },
    remove() {}, querySelector() { return null; }, querySelectorAll() { return []; }, focus() {}
  };
  Object.defineProperty(e, 'innerHTML', { get() { return e._html; }, set(v) { e._html = String(v); } });
  Object.defineProperty(e, 'textContent', { get() { return e._text; }, set(v) { e._text = String(v); } });
  return e;
}
function installDom() {
  global.document = { createElement: () => makeEl(), getElementById: () => makeEl(), body: makeEl() };
  return global.document;
}
// collect all innerHTML on the tree (mount builds via innerHTML strings)
function html(el, acc) { acc = acc || []; if (!el) return ''; if (el._html) acc.push(el._html); (el.children || []).forEach((c) => html(c, acc)); return acc.join(' '); }

module.exports = async function run() {
  const t = makeRunner('visual-evidence-ui');
  const { G } = setupEnv();
  installDom();
  try {
    load('js/intelligence/provenance-store.js');
    load('js/intelligence/visual-memory-store.js');
    load('js/ui/visual-evidence-ui.js');
    const VM = G.AAA_VISUAL_MEMORY, VE = G.AAA_VISUAL_EVIDENCE_UI;

    // ===== honest empty state with no captures =====
    const empty = await VE.renderModel({ jobId: 'jX' });
    t.ok('renderModel ok with no data', empty.ok === true);
    t.ok('captured is honestly empty', empty.captured.empty === true && /No photos captured/i.test(empty.captured.emptyLabel));
    t.ok('no similar/accuracy fabricated when there is nothing', empty.similar === null && empty.accuracy === null);

    // ===== seed evidence for a job + a comparable corpus with outcomes =====
    const r = await VM.record({ jobId: 'j1', customerId: 'c1', imageRef: 'm1', source: 'vision', serviceType: ['stretch'], analysis: { category: 'PET_DAMAGE', recommendation: 'Stretch + seam', confidenceScore: 0.8, estimateLowUSD: 250, estimateHighUSD: 350 } });
    await VM.linkOutcome(r.id, { finalAmountUSD: 320, won: true, laborHours: 3 });
    const p1 = await VM.record({ jobId: 'j2', customerId: 'c2', imageRef: 'm2', analysis: { category: 'PET_DAMAGE', estimateLowUSD: 200, estimateHighUSD: 300 } });
    await VM.linkOutcome(p1.id, { finalAmountUSD: 280, won: true, laborHours: 2 });
    const p2 = await VM.record({ jobId: 'j3', customerId: 'c3', imageRef: 'm3', analysis: { category: 'PET_DAMAGE' } });
    await VM.linkOutcome(p2.id, { finalAmountUSD: 500, won: false });

    const m = await VE.renderModel({ jobId: 'j1' });
    t.ok('captured rows reflect the job photo with category + confidence', m.captured.rows.length === 1 && m.captured.rows[0].category === 'PET_DAMAGE' && m.captured.rows[0].confidence === '80%');
    t.ok('predicted estimate range surfaced', /\$250.*\$350/.test(m.captured.rows[0].estimate));
    t.ok('similar-jobs evidence is computed from real outcomes', m.similar && m.similar.count === 2 && m.similar.closeRatePct === 50 && m.similar.avgFinalAmountUSD === 390);
    t.ok('estimate accuracy is reported once there are scored records', m.accuracy && m.accuracy.sample >= 1 && typeof m.accuracy.withinRangePct === 'number');

    // ===== mount: builds, no throw, renders the real numbers =====
    const el = makeEl();
    let threw = null, res = null;
    try { res = await VE.mount(el, { jobId: 'j1' }); } catch (e) { threw = e; }
    t.ok('mount returns mounted and does not throw', threw === null && res && res.mounted === true);
    const out = html(el);
    t.ok('rendered HTML shows the similar-jobs avg final', /\$390/.test(out));
    t.ok('rendered HTML never leaks a customer id', out.indexOf('c1') === -1 && out.indexOf('c2') === -1);

    // ===== open(): the sheet actually attaches to the document =====
    let appended = 0; const overlay = makeEl();
    G.AAA_UI = { sheet: () => ({ overlay: overlay, body: makeEl(), close: () => {} }) };
    const realAppend = global.document.body.appendChild;
    global.document.body.appendChild = function (c) { appended++; return realAppend.call(global.document.body, c); };
    const opened = await VE.open({ jobId: 'j1' });
    t.ok('open() attaches the sheet overlay to the document', opened.opened === true && appended === 1);
    delete G.AAA_UI;

    // ===== XSS: hostile analysis text is escaped =====
    const hostile = await VM.record({ jobId: 'jh', imageRef: 'mh', analysis: { category: '<img src=x onerror=alert(1)>', recommendation: '<script>bad()</script>' } });
    const hEl = makeEl(); await VE.mount(hEl, { jobId: 'jh' });
    const hHtml = html(hEl);
    t.ok('hostile category/recommendation are escaped', hHtml.indexOf('<img src=x') === -1 && hHtml.indexOf('<script>bad') === -1 && /&lt;img/.test(hHtml));

    // ===== null-safety: store absent → honest, no throw =====
    const savedVM = G.AAA_VISUAL_MEMORY; delete G.AAA_VISUAL_MEMORY;
    let threw2 = null, bare = null;
    try { bare = await VE.renderModel({ jobId: 'j1' }); } catch (e) { threw2 = e; }
    G.AAA_VISUAL_MEMORY = savedVM;
    t.ok('renderModel survives a missing memory store', threw2 === null && bare && bare.ok === false && bare.captured.empty === true);

    // no-DOM guard
    const savedDoc = global.document; delete global.document;
    const noDom = await VE.mount(null, { jobId: 'j1' });
    global.document = savedDoc;
    t.ok('mount honestly reports no_dom without a document', noDom.mounted === false && noDom.reason === 'no_dom');

    return t.report();
  } finally {
    delete global.document;
  }
};
