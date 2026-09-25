'use strict';

const { requireAuth, requireNonEmptyString, optionalString, optionalArray, HttpsError } = require('./validate');
const { calcRatings, START_RATING } = require('./elo');
const { checkBadgesServer } = require('./badges');
const { resolveCallerPlayerId } = require('./identity');

/**
 * Reads this player's games (both as winner and as loser) from the `games`
 * collection, for streak calc. Two equality-only queries (no orderBy in
 * Firestore, sorted in JS) so no composite index is required.
 */
async function readPriorGames(tx, db, playerId) {
  const winsQ = db.collection('games').where('winnerId', '==', playerId);
  const lossesQ = db.collection('games').where('loserId', '==', playerId);
  const [winsSnap, lossesSnap] = await Promise.all([tx.get(winsQ), tx.get(lossesQ)]);
  const games = [];
  winsSnap.forEach((d) => games.push(d.data()));
  lossesSnap.forEach((d) => games.push(d.data()));
  return games;
}

/**
 * Authorization for the two supported call sites. Exactly one of
 * liveGameId / pendingId must be given — see the module doc comment in
 * index.js for why these two fields exist even though the original spec's
 * input list didn't name them: without an id pointing at the specific
 * liveGames/{id} or pending entry, there is nothing server-side to check
 * the caller against, and "is signed in" alone is not authorization.
 *
 * callerId is the caller's resolved PLAYER id (lib/identity.js), not their
 * auth uid — the two differ for legacy accounts.
 *
 * Returns { resolutionKey, resolutionKind, strikeUids } — resolutionKey
 * names the resolutions/{key} doc that records this live game / pending
 * entry as settled (see submitMatchResultHandler), and strikeUids are the
 * players the server itself determined hit 3 live-dispute strikes and must
 * lose 1 rating point before ELO runs. Never trusts a client-supplied
 * strikePenalties field for this.
 */
async function authorizeAndGetStrikes(tx, db, callerId, { liveGameId, pendingId, winnerId, loserId }) {
  if (liveGameId && pendingId) {
    throw new HttpsError('invalid-argument', 'Provide only one of liveGameId or pendingId, not both.');
  }

  if (liveGameId) {
    const liveSnap = await tx.get(db.collection('liveGames').doc(liveGameId));
    if (!liveSnap.exists) {
      throw new HttpsError('permission-denied', 'No matching live game found for this caller.');
    }
    const live = liveSnap.data();
    const isParty = callerId === live.p1 || callerId === live.p2 || callerId === live.judgeId;
    if (!isParty) {
      throw new HttpsError('permission-denied', 'Caller is not a participant in this live game.');
    }
    const players = new Set([live.p1, live.p2]);
    if (!players.has(winnerId) || !players.has(loserId) || winnerId === loserId) {
      throw new HttpsError('invalid-argument', 'winnerId/loserId do not match this live game.');
    }
    const strikes = live.strikes || {};
    const strikeUids = new Set();
    for (const pid of [live.p1, live.p2]) {
      if ((strikes[pid] || 0) >= 3) strikeUids.add(pid);
    }
    return { resolutionKey: `live_${liveGameId}`, resolutionKind: 'live', strikeUids };
  }

  if (pendingId) {
    const globalSnap = await tx.get(db.collection('state').doc('global'));
    const pending = (globalSnap.exists && Array.isArray(globalSnap.data().pending)) ? globalSnap.data().pending : [];
    const entry = pending.find((r) => r.id === pendingId);
    if (!entry || entry.status !== 'pending') {
      throw new HttpsError('permission-denied', 'No matching pending result found for this caller.');
    }
    if (callerId !== entry.opponentId) {
      throw new HttpsError('permission-denied', 'Only the opponent may confirm a pending result.');
    }
    if (entry.winnerId !== winnerId || entry.loserId !== loserId) {
      throw new HttpsError('invalid-argument', 'winnerId/loserId do not match the pending entry being confirmed.');
    }
    return { resolutionKey: `pending_${pendingId}`, resolutionKind: 'confirmed', strikeUids: new Set() };
  }

  throw new HttpsError('invalid-argument', 'Must provide liveGameId or pendingId to authorize this call.');
}

