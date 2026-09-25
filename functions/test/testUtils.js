'use strict';

// Shared helpers for the emulator-backed integration tests. These call the
// handler functions directly (bypassing the onCall() HTTPS wrapper, which
// is a two-line passthrough with no logic of its own) against a REAL
// Firestore emulator instance, so transaction semantics, missing-doc reads,
// and query behavior are all genuine — only the callable-function transport
// layer itself is skipped.

const { initializeApp, getApps } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');

const PROJECT_ID = 'demo-step5';

function getDb() {
  const app = getApps()[0] || initializeApp({ projectId: PROJECT_ID });
  return getFirestore(app);
}

async function clearEmulatorData() {
  const host = process.env.FIRESTORE_EMULATOR_HOST;
  if (!host) {
    throw new Error('FIRESTORE_EMULATOR_HOST is not set — these tests must run under firebase emulators:exec.');
  }
  const res = await fetch(`http://${host}/emulator/v1/projects/${PROJECT_ID}/databases/(default)/documents`, {
    method: 'DELETE'
  });
  if (!res.ok) {
    throw new Error(`Failed to clear emulator data: ${res.status} ${await res.text()}`);
  }
}

function fakeRequest(uid, data) {
  return { auth: uid ? { uid } : null, data };
}

// Rollout step 6a: submitMatchResult's live path requires a join doc per
// player. By default each player "joins" as a native account (auth uid ==
// player id); pass `joins` explicitly to model legacy accounts or a player
// who never joined.
// Also seeds a FINISHED game (p2 holds 3 letters, i.e. p1 won) unless the
// fixture sets its own letters, since submitMatchResult now requires the
// named loser to have spelled SKI (step 6a review fix 2).
async function seedLive(db, id, data, joins = [data.p1, data.p2]) {
  const seeded = data.letters ? data : { ...data, letters: { [data.p1]: 0, [data.p2]: 3 } };
  await db.collection('liveGames').doc(id).set(seeded);
  await Promise.all(joins.filter(Boolean).map((uid) =>
    db.collection('liveGames').doc(id).collection('joins').doc(uid).set({ joinedAt: Date.now() })));
}

// Rollout step 6a: the functions authorize against pendingResults/{id},
// which in prod only reportPendingResult writes.
function seedPendingResult(db, id, entry) {
  return db.collection('pendingResults').doc(id).set(entry);
}

module.exports = { PROJECT_ID, getDb, clearEmulatorData, fakeRequest, seedLive, seedPendingResult };
