// (C) Emulator test for Backend Migration Plan, sequenced rollout step 1.
// Covers exactly the verify criteria from "01 Refinements/(C) Backend Migration
// Plan - Verified 2026-09-16.md" line 123:
//   - forged direct write to players/{other-uid}.rating rejected
//   - own non-rating field update allowed
//   - games create/update rejected for all non-admin clients
//   - messages/friendRequests participant-only read/write enforced
//     (including the admin-bulk-delete carve-out)
//
// Run: npx firebase emulators:exec --project demo-test "node \"(C) rules-test/step1.test.mjs\""

import {
  initializeTestEnvironment,
  assertFails,
  assertSucceeds,
} from '@firebase/rules-unit-testing';
import { readFileSync } from 'fs';
import assert from 'assert';

const rules = readFileSync('firestore.rules', 'utf8');

let passed = 0;
async function check(name, fn) {
  await fn();
  passed++;
  console.log(`  ok - ${name}`);
}

async function main() {
  const testEnv = await initializeTestEnvironment({
    projectId: 'demo-test',
    firestore: { rules },
  });

  // Seed data as admin (bypasses rules) so read/update/delete tests have something real to act on.
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    await db.doc('players/alice-uid').set({ id: 'alice-uid', name: 'Alice', rating: 400, wins: 0, losses: 0, gamesPlayed: 0, peakRating: 0 });
    await db.doc('players/bob-uid').set({ id: 'bob-uid', name: 'Bob', rating: 400, wins: 0, losses: 0, gamesPlayed: 0, peakRating: 0 });
    await db.doc('games/game1').set({ id: 'game1', winnerId: 'alice-uid', loserId: 'bob-uid', date: Date.now() });
    await db.doc('messages/msg1').set({ id: 'msg1', fromId: 'alice-uid', fromName: 'Alice', toId: 'bob-uid', text: 'hi', date: Date.now() });
    await db.doc('friendRequests/fr1').set({ id: 'fr1', fromId: 'alice-uid', fromName: 'Alice', toId: 'bob-uid', toName: 'Bob', status: 'pending', date: Date.now() });
  });

  const alice = testEnv.authenticatedContext('alice-uid', { email: 'alice@example.com' }).firestore();
  const bob = testEnv.authenticatedContext('bob-uid', { email: 'bob@example.com' }).firestore();
  const eve = testEnv.authenticatedContext('eve-uid', { email: 'eve@example.com' }).firestore();
  const admin = testEnv.authenticatedContext('admin-uid', { email: 'ashtonattar@gmail.com' }).firestore();
  const anon = testEnv.unauthenticatedContext().firestore();

  // ── players ──
  await check('forged direct write to players/{other-uid}.rating rejected', async () => {
    await assertFails(eve.doc('players/alice-uid').update({ rating: 9999 }));
  });
  await check('own rating write rejected too (locked to server only)', async () => {
    await assertFails(alice.doc('players/alice-uid').update({ rating: 9999 }));
  });
  await check('own non-rating field update allowed', async () => {
    await assertSucceeds(alice.doc('players/alice-uid').update({ name: 'Alice2' }));
  });
  await check('other-uid non-rating field update rejected', async () => {
    await assertFails(eve.doc('players/alice-uid').update({ name: 'Hacked' }));
  });
  await check('forged create with inflated rating rejected', async () => {
    await assertFails(eve.doc('players/eve-uid').set({ id: 'eve-uid', name: 'Eve', rating: 3000 }));
  });
  await check('legitimate self-create at default rating allowed', async () => {
    await assertSucceeds(eve.doc('players/eve-uid').set({ id: 'eve-uid', name: 'Eve', rating: 400, wins: 0, losses: 0, gamesPlayed: 0, peakRating: 0 }));
  });
  await check('non-admin cannot delete a player doc (wipe tool is admin-only)', async () => {
    await assertFails(alice.doc('players/bob-uid').delete());
  });
  await check('admin can delete a player doc (wipe tool)', async () => {
    await assertSucceeds(admin.doc('players/bob-uid').delete());
  });
  await check('players are publicly readable (leaderboard)', async () => {
    await assertSucceeds(anon.doc('players/alice-uid').get());
  });

  // ── games ──
  await check('games create rejected for all non-admin clients', async () => {
    await assertFails(alice.doc('games/game2').set({ id: 'game2', winnerId: 'alice-uid', loserId: 'bob-uid', date: Date.now() }));
  });
  await check('games update rejected for all non-admin clients', async () => {
    await assertFails(alice.doc('games/game1').update({ notes: 'edited' }));
  });
  await check('games create rejected even for admin client (CF/Admin SDK only)', async () => {
    await assertFails(admin.doc('games/game3').set({ id: 'game3', winnerId: 'alice-uid', loserId: 'bob-uid', date: Date.now() }));
  });
  await check('non-admin cannot delete a game (wipe tool is admin-only)', async () => {
    await assertFails(alice.doc('games/game1').delete());
  });
  await check('admin can delete a game (wipe tool)', async () => {
    await assertSucceeds(admin.doc('games/game1').delete());
  });
  await check('games are publicly readable (match history)', async () => {
    await assertSucceeds(anon.doc('games/game1').get());
  });

  // ── messages ──
  await check('non-participant cannot read a message', async () => {
    await assertFails(eve.doc('messages/msg1').get());
  });
  await check('unauthenticated cannot read a message (closes the state/global privacy hole)', async () => {
    await assertFails(anon.doc('messages/msg1').get());
  });
  await check('sender can read their own message', async () => {
    await assertSucceeds(alice.doc('messages/msg1').get());
  });
  await check('recipient can read their own message', async () => {
    await assertSucceeds(bob.doc('messages/msg1').get());
  });
  await check('participant can send a message', async () => {
    await assertSucceeds(bob.doc('messages/msg2').set({ id: 'msg2', fromId: 'bob-uid', fromName: 'Bob', toId: 'alice-uid', text: 'hey', date: Date.now() }));
  });
  await check('cannot forge a message as someone else', async () => {
    await assertFails(eve.doc('messages/msg3').set({ id: 'msg3', fromId: 'alice-uid', fromName: 'Alice', toId: 'bob-uid', text: 'forged', date: Date.now() }));
  });
  await check('messages are immutable once sent', async () => {
    await assertFails(alice.doc('messages/msg1').update({ text: 'edited' }));
  });
  await check('admin can bulk-delete messages (wipe tool)', async () => {
    await assertSucceeds(admin.doc('messages/msg1').delete());
  });
  await check('non-admin non-participant cannot delete a message', async () => {
    await assertFails(eve.doc('messages/msg2').delete());
  });

  // ── friendRequests ──
  await check('non-participant cannot read a friend request', async () => {
    await assertFails(eve.doc('friendRequests/fr1').get());
  });
  await check('recipient can read a friend request addressed to them', async () => {
    await assertSucceeds(bob.doc('friendRequests/fr1').get());
  });
  await check('recipient can accept a pending friend request', async () => {
    await assertSucceeds(bob.doc('friendRequests/fr1').update({ status: 'accepted' }));
  });
  await check('sender cannot accept their own sent request', async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await ctx.firestore().doc('friendRequests/fr2').set({ id: 'fr2', fromId: 'alice-uid', toId: 'bob-uid', status: 'pending', date: Date.now() });
    });
    await assertFails(alice.doc('friendRequests/fr2').update({ status: 'accepted' }));
  });
  await check('recipient cannot smuggle other field changes into an accept', async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await ctx.firestore().doc('friendRequests/fr3').set({ id: 'fr3', fromId: 'alice-uid', toId: 'bob-uid', status: 'pending', date: Date.now() });
    });
    await assertFails(bob.doc('friendRequests/fr3').update({ status: 'accepted', fromId: 'eve-uid' }));
  });
  await check('sender can cancel (delete) their own pending request', async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await ctx.firestore().doc('friendRequests/fr4').set({ id: 'fr4', fromId: 'alice-uid', toId: 'bob-uid', status: 'pending', date: Date.now() });
    });
    await assertSucceeds(alice.doc('friendRequests/fr4').delete());
  });
  await check('non-participant cannot delete a friend request', async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await ctx.firestore().doc('friendRequests/fr5').set({ id: 'fr5', fromId: 'alice-uid', toId: 'bob-uid', status: 'pending', date: Date.now() });
    });
    await assertFails(eve.doc('friendRequests/fr5').delete());
  });
  await check('admin can bulk-delete friend requests (wipe tool)', async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await ctx.firestore().doc('friendRequests/fr6').set({ id: 'fr6', fromId: 'alice-uid', toId: 'bob-uid', status: 'pending', date: Date.now() });
    });
    await assertSucceeds(admin.doc('friendRequests/fr6').delete());
  });
  await check('cannot forge a friend request as someone else', async () => {
    await assertFails(eve.doc('friendRequests/fr7').set({ id: 'fr7', fromId: 'alice-uid', toId: 'bob-uid', status: 'pending', date: Date.now() }));
  });

  await testEnv.cleanup();
  console.log(`\n${passed} checks passed.`);
}

main().catch((e) => { console.error('FAILED:', e); process.exit(1); });
