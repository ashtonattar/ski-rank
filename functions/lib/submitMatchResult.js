'use strict';

const { requireAuth, requireNonEmptyString, optionalString, optionalArray, HttpsError } = require('./validate');
const { calcRatings, START_RATING } = require('./elo');
const { checkBadgesServer } = require('./badges');
const { resolveCallerPlayerId, hasPlayerJoined } = require('./identity');

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
 * liveGameId / pendingId must be given: without an id pointing at a specific
 * live game or pending result, there is nothing server-side to check the
 * caller against, and "is signed in" alone is not authorization.
 *
 * callerId is the caller's resolved PLAYER id (lib/identity.js), not their
 * auth uid; the two differ for legacy accounts.
 *
 * FORGERY GATE (rollout step 6a, 2026-09-24): both evidence documents used
 * to be forgeable by any signed-in user (liveGames create is open to anyone;
 * state/global.pending is appendable by anyone), so an attacker could name a
 * victim and apply a loss to them. Now:
 *   - live path: BOTH players must have a liveGames/{id}/joins/{authUid} doc
 *     (only creatable by that account itself, per firestore.rules).
 *   - pending path: authorizes against pendingResults/{id}, which only
 *     reportPendingResult writes, with a server-resolved reporter who must be
 *     one of the two players. state/global.pending is no longer trusted.
 *
 * Returns the match inputs from those trusted docs, not the payload.
 * `score` feeds calcRatings (scoreMultiplier), so taking it from the payload
 * let the caller pick their own rating swing. Live path: score is always ''
 * (finishLive() in index.html always passes '') and the stored handicap
 * comes from the liveGames doc. (calcRatings accepts a handicap argument but
 * never reads it, here or in the client, so handicap is display-only.)
 * Pending path: everything comes from the stored report. Only cosmetic
 * fields (liveLog, resort) still come from the payload on the live path.
 */
async function authorizeAndGetMatch(tx, db, callerId, { liveGameId, pendingId, winnerId, loserId, payloadScore }) {
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
    const [p1Joined, p2Joined] = await Promise.all([
      hasPlayerJoined(tx, db, liveGameId, live.p1),
      hasPlayerJoined(tx, db, liveGameId, live.p2)
    ]);
    if (!p1Joined || !p2Joined) {
      throw new HttpsError('failed-precondition', 'Both players must have joined this live game before a result can be recorded.');
    }
    // The game must actually be over for the named loser. Every client
    // end-of-game path sets the loser's letters to 3 before finishLive():
    // the letter paths (index.html:8292/8307/8468/8474) and the forfeit
    // paths (:4605, :6765, :8781). This doesn't stop a participant editing
    // the live doc (out of scope), but it does stop a one-call "I won"
    // mid-game, and forces any cheating into the doc the opponent is
    // watching.
    // 6b ORDERING REQUIREMENT: the client must persist the live doc with the
    // final letters (saveLiveGame) BEFORE calling this function. Today
    // finishLive() calls commitGame() before saveLiveGame().
    const letters = live.letters || {};
    if ((letters[loserId] || 0) < 3 || (letters[winnerId] || 0) >= 3) {
      throw new HttpsError('failed-precondition', 'This live game is not finished for the named loser.');
    }
    const strikes = live.strikes || {};
    const strikeUids = new Set();
    for (const pid of [live.p1, live.p2]) {
      if ((strikes[pid] || 0) >= 3) strikeUids.add(pid);
    }
    return {
      resolutionKey: `live_${liveGameId}`, resolutionKind: 'live', strikeUids,
      match: { score: '', handicap: live.handicap || null, tricks: [], notes: '', clipUrl: '', fromPayload: ['liveLog', 'resort'] }
    };
  }

  if (pendingId) {
    const pendingSnap = await tx.get(db.collection('pendingResults').doc(pendingId));
    if (!pendingSnap.exists) {
      throw new HttpsError('permission-denied', 'No matching pending result found for this caller.');
    }
    const entry = pendingSnap.data();
    if (callerId !== entry.opponentId) {
      throw new HttpsError('permission-denied', 'Only the opponent may confirm a pending result.');
    }
    if (entry.winnerId !== winnerId || entry.loserId !== loserId) {
      throw new HttpsError('invalid-argument', 'winnerId/loserId do not match the pending result being confirmed.');
    }
    // state/global.pending (what the opponent's UI shows) is display-only
    // and reporter-written, so nothing ties it to this stored copy. Without
    // this check the opponent could confirm "S — SKI" while the server
    // applies "0 — SKI" (1.25x vs 1.5x scoreMultiplier). The math still
    // uses the STORED score; this only proves the confirmer agreed to it.
    // 6b: the confirm call must send the score exactly as the opponent saw it.
    if (payloadScore !== (entry.score || '')) {
      throw new HttpsError('invalid-argument', 'score does not match the pending result being confirmed.');
    }
    return {
      resolutionKey: `pending_${pendingId}`, resolutionKind: 'confirmed', strikeUids: new Set(),
      match: {
        score: entry.score || '', handicap: null, tricks: entry.tricks || [], notes: entry.notes || '',
        clipUrl: entry.clipUrl || '', resort: entry.resort || '', liveLog: [], fromPayload: []
      }
    };
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
  const payloadLiveLog = optionalArray(data.liveLog, []);
  const payloadResort = optionalString(data.resort, '');
  const payloadScore = optionalString(data.score, '');
  const liveGameId = typeof data.liveGameId === 'string' && data.liveGameId ? data.liveGameId : null;
  const pendingId = typeof data.pendingId === 'string' && data.pendingId ? data.pendingId : null;

  return db.runTransaction(async (tx) => {
    const callerId = await resolveCallerPlayerId(tx, db, uid);
    const { resolutionKey, resolutionKind, strikeUids, match } = await authorizeAndGetMatch(tx, db, callerId, {
      liveGameId, pendingId, winnerId, loserId, payloadScore
    });
    const { score, handicap, tricks, notes, clipUrl } = match;
    const liveLog = match.fromPayload.includes('liveLog') ? payloadLiveLog : match.liveLog;
    const resort = match.fromPayload.includes('resort') ? payloadResort : match.resort;

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
    // An UNRATED player who hits 3 strikes is START_RATING like everywhere
    // else, so the math starts from 399. (This was a deliberate divergence
    // until 2026-10-01: the client used `(p.rating || 0) - 1` and started
    // from 0. finishLive() now uses `?? START_RATING` too.)
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
      tricks,
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
