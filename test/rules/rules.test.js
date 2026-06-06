/*
 * Firestore security-rules tests — run against the emulator via:
 *   cd test/rules && npm install
 *   npx firebase emulators:exec --only firestore "npm test"
 *
 * NOTE on firebase.json: its "firestore" config is intentionally EMPTY ({}).
 * The canonical rules live at the repo root (../../firestore.rules), which is
 * OUTSIDE this emulator project directory, and firebase-tools refuses a rules
 * path outside the project root ("... is outside of project directory"), which
 * fails the emulator at startup. We do NOT need the emulator to load the rules
 * itself: this test deploys the real rules into the test environment directly,
 * by reading ../../firestore.rules and passing it to initializeTestEnvironment
 * below. That is the source of truth the assertions run against (the 19 checks,
 * including every assertFails() denial, pass precisely because THESE rules are
 * in force — not the emulator's default). Do not add a "rules" path back to
 * firebase.json or the emulator will fail to start in CI.
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

const PROJECT_ID = 'aaa-rules-test';
const WS = 'ws1';

let pass = 0, fail = 0;
async function check(label, p) { try { await p; pass++; } catch (e) { fail++; console.log('   FAIL: ' + label + ' -> ' + (e && e.message || e)); } }

async function main() {
  const env = await initializeTestEnvironment({
    projectId: PROJECT_ID,
    firestore: { rules: fs.readFileSync(path.join(__dirname, '..', '..', 'firestore.rules'), 'utf8') }
  });

  // Seed with rules bypassed (members are not client-writable).
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    await setDoc(doc(db, `workspaces/${WS}/members/owner1`), { role: 'owner' });
    await setDoc(doc(db, `workspaces/${WS}/members/crew1`), { role: 'crew' });
    await setDoc(doc(db, `workspaces/${WS}/members/manager1`), { role: 'manager' });
    await setDoc(doc(db, `workspaces/${WS}/members/norole`), { name: 'x' }); // defaults to crew
    await setDoc(doc(db, `workspaces/${WS}/invoices/inv1`), { amount: 100 });
    await setDoc(doc(db, `workspaces/${WS}/receipts/r1`), { total: 42, vendor: 'Home Depot' });
    await setDoc(doc(db, `workspaces/${WS}/quotes/q1`), { customerTotal: 500, marginEstimate: 200 });
    await setDoc(doc(db, `workspaces/${WS}/pricing_recommendations/pr1`), { title: 'x', confidence: 70 });
    await setDoc(doc(db, `workspaces/${WS}/learning_feedback/lf1`), { kind: 'closure', status: 'validated' });
    await setDoc(doc(db, `workspaces/${WS}/calibration_versions/cv1`), { agent: 'pricing_optimizer', confidenceBias: 5 });
    await setDoc(doc(db, `workspaces/${WS}/council_sessions/cs1`), { decision: 'approve', disagreement: 20 });
    await setDoc(doc(db, `workspaces/${WS}/legal_records/lr1`), { type: 'incident', summary: 'sensitive' });
    await setDoc(doc(db, `workspaces/${WS}/audit_log/a1`), { action: 'X' });
    await setDoc(doc(db, `workspaces/${WS}/integrations/qbo`), { accessToken: 'SECRET' });
    await setDoc(doc(db, `workspaces/${WS}/jobs/j1`), { name: 'job' });
  });

  const owner = env.authenticatedContext('owner1').firestore();
  const crew = env.authenticatedContext('crew1').firestore();
  const manager = env.authenticatedContext('manager1').firestore();
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
  await check('owner reads receipts', assertSucceeds(getDoc(doc(owner, `workspaces/${WS}/receipts/r1`))));
  await check('crew CANNOT read receipts', assertFails(getDoc(doc(crew, `workspaces/${WS}/receipts/r1`))));
  await check('crew CANNOT write receipts', assertFails(setDoc(doc(crew, `workspaces/${WS}/receipts/r2`), { total: 9 })));
  await check('owner reads quotes', assertSucceeds(getDoc(doc(owner, `workspaces/${WS}/quotes/q1`))));
  await check('crew CANNOT read quotes (margins)', assertFails(getDoc(doc(crew, `workspaces/${WS}/quotes/q1`))));
  await check('owner reads pricing recommendations', assertSucceeds(getDoc(doc(owner, `workspaces/${WS}/pricing_recommendations/pr1`))));
  await check('crew CANNOT read pricing recommendations', assertFails(getDoc(doc(crew, `workspaces/${WS}/pricing_recommendations/pr1`))));
  await check('owner reads learning feedback', assertSucceeds(getDoc(doc(owner, `workspaces/${WS}/learning_feedback/lf1`))));
  await check('crew CANNOT read learning feedback', assertFails(getDoc(doc(crew, `workspaces/${WS}/learning_feedback/lf1`))));
  await check('owner reads calibration versions', assertSucceeds(getDoc(doc(owner, `workspaces/${WS}/calibration_versions/cv1`))));
  await check('crew CANNOT read calibration versions', assertFails(getDoc(doc(crew, `workspaces/${WS}/calibration_versions/cv1`))));
  await check('owner reads council sessions', assertSucceeds(getDoc(doc(owner, `workspaces/${WS}/council_sessions/cs1`))));
  await check('crew CANNOT read council sessions', assertFails(getDoc(doc(crew, `workspaces/${WS}/council_sessions/cs1`))));
  // legal records: owner + manager (the legal roles) may read/write; crew cannot.
  await check('owner reads legal records', assertSucceeds(getDoc(doc(owner, `workspaces/${WS}/legal_records/lr1`))));
  await check('manager reads legal records', assertSucceeds(getDoc(doc(manager, `workspaces/${WS}/legal_records/lr1`))));
  await check('crew CANNOT read legal records', assertFails(getDoc(doc(crew, `workspaces/${WS}/legal_records/lr1`))));
  await check('crew CANNOT write legal records', assertFails(setDoc(doc(crew, `workspaces/${WS}/legal_records/lr2`), { type: 'incident' })));
  await check('manager CAN write a legal record', assertSucceeds(setDoc(doc(manager, `workspaces/${WS}/legal_records/lr3`), { type: 'contract' })));

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
