'use strict';

// Rollout step 6a (2026-09-24): the forgery gate. Before this, any signed-in
// user could create a liveGames doc or a state/global.pending entry naming a
// victim, and the functions trusted both.

const test = require('node:test');
const assert = require('node:assert/strict');
const { getDb, clearEmulatorData, fakeRequest, seedLive, seedPendingResult } = require('./testUtils');
const { submitMatchResultHandler } = require('../lib/submitMatchResult');
const { applyStrikePenaltyHandler } = require('../lib/applyStrikePenalty');
const { reportPendingResultHandler } = require('../lib/reportPendingResult');
const { cancelPendingResultHandler } = require('../lib/cancelPendingResult');
const { calcRatings } = require('../lib/elo');

const report = (db, uid, data) => reportPendingResultHandler(db, fakeRequest(uid, data));
const confirm = (db, uid, data) => submitMatchResultHandler(db, fakeRequest(uid, data));
const dispute = (db, uid, pendingId) => applyStrikePenaltyHandler(db, fakeRequest(uid, { pendingId }));
const cancel = (db, uid, pendingId) => cancelPendingResultHandler(db, fakeRequest(uid, { pendingId }));
const code = (c) => (err) => err.code === c;

test('forgery gate', async (t) => {
  const db = getDb();
  t.beforeEach(async () => { await clearEmulatorData(); });

  // ── Pending path ──────────────────────────────────────────────────────

  await t.test('a third party cannot report a match they did not play in', async () => {
    await assert.rejects(() => report(db, 'eve', { pendingId: 'p1', winnerId: 'w', loserId: 'l' }), code('permission-denied'));
    assert.strictEqual((await db.collection('pendingResults').doc('p1').get()).exists, false);
  });

  await t.test('reporter and opponent are server-derived; a payload reporterId/opponentId is ignored', async () => {
    const r = await report(db, 'w', { pendingId: 'p1', winnerId: 'w', loserId: 'l', reporterId: 'x', opponentId: 'w' });
    assert.deepStrictEqual([r.reporterId, r.opponentId], ['w', 'l']);
    const doc = (await db.collection('pendingResults').doc('p1').get()).data();
    assert.deepStrictEqual([doc.reporterId, doc.opponentId, doc.reporterAuthUid], ['w', 'l', 'w']);
  });

  await t.test('the loser can report too, and the winner becomes the opponent', async () => {
    const r = await report(db, 'l', { pendingId: 'p1', winnerId: 'w', loserId: 'l' });
    assert.strictEqual(r.opponentId, 'w');
  });

  await t.test('a forged state/global.pending entry with no pendingResults twin is rejected by both functions', async () => {
    await db.collection('state').doc('global').set({
      pending: [{ id: 'p1', reporterId: 'eve', opponentId: 'eve', winnerId: 'eve', loserId: 'victim', status: 'pending' }]
    });
    await assert.rejects(() => confirm(db, 'eve', { gameId: 'g1', winnerId: 'eve', loserId: 'victim', pendingId: 'p1' }), code('permission-denied'));
    await assert.rejects(() => dispute(db, 'eve', 'p1'), code('permission-denied'));
    assert.strictEqual((await db.collection('players').doc('victim').get()).exists, false);
  });

  await t.test('the reporter cannot confirm their own report', async () => {
    await report(db, 'w', { pendingId: 'p1', winnerId: 'w', loserId: 'l' });
    await assert.rejects(() => confirm(db, 'w', { gameId: 'g1', winnerId: 'w', loserId: 'l', pendingId: 'p1' }), code('permission-denied'));
  });

  // Step 6a review fix 1 (spec change, by design): the confirmer's payload
  // score must equal the stored score, so the opponent can't confirm a
  // different score from the one the server applies.
  await t.test('confirm with a payload score that differs from the stored score is rejected, nothing written', async () => {
    await report(db, 'w', { pendingId: 'p1', winnerId: 'w', loserId: 'l', score: '0 — SKI' });
    await assert.rejects(() => confirm(db, 'l', { gameId: 'g1', winnerId: 'w', loserId: 'l', pendingId: 'p1', score: 'S — SKI' }), code('invalid-argument'));
    assert.strictEqual((await db.collection('players').doc('w').get()).exists, false);
    assert.strictEqual((await db.collection('games').doc('g1').get()).exists, false);
    assert.strictEqual((await db.collection('resolutions').doc('pending_p1').get()).exists, false);
  });

  await t.test('confirm with the matching score succeeds, and the delta reflects the 1.5x shutout multiplier', async () => {
    await report(db, 'w', { pendingId: 'p1', winnerId: 'w', loserId: 'l', score: '0 — SKI', tricks: 'rail, 360', resort: 'Stowe' });
    const res = await confirm(db, 'l', { gameId: 'g1', winnerId: 'w', loserId: 'l', pendingId: 'p1', score: '0 — SKI', resort: 'fake' });
    const expected = calcRatings({ gamesPlayed: 0 }, { gamesPlayed: 0 }, '0 — SKI');
    assert.strictEqual(expected.scoreMultiplier, 1.5);
    assert.strictEqual(res.winnerDelta, expected.winnerDelta);
    assert.strictEqual(res.winnerNew, expected.winnerNew);
    const g = (await db.collection('games').doc('g1').get()).data();
    assert.strictEqual(g.score, '0 — SKI');
    assert.strictEqual(g.resort, 'Stowe'); // stored, not the payload's
    assert.deepStrictEqual(g.tricks, ['rail', '360']);
  });

  await t.test('no score on either side: confirm succeeds', async () => {
    await report(db, 'w', { pendingId: 'p1', winnerId: 'w', loserId: 'l' });
    const res = await confirm(db, 'l', { gameId: 'g1', winnerId: 'w', loserId: 'l', pendingId: 'p1' });
    assert.strictEqual(res.duplicate, false);
  });

  await t.test('report then dispute: both get a strike', async () => {
    await db.collection('players').doc('w').set({ rating: 500, logStrikes: 0 });
    await db.collection('players').doc('l').set({ rating: 500, logStrikes: 0 });
    await report(db, 'w', { pendingId: 'p1', winnerId: 'w', loserId: 'l' });
    await dispute(db, 'l', 'p1');
    assert.strictEqual((await db.collection('players').doc('w').get()).data().logStrikes, 1);
    assert.strictEqual((await db.collection('players').doc('l').get()).data().logStrikes, 1);
  });

  await t.test('report then cancel: confirm and dispute both fail afterwards', async () => {
    await report(db, 'w', { pendingId: 'p1', winnerId: 'w', loserId: 'l' });
    const c = await cancel(db, 'w', 'p1');
    assert.strictEqual(c.duplicate, false);
    assert.strictEqual((await cancel(db, 'w', 'p1')).duplicate, true);
    await assert.rejects(() => confirm(db, 'l', { gameId: 'g1', winnerId: 'w', loserId: 'l', pendingId: 'p1' }), code('already-exists'));
    await assert.rejects(() => dispute(db, 'l', 'p1'), code('already-exists'));
  });

  await t.test('only the reporter can cancel, and not after it was confirmed', async () => {
    await report(db, 'w', { pendingId: 'p1', winnerId: 'w', loserId: 'l' });
    await assert.rejects(() => cancel(db, 'l', 'p1'), code('permission-denied'));
    await confirm(db, 'l', { gameId: 'g1', winnerId: 'w', loserId: 'l', pendingId: 'p1' });
    await assert.rejects(() => cancel(db, 'w', 'p1'), code('already-exists'));
  });

  await t.test('re-reporting the same pendingId: identical retry is benign, a different payload is rejected', async () => {
    await report(db, 'w', { pendingId: 'p1', winnerId: 'w', loserId: 'l' });
    assert.strictEqual((await report(db, 'w', { pendingId: 'p1', winnerId: 'w', loserId: 'l' })).duplicate, true);
    await assert.rejects(() => report(db, 'w', { pendingId: 'p1', winnerId: 'w', loserId: 'other' }), code('already-exists'));
    await assert.rejects(() => report(db, 'l', { pendingId: 'p1', winnerId: 'w', loserId: 'l' }), code('already-exists'));
  });

  await t.test('legacy reporter and legacy confirmer both work', async () => {
    await db.collection('players').doc('legacyW').set({ rating: 500, gamesPlayed: 5, firebaseUid: 'authW' });
    await db.collection('players').doc('legacyL').set({ rating: 500, gamesPlayed: 5, firebaseUid: 'authL' });
    const r = await report(db, 'authW', { pendingId: 'p1', winnerId: 'legacyW', loserId: 'legacyL' });
    assert.deepStrictEqual([r.reporterId, r.opponentId], ['legacyW', 'legacyL']);
    const res = await confirm(db, 'authL', { gameId: 'g1', winnerId: 'legacyW', loserId: 'legacyL', pendingId: 'p1' });
    assert.strictEqual(res.duplicate, false);
  });

  // ── Live path ─────────────────────────────────────────────────────────

  await t.test('attacker-created live game naming a victim who never joined is rejected', async () => {
    await seedLive(db, 'lg1', { p1: 'eve', p2: 'victim', judgeId: null }, ['eve']);
    await assert.rejects(() => confirm(db, 'eve', { gameId: 'g1', winnerId: 'eve', loserId: 'victim', liveGameId: 'lg1' }), code('failed-precondition'));
    assert.strictEqual((await db.collection('players').doc('victim').get()).exists, false);
  });

  await t.test('...still rejected with the attacker as judge and joined under every seat they control', async () => {
    await seedLive(db, 'lg1', { p1: 'victimA', p2: 'victimB', judgeId: 'eve' }, ['eve']);
    await assert.rejects(() => confirm(db, 'eve', { gameId: 'g1', winnerId: 'victimA', loserId: 'victimB', liveGameId: 'lg1' }), code('failed-precondition'));
  });

  await t.test('a join under a different auth uid does not count for the victim', async () => {
    // eve's join doc exists, but her auth uid resolves to eve, not to victim.
    await seedLive(db, 'lg1', { p1: 'eve', p2: 'victim', judgeId: null }, ['eve', 'eve2']);
    await assert.rejects(() => confirm(db, 'eve', { gameId: 'g1', winnerId: 'eve', loserId: 'victim', liveGameId: 'lg1' }), code('failed-precondition'));
  });

  await t.test('a legacy player\'s join counts via firebaseUid, a native one via player id', async () => {
    await db.collection('players').doc('legacyW').set({ rating: 500, gamesPlayed: 5, firebaseUid: 'authW' });
    await seedLive(db, 'lg1', { p1: 'legacyW', p2: 'l', judgeId: null }, ['authW', 'l']);
    const res = await confirm(db, 'l', { gameId: 'g1', winnerId: 'legacyW', loserId: 'l', liveGameId: 'lg1' });
    assert.strictEqual(res.duplicate, false);
  });

  await t.test('live path: payload score is ignored (always \'\'), stored handicap comes from the liveGames doc', async () => {
    await db.collection('players').doc('w').set({ rating: 500, gamesPlayed: 10 });
    await db.collection('players').doc('l').set({ rating: 500, gamesPlayed: 10 });
    const hcap = { higherId: 'l', hcap: 2 };
    await seedLive(db, 'lg1', { p1: 'w', p2: 'l', judgeId: null, handicap: hcap });
    const res = await confirm(db, 'w', { gameId: 'g1', winnerId: 'w', loserId: 'l', liveGameId: 'lg1', score: '0 — SKI', handicap: null });
    const expected = calcRatings({ rating: 500, gamesPlayed: 10 }, { rating: 500, gamesPlayed: 10 }, '');
    assert.strictEqual(res.winnerNew, expected.winnerNew);
    assert.notStrictEqual(expected.winnerNew, calcRatings({ rating: 500, gamesPlayed: 10 }, { rating: 500, gamesPlayed: 10 }, '0 — SKI').winnerNew);
    const g = (await db.collection('games').doc('g1').get()).data();
    assert.deepStrictEqual(g.handicap, hcap);
    assert.strictEqual(g.score, '');
  });
  // ── Step 6a review fix 2: the live game must be finished ──────────────

  await t.test('live game mid-play (loser has 1 letter): rejected, nothing written', async () => {
    await seedLive(db, 'lg1', { p1: 'w', p2: 'l', judgeId: null, letters: { w: 0, l: 1 } });
    await assert.rejects(() => confirm(db, 'w', { gameId: 'g1', winnerId: 'w', loserId: 'l', liveGameId: 'lg1' }), code('failed-precondition'));
    assert.strictEqual((await db.collection('games').doc('g1').get()).exists, false);
    assert.strictEqual((await db.collection('resolutions').doc('live_lg1').get()).exists, false);
    assert.strictEqual((await db.collection('players').doc('w').get()).exists, false);
  });

  await t.test('both players at 3 letters: rejected', async () => {
    await seedLive(db, 'lg1', { p1: 'w', p2: 'l', judgeId: null, letters: { w: 3, l: 3 } });
    await assert.rejects(() => confirm(db, 'w', { gameId: 'g1', winnerId: 'w', loserId: 'l', liveGameId: 'lg1' }), code('failed-precondition'));
  });

  await t.test('caller naming themselves winner while THEY hold 3 letters: rejected', async () => {
    await seedLive(db, 'lg1', { p1: 'w', p2: 'l', judgeId: null, letters: { w: 3, l: 0 } });
    await assert.rejects(() => confirm(db, 'w', { gameId: 'g1', winnerId: 'w', loserId: 'l', liveGameId: 'lg1' }), code('failed-precondition'));
  });

  await t.test('forfeit shape (loser set to 3 letters, forfeitBy loser): succeeds', async () => {
    await seedLive(db, 'lg1', { p1: 'w', p2: 'l', judgeId: null, letters: { w: 1, l: 3 }, forfeitBy: 'l' });
    const res = await confirm(db, 'w', { gameId: 'g1', winnerId: 'w', loserId: 'l', liveGameId: 'lg1' });
    assert.strictEqual(res.duplicate, false);
  });
});
