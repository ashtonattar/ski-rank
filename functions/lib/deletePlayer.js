'use strict';

const { FieldValue } = require('firebase-admin/firestore');
const { requireAuth, HttpsError } = require('./validate');
const { resolveCallerPlayerId } = require('./identity');

// Keep in sync with isAdmin() in firestore.rules and ADMIN_EMAILS in index.html.
const ADMIN_EMAIL = 'ashtonattar@gmail.com';

function isAdminRequest(request) {
  return !!request.auth && !!request.auth.token && request.auth.token.email === ADMIN_EMAIL;
}

/**
 * Rollout step 8. Removes a player from the new collections:
 * players/{id}, the id in every other player's `friends`, and every
 * friendRequests doc to or from them. Games stay (they're both players'
 * history), and so do messages, as they did before.
 *
 * Without `playerId` (or with the caller's own), it deletes the caller
 * (deleteAccount() in index.html). With another player's id it needs the
 * admin account (adminDeleteUser()).
 *
 * Why a callable: the rules only let an admin delete a players/ doc. An
 * owner delete would let a player delete and re-create their doc to reset
 * a low rating. For the same reason, a self-delete also deletes the
 * caller's Firebase Auth user here, after the transaction commits, through
 * `deleteAuthUser`. The client's own currentUser.delete() fails with
 * requires-recent-login on an older session, and then the same login could
 * self-heal a fresh players doc at the default rating. The admin path
 * leaves the target's Auth user alone, same as adminDeleteUser() always has.
 *
 * `deleteAuthUser(uid)` is injected so the emulator tests don't need the
 * Auth emulator. A failure there is reported, not thrown: the player data
 * is already gone by then.
 */
async function deletePlayerHandler(db, request, { deleteAuthUser } = {}) {
  const uid = requireAuth(request);
  const data = request.data || {};
  if (data.playerId !== undefined && (typeof data.playerId !== 'string' || data.playerId.trim() === '')) {
    throw new HttpsError('invalid-argument', 'playerId must be a non-empty string.');
  }

  const result = await db.runTransaction(async (tx) => {
    const callerId = await resolveCallerPlayerId(tx, db, uid);
    const targetId = data.playerId || callerId;
    const self = targetId === callerId;
    if (!self && !isAdminRequest(request)) {
      throw new HttpsError('permission-denied', 'Only an admin may delete another player.');
    }

    const playerRef = db.collection('players').doc(targetId);
    const reqs = db.collection('friendRequests');
    const [playerSnap, friendOf, sent, received] = await Promise.all([
      tx.get(playerRef),
      tx.get(db.collection('players').where('friends', 'array-contains', targetId)),
      tx.get(reqs.where('fromId', '==', targetId)),
      tx.get(reqs.where('toId', '==', targetId))
    ]);

    friendOf.docs
      .filter((d) => d.id !== targetId)
      .forEach((d) => tx.update(d.ref, { friends: FieldValue.arrayRemove(targetId) }));
    const reqDocs = new Map([...sent.docs, ...received.docs].map((d) => [d.id, d.ref]));
    reqDocs.forEach((ref) => tx.delete(ref));
    if (playerSnap.exists) tx.delete(playerRef);

    return {
      playerId: targetId,
      self,
      existed: playerSnap.exists,
      friendsUpdated: friendOf.docs.filter((d) => d.id !== targetId).length,
      requestsDeleted: reqDocs.size
    };
  });

  result.authDeleted = false;
  if (result.self && deleteAuthUser) {
    try {
      await deleteAuthUser(uid);
      result.authDeleted = true;
    } catch (e) {
      console.warn(`deletePlayer: auth user delete failed for ${result.playerId}:`, e.code || e.message);
    }
  }
  return result;
}

module.exports = { deletePlayerHandler, isAdminRequest, ADMIN_EMAIL };
