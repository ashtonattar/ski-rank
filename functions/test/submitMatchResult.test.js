'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { getDb, clearEmulatorData, fakeRequest } = require('./testUtils');
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
    await db.collection('liveGames').doc('lg1').set({ p1: 'w', p2: 'l', judgeId: null });
    await assert.rejects(
      () => submitMatchResultHandler(db, fakeRequest('forger', { gameId: 'g1', winnerId: 'w', loserId: 'l', liveGameId: 'lg1' })),
      (err) => err.code === 'permission-denied'
    );
  });

  await t.test('rejects payload winnerId/loserId that do not match the live game', async () => {
    await db.collection('liveGames').doc('lg1').set({ p1: 'w', p2: 'l', judgeId: null });
    await assert.rejects(
      () => submitMatchResultHandler(db, fakeRequest('w', { gameId: 'g1', winnerId: 'w', loserId: 'someoneElse', liveGameId: 'lg1' })),
      (err) => err.code === 'invalid-argument'
    );
  });

  await t.test('a real participant succeeds and computes ratings matching lib/elo directly', async () => {
    await db.collection('liveGames').doc('lg1').set({ p1: 'w', p2: 'l', judgeId: null });
    const result = await submitMatchResultHandler(db, fakeRequest('w', {
      gameId: 'g1', winnerId: 'w', loserId: 'l', score: '0 — SKI', liveGameId: 'lg1'
    }));

    const expected = calcRatings({ gamesPlayed: 0 }, { gamesPlayed: 0 }, '0 — SKI');
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

    const liveDoc = await db.collection('liveGames').doc('lg1').get();
    assert.strictEqual(liveDoc.data().resultSubmitted, true);
    assert.strictEqual(liveDoc.data().resultGameId, 'g1');
  });

  await t.test('idempotency: retrying the same gameId does not double-apply the rating change', async () => {
    await db.collection('liveGames').doc('lg1').set({ p1: 'w', p2: 'l', judgeId: null });
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
    await db.collection('liveGames').doc('lg1').set({ p1: 'w', p2: 'l', judgeId: null });
    await submitMatchResultHandler(db, fakeRequest('w', { gameId: 'g1', winnerId: 'w', loserId: 'l', liveGameId: 'lg1' }));

    await assert.rejects(
      () => submitMatchResultHandler(db, fakeRequest('w', { gameId: 'g2', winnerId: 'w', loserId: 'l', liveGameId: 'lg1' })),
      (err) => err.code === 'already-exists'
    );
  });

  await t.test('missing player docs do not throw and are created with defaults', async () => {
    await db.collection('liveGames').doc('lg1').set({ p1: 'ghost-w', p2: 'ghost-l', judgeId: null });
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
    await db.collection('liveGames').doc('lg1').set({ p1: 'w', p2: 'l', judgeId: null, strikes: { w: 3 } });

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
    await db.collection('state').doc('global').set({
      pending: [{ id: 'p1', reporterId: 'reporter', opponentId: 'opponent', winnerId: 'reporter', loserId: 'opponent', status: 'pending' }]
    });
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
    await db.collection('liveGames').doc('lg1').set({ p1: 'w', p2: 'l', judgeId: null });
    const result = await submitMatchResultHandler(db, fakeRequest('w', { gameId: 'g1', winnerId: 'w', loserId: 'l', liveGameId: 'lg1' }));
    assert.ok(result.winnerBadgesEarned.includes('first_game'));
    assert.ok(result.winnerBadgesEarned.includes('first_win'));
    assert.ok(result.loserBadgesEarned.includes('first_game'));
    assert.ok(!result.loserBadgesEarned.includes('first_win'));
  });
});
