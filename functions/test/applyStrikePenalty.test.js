'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { getDb, clearEmulatorData, fakeRequest } = require('./testUtils');
const { applyStrikePenaltyHandler } = require('../lib/applyStrikePenalty');

test('applyStrikePenalty', async (t) => {
  const db = getDb();

  t.beforeEach(async () => {
    await clearEmulatorData();
  });

  await t.test('rejects an unauthenticated caller', async () => {
    await assert.rejects(
      () => applyStrikePenaltyHandler(db, fakeRequest(null, { pendingId: 'p1' })),
      (err) => err.code === 'unauthenticated'
    );
  });

  await t.test('rejects a caller who is not the pending entry\'s opponent', async () => {
    await db.collection('state').doc('global').set({
      pending: [{ id: 'p1', reporterId: 'reporter', opponentId: 'opponent', status: 'pending' }]
    });
    await assert.rejects(
      () => applyStrikePenaltyHandler(db, fakeRequest('forger', { pendingId: 'p1' })),
      (err) => err.code === 'permission-denied'
    );
  });

  await t.test('increments logStrikes on both parties without penalizing below 3', async () => {
    await db.collection('state').doc('global').set({
      pending: [{ id: 'p1', reporterId: 'reporter', opponentId: 'opponent', status: 'pending' }]
    });
    await db.collection('players').doc('reporter').set({ rating: 500, logStrikes: 0 });
    await db.collection('players').doc('opponent').set({ rating: 500, logStrikes: 0 });

    const result = await applyStrikePenaltyHandler(db, fakeRequest('opponent', { pendingId: 'p1' }));
    assert.strictEqual(result.reporterPenalized, false);
    assert.strictEqual(result.opponentPenalized, false);

    const reporter = (await db.collection('players').doc('reporter').get()).data();
    const opponent = (await db.collection('players').doc('opponent').get()).data();
    assert.strictEqual(reporter.logStrikes, 1);
    assert.strictEqual(reporter.rating, 500);
    assert.strictEqual(opponent.logStrikes, 1);
    assert.strictEqual(opponent.rating, 500);
  });

  await t.test('the 3rd strike costs 1 rating point and resets logStrikes to 0', async () => {
    await db.collection('state').doc('global').set({
      pending: [{ id: 'p1', reporterId: 'reporter', opponentId: 'opponent', status: 'pending' }]
    });
    await db.collection('players').doc('reporter').set({ rating: 500, logStrikes: 2 });
    await db.collection('players').doc('opponent').set({ rating: 500, logStrikes: 2 });

    const result = await applyStrikePenaltyHandler(db, fakeRequest('opponent', { pendingId: 'p1' }));
    assert.strictEqual(result.reporterPenalized, true);
    assert.strictEqual(result.opponentPenalized, true);

    const reporter = (await db.collection('players').doc('reporter').get()).data();
    const opponent = (await db.collection('players').doc('opponent').get()).data();
    assert.strictEqual(reporter.logStrikes, 0);
    assert.strictEqual(reporter.rating, 499);
    assert.strictEqual(opponent.logStrikes, 0);
    assert.strictEqual(opponent.rating, 499);
  });

  await t.test('idempotency: retrying the same pendingId does not double-penalize', async () => {
    await db.collection('state').doc('global').set({
      pending: [{ id: 'p1', reporterId: 'reporter', opponentId: 'opponent', status: 'pending' }]
    });
    await db.collection('players').doc('reporter').set({ rating: 500, logStrikes: 2 });
    await db.collection('players').doc('opponent').set({ rating: 500, logStrikes: 2 });

    const call = () => applyStrikePenaltyHandler(db, fakeRequest('opponent', { pendingId: 'p1' }));
    const first = await call();
    const second = await call();

    assert.strictEqual(first.duplicate, false);
    assert.strictEqual(second.duplicate, true);

    const reporter = (await db.collection('players').doc('reporter').get()).data();
    assert.strictEqual(reporter.rating, 499); // not 498 — the retry must not have re-applied
  });

  await t.test('missing player doc is skipped, not created, mirroring applyLogStrike\'s "if (!p) return"', async () => {
    await db.collection('state').doc('global').set({
      pending: [{ id: 'p1', reporterId: 'ghost-reporter', opponentId: 'opponent', status: 'pending' }]
    });
    await db.collection('players').doc('opponent').set({ rating: 500, logStrikes: 2 });

    const result = await applyStrikePenaltyHandler(db, fakeRequest('opponent', { pendingId: 'p1' }));
    assert.strictEqual(result.reporterPenalized, false);
    assert.strictEqual(result.opponentPenalized, true);

    const ghostDoc = await db.collection('players').doc('ghost-reporter').get();
    assert.strictEqual(ghostDoc.exists, false);
  });
});
