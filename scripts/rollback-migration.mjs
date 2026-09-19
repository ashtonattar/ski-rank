// (C) Rollback for the players/games/messages/friendRequests migration
// (Backend Migration Plan, rollout step 4/6). Deletes every document in the
// four collections migrate-to-collections.mjs writes. Never touches
// state/global — the old arrays stay live and authoritative, so a rollback
// leaves production exactly as it was before the migration ran, with no
// user-visible change (rollout step 7 is what starts reading the new
// collections; nothing does yet).
//
// Same connection/guard conventions as migrate-to-collections.mjs
// (FIRESTORE_EMULATOR_HOST / --prod / MIGRATION_CONFIRM_PROD / GCLOUD_PROJECT
// + the pathToFileURL entrypoint guard — see entrypoint.test.mjs for why the
// naive `file://${argv[1]}` comparison silently no-ops on this repo's path).

import { pathToFileURL } from 'url';
import { initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

const COLLECTIONS = ['players', 'games', 'messages', 'friendRequests'];
const BATCH_SIZE = 500; // Firestore batch write limit

// Deletes every document in each of the four collections. Never reads or
// writes state/global. Returns { collection: docsDeleted } for each.
export async function runRollback(db) {
  const summary = {};

  for (const collection of COLLECTIONS) {
    const snap = await db.collection(collection).get();
    const docs = snap.docs;

    for (let i = 0; i < docs.length; i += BATCH_SIZE) {
      const batch = db.batch();
      for (const doc of docs.slice(i, i + BATCH_SIZE)) {
        batch.delete(doc.ref);
      }
      await batch.commit();
    }

    summary[collection] = docs.length;
  }

  return summary;
}

async function main() {
  const emulatorHost = process.env.FIRESTORE_EMULATOR_HOST;
  const allowProd = process.argv.includes('--prod');
  const confirmedProd = process.env.MIGRATION_CONFIRM_PROD === 'yes-i-am-sure';

  if (!emulatorHost && !(allowProd && confirmedProd)) {
    console.error(
      'Refusing to run: FIRESTORE_EMULATOR_HOST is not set.\n' +
      'This script DELETES every doc in players/games/messages/friendRequests.\n\n' +
      'For a dry run: start a Firestore emulator and set FIRESTORE_EMULATOR_HOST.\n\n' +
      'To run against real production (undoing rollout step 4 or 6 — a separate,\n' +
      'deliberate action, never a default): pass --prod, set\n' +
      'MIGRATION_CONFIRM_PROD=yes-i-am-sure, and set GCLOUD_PROJECT explicitly.'
    );
    process.exit(1);
  }

  if (emulatorHost && allowProd) {
    console.error(
      `Refusing to run: --prod was passed but FIRESTORE_EMULATOR_HOST is set (${emulatorHost}).\n` +
      'That is contradictory intent — firebase-admin honours the emulator host and would\n' +
      'silently delete from the emulator while this script logs a "real production" warning.\n' +
      'Unset FIRESTORE_EMULATOR_HOST to actually run against prod, or drop --prod for a dry run.'
    );
    process.exit(1);
  }

  if (allowProd && confirmedProd) {
    const projectId = process.env.GCLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT;
    if (!projectId) {
      console.error('Set GCLOUD_PROJECT explicitly when running with --prod. Refusing to guess a project id.');
      process.exit(1);
    }
    console.warn(`⚠  Running against REAL project "${projectId}" — this DELETES production data.`);
    initializeApp({ projectId });
  } else {
    initializeApp({ projectId: process.env.GCLOUD_PROJECT || 'demo-migration' });
  }

  const db = getFirestore();
  const summary = await runRollback(db);
  console.log('Rollback complete:', summary);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
