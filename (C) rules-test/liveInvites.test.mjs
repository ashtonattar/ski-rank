// (C) Emulator rules test for liveInvites/{id} (2026-11-20): live game
// invites moved off the state/global array into one doc per invite.
//   - the sender creates a pending invite carrying members[]; blocked senders can't
//   - the client's array-contains listener query is allowed for signed-in riders
//   - only the recipient answers, and only `status` may change
//   - any member (or a legacy sender/recipient) can clear it; strangers can't
//
// Run: npm run test:rules

import { initializeTestEnvironment, assertFails, assertSucceeds } from '@firebase/rules-unit-testing';
import { readFileSync } from 'fs';

const rules = readFileSync('firestore.rules', 'utf8');

let passed = 0;
async function check(name, fn) {
  await fn();
  passed++;
  console.log(`  ok - ${name}`);
}

const invite = (id, extra = {}) => ({
  id, fromId: 'bob-uid', fromName: 'Bob', toId: 'legacy-old-id', toName: 'Legacy Lee',
  p1Id: 'bob-uid', p2Id: 'legacy-old-id', judgeId: null, resort: '', status: 'pending',
  createdAt: 1, members: ['bob-uid', 'legacy-old-id'], ...extra
});

async function main() {
  const testEnv = await initializeTestEnvironment({ projectId: 'demo-test-invites', firestore: { rules } });

  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    await db.doc('players/bob-uid').set({ id: 'bob-uid', name: 'Bob' });
    await db.doc('players/legacy-old-id').set({ id: 'legacy-old-id', name: 'Legacy Lee', firebaseUid: 'legacy-real-uid' });
    await db.doc('players/judy-uid').set({ id: 'judy-uid', name: 'Judy' });
    await db.doc('blocks/judy-uid').set({ blocked: ['bob-uid'], updatedAt: 1 });
    await db.doc('liveInvites/seed').set(invite('seed'));
  });

  const bob = testEnv.authenticatedContext('bob-uid').firestore();
  const legacy = testEnv.authenticatedContext('legacy-real-uid').firestore();
  const judy = testEnv.authenticatedContext('judy-uid').firestore();
  const eve = testEnv.authenticatedContext('eve-uid').firestore();
  const anon = testEnv.unauthenticatedContext().firestore();
  const admin = testEnv.authenticatedContext('admin-uid', { email: 'ashtonattar@gmail.com' }).firestore();

  // ── create ──
  await check('sender creates a pending invite (the exact client shape)', async () => {
    await assertSucceeds(bob.doc('liveInvites/i1').set(invite('i1')));
  });
  await check('a judge invite with all three members', async () => {
    await assertSucceeds(bob.doc('liveInvites/j1').set(invite('j1', {
      toId: 'jim-uid', toName: 'Jim', judgeId: 'jim-uid', role: 'judge', gameId: 'i1',
      members: ['bob-uid', 'jim-uid', 'legacy-old-id']
    })));
  });
  await check('legacy sender can create', async () => {
    await assertSucceeds(legacy.doc('liveInvites/i2').set(invite('i2', {
      fromId: 'legacy-old-id', toId: 'bob-uid', members: ['legacy-old-id', 'bob-uid']
    })));
  });
  await check("can't forge someone else as sender", async () => {
    await assertFails(eve.doc('liveInvites/i3').set(invite('i3')));
  });
  await check('must start pending, id must match, members must hold sender + recipient', async () => {
    await assertFails(bob.doc('liveInvites/i4').set(invite('i4', { status: 'accepted' })));
    await assertFails(bob.doc('liveInvites/i5').set(invite('other')));
    await assertFails(bob.doc('liveInvites/i6').set(invite('i6', { members: ['bob-uid'] })));
    await assertFails(bob.doc('liveInvites/i7').set(invite('i7', { members: 'bob-uid' })));
    await assertFails(bob.doc('liveInvites/i8').set(invite('i8', { members: ['bob-uid', 'legacy-old-id', 'a', 'b', 'c', 'd'] })));
  });
  await check("a blocked sender can't invite the blocker", async () => {
    await assertFails(bob.doc('liveInvites/i9').set(invite('i9', {
      toId: 'judy-uid', p2Id: 'judy-uid', members: ['bob-uid', 'judy-uid']
    })));
  });
  await check('signed out cannot create', async () => {
    await assertFails(anon.doc('liveInvites/i10').set(invite('i10')));
  });

  // ── read / the listener query ──
  await check("the client's members array-contains query works (native + legacy id)", async () => {
    await assertSucceeds(bob.collection('liveInvites').where('members', 'array-contains', 'bob-uid').get());
    await assertSucceeds(legacy.collection('liveInvites').where('members', 'array-contains', 'legacy-old-id').get());
  });
  await check('signed out cannot read', async () => {
    await assertFails(anon.doc('liveInvites/seed').get());
  });

  // ── answer ──
  await check('recipient (legacy id) accepts and declines', async () => {
    await assertSucceeds(legacy.doc('liveInvites/seed').update({ status: 'accepted' }));
    await assertSucceeds(legacy.doc('liveInvites/seed').update({ status: 'declined' }));
    await assertSucceeds(legacy.doc('liveInvites/seed').update({ status: 'pending' }));
  });
  await check("sender and strangers can't answer", async () => {
    await assertFails(bob.doc('liveInvites/seed').update({ status: 'accepted' }));
    await assertFails(eve.doc('liveInvites/seed').update({ status: 'accepted' }));
  });
  await check('only status changes, and only to a known value', async () => {
    await assertFails(legacy.doc('liveInvites/seed').update({ status: 'accepted', toId: 'eve-uid' }));
    await assertFails(legacy.doc('liveInvites/seed').update({ status: 'won' }));
  });

  // ── clear ──
  await check("a stranger can't delete", async () => {
    await assertFails(eve.doc('liveInvites/seed').delete());
  });
  await check('legacy recipient can delete', async () => {
    await assertSucceeds(legacy.doc('liveInvites/i1').delete());
  });
  await check('a member by uid (sender) can delete', async () => {
    await assertSucceeds(bob.doc('liveInvites/seed').delete());
  });
  await check('a judge member can clear the players\' invite', async () => {
    await testEnv.withSecurityRulesDisabled(ctx => ctx.firestore().doc('liveInvites/g1').set(invite('g1', {
      judgeId: 'judy-uid', members: ['bob-uid', 'legacy-old-id', 'judy-uid']
    })));
    await assertSucceeds(judy.doc('liveInvites/g1').delete());
  });
  await check('clearing an already-cleared invite is not an error', async () => {
    await assertSucceeds(bob.doc('liveInvites/gone').delete());
  });
  await check('admin can delete (wipe tools)', async () => {
    await assertSucceeds(admin.doc('liveInvites/i2').delete());
  });

  await testEnv.cleanup();
  console.log(`liveInvites: ${passed} checks passed`);
}

main().catch(e => { console.error(e); process.exit(1); });
