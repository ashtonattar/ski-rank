'use strict';

const { requireAuth, requireNonEmptyString, HttpsError } = require('./validate');
const { resolveCallerPlayerId } = require('./identity');
const { START_RATING } = require('./elo');

/**
 * DELIBERATE DIVERGENCE from the spec's literal `{ playerId, gameId }` input:
 * this takes `{ pendingId }` alone and resolves the WHOLE dispute atomically
 * (both parties penalized/not in one transaction), rather than being called
 * once per target uid.
 *
 * Why: a single dispute (disputeGame() in index.html:12130) always produces
 * exactly two applyLogStrike() calls — one per party — sharing one cause.
 * A `{playerId, gameId}` signature would need the client to make two
 * separate calls for that one event, each independently "authorized," which
 * either (a) lets a caller trigger just one half of a dispute's consequence
 * (call it for the opponent, silently skip themselves), or (b) requires a
 * second identifier scheme just to prove the two calls belong to the same
 * dispute and neither has already fired — at which point it's simpler and
 * strictly safer to key the whole thing off the one real event: the pending
 * entry being disputed. This is the same reasoning the spec itself uses for
 * the `?? 0` gamesPlayed fix in elo.js — flagging it here so step 6.5 (and
 * whoever wires the client in step 6) doesn't mistake it for a transcription
 * error.
 *
 * Idempotency: resolutions/pending_<pendingId> (a 'cancelled' kind, from
 * cancelPendingResult, is also already-exists here) — the same Cloud-Function-
 * only doc submitMatchResult writes when a pending entry is CONFIRMED. Its
 * existence means this pending entry is settled: kind 'disputed' → a benign
 * retry (return the stored outcome); kind 'confirmed' → already-exists, so
 * one pending entry can never be both confirmed and disputed. (Replaces the
 * original disputeResolutions/{pendingId}, which only guarded against a
 * repeated dispute, not a confirm+dispute of the same entry.)
 *
 * The caller check uses the caller's resolved player id (lib/identity.js),
 * not their auth uid — they differ for legacy accounts.
 *
 * Missing-player handling here intentionally mirrors applyLogStrike()'s own
 * `if (!p) return;` (index.html:12161) — a missing player is skipped
 * entirely, not treated as an implicit START_RATING account the way
 * calcRatings() does. That is the client's existing behavior for this
 * specific function, not the ELO section's convention, and the two should
 * not be unified into one "missing player" rule.
 */
async function applyStrikePenaltyHandler(db, request) {
  const uid = requireAuth(request);
  const data = request.data || {};
  const pendingId = requireNonEmptyString(data.pendingId, 'pendingId');

  return db.runTransaction(async (tx) => {
    const callerId = await resolveCallerPlayerId(tx, db, uid);
    const resolutionRef = db.collection('resolutions').doc(`pending_${pendingId}`);
    const resolutionSnap = await tx.get(resolutionRef);
    if (resolutionSnap.exists) {
      const r = resolutionSnap.data();
      if (r.kind !== 'disputed') {
        throw new HttpsError('already-exists', 'This result has already been settled.');
      }
      return {
        pendingId,
        reporterId: r.reporterId, opponentId: r.opponentId,
        reporterPenalized: r.reporterPenalized, opponentPenalized: r.opponentPenalized,
        duplicate: true
      };
    }

    // Rollout step 6a forgery gate: authorize against the server-owned
    // pendingResults/{id} (written only by reportPendingResult), not
    // state/global.pending, which any signed-in user can append to.
    const pendingSnap = await tx.get(db.collection('pendingResults').doc(pendingId));
    const entry = pendingSnap.exists ? pendingSnap.data() : null;
    if (!entry) {
      throw new HttpsError('permission-denied', 'No matching pending dispute found for this caller.');
    }
    if (callerId !== entry.opponentId) {
      throw new HttpsError('permission-denied', 'Only the opponent may dispute a pending result.');
    }

    const reporterRef = db.collection('players').doc(entry.reporterId);
    const opponentRef = db.collection('players').doc(entry.opponentId);
    const [reporterSnap, opponentSnap] = await Promise.all([tx.get(reporterRef), tx.get(opponentRef)]);

    function applyOneStrike(ref, snap) {
      if (!snap.exists) return { penalized: false, skipped: true };
      const p = snap.data();
      const logStrikes = (p.logStrikes ?? 0) + 1;
      if (logStrikes >= 3) {
        // Unrated (absent/null) counts as START_RATING, matching calcRatings
        // and applyLogStrike() in index.html. `?? 0` used to drop a new
        // player from 4.00 to 0.00 for one strike (found by the step-6.5
        // emulator sim, 2026-10-01).
        const rating = Math.max(0, (p.rating ?? START_RATING) - 1);
        tx.set(ref, { logStrikes: 0, rating }, { merge: true });
        return { penalized: true, skipped: false };
      }
      tx.set(ref, { logStrikes }, { merge: true });
      return { penalized: false, skipped: false };
    }

    const reporterResult = applyOneStrike(reporterRef, reporterSnap);
    const opponentResult = applyOneStrike(opponentRef, opponentSnap);

    tx.set(resolutionRef, {
      kind: 'disputed',
      byPlayerId: callerId,
      pendingId,
      reporterId: entry.reporterId,
      opponentId: entry.opponentId,
      reporterPenalized: reporterResult.penalized,
      opponentPenalized: opponentResult.penalized,
      resolvedAt: Date.now()
    });

    return {
      pendingId,
      reporterId: entry.reporterId, opponentId: entry.opponentId,
      reporterPenalized: reporterResult.penalized, opponentPenalized: opponentResult.penalized,
      duplicate: false
    };
  });
}

module.exports = { applyStrikePenaltyHandler };
