/*
 * Convenience wrapper for `npm run test:rules` from the repo root. Requires the
 * Firebase emulator (Java) + deps installed under test/rules. Runs:
 *   firebase emulators:exec --only firestore "node rules.test.js"
 */
'use strict';
const cp = require('child_process');
const path = require('path');
const fs = require('fs');

const dir = path.join(__dirname, 'rules');
if (!fs.existsSync(path.join(dir, 'node_modules'))) {
  console.log('Rules test deps not installed. Run:\n  cd test/rules && npm install\nThen from the repo root: npm run test:rules');
  process.exit(2);
}
const r = cp.spawnSync('npx', ['firebase', 'emulators:exec', '--only', 'firestore', 'node rules.test.js'], { cwd: dir, stdio: 'inherit', shell: true });
process.exit(r.status || 0);
