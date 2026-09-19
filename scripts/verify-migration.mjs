// (C) Verification for the players/games/messages/friendRequests migration
// (Backend Migration Plan, rollout steps 3/4/6). Reusable against any
// target the caller has already connected `db` to — an emulator dry run or
// real prod — same connection convention as migrate-to-collections.mjs.
//
// Deliberately does NOT assert cross-collection referential integrity
// between games/messages/friendRequests and players — real prod data
// already has dangling participant ids across 56% of games (Pass 5 finding
// #2: 01 Refinements/(C) Backend Migration Plan - Verified 2026-09-16.md).
// Instead this asserts the orphan id set found in the SOURCE data survives
// the migration unchanged in the destination collections. A new orphan that
// wasn't already in state/global is a real migration bug; a pre-existing
// one is not something this script "fixes" by asserting it away.
//
// Source of truth for every check is state/global itself, read fresh at
// verify time (not a hardcoded snapshot) — so this script stays correct
// when re-run at rollout step 6 against however much prod data has changed
// by then, not just against today's dry run.

import assert from 'assert';
import { pathToFileURL } from 'url';

const SOURCE = [
  { collection: 'players', participantFields: [] },
  { collection: 'games', participantFields: ['winnerId', 'loserId', 'player1Id', 'player2Id'] },
  { collection: 'messages', participantFields: ['fromId', 'toId'] },
  { collection: 'friendRequests', participantFields: ['fromId', 'toId'] },
];

function deepEqual(a, b) {
  try {
    assert.deepStrictEqual(a, b);
    return true;
  } catch {
    return false;
  }
}

function orphansOf(elements, playerIds, participantFields) {
  const set = new Set();
  for (const el of elements) {
    for (const f of participantFields) {
      const v = el[f];
      if (v && !playerIds.has(v)) set.add(v);
    }
  }
  return set;
}

// Runs every verify criterion against `db` and returns an array of
// { name, pass, detail } — does not print or exit, so the dry-run harness
// can fold these results in alongside its own before/after checks.
export async function runVerification(db) {
  const results = [];
  const record = (name, pass, detail) => results.push({ name, pass: !!pass, detail });

  const globalSnap = await db.doc('state/global').get();
  assert(globalSnap.exists, 'state/global must exist to verify against');
  const state = globalSnap.data();

  const sourceById = {};
  for (const { collection } of SOURCE) {
    const map = new Map();
    for (const el of state[collection] || []) map.set(el.id, el);
    sourceById[collection] = map;
  }

  const destByCollection = {};

  // Criteria 1-3: doc counts, id round-trip (no missing/extra), field-for-
  // field identity (players get one deliberate exception: firebaseUid).
  for (const { collection } of SOURCE) {
    const srcMap = sourceById[collection];
    const snap = await db.collection(collection).get();
    const destMap = new Map(snap.docs.map((d) => [d.id, d.data()]));
    destByCollection[collection] = destMap;

    record(
      `${collection}: doc count matches source (${srcMap.size})`,
      destMap.size === srcMap.size,
      `dest=${destMap.size} src=${srcMap.size}`
    );

    const srcIds = new Set(srcMap.keys());
    const destIds = new Set(destMap.keys());
    const missing = [...srcIds].filter((id) => !destIds.has(id));
    const extra = [...destIds].filter((id) => !srcIds.has(id));
    record(
      `${collection}: every source id present, no extra docs`,
      missing.length === 0 && extra.length === 0,
      `missing=${JSON.stringify(missing)} extra=${JSON.stringify(extra)}`
    );

    const mismatches = [];
    for (const [id, dest] of destMap) {
      const src = srcMap.get(id);
      if (!src) continue; // already reported above as an extra doc
      if (collection === 'players') {
        const { firebaseUid, ...destWithoutFirebaseUid } = dest;
        const allowedKeys = new Set([...Object.keys(src), 'firebaseUid']);
        const hasUnexpectedKey = Object.keys(dest).some((k) => !allowedKeys.has(k));
        if (hasUnexpectedKey || !deepEqual(destWithoutFirebaseUid, src)) mismatches.push(id);
      } else if (!deepEqual(dest, src)) {
        mismatches.push(id);
      }
    }
    record(
      `${collection}: field-for-field identical to source` +
        (collection === 'players' ? ' (firebaseUid excepted, checked separately)' : ''),
      mismatches.length === 0,
      `mismatched ids: ${JSON.stringify(mismatches)}`
    );
  }

  // Criterion 4: firebaseUid is a cross-collection mirror of
  // users/{id}.firebaseUid, not a copied field (Pass 5 finding #1).
  const playersDest = destByCollection.players;
  let linkedCount = 0;
  const linkMismatches = [];
  for (const [id, dest] of playersDest) {
    const userSnap = await db.doc(`users/${id}`).get();
    const expectedUid = userSnap.exists ? userSnap.data().firebaseUid : undefined;
    if (expectedUid) {
      linkedCount++;
      if (dest.firebaseUid !== expectedUid) linkMismatches.push(`${id}: expected ${expectedUid}, got ${dest.firebaseUid}`);
    } else if (dest.firebaseUid !== undefined) {
      linkMismatches.push(`${id}: has firebaseUid but users/${id} has none`);
    }
  }
  record(
    `players: firebaseUid mirrored correctly from users/{id} (${linkedCount} linked)`,
    linkMismatches.length === 0,
    `mismatches=${JSON.stringify(linkMismatches)}`
  );

  // Criterion 5: known orphan set unchanged, not "zero orphans" (Pass 5
  // finding #2 / Trap 2) — asserted per collection, as an exact set.
  const playerIds = new Set(sourceById.players.keys());
  for (const { collection, participantFields } of SOURCE) {
    if (participantFields.length === 0) continue;
    const sourceOrphans = [...orphansOf(sourceById[collection].values(), playerIds, participantFields)].sort();
    const destOrphans = [...orphansOf(destByCollection[collection].values(), playerIds, participantFields)].sort();
    record(
      `${collection}: known orphan id set unchanged after migration`,
      deepEqual(sourceOrphans, destOrphans),
      `source=${JSON.stringify(sourceOrphans)} dest=${JSON.stringify(destOrphans)}`
    );
  }

  return results;
}

function printAndExit(results) {
  let fail = 0;
  for (const r of results) {
    console.log((r.pass ? 'PASS  ' : 'FAIL  ') + r.name);
    if (!r.pass) {
      console.log(`      ${r.detail}`);
      fail++;
    }
  }
  console.log(fail ? `\n${fail} CHECK(S) FAILED` : '\nALL CHECKS PASSED');
  process.exit(fail ? 1 : 0);
}

async function main() {
  const { initializeApp, getApps } = await import('firebase-admin/app');
  const { getFirestore } = await import('firebase-admin/firestore');
  if (!getApps().length) {
    if (!process.env.FIRESTORE_EMULATOR_HOST) {
      console.error('FIRESTORE_EMULATOR_HOST is not set — run under npm run migrate:dry-run, or point this at prod deliberately via GCLOUD_PROJECT + real credentials.');
      process.exit(1);
    }
    initializeApp({ projectId: process.env.GCLOUD_PROJECT || 'demo-migration' });
  }
  const db = getFirestore();
  const results = await runVerification(db);
  printAndExit(results);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
