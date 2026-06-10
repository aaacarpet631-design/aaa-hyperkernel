/*
 * CSS visual-contract guards — the class of bug behavioral tests can't see.
 *
 * When JS toggles a class to HIDE something but a higher-specificity rule keeps
 * it SHOWN, every unit test stays green (the class IS on the element) while the
 * screen renders the opposite. That's how the voice FAB sat on the chat Send
 * button across two "fixes": JS added `hk-hide-voice-fab`, but the hide rule
 * `body.hk-hide-voice-fab .voice-fab` (0,2,1) lost to `#voice-hud .voice-fab`
 * (1,1,0) — an ID outranks any number of classes.
 *
 * Each CONTRACT below pins a "hide must out-rank show" relationship by computing
 * real CSS specificity from the actual selectors in the stylesheets, so a future
 * edit that re-introduces the inversion fails CI by name. Extend CONTRACTS for
 * decision sheets, bottom nav, command composer, overlays, and modals as those
 * hide/show pairs appear.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { makeRunner, ROOT } = require('../helpers/harness');

// CSS specificity as [ids, classes/attrs/pseudo-classes, types/pseudo-elements].
function specificity(selector) {
  let s = ' ' + String(selector).trim() + ' ';
  let a = 0, b = 0, c = 0;
  s = s.replace(/::[a-zA-Z-]+/g, function () { c++; return ' '; });      // ::pseudo-elements → type
  s = s.replace(/#[\w-]+/g, function () { a++; return ' '; });            // #ids
  s = s.replace(/\.[\w-]+/g, function () { b++; return ' '; });           // .classes
  s = s.replace(/\[[^\]]*\]/g, function () { b++; return ' '; });         // [attr]
  s = s.replace(/:[a-zA-Z-]+(\([^)]*\))?/g, function () { b++; return ' '; }); // :pseudo-class
  s = s.replace(/[>+~*]/g, ' ');                                          // combinators/universal: no weight
  (s.match(/[a-zA-Z][\w-]*/g) || []).forEach(function () { c++; });        // remaining type selectors
  return [a, b, c];
}
// returns >0 if x outranks y, <0 if weaker, 0 if equal
function cmp(x, y) { for (let i = 0; i < 3; i++) { if (x[i] !== y[i]) return x[i] - y[i]; } return 0; }

// Flat CSS rule parser (good enough for our non-nested rules). Returns the
// declaring selector that matches a predicate and whose body sets a declaration.
function rules(css) {
  css = css.replace(/\/\*[\s\S]*?\*\//g, ' '); // strip comments — braces inside them (e.g. `{ display: flex }`) would fool the brace parser
  const out = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m;
  while ((m = re.exec(css))) out.push({ selector: m[1].trim().replace(/\s+/g, ' '), body: m[2] });
  return out;
}
function findRule(file, selectorIncludes, declRe) {
  const css = fs.readFileSync(path.join(ROOT, file), 'utf8');
  return rules(css).filter(function (r) {
    return r.selector.indexOf(selectorIncludes) !== -1 && declRe.test(r.body) && r.selector.charAt(0) !== '@';
  })[0] || null;
}

// hide MUST out-specify show for the JS toggle to actually render.
const CONTRACTS = [
  {
    name: 'voiceFabHideRuleOutranksVoiceHudDisplayRule',
    // key on the toggle class, not the target, so a class-based revert is still
    // FOUND and then caught by the specificity comparison (the real contract).
    hide: { file: 'css/field-mode.css', selectorIncludes: 'hk-hide-voice-fab', decl: /display\s*:\s*none/ },
    show: { file: 'css/voice-hud.css', selectorIncludes: '.voice-fab', decl: /display\s*:/ }
  }
];

module.exports = function run() {
  const t = makeRunner('css-contracts');

  // ---- self-tests: the specificity math itself must be trustworthy ----------
  t.ok('specificity(#voice-hud .voice-fab) === [1,1,0]', JSON.stringify(specificity('#voice-hud .voice-fab')) === '[1,1,0]');
  t.ok('specificity(body.hk-hide-voice-fab #voice-fab) === [1,1,1]', JSON.stringify(specificity('body.hk-hide-voice-fab #voice-fab')) === '[1,1,1]');
  t.ok('one ID outranks four classes', cmp(specificity('#x'), specificity('.a.b.c.d')) > 0);
  t.ok('more classes outrank a bare type', cmp(specificity('.a'), specificity('div')) > 0);
  t.ok('::before counts as a type, not a class', JSON.stringify(specificity('.x::before')) === '[0,1,1]');

  // ---- the visual contracts -------------------------------------------------
  CONTRACTS.forEach(function (con) {
    const hide = findRule(con.hide.file, con.hide.selectorIncludes, con.hide.decl);
    const show = findRule(con.show.file, con.show.selectorIncludes, con.show.decl);
    t.ok(con.name + ': hide rule exists (' + con.hide.file + ' ' + con.hide.selectorIncludes + ')', !!hide);
    t.ok(con.name + ': show rule exists (' + con.show.file + ' ' + con.show.selectorIncludes + ')', !!show);
    if (hide && show) {
      const sh = specificity(hide.selector), ss = specificity(show.selector);
      t.ok(con.name + ' [' + sh.join(',') + ' > ' + ss.join(',') + ']', cmp(sh, ss) > 0);
    }
  });

  return t.report();
};
