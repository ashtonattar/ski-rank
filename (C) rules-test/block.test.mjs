// (C) Emulator rules test for block-user (beta scope, 2026-11-20):
//   - blocks/{playerId} is private: only its owner (legacy ids via
//     callerIsPlayer()) or admin can read or write it
//   - only `blocked` (a list, no self-block) and `updatedAt` may be stored
//   - a blocked rider can't message or friend-request the blocker
//   - blocking is one-way: everyone else, and the blocker, are unaffected
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

async function main() {
  const testEnv = await initializeTestEnvironment({ projectId: 'demo-test-block', firestore: { rules } });

  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    await db.doc('players/bob-uid').set({ id: 'bob-uid', name: 'Bob' });
    await db.doc('players/eve-uid').set({ id: 'eve-uid', name: 'Eve' });
    await db.doc('players/carl-uid').set({ id: 'carl-uid', name: 'Carl' });
    await db.doc('players/legacy-old-id').set({ id: 'legacy-old-id', name: 'Legacy Lee', firebaseUid: 'legacy-real-uid' });
    // Legacy Lee has blocked Eve
    await db.doc('blocks/legacy-old-id').set({ blocked: ['eve-uid'], updatedAt: 1 });
  });

  const bob = testEnv.authenticatedContext('bob-uid').firestore();
  const eve = testEnv.authenticatedContext('eve-uid').firestore();
  const carl = testEnv.authenticatedContext('carl-uid').firestore();
  const legacy = testEnv.authenticatedContext('legacy-real-uid').firestore();
  const admin = testEnv.authenticatedContext('admin-uid', { email: 'ashtonattar@gmail.com' }).firestore();
  const anon = testEnv.unauthenticatedContext().firestore();

  const msg = (id, fromId, toId) => ({ id, fromId, toId, text: 'hi', date: 1 });
  const req = (id, fromId, toId) => ({ id, fromId, fromName: 'x', toId, toName: 'y', status: 'pending', date: 1 });

  // ── the list itself ──
  await check('owner (legacy id) can read their block list', async () => {
    await assertSucceeds(legacy.doc('blocks/legacy-old-id').get());
  });
  await check('the blocked rider, strangers and anon cannot read it', async () => {
    await assertFails(eve.doc('blocks/legacy-old-id').get());
    await assertFails(bob.doc('blocks/legacy-old-id').get());
    await assertFails(anon.doc('blocks/legacy-old-id').get());
  });
  await check('admin can read it', async () => {
    await assertSucceeds(admin.doc('blocks/legacy-old-id').get());
  });
  await check('owner can create and update their own list', async () => {
    await assertSucceeds(bob.doc('blocks/bob-uid').set({ blocked: ['carl-uid'], updatedAt: 2 }));
    await assertSucceeds(bob.doc('blocks/bob-uid').set({ blocked: ['carl-uid', 'eve-uid'], updatedAt: 3 }, { merge: true }));
  });
  await check("nobody can write someone else's list", async () => {
    await assertFails(eve.doc('blocks/legacy-old-id').set({ blocked: [], updatedAt: 4 }));
    await assertFails(eve.doc('blocks/carl-uid').set({ blocked: ['bob-uid'], updatedAt: 4 }));
  });
  await check('only blocked + updatedAt, blocked must be a list, no self-block', async () => {
    await assertFails(carl.doc('blocks/carl-uid').set({ blocked: [], updatedAt: 1, note: 'x' }));
    await assertFails(carl.doc('blocks/carl-uid').set({ blocked: 'eve-uid', updatedAt: 1 }));
    await assertFails(carl.doc('blocks/carl-uid').set({ blocked: ['carl-uid'], updatedAt: 1 }));
  });
  await check('owner can delete their list (account deletion)', async () => {
    await assertSucceeds(carl.doc('blocks/carl-uid').set({ blocked: [], updatedAt: 1 }));
    await assertSucceeds(carl.doc('blocks/carl-uid').delete());
  });

  // ── enforcement ──
  await check('a blocked rider cannot message the blocker', async () => {
    await assertFails(eve.doc('messages/b1').set(msg('b1', 'eve-uid', 'legacy-old-id')));
  });
  await check('a blocked rider cannot friend-request the blocker', async () => {
    await assertFails(eve.doc('friendRequests/b2').set(req('b2', 'eve-uid', 'legacy-old-id')));
  });
  await check('others can still message and friend-request the blocker', async () => {
    await assertSucceeds(bob.doc('messages/b3').set(msg('b3', 'bob-uid', 'legacy-old-id')));
    await assertSucceeds(bob.doc('friendRequests/b4').set(req('b4', 'bob-uid', 'legacy-old-id')));
  });
  await check('the blocked rider can still reach everyone else', async () => {
    await assertSucceeds(eve.doc('messages/b5').set(msg('b5', 'eve-uid', 'carl-uid')));
  });
  await check('riders with no block list are unaffected', async () => {
    await assertSucceeds(eve.doc('friendRequests/b6').set(req('b6', 'eve-uid', 'carl-uid')));
  });
  await check('unblocking reopens the door', async () => {
    await assertSucceeds(legacy.doc('blocks/legacy-old-id').set({ blocked: [], updatedAt: 5 }));
    await assertSucceeds(eve.doc('messages/b7').set(msg('b7', 'eve-uid', 'legacy-old-id')));
  });
  await check('friend request still needs a toId', async () => {
    await assertFails(eve.doc('friendRequests/b8').set({ id: 'b8', fromId: 'eve-uid', status: 'pending', date: 1 }));
  });

  await testEnv.cleanup();
  console.log(`block: ${passed} checks passed`);
}

main().catch(e => { console.error(e); process.exit(1); });
