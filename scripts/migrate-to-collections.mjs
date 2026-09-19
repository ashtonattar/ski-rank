// (C) One-time migration: copies players/games/messages/friendRequests off
// state/global's four arrays into their own collections, keyed by each
// element's own `id` (never `add()` — that would break idempotency).
// Backend Migration Plan, rollout steps 3/4/6:
//   01 Refinements/(C) Backend Migration Plan - Verified 2026-09-16.md
//
// ⚠ SAFE-WINDOW WARNING (Pass 5 finding #4) — read this before ever running
// this script again after today: it does a full set() per document, sourced
// from state/global's arrays. That is only safe BEFORE the Cloud Functions
// (submitMatchResult/applyStrikePenalty, rollout step 5) begin writing
// rating/wins/losses/gamesPlayed. Run it again after that point and it will
// silently overwrite CF-computed values with stale array data, reverting
// real match results. Nothing in this script detects that condition —
// the rollout plan controls safety by sequencing (re-run at step 6, never
// after), not this script.
//
// firebaseUid is a CROSS-COLLECTION LOOKUP, not a field copy (Pass 5 finding
// #1): it does not exist on state/global.players elements. Both places that
// write it (signup ~index.html:4907, finishMigration() ~index.html:5043)
// write only to users/{uid}. So for each player this script separately
// reads users/{playerId}.firebaseUid and mirrors it onto players/{playerId}
// only when present; when the users doc is missing or has no firebaseUid,
// the player doc is written without one (the intended lockout fallback for
// unlinked legacy/seed accounts, not a bug).
//
// Referential integrity between the four new collections is NOT enforced or
// repaired here (Pass 5 finding #2) — state/global's real data already has
// dangling participant ids (66/117 games) and this script preserves them
// exactly, byte for byte. Cleaning that up is a separate project.
//
// state/global itself is only ever READ here, never written. The old arrays
// stay live and authoritative until rollout step 9.

import { pathToFileURL } from 'url';
import { initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

const COLLECTIONS = ['players', 'games', 'messages', 'friendRequests'];

// Copies state[collection]'s array into the `collection` Firestore
// collection, one doc per element keyed by element.id. Returns
// { collection: docsWritten } for each of the four collections.
export async function runMigration(db) {
  const globalSnap = await db.doc('state/global').get();
  if (!globalSnap.exists) {
    throw new Error('state/global does not exist — nothing to migrate');
  }
  const state = globalSnap.data();

  const summary = {};

  for (const collection of COLLECTIONS) {
    const elements = state[collection] || [];
    let written = 0;

    for (const el of elements) {
      if (!el || typeof el.id !== 'string' || el.id === '') {
        throw new Error(`${collection} element missing a usable id: ${JSON.stringify(el)}`);
      }

      let docData = el;
      if (collection === 'players') {
        const userSnap = await db.doc(`users/${el.id}`).get();
        const firebaseUid = userSnap.exists ? userSnap.data().firebaseUid : undefined;
        docData = firebaseUid ? { ...el, firebaseUid } : el;
      }

      // set(), not merge — a full overwrite is what keeps a re-run
      // byte-identical instead of letting stale fields accumulate.
      await db.doc(`${collection}/${el.id}`).set(docData);
      written++;
    }

    summary[collection] = written;
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
      'This script writes players/games/messages/friendRequests from state/global.\n\n' +
      'For a dry run against the real prod snapshot: npm run migrate:dry-run\n' +
      '(starts a clean emulator for you, never touches prod).\n\n' +
      'To run against real production (rollout step 4 or 6 — a separate,\n' +
      'deliberate action, never a default): pass --prod, set\n' +
      'MIGRATION_CONFIRM_PROD=yes-i-am-sure, and set GCLOUD_PROJECT explicitly.'
    );
    process.exit(1);
  }

  if (emulatorHost && allowProd) {
    console.error(
      `Refusing to run: --prod was passed but FIRESTORE_EMULATOR_HOST is set (${emulatorHost}).\n` +
      'That is contradictory intent — firebase-admin honours the emulator host and would\n' +
      'silently write to the emulator while this script logs a "real production" warning.\n' +
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
    console.warn(`⚠  Running against REAL project "${projectId}" — this writes production data.`);
    initializeApp({ projectId });
  } else {
    initializeApp({ projectId: process.env.GCLOUD_PROJECT || 'demo-migration' });
  }

  const db = getFirestore();
  const summary = await runMigration(db);
  console.log('Migration complete:', summary);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
