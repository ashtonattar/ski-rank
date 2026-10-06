'use strict';

// Rollout step 8 (2026-10-06): the cross-player writes that used to go
// through state/global.players — accepting/removing a friend (both sides'
// `friends`) and deleting a player.

const test = require('node:test');
const assert = require('node:assert/strict');
const { getDb, clearEmulatorData, fakeRequest } = require('./testUtils');
const { acceptFriendRequestHandler, removeFriendHandler } = require('../lib/friends');
const { deletePlayerHandler, ADMIN_EMAIL } = require('../lib/deletePlayer');

const accept = (db, uid, requestId) => acceptFriendRequestHandler(db, fakeRequest(uid, { requestId }));
const remove = (db, uid, otherId) => removeFriendHandler(db, fakeRequest(uid, { otherId }));
const code = (c) => (err) => err.code === c;
const adminReq = (uid, data) => ({ auth: { uid, token: { email: ADMIN_EMAIL } }, data });

test('step 8 callables', async (t) => {
  const db = getDb();
  t.beforeEach(async () => { await clearEmulatorData(); });

  const player = (id, data = {}) => db.collection('players').doc(id).set({ name: id, rating: 512, ...data });
  const friendsOf = async (id) => ((await db.collection('players').doc(id).get()).data() || {}).friends || [];
  const req = (id, data) => db.collection('friendRequests').doc(id).set({ status: 'pending', date: 1, ...data });
  const reqDoc = async (id) => (await db.collection('friendRequests').doc(id).get());

  // ── acceptFriendRequest ────────────────────────────────────────────────

  await t.test('accept: rejects an unauthenticated caller', async () => {
    await assert.rejects(() => accept(db, null, 'r1'), code('unauthenticated'));
  });

  await t.test('accept: the recipient accepts, both friends lists update, request marked accepted', async () => {
    await player('a', { friends: ['x'] });
    await player('b');
    await req('r1', { fromId: 'a', toId: 'b' });
    const res = await accept(db, 'b', 'r1');
    assert.strictEqual(res.duplicate, false);
    assert.deepStrictEqual(await friendsOf('a'), ['x', 'b']);
    assert.deepStrictEqual(await friendsOf('b'), ['a']);
    assert.strictEqual((await reqDoc('r1')).data().status, 'accepted');
    assert.strictEqual((await db.collection('players').doc('a').get()).data().rating, 512); // nothing else touched
  });

  await t.test('accept: the sender cannot accept their own request', async () => {
    await player('a'); await player('b');
    await req('r1', { fromId: 'a', toId: 'b' });
    await assert.rejects(() => accept(db, 'a', 'r1'), code('permission-denied'));
    assert.deepStrictEqual(await friendsOf('b'), []);
  });

  await t.test('accept: a third party cannot accept someone else\'s request', async () => {
    await player('a'); await player('b'); await player('eve');
    await req('r1', { fromId: 'a', toId: 'b' });
    await assert.rejects(() => accept(db, 'eve', 'r1'), code('permission-denied'));
    assert.strictEqual((await reqDoc('r1')).data().status, 'pending');
  });

  await t.test('accept: a legacy recipient (player id != auth uid) can accept', async () => {
    await player('a');
    await player('legacyB', { firebaseUid: 'authB' });
    await req('r1', { fromId: 'a', toId: 'legacyB' });
    await accept(db, 'authB', 'r1');
    assert.deepStrictEqual(await friendsOf('a'), ['legacyB']);
    assert.deepStrictEqual(await friendsOf('legacyB'), ['a']);
  });

  await t.test('accept: a repeat call is a benign duplicate', async () => {
    await player('a'); await player('b');
    await req('r1', { fromId: 'a', toId: 'b' });
    await accept(db, 'b', 'r1');
    const res = await accept(db, 'b', 'r1');
    assert.strictEqual(res.duplicate, true);
    assert.deepStrictEqual(await friendsOf('a'), ['b']);
  });

  await t.test('accept: a declined request cannot be accepted', async () => {
    await player('a'); await player('b');
    await req('r1', { fromId: 'a', toId: 'b', status: 'declined' });
    await assert.rejects(() => accept(db, 'b', 'r1'), code('failed-precondition'));
    assert.deepStrictEqual(await friendsOf('a'), []);
  });

  await t.test('accept: a missing request or a deleted sender is rejected, nothing written', async () => {
    await player('b');
    await assert.rejects(() => accept(db, 'b', 'nope'), code('not-found'));
    await req('r1', { fromId: 'gone', toId: 'b' });
    await assert.rejects(() => accept(db, 'b', 'r1'), code('failed-precondition'));
    assert.strictEqual((await reqDoc('r1')).data().status, 'pending');
    assert.deepStrictEqual(await friendsOf('b'), []);
  });

  // ── removeFriend ───────────────────────────────────────────────────────

  await t.test('remove: unfriends both sides and deletes the settled request', async () => {
    await player('a', { friends: ['b', 'x'] });
    await player('b', { friends: ['a'] });
    await req('r1', { fromId: 'b', toId: 'a', status: 'accepted' });
    await req('other', { fromId: 'a', toId: 'x', status: 'accepted' });
    const res = await remove(db, 'a', 'b');
    assert.strictEqual(res.requestsDeleted, 1);
    assert.deepStrictEqual(await friendsOf('a'), ['x']);
    assert.deepStrictEqual(await friendsOf('b'), []);
    assert.strictEqual((await reqDoc('r1')).exists, false);
    assert.strictEqual((await reqDoc('other')).exists, true);
  });

  await t.test('remove: leaves a still-pending request alone', async () => {
    await player('a'); await player('b');
    await req('r1', { fromId: 'a', toId: 'b' });
    await remove(db, 'b', 'a');
    assert.strictEqual((await reqDoc('r1')).exists, true);
  });

  await t.test('remove: a legacy caller removes by player id, not auth uid', async () => {
    await player('legacyA', { firebaseUid: 'authA', friends: ['b'] });
    await player('b', { friends: ['legacyA'] });
    await remove(db, 'authA', 'b');
    assert.deepStrictEqual(await friendsOf('legacyA'), []);
    assert.deepStrictEqual(await friendsOf('b'), []);
  });

  await t.test('remove: yourself or a missing id is rejected; a repeat is a no-op', async () => {
    await player('a', { friends: ['b'] }); await player('b', { friends: ['a'] });
    await assert.rejects(() => remove(db, 'a', 'a'), code('invalid-argument'));
    await assert.rejects(() => remove(db, 'a', ''), code('invalid-argument'));
    await remove(db, 'a', 'b');
    await remove(db, 'a', 'b');
    assert.deepStrictEqual(await friendsOf('a'), []);
  });

  // ── deletePlayer ───────────────────────────────────────────────────────

  await t.test('delete: self-delete removes the doc, strips friends, deletes requests, deletes the auth user', async () => {
    await player('a', { friends: ['b', 'c'] });
    await player('b', { friends: ['a', 'c'] });
    await player('c', { friends: ['a'] });
    await req('r1', { fromId: 'a', toId: 'b', status: 'accepted' });
    await req('r2', { fromId: 'c', toId: 'a' });
    await req('r3', { fromId: 'b', toId: 'c', status: 'accepted' });
    await db.collection('games').doc('g1').set({ winnerId: 'a', loserId: 'b' });
    const deleted = [];
    const res = await deletePlayerHandler(db, fakeRequest('a', {}), { deleteAuthUser: async (u) => deleted.push(u) });
    assert.deepStrictEqual(
      [res.playerId, res.self, res.existed, res.friendsUpdated, res.requestsDeleted, res.authDeleted],
      ['a', true, true, 2, 2, true]);
    assert.deepStrictEqual(deleted, ['a']);
    assert.strictEqual((await db.collection('players').doc('a').get()).exists, false);
    assert.deepStrictEqual(await friendsOf('b'), ['c']);
    assert.deepStrictEqual(await friendsOf('c'), []);
    assert.strictEqual((await reqDoc('r1')).exists, false);
    assert.strictEqual((await reqDoc('r2')).exists, false);
    assert.strictEqual((await reqDoc('r3')).exists, true);
    assert.strictEqual((await db.collection('games').doc('g1').get()).exists, true); // history stays
  });

  await t.test('delete: a legacy self-delete targets the player id and deletes the AUTH uid', async () => {
    await player('legacyA', { firebaseUid: 'authA' });
    const deleted = [];
    const res = await deletePlayerHandler(db, fakeRequest('authA', {}), { deleteAuthUser: async (u) => deleted.push(u) });
    assert.strictEqual(res.playerId, 'legacyA');
    assert.deepStrictEqual(deleted, ['authA']);
    assert.strictEqual((await db.collection('players').doc('legacyA').get()).exists, false);
  });

  await t.test('delete: a non-admin cannot delete another player', async () => {
    await player('a'); await player('victim');
    await assert.rejects(
      () => deletePlayerHandler(db, fakeRequest('a', { playerId: 'victim' }), { deleteAuthUser: async () => {} }),
      code('permission-denied'));
    assert.strictEqual((await db.collection('players').doc('victim').get()).exists, true);
  });

  await t.test('delete: an admin deletes another player, and their auth user is left alone', async () => {
    await player('admin'); await player('victim'); await player('b', { friends: ['victim'] });
    const deleted = [];
    const res = await deletePlayerHandler(db, adminReq('admin', { playerId: 'victim' }), { deleteAuthUser: async (u) => deleted.push(u) });
    assert.deepStrictEqual([res.self, res.authDeleted], [false, false]);
    assert.deepStrictEqual(deleted, []);
    assert.strictEqual((await db.collection('players').doc('victim').get()).exists, false);
    assert.deepStrictEqual(await friendsOf('b'), []);
  });

  await t.test('delete: an auth-delete failure is reported, the data cleanup still stands', async () => {
    await player('a');
    const res = await deletePlayerHandler(db, fakeRequest('a', {}), { deleteAuthUser: async () => { throw new Error('boom'); } });
    assert.strictEqual(res.authDeleted, false);
    assert.strictEqual((await db.collection('players').doc('a').get()).exists, false);
  });

  await t.test('delete: unauthenticated or a bad playerId is rejected', async () => {
    await assert.rejects(() => deletePlayerHandler(db, fakeRequest(null, {})), code('unauthenticated'));
    await assert.rejects(() => deletePlayerHandler(db, fakeRequest('a', { playerId: '' })), code('invalid-argument'));
    await assert.rejects(() => deletePlayerHandler(db, fakeRequest('a', { playerId: 5 })), code('invalid-argument'));
  });
});
