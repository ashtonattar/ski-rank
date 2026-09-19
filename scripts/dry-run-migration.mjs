// (C) Dry-run harness for the players/games/messages/friendRequests
// migration (Backend Migration Plan, rollout step 3). Loads the REAL
// production snapshot taken at rollout step 2 into a clean Firestore
// emulator, then:
//   1. runs the migration script twice back-to-back (idempotency check —
//      required per the plan, since step 6 depends on safely re-running
//      this same script against live prod data),
//   2. runs verify-migration.mjs's general checks,
//   3. adds two checks that only make sense with harness-level control of
//      the run (before/after state/global, and a real byte-identical
//      re-run diff — verify-migration.mjs alone can't see "before"),
//   4. pins the doc counts and firebaseUid link count to the numbers
//      documented for this exact snapshot (01 Refinements/(C) Step 2 -
//      Backup Decision & Verification.md), as an extra sanity check
//      specific to this dry run.
//
// NEVER touches production. Must run under `firebase emulators:exec` (which
// sets FIRESTORE_EMULATOR_HOST for us) — refuses to run otherwise.
//
// Run: npm run migrate:dry-run

import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';
import assert from 'assert';
import { initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { runMigration } from './migrate-to-collections.mjs';
import { runVerification } from './verify-migration.mjs';
import { runRollback } from './rollback-migration.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const EMULATOR_HOST = process.env.FIRESTORE_EMULATOR_HOST;
if (!EMULATOR_HOST) {
  console.error(
    'This harness must run under `firebase emulators:exec` (FIRESTORE_EMULATOR_HOST ' +
    'is not set) so it can never reach a real project. Use: npm run migrate:dry-run'
  );
  process.exit(1);
}

// The real prod snapshot from rollout step 2, living in the Obsidian vault
// (not this repo) — overridable for anyone running this outside that vault
// layout.
const DEFAULT_BACKUP_FILE = path.resolve(
  __dirname, '..', '..', '..',
  '01 Refinements', '(C) Pre-Migration Backups',
  'state-global-backup-2026-09-19T00-30-01-208Z.json'
);
const BACKUP_FILE = process.env.SLOPEBATTLES_BACKUP_FILE || DEFAULT_BACKUP_FILE;

const PROJECT_ID = 'demo-migration';
const base = `http://${EMULATOR_HOST}/v1/projects/${PROJECT_ID}/databases/(default)/documents`;

async function put(docPath, fields) {
  const r = await fetch(`${base}/${docPath}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer owner' },
    body: JSON.stringify({ fields }),
  });
  if (!r.ok) {
    throw new Error(`${docPath} -> ${r.status} ${(await r.text()).slice(0, 200)}`);
  }
}

// Loads only what the migration script actually reads: state/global (the
// four source arrays) and users (the firebaseUid cross-reference, Pass 5
// finding #1). Admin-authenticated PATCH, same as the step-2 restore
// tooling — firestore.rules correctly rejects an unauthenticated write to
// state/global.
async function loadRealSnapshot(backupFile) {
  const bk = JSON.parse(readFileSync(backupFile, 'utf8'));
  await put('state/global', bk.docs['state/global'].fields);
  let n = 0;
  for (const doc of bk.collections.users || []) {
    await put(`users/${doc.name.split('/').pop()}`, doc.fields || {});
    n++;
  }
  console.log(`Loaded real prod snapshot: state/global + ${n} users docs (${path.basename(backupFile)})`);
}

async function snapshotAll(db, collections) {
  const out = {};
  for (const collection of collections) {
    const snap = await db.collection(collection).get();
    out[collection] = Object.fromEntries(snap.docs.map((d) => [d.id, d.data()]));
  }
  return out;
}

function deepEqual(a, b) {
  try {
    assert.deepStrictEqual(a, b);
    return true;
  } catch {
    return false;
  }
}

async function main() {
  console.log(`Backup source: ${BACKUP_FILE}\n`);
  await loadRealSnapshot(BACKUP_FILE);

  initializeApp({ projectId: PROJECT_ID });
  const db = getFirestore();

  const results = [];
  const record = (name, pass, detail) => results.push({ name, pass: !!pass, detail });

  const globalBefore = (await db.doc('state/global').get()).data();

  console.log('\nRunning migration (pass 1)...');
  console.log('  ', await runMigration(db));
  const snap1 = await snapshotAll(db, ['players', 'games', 'messages', 'friendRequests']);

  console.log('Running migration (pass 2 — idempotency check)...');
  console.log('  ', await runMigration(db));
  const snap2 = await snapshotAll(db, ['players', 'games', 'messages', 'friendRequests']);

  record('re-running the migration is a byte-identical no-op', deepEqual(snap1, snap2), 'diff between run 1 and run 2 snapshots');

  const globalAfter = (await db.doc('state/global').get()).data();
  record('state/global is unmodified by the migration', deepEqual(globalBefore, globalAfter), 'state/global changed between before and after');

  console.log('\nRunning rollback (exercising the untested-until-now rollback path)...');
  console.log('  ', await runRollback(db));
  const emptyAfterRollback = await snapshotAll(db, ['players', 'games', 'messages', 'friendRequests']);
  for (const collection of ['players', 'games', 'messages', 'friendRequests']) {
    record(
      `rollback: ${collection} is empty`,
      Object.keys(emptyAfterRollback[collection]).length === 0,
      `expected 0 docs, got ${Object.keys(emptyAfterRollback[collection]).length}`
    );
  }
  const globalAfterRollback = (await db.doc('state/global').get()).data();
  record(
    'rollback: state/global is unmodified',
    deepEqual(globalBefore, globalAfterRollback),
    'state/global changed by rollback'
  );

  console.log('Running migration (pass 3 — re-migrating after rollback)...');
  console.log('  ', await runMigration(db));
  const snap3 = await snapshotAll(db, ['players', 'games', 'messages', 'friendRequests']);
  record(
    're-migrating after rollback reproduces the original migration exactly',
    deepEqual(snap1, snap3),
    'diff between pass-1 snapshot and post-rollback pass-3 snapshot'
  );

  console.log('\nRunning verify-migration checks...');
  results.push(...(await runVerification(db)));

  // Dataset-specific pins for this exact documented snapshot (01
  // Refinements/(C) Step 2 - Backup Decision & Verification.md) — extra
  // confidence on top of verify-migration.mjs's data-driven checks above,
  // not a replacement for them.
  const counts = Object.fromEntries(Object.entries(snap1).map(([k, v]) => [k, Object.keys(v).length]));
  record(`players doc count == 16 (documented step-2 snapshot)`, counts.players === 16, `got ${counts.players}`);
  record(`games doc count == 117 (documented step-2 snapshot)`, counts.games === 117, `got ${counts.games}`);
  record(`messages doc count == 11 (documented step-2 snapshot)`, counts.messages === 11, `got ${counts.messages}`);
  record(`friendRequests doc count == 5 (documented step-2 snapshot)`, counts.friendRequests === 5, `got ${counts.friendRequests}`);

  const linkedCount = Object.values(snap1.players).filter((p) => p.firebaseUid).length;
  record('exactly 7 player docs carry firebaseUid (documented step-2 snapshot)', linkedCount === 7, `got ${linkedCount}`);

  console.log('');
  let fail = 0;
  for (const r of results) {
    console.log((r.pass ? 'PASS  ' : 'FAIL  ') + r.name);
    if (!r.pass) {
      console.log(`      ${r.detail}`);
      fail++;
    }
  }
  console.log(fail ? `\n${fail} CHECK(S) FAILED` : '\nALL CHECKS PASSED — migration dry run verified against real prod snapshot');
  process.exit(fail ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
