'use strict';

const { HttpsError } = require('./validate');

/**
 * Maps a Firebase Auth uid to the caller's player id.
 *
 * Player ids are NOT auth uids in general (index.html:4898,
 * `playerId = firebaseUid || uid()`): a Firebase-native signup's player id
 * equals its auth uid, but a legacy account keeps its original random id and
 * only gains a `firebaseUid` link — which the step-4 migration mirrored onto
 * players/{id}. The two most active real accounts (`mptze2pp`, `mptzm7c0`)
 * are legacy, so comparing request.auth.uid directly against player ids
 * (live.p1/p2/judgeId, pending opponentId) rejects them outright.
 *
 * Resolution order:
 *   1. players/{authUid} exists → authUid (Firebase-native account).
 *   2. Exactly one players doc with firebaseUid == authUid → that doc's id
 *      (legacy account). More than one → refuse to guess.
 *   3. Neither → authUid. This is what a Firebase-native account's player id
 *      is by construction, and covers a native signup whose players doc
 *      doesn't exist yet (players/ is only populated by the migration until
 *      step 6's dual-write). Safe because the caller still has to pass the
 *      party check against the resolved id — an unknown uid matches nothing.
 *
 * Must run inside the transaction, before any writes.
 */
async function resolveCallerPlayerId(tx, db, authUid) {
  const ownSnap = await tx.get(db.collection('players').doc(authUid));
  if (ownSnap.exists) return authUid;

  const linked = await tx.get(
    db.collection('players').where('firebaseUid', '==', authUid).limit(2)
  );
  if (linked.size > 1) {
    throw new HttpsError('failed-precondition', 'Multiple player records are linked to this account.');
  }
  if (linked.size === 1) return linked.docs[0].id;
  return authUid;
}

/**
 * True if player `playerId` has a join doc under liveGames/{liveGameId}/joins.
 * Join docs are keyed by AUTH uid, and firestore.rules only lets a user
 * create the one whose id is their own uid, so a join is proof that
 * specific account showed up (rollout step 6a, forgery gate).
 *
 * Only the two auth uids that can belong to this player are looked up, not
 * the whole subcollection: the player id itself (Firebase-native account)
 * and players/{playerId}.firebaseUid (legacy account, set only by the
 * migration or an admin). Each hit is then run back through
 * resolveCallerPlayerId, so "who is this auth uid" has exactly one
 * definition across the functions.
 */
async function hasPlayerJoined(tx, db, liveGameId, playerId) {
  const playerSnap = await tx.get(db.collection('players').doc(playerId));
  const linkedUid = playerSnap.exists ? playerSnap.data().firebaseUid : null;
  const candidates = [...new Set([playerId, linkedUid].filter((c) => typeof c === 'string' && c))];

  const joinsRef = db.collection('liveGames').doc(liveGameId).collection('joins');
  const joinSnaps = await Promise.all(candidates.map((c) => tx.get(joinsRef.doc(c))));
  for (let i = 0; i < candidates.length; i++) {
    if (!joinSnaps[i].exists) continue;
    if ((await resolveCallerPlayerId(tx, db, candidates[i])) === playerId) return true;
  }
  return false;
}

module.exports = { resolveCallerPlayerId, hasPlayerJoined };
