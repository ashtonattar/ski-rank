'use strict';

const { requireAuth, requireNonEmptyString, HttpsError } = require('./validate');
const { resolveCallerPlayerId } = require('./identity');

/**
 * The reporter withdraws a logged result before the opponent acts on it
 * (cancelPending() in index.html). Settles the entry by writing
 * resolutions/pending_<pendingId> with kind 'cancelled', so neither
 * submitMatchResult (expects 'confirmed') nor applyStrikePenalty (expects
 * 'disputed') will accept it afterwards; both treat any other kind as
 * already-exists.
 */
async function cancelPendingResultHandler(db, request) {
  const uid = requireAuth(request);
  const pendingId = requireNonEmptyString((request.data || {}).pendingId, 'pendingId');

  return db.runTransaction(async (tx) => {
    const callerId = await resolveCallerPlayerId(tx, db, uid);
    const pendingRef = db.collection('pendingResults').doc(pendingId);
    const resolutionRef = db.collection('resolutions').doc(`pending_${pendingId}`);
    const [pendingSnap, resolutionSnap] = await Promise.all([tx.get(pendingRef), tx.get(resolutionRef)]);

    if (!pendingSnap.exists) {
      throw new HttpsError('permission-denied', 'No matching pending result found for this caller.');
    }
    if (callerId !== pendingSnap.data().reporterId) {
      throw new HttpsError('permission-denied', 'Only the reporter may cancel a pending result.');
    }
    if (resolutionSnap.exists) {
      if (resolutionSnap.data().kind === 'cancelled') return { pendingId, duplicate: true };
      throw new HttpsError('already-exists', 'This result has already been settled.');
    }

    tx.set(resolutionRef, { kind: 'cancelled', byPlayerId: callerId, pendingId, resolvedAt: Date.now() });
    return { pendingId, duplicate: false };
  });
}

module.exports = { cancelPendingResultHandler };
