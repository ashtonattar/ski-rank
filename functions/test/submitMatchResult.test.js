'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { getDb, clearEmulatorData, fakeRequest, seedLive, seedPendingResult } = require('./testUtils');
const { submitMatchResultHandler } = require('../lib/submitMatchResult');
const { calcRatings } = require('../lib/elo');

test('submitMatchResult', async (t) => {
  const db = getDb();

  t.beforeEach(async () => {
    await clearEmulatorData();
  });

  await t.test('rejects an unauthenticated caller', async () => {
    await assert.rejects(
      () => submitMatchResultHandler(db, fakeRequest(null, { gameId: 'g1', winnerId: 'w', loserId: 'l', liveGameId: 'lg1' })),
      (err) => err.code === 'unauthenticated'
    );
  });

  await t.test('rejects a signed-in caller who is not a party to the live game', async () => {
    await seedLive(db, 'lg1', { p1: 'w', p2: 'l', judgeId: null });
    await assert.rejects(
      () => submitMatchResultHandler(db, fakeRequest('forger', { gameId: 'g1', winnerId: 'w', loserId: 'l', liveGameId: 'lg1' })),
      (err) => err.code === 'permission-denied'
    );
  });

  await t.test('rejects payload winnerId/loserId that do not match the live game', async () => {
    await seedLive(db, 'lg1', { p1: 'w', p2: 'l', judgeId: null });
    await assert.rejects(
      () => submitMatchResultHandler(db, fakeRequest('w', { gameId: 'g1', winnerId: 'w', loserId: 'someoneElse', liveGameId: 'lg1' })),
      (err) => err.code === 'invalid-argument'
    );
  });

  await t.test('a real participant succeeds and computes ratings matching lib/elo directly', async () => {
    await seedLive(db, 'lg1', { p1: 'w', p2: 'l', judgeId: null });
    // score in the payload is ignored on the live path (step 6a): the server
    // always uses '' there, which is what finishLive() sends anyway.
    const result = await submitMatchResultHandler(db, fakeRequest('w', {
      gameId: 'g1', winnerId: 'w', loserId: 'l', score: '0 — SKI', liveGameId: 'lg1'
    }));

    const expected = calcRatings({ gamesPlayed: 0 }, { gamesPlayed: 0 }, '');
    assert.strictEqual(result.winnerNew, expected.winnerNew);
    assert.strictEqual(result.loserNew, expected.loserNew);
    assert.strictEqual(result.duplicate, false);

    const winnerDoc = await db.collection('players').doc('w').get();
    const loserDoc = await db.collection('players').doc('l').get();
    assert.strictEqual(winnerDoc.data().rating, expected.winnerNew);
    assert.strictEqual(winnerDoc.data().wins, 1);
    assert.strictEqual(winnerDoc.data().gamesPlayed, 1);
    assert.strictEqual(loserDoc.data().rating, expected.loserNew);
    assert.strictEqual(loserDoc.data().losses, 1);

    const gameDoc = await db.collection('games').doc('g1').get();
    assert.strictEqual(gameDoc.exists, true);
    assert.strictEqual(gameDoc.data().winnerId, 'w');

    const resolution = await db.collection('resolutions').doc('live_lg1').get();
    assert.strictEqual(resolution.data().kind, 'live');
    assert.strictEqual(resolution.data().gameId, 'g1');
  });

  await t.test('idempotency: retrying the same gameId does not double-apply the rating change', async () => {
    await seedLive(db, 'lg1', { p1: 'w', p2: 'l', judgeId: null });
    const call = () => submitMatchResultHandler(db, fakeRequest('w', {
      gameId: 'g1', winnerId: 'w', loserId: 'l', score: '0 — SKI', liveGameId: 'lg1'
    }));

    const first = await call();
    const second = await call();

    assert.strictEqual(first.duplicate, false);
    assert.strictEqual(second.duplicate, true);
    assert.deepStrictEqual(
      { winnerNew: second.winnerNew, loserNew: second.loserNew },
      { winnerNew: first.winnerNew, loserNew: first.loserNew }
    );

    const winnerDoc = await db.collection('players').doc('w').get();
    assert.strictEqual(winnerDoc.data().wins, 1); // not 2 — the retry must not have re-applied
    assert.strictEqual(winnerDoc.data().gamesPlayed, 1);
  });

  await t.test('a different gameId against an already-submitted live game is rejected, not silently reapplied', async () => {
    await seedLive(db, 'lg1', { p1: 'w', p2: 'l', judgeId: null });
    await submitMatchResultHandler(db, fakeRequest('w', { gameId: 'g1', winnerId: 'w', loserId: 'l', liveGameId: 'lg1' }));

    await assert.rejects(
      () => submitMatchResultHandler(db, fakeRequest('w', { gameId: 'g2', winnerId: 'w', loserId: 'l', liveGameId: 'lg1' })),
      (err) => err.code === 'already-exists'
    );
  });

  await t.test('missing player docs do not throw and are created with defaults', async () => {
    await seedLive(db, 'lg1', { p1: 'ghost-w', p2: 'ghost-l', judgeId: null });
    const result = await submitMatchResultHandler(db, fakeRequest('ghost-w', {
      gameId: 'g1', winnerId: 'ghost-w', loserId: 'ghost-l', liveGameId: 'lg1'
    }));
    assert.strictEqual(result.duplicate, false);
    const winnerDoc = await db.collection('players').doc('ghost-w').get();
    assert.strictEqual(winnerDoc.exists, true);
    assert.strictEqual(winnerDoc.data().gamesPlayed, 1);
  });

  await t.test('strike ordering: a 3-strike penalty is applied before calcRatings runs', async () => {
    await db.collection('players').doc('w').set({ rating: 500, gamesPlayed: 10 });
    await db.collection('players').doc('l').set({ rating: 500, gamesPlayed: 10 });
    await seedLive(db, 'lg1', { p1: 'w', p2: 'l', judgeId: null, strikes: { w: 3 } });

    const result = await submitMatchResultHandler(db, fakeRequest('w', {
      gameId: 'g1', winnerId: 'w', loserId: 'l', liveGameId: 'lg1'
    }));

    // Winner's rating is penalized to 499 BEFORE calcRatings runs, so the
    // ELO math (and thus the delta) starts from 499, not 500.
    const expected = calcRatings({ rating: 499, gamesPlayed: 10 }, { rating: 500, gamesPlayed: 10 }, '');
    assert.strictEqual(result.winnerNew, expected.winnerNew);
    assert.strictEqual(result.loserNew, expected.loserNew);
  });

  await t.test('logged-game path: only the pending entry\'s opponent may confirm', async () => {
    await seedPendingResult(db, 'p1', { reporterId: 'reporter', opponentId: 'opponent', winnerId: 'reporter', loserId: 'opponent', status: 'pending' });
    await assert.rejects(
      () => submitMatchResultHandler(db, fakeRequest('reporter', { gameId: 'g1', winnerId: 'reporter', loserId: 'opponent', pendingId: 'p1' })),
      (err) => err.code === 'permission-denied'
    );

    const result = await submitMatchResultHandler(db, fakeRequest('opponent', {
      gameId: 'g1', winnerId: 'reporter', loserId: 'opponent', pendingId: 'p1'
    }));
    assert.strictEqual(result.duplicate, false);
  });

  await t.test('badges: first_game and first_win are awarded on a player\'s first win', async () => {
    await seedLive(db, 'lg1', { p1: 'w', p2: 'l', judgeId: null });
    const result = await submitMatchResultHandler(db, fakeRequest('w', { gameId: 'g1', winnerId: 'w', loserId: 'l', liveGameId: 'lg1' }));
    assert.ok(result.winnerBadgesEarned.includes('first_game'));
    assert.ok(result.winnerBadgesEarned.includes('first_win'));
    assert.ok(result.loserBadgesEarned.includes('first_game'));
    assert.ok(!result.loserBadgesEarned.includes('first_win'));
  });

  // ── Step 5 review fixes (2026-09-24) ──────────────────────────────────

  await t.test('legacy account: caller whose player id != auth uid is resolved via firebaseUid (live path)', async () => {
    await db.collection('players').doc('legacyW').set({ rating: 500, gamesPlayed: 10, firebaseUid: 'authW' });
    await db.collection('players').doc('l').set({ rating: 500, gamesPlayed: 10 });
    await seedLive(db, 'lg1', { p1: 'legacyW', p2: 'l', judgeId: null }, ['authW', 'l']);
    const result = await submitMatchResultHandler(db, fakeRequest('authW', {
      gameId: 'g1', winnerId: 'legacyW', loserId: 'l', liveGameId: 'lg1'
    }));
    assert.strictEqual(result.duplicate, false);
    assert.strictEqual((await db.collection('players').doc('legacyW').get()).data().wins, 1);
  });

  await t.test('legacy account: resolved via firebaseUid on the pending path', async () => {
    await db.collection('players').doc('legacyO').set({ rating: 500, gamesPlayed: 10, firebaseUid: 'authO' });
    await seedPendingResult(db, 'p1', { reporterId: 'reporter', opponentId: 'legacyO', winnerId: 'reporter', loserId: 'legacyO', status: 'pending' });
    const result = await submitMatchResultHandler(db, fakeRequest('authO', {
      gameId: 'g1', winnerId: 'reporter', loserId: 'legacyO', pendingId: 'p1'
    }));
    assert.strictEqual(result.duplicate, false);
  });

  await t.test('an auth uid linked to nothing cannot act as a legacy player', async () => {
    await db.collection('players').doc('legacyW').set({ rating: 500, firebaseUid: 'authW' });
    await seedLive(db, 'lg1', { p1: 'legacyW', p2: 'l', judgeId: null });
    await assert.rejects(
      () => submitMatchResultHandler(db, fakeRequest('someoneElse', { gameId: 'g1', winnerId: 'legacyW', loserId: 'l', liveGameId: 'lg1' })),
      (err) => err.code === 'permission-denied'
    );
  });

  await t.test('two players linked to the same auth uid is refused, not guessed', async () => {
    await db.collection('players').doc('a').set({ firebaseUid: 'dup' });
    await db.collection('players').doc('b').set({ firebaseUid: 'dup' });
    await seedLive(db, 'lg1', { p1: 'a', p2: 'l', judgeId: null });
    await assert.rejects(
      () => submitMatchResultHandler(db, fakeRequest('dup', { gameId: 'g1', winnerId: 'a', loserId: 'l', liveGameId: 'lg1' })),
      (err) => err.code === 'failed-precondition'
    );
  });

  await t.test('same pendingId confirmed twice with DIFFERENT gameIds applies ratings exactly once', async () => {
    await seedPendingResult(db, 'p1', { reporterId: 'reporter', opponentId: 'opponent', winnerId: 'reporter', loserId: 'opponent', status: 'pending' });
    await submitMatchResultHandler(db, fakeRequest('opponent', { gameId: 'g1', winnerId: 'reporter', loserId: 'opponent', pendingId: 'p1' }));
    await assert.rejects(
      () => submitMatchResultHandler(db, fakeRequest('opponent', { gameId: 'g2', winnerId: 'reporter', loserId: 'opponent', pendingId: 'p1' })),
      (err) => err.code === 'already-exists'
    );
    assert.strictEqual((await db.collection('players').doc('reporter').get()).data().wins, 1);
    assert.strictEqual((await db.collection('games').doc('g2').get()).exists, false);
  });

  await t.test('live game: resetting resultSubmitted on the client-writable liveGames doc does not allow a second result', async () => {
    await seedLive(db, 'lg1', { p1: 'w', p2: 'l', judgeId: null });
    await submitMatchResultHandler(db, fakeRequest('w', { gameId: 'g1', winnerId: 'w', loserId: 'l', liveGameId: 'lg1' }));
    await db.collection('liveGames').doc('lg1').set({ resultSubmitted: false, resultGameId: null }, { merge: true });
    await assert.rejects(
      () => submitMatchResultHandler(db, fakeRequest('w', { gameId: 'g2', winnerId: 'w', loserId: 'l', liveGameId: 'lg1' })),
      (err) => err.code === 'already-exists'
    );
    assert.strictEqual((await db.collection('players').doc('w').get()).data().wins, 1);
  });

  await t.test('a gameId that already belongs to another game is rejected', async () => {
    await db.collection('games').doc('g1').set({ winnerId: 'x', loserId: 'y' });
    await seedLive(db, 'lg1', { p1: 'w', p2: 'l', judgeId: null });
    await assert.rejects(
      () => submitMatchResultHandler(db, fakeRequest('w', { gameId: 'g1', winnerId: 'w', loserId: 'l', liveGameId: 'lg1' })),
      (err) => err.code === 'already-exists'
    );
  });

  await t.test('deliberate divergence #2: unrated player with 3 strikes starts ELO from 399, not the client\'s 0', async () => {
    await db.collection('players').doc('l').set({ rating: 500, gamesPlayed: 10 });
    await seedLive(db, 'lg1', { p1: 'w', p2: 'l', judgeId: null, strikes: { w: 3 } });
    const result = await submitMatchResultHandler(db, fakeRequest('w', { gameId: 'g1', winnerId: 'w', loserId: 'l', liveGameId: 'lg1' }));
    const expected = calcRatings({ rating: 399, gamesPlayed: 0 }, { rating: 500, gamesPlayed: 10 }, '');
    assert.strictEqual(result.winnerNew, expected.winnerNew);
    const clientBehaviour = calcRatings({ rating: 0, gamesPlayed: 0 }, { rating: 500, gamesPlayed: 10 }, '');
    assert.notStrictEqual(result.winnerNew, clientBehaviour.winnerNew);
  });
});
