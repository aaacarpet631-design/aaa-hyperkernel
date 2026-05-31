/*
 * Firestore security-rules tests — run against the emulator via:
 *   cd test/rules && npm install
 *   npx firebase emulators:exec --only firestore --project demo-aaa-rules "npm test"
 *
 * Proves the guarantees the app relies on:
 *   - workspace isolation (non-members blocked),
 *   - crew CANNOT read financial collections; owner CAN,
 *   - audit_log is append-only (create yes; update/delete no) and owner-read,
 *   - the generic wildcard does NOT loosen members / audit_log / integrations,
 *   - integrations (OAuth tokens) is fully denied to all clients.
 *
 * Zero test-framework: a tiny assert + summary, exits non-zero on any failure.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { initializeTestEnvironment, assertSucceeds, assertFails } = require('@firebase/rules-unit-testing');
const { setDoc, getDoc, updateDoc, deleteDoc, doc } = require('firebase/firestore');

const PROJECT_ID = 'demo-aaa-rules';   // 'demo-' prefix => emulator runs fully offline, no real project/credentials
const WS = 'ws1';

let pass = 0, fail = 0;
async function check(label, p) { try { await p; pass++; } catch (e) { fail++; console.log('   FAIL: ' + label + ' -> ' + (e && e.message || e)); } }

// "127.0.0.1:8080" -> { host, port } for initializeTestEnvironment; {} if unset.
function parseEmulatorHost(v) {
  if (!v) return {};
  const m = String(v).match(/^(.*):(\d+)$/);
  return m ? { host: m[1], port: Number(m[2]) } : {};
}

async function main() {
  // Honor the emulator host the Firebase CLI advertises to child processes.
  // Default to the firebase.json port so a bare `node rules.test.js` also works
  // when the emulator is already running.
  const env = await initializeTestEnvironment({
    projectId: PROJECT_ID,
    firestore: Object.assign(
      { rules: fs.readFileSync(path.join(__dirname, '..', '..', 'firestore.rules'), 'utf8') },
      parseEmulatorHost(process.env.FIRESTORE_EMULATOR_HOST)
    )
  });

  // Seed with rules bypassed (members are not client-writable).
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    await setDoc(doc(db, `workspaces/${WS}/members/owner1`), { role: 'owner' });
    await setDoc(doc(db, `workspaces/${WS}/members/crew1`), { role: 'crew' });
    await setDoc(doc(db, `workspaces/${WS}/members/norole`), { name: 'x' }); // defaults to crew
    await setDoc(doc(db, `workspaces/${WS}/invoices/inv1`), { amount: 100 });
    await setDoc(doc(db, `workspaces/${WS}/audit_log/a1`), { action: 'X' });
    await setDoc(doc(db, `workspaces/${WS}/integrations/qbo`), { accessToken: 'SECRET' });
    await setDoc(doc(db, `workspaces/${WS}/jobs/j1`), { name: 'job' });
  });

  const owner = env.authenticatedContext('owner1').firestore();
  const crew = env.authenticatedContext('crew1').firestore();
  const norole = env.authenticatedContext('norole').firestore();
  const stranger = env.authenticatedContext('nobody').firestore();

  // workspace isolation
  await check('non-member cannot read a job', assertFails(getDoc(doc(stranger, `workspaces/${WS}/jobs/j1`))));
  await check('member can read a job', assertSucceeds(getDoc(doc(crew, `workspaces/${WS}/jobs/j1`))));

  // financial collections: owner yes, crew no
  await check('owner reads invoices', assertSucceeds(getDoc(doc(owner, `workspaces/${WS}/invoices/inv1`))));
  await check('crew CANNOT read invoices', assertFails(getDoc(doc(crew, `workspaces/${WS}/invoices/inv1`))));
  await check('no-role (default crew) CANNOT read invoices', assertFails(getDoc(doc(norole, `workspaces/${WS}/invoices/inv1`))));
  await check('crew CANNOT write payments', assertFails(setDoc(doc(crew, `workspaces/${WS}/payments/p1`), { amount: 5 })));
  await check('owner CAN write expenses', assertSucceeds(setDoc(doc(owner, `workspaces/${WS}/expenses/e1`), { amount: 5 })));

  // audit_log: append-only + owner-read (regression for the wildcard bug)
  await check('member CAN create audit entry', assertSucceeds(setDoc(doc(crew, `workspaces/${WS}/audit_log/a2`), { action: 'Y' })));
  await check('owner CAN read audit log', assertSucceeds(getDoc(doc(owner, `workspaces/${WS}/audit_log/a1`))));
  await check('crew CANNOT read audit log', assertFails(getDoc(doc(crew, `workspaces/${WS}/audit_log/a1`))));
  await check('member CANNOT update audit entry', assertFails(updateDoc(doc(crew, `workspaces/${WS}/audit_log/a1`), { action: 'Z' })));
  await check('member CANNOT delete audit entry', assertFails(deleteDoc(doc(crew, `workspaces/${WS}/audit_log/a1`))));
  await check('owner CANNOT update audit entry (immutable)', assertFails(updateDoc(doc(owner, `workspaces/${WS}/audit_log/a1`), { action: 'Z' })));

  // members: not client-writable (regression for the wildcard bug)
  await check('member can read members', assertSucceeds(getDoc(doc(crew, `workspaces/${WS}/members/owner1`))));
  await check('crew CANNOT write a member doc (no self-promote)', assertFails(setDoc(doc(crew, `workspaces/${WS}/members/crew1`), { role: 'owner' })));
  await check('owner CANNOT write a member doc from client', assertFails(setDoc(doc(owner, `workspaces/${WS}/members/crew1`), { role: 'owner' })));

  // integrations: fully denied to clients (OAuth tokens)
  await check('owner CANNOT read integrations tokens', assertFails(getDoc(doc(owner, `workspaces/${WS}/integrations/qbo`))));
  await check('crew CANNOT read integrations tokens', assertFails(getDoc(doc(crew, `workspaces/${WS}/integrations/qbo`))));
  await check('owner CANNOT write integrations', assertFails(setDoc(doc(owner, `workspaces/${WS}/integrations/qbo`), { accessToken: 'x' })));

  await env.cleanup();
  console.log('\n[rules] ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
