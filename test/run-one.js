/* Runs a single suite module (in its own process) and exits non-zero on fail.
 * Prints a machine-readable final line: "RESULT <name> <pass> <fail>". */
'use strict';
const path = require('path');
const rel = process.argv[2];
if (!rel) { console.log('RESULT unknown 0 1'); process.exit(1); }

(async () => {
  try {
    const mod = require(path.join(__dirname, rel));
    const res = await mod();
    const name = (res && res.name) || rel;
    const pass = (res && res.pass) || 0;
    const fail = (res && res.fail) || 0;
    console.log('RESULT ' + name + ' ' + pass + ' ' + fail);
    process.exit(fail ? 1 : 0);
  } catch (e) {
    console.log('   FAIL: ' + rel + ' threw ' + (e && e.stack || e));
    console.log('RESULT ' + rel + ' 0 1');
    process.exit(1);
  }
})();
