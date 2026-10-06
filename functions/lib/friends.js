'use strict';

const { FieldValue } = require('firebase-admin/firestore');
const { requireAuth, requireNonEmptyString, HttpsError } = require('./validate');
const { resolveCallerPlayerId } = require('./identity');

/**
 * Rollout step 8. `friends` lives on both players' docs, and a friendship
 * edits the OTHER player's doc too, which the rules only let that player (or
 * an admin) write. Until step 8 the client wrote both sides into
 * state/global.players instead. These two callables do both sides in one
 * transaction, so a friendship is never one-sided (Ashton, 2026-10-06).
 */

/**
 * The recipient accepts a pending request (acceptFriendRequest() in
 * index.html). Marks friendRequests/{requestId} accepted and adds each player
 * to the other's `friends`. A repeat call on an already-accepted request is a
 * benign retry: it re-applies the arrayUnions (no-ops) and reports duplicate.
 */
async function acceptFriendRequestHandler(db, request) {
  const uid = requireAuth(request);
  const requestId = requireNonEmptyString((request.data || {}).requestId, 'requestId');

  return db.runTransaction(async (tx) => {
    const callerId = await resolveCallerPlayerId(tx, db, uid);
    const reqRef = db.collection('friendRequests').doc(requestId);
    const reqSnap = await tx.get(reqRef);
    if (!reqSnap.exists) {
      throw new HttpsError('not-found', 'Friend request not found.');
    }
    const r = reqSnap.data();
    if (r.toId !== callerId) {
      throw new HttpsError('permission-denied', 'Only the recipient may accept a friend request.');
    }
    if (r.fromId === r.toId) {
      throw new HttpsError('invalid-argument', 'A friend request must be between two players.');
    }
    if (r.status !== 'pending' && r.status !== 'accepted') {
      throw new HttpsError('failed-precondition', 'This friend request is no longer pending.');
    }

    const fromRef = db.collection('players').doc(r.fromId);
    const toRef = db.collection('players').doc(r.toId);
    const [fromSnap, toSnap] = await Promise.all([tx.get(fromRef), tx.get(toRef)]);
    if (!fromSnap.exists || !toSnap.exists) {
      throw new HttpsError('failed-precondition', 'That player no longer exists.');
    }

    const duplicate = r.status === 'accepted';
    if (!duplicate) tx.update(reqRef, { status: 'accepted' });
    tx.update(fromRef, { friends: FieldValue.arrayUnion(r.toId) });
    tx.update(toRef, { friends: FieldValue.arrayUnion(r.fromId) });
    return { requestId, fromId: r.fromId, toId: r.toId, duplicate };
  });
}

/**
 * Either player ends a friendship (unfriend() in index.html). Removes each
 * from the other's `friends` and deletes the settled request(s) between
 * them, as unfriend() always has. A still-pending request is left alone:
 * that's cancel/decline's job. Removing yourself from someone's list needs
 * no proof of an existing friendship, and running it twice is a no-op.
 */
async function removeFriendHandler(db, request) {
  const uid = requireAuth(request);
  const otherId = requireNonEmptyString((request.data || {}).otherId, 'otherId');

  return db.runTransaction(async (tx) => {
    const callerId = await resolveCallerPlayerId(tx, db, uid);
    if (otherId === callerId) {
      throw new HttpsError('invalid-argument', 'Cannot unfriend yourself.');
    }
    const meRef = db.collection('players').doc(callerId);
    const otherRef = db.collection('players').doc(otherId);
    const reqs = db.collection('friendRequests');
    const [meSnap, otherSnap, sent, received] = await Promise.all([
      tx.get(meRef),
      tx.get(otherRef),
      tx.get(reqs.where('fromId', '==', callerId).where('toId', '==', otherId)),
      tx.get(reqs.where('fromId', '==', otherId).where('toId', '==', callerId))
    ]);

    if (meSnap.exists) tx.update(meRef, { friends: FieldValue.arrayRemove(otherId) });
    if (otherSnap.exists) tx.update(otherRef, { friends: FieldValue.arrayRemove(callerId) });
    const settled = [...sent.docs, ...received.docs].filter((d) => d.data().status !== 'pending');
    settled.forEach((d) => tx.delete(d.ref));
    return { otherId, requestsDeleted: settled.length };
  });
}

module.exports = { acceptFriendRequestHandler, removeFriendHandler };
