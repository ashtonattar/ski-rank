'use strict';

const { requireAuth, requireNonEmptyString, optionalString, HttpsError } = require('./validate');
const { resolveCallerPlayerId } = require('./identity');

/**
 * Records a logged (non-live) match result as awaiting the opponent's
 * confirmation, in pendingResults/{pendingId} — a Cloud-Function-only
 * collection (firestore.rules), so it is the server-trusted twin of the
 * display-only state/global.pending entry the client keeps writing.
 *
 * Why this exists (rollout step 6a, forgery gate): submitMatchResult and
 * applyStrikePenalty used to authorize against state/global.pending, which
 * any signed-in user can append to. An attacker could append
 * {opponentId: attacker, winnerId: attacker, loserId: victim} and confirm it
 * themselves. Here the reporter is the server-resolved caller and the
 * opponent is derived, never taken from the payload.
 *
 * DECISION (Ashton, 2026-09-24): the reporter must be one of the two players.
 * The client used to allow logging a match between two other riders, where
 * the winner never consented to anything; that is now rejected.
 *
 * pendingId is the client's existing request.id from submitLog(), so the
 * state/global.pending entry and this doc share one key.
 */
async function reportPendingResultHandler(db, request) {
  const uid = requireAuth(request);
  const data = request.data || {};

  const pendingId = requireNonEmptyString(data.pendingId, 'pendingId');
  const winnerId = requireNonEmptyString(data.winnerId, 'winnerId');
  const loserId = requireNonEmptyString(data.loserId, 'loserId');
  if (winnerId === loserId) {
    throw new HttpsError('invalid-argument', 'winnerId and loserId must differ.');
  }
  const tricks = Array.isArray(data.tricks)
    ? data.tricks.filter((t) => typeof t === 'string').map((t) => t.trim()).filter(Boolean)
    : optionalString(data.tricks, '').split(',').map((t) => t.trim()).filter(Boolean);
  const fields = {
    winnerId, loserId, tricks,
    score: optionalString(data.score, ''),
    notes: optionalString(data.notes, ''),
    clipUrl: optionalString(data.clipUrl, ''),
    resort: optionalString(data.resort, '')
  };

  return db.runTransaction(async (tx) => {
    const callerId = await resolveCallerPlayerId(tx, db, uid);
    if (callerId !== winnerId && callerId !== loserId) {
      throw new HttpsError('permission-denied', 'You can only report a match you played in.');
    }
    const opponentId = callerId === winnerId ? loserId : winnerId;

    const pendingRef = db.collection('pendingResults').doc(pendingId);
    const resolutionRef = db.collection('resolutions').doc(`pending_${pendingId}`);
    const [pendingSnap, resolutionSnap] = await Promise.all([tx.get(pendingRef), tx.get(resolutionRef)]);

    if (pendingSnap.exists) {
      const p = pendingSnap.data();
      if (p.reporterId === callerId && p.winnerId === winnerId && p.loserId === loserId) {
        // Benign retry of the same report.
        return { pendingId, reporterId: p.reporterId, opponentId: p.opponentId, duplicate: true };
      }
      throw new HttpsError('already-exists', 'pendingId is already in use.');
    }
    if (resolutionSnap.exists) {
      throw new HttpsError('already-exists', 'This result has already been settled.');
    }

    tx.set(pendingRef, {
      ...fields,
      reporterId: callerId,
      opponentId,
      reporterAuthUid: uid,
      createdAt: Date.now()
    });
    return { pendingId, reporterId: callerId, opponentId, duplicate: false };
  });
}

module.exports = { reportPendingResultHandler };