async function submitMatchResultHandler(db, request) {
  const uid = requireAuth(request);
  const data = request.data || {};

  const gameId = requireNonEmptyString(data.gameId, 'gameId');
  const winnerId = requireNonEmptyString(data.winnerId, 'winnerId');
  const loserId = requireNonEmptyString(data.loserId, 'loserId');
  if (winnerId === loserId) {
    throw new HttpsError('invalid-argument', 'winnerId and loserId must differ.');
  }
  const tricksStr = optionalString(data.tricks, '');
  const notes = optionalString(data.notes, '');
  const liveLog = optionalArray(data.liveLog, []);
  const score = optionalString(data.score, '');
  const clipUrl = optionalString(data.clipUrl, '');
  const resort = optionalString(data.resort, '');
  const handicap = data.handicap ?? null;
  const liveGameId = typeof data.liveGameId === 'string' && data.liveGameId ? data.liveGameId : null;
  const pendingId = typeof data.pendingId === 'string' && data.pendingId ? data.pendingId : null;

  return db.runTransaction(async (tx) => {
    const callerId = await resolveCallerPlayerId(tx, db, uid);
    const { resolutionKey, resolutionKind, strikeUids } = await authorizeAndGetStrikes(tx, db, callerId, {
      liveGameId, pendingId, winnerId, loserId
    });

    // Idempotency is keyed on the EVENT (this live game / pending entry), not
    // just the client-generated gameId. A gameId-only check let the same
    // pending entry be applied N times with fresh gameIds (the server can't
    // consume the entry — it lives on state/global, which this function must
    // never write), and let a pending entry be both confirmed and disputed.
    // The live game's own resultSubmitted flag can't serve either: liveGames
    // is participant-writable, so it can be reset. resolutions/{key} is
    // Cloud-Function-only (firestore.rules), shared with applyStrikePenalty.
    const resolutionRef = db.collection('resolutions').doc(resolutionKey);
    const gameRef = db.collection('games').doc(gameId);
    const [resolutionSnap, gameSnap] = await Promise.all([tx.get(resolutionRef), tx.get(gameRef)]);

    if (resolutionSnap.exists) {
      const r = resolutionSnap.data();
      if (r.kind !== resolutionKind || r.gameId !== gameId || !gameSnap.exists) {
        throw new HttpsError('already-exists', 'This result has already been settled.');
      }
      // Benign retry of the exact same submission: return success-shaped
      // output from what's already stored, write nothing.
      const g = gameSnap.data();
      return {
        gameId, winnerId: g.winnerId, loserId: g.loserId,
        winnerNew: g.player1EndRating, loserNew: g.player2EndRating,
        winnerDelta: g.winnerDelta, loserDelta: g.loserDelta,
        duplicate: true
      };
    }
    if (gameSnap.exists) {
      // gameId already belongs to some other game (e.g. a migrated one).
      throw new HttpsError('already-exists', 'gameId is already in use.');
    }

    const winnerRef = db.collection('players').doc(winnerId);
    const loserRef = db.collection('players').doc(loserId);
    const [winnerSnap, loserSnap] = await Promise.all([tx.get(winnerRef), tx.get(loserRef)]);
    const winnerBefore = winnerSnap.exists ? winnerSnap.data() : {};
    const loserBefore = loserSnap.exists ? loserSnap.data() : {};

    const [winnerPriorGames, loserPriorGames] = await Promise.all([
      readPriorGames(tx, db, winnerId),
      readPriorGames(tx, db, loserId)
    ]);

    // Strike penalty applied BEFORE calcRatings, matching finishLive()
    // (index.html:8507-8521): the ELO math starts from the post-penalty
    // rating, not the pre-penalty one.
    //
    // SECOND DELIBERATE DIVERGENCE (step 5 review, 2026-09-24): the client
    // computes `Math.max(0, (p.rating || 0) - 1)`, so an UNRATED player who
    // hits 3 strikes starts the ELO math from 0 (clamped to 100 afterwards),
    // a ~300-point loss for a new player. That's a client bug; here an
    // unrated player is START_RATING like everywhere else, so the math starts
    // from 399. Step 6.5's diff will show a mismatch ONLY for an unrated
    // player finishing a live game with 3 strikes, and that one is expected.
    const winnerRatingForElo = strikeUids.has(winnerId)
      ? Math.max(0, (winnerBefore.rating ?? START_RATING) - 1)
      : (winnerBefore.rating ?? START_RATING);
    const loserRatingForElo = strikeUids.has(loserId)
      ? Math.max(0, (loserBefore.rating ?? START_RATING) - 1)
      : (loserBefore.rating ?? START_RATING);

    const ratings = calcRatings(
      { rating: winnerRatingForElo, gamesPlayed: winnerBefore.gamesPlayed },
      { rating: loserRatingForElo, gamesPlayed: loserBefore.gamesPlayed },
      score,
      handicap
    );

    const game = {
      id: gameId,
      winnerId, loserId,
      player1Id: winnerId, player2Id: loserId,
      player1StartRating: ratings.winnerStartRating, player2StartRating: ratings.loserStartRating,
      player1EndRating: ratings.winnerNew, player2EndRating: ratings.loserNew,
      winnerDelta: ratings.winnerDelta, loserDelta: ratings.loserDelta,
      handicap: handicap || null,
      tricks: tricksStr.split(',').map((t) => t.trim()).filter(Boolean),
      liveLog, notes, score, clipUrl, resort,
      date: Date.now()
    };

    const winnerAfter = {
      rating: ratings.winnerNew,
      wins: (winnerBefore.wins ?? 0) + 1,
      losses: winnerBefore.losses ?? 0,
      gamesPlayed: (winnerBefore.gamesPlayed ?? 0) + 1,
      peakRating: Math.max(winnerBefore.peakRating ?? 0, ratings.winnerNew)
    };
    const loserAfter = {
      rating: ratings.loserNew,
      wins: loserBefore.wins ?? 0,
      losses: (loserBefore.losses ?? 0) + 1,
      gamesPlayed: (loserBefore.gamesPlayed ?? 0) + 1,
      peakRating: Math.max(loserBefore.peakRating ?? 0, ratings.loserNew)
    };

    const winnerBadges = checkBadgesServer(winnerId, winnerAfter, game, winnerPriorGames, winnerBefore.badges);
    const loserBadges = checkBadgesServer(loserId, loserAfter, game, loserPriorGames, loserBefore.badges);

    tx.set(winnerRef, { ...winnerAfter, badges: winnerBadges.badges }, { merge: true });
    tx.set(loserRef, { ...loserAfter, badges: loserBadges.badges }, { merge: true });
    tx.set(gameRef, game);
    tx.set(resolutionRef, { kind: resolutionKind, gameId, byPlayerId: callerId, resolvedAt: Date.now() });

    return {
      gameId, winnerId, loserId,
      winnerNew: ratings.winnerNew, loserNew: ratings.loserNew,
      winnerDelta: ratings.winnerDelta, loserDelta: ratings.loserDelta,
      winnerBadgesEarned: winnerBadges.earned,
      loserBadgesEarned: loserBadges.earned,
      duplicate: false
    };
  });
}

module.exports = { submitMatchResultHandler };
