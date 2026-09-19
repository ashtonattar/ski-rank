// (C) Emulator test for Backend Migration Plan, sequenced rollout step 1.
// Covers the verify criteria from "01 Refinements/(C) Backend Migration
// Plan - Verified 2026-09-16.md" line 123, plus gaps found in a post-deploy
// review (2026-09-18): the legacy-account firebaseUid decision (create path,
// not just update), the admin create/update trust-model inconsistency for
// seeded demo players, and the scoped-query shape required for step 7's
// read cutover (a bare collection listener is rejected under participant-
// only rules — see the messages/friendRequests comments in firestore.rules):
//   - forged direct write to players/{other-uid}.rating rejected
//   - own non-rating field update allowed
//   - legacy-migrated player can self-edit via mirrored firebaseUid
//   - legacy player with no firebaseUid on doc is locked out (intended)
//   - legacy self-heal CREATE of a missing player doc succeeds
//   - firebaseUid is fully immutable via non-admin update (can't be added,
//     changed, or cleared) — no owner can repoint/share ownership, and no
//     stranger can squat an unlinked doc by claiming its absent field either;
//     admin retains a correction path
//   - admin can create/update a seeded demo player with a real rating
//   - games create/update rejected for all non-admin clients
//   - messages/friendRequests participant-only read/write enforced
//     (including the admin-bulk-delete carve-out)
//   - messages/friendRequests: scoped fromId/toId queries succeed, a bare
//     whole-collection query is rejected
//
// Run: npm test  (or: npx firebase emulators:exec --project demo-test --only firestore "node \"(C) rules-test/step1.test.mjs\"")

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
    // Migrated legacy account: doc id is the old random uid(), firebaseUid mirrors the
    // real Firebase Auth uid the account linked to (Plan Pass 2 finding #4, option a).
    await db.doc('players/legacy-old-id').set({ id: 'legacy-old-id', name: 'Legacy Lee', firebaseUid: 'legacy-real-uid', rating: 400, wins: 0, losses: 0, gamesPlayed: 0, peakRating: 0 });
    // Legacy account that has NOT linked a Firebase Auth identity yet — no firebaseUid field at all.
    await db.doc('players/legacy-unlinked-id').set({ id: 'legacy-unlinked-id', name: 'Legacy Unlinked', rating: 400, wins: 0, losses: 0, gamesPlayed: 0, peakRating: 0 });
    await db.doc('games/game1').set({ id: 'game1', winnerId: 'alice-uid', loserId: 'bob-uid', date: Date.now() });
    await db.doc('messages/msg1').set({ id: 'msg1', fromId: 'alice-uid', fromName: 'Alice', toId: 'bob-uid', text: 'hi', date: Date.now() });
    await db.doc('friendRequests/fr1').set({ id: 'fr1', fromId: 'alice-uid', fromName: 'Alice', toId: 'bob-uid', toName: 'Bob', status: 'pending', date: Date.now() });
  });

  const alice = testEnv.authenticatedContext('alice-uid', { email: 'alice@example.com' }).firestore();
  const bob = testEnv.authenticatedContext('bob-uid', { email: 'bob@example.com' }).firestore();
  const eve = testEnv.authenticatedContext('eve-uid', { email: 'eve@example.com' }).firestore();
  const admin = testEnv.authenticatedContext('admin-uid', { email: 'ashtonattar@gmail.com' }).firestore();
  const anon = testEnv.unauthenticatedContext().firestore();
  // The real Firebase Auth identity a legacy account linked to on migration — distinct
  // from its players/{id} doc id (legacy-old-id / legacy-unlinked-id above).
  const legacy = testEnv.authenticatedContext('legacy-real-uid', { email: 'legacy@example.com' }).firestore();

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

  // ── players: legacy-account firebaseUid decision (Plan Pass 2 finding #4) ──
  await check('A. legacy-migrated player CAN self-edit via mirrored firebaseUid', async () => {
    await assertSucceeds(legacy.doc('players/legacy-old-id').update({ name: 'Legacy Lee 2' }));
  });
  await check('B. legacy player whose doc lacks firebaseUid is locked out entirely (intended fallback)', async () => {
    await assertFails(legacy.doc('players/legacy-unlinked-id').update({ name: 'Nope' }));
  });
  await check('C. legacy self-heal CREATE of own missing player doc (myMissingRecord/_healPlayerDone)', async () => {
    await assertSucceeds(legacy.doc('players/legacy-brand-new-id').set({
      id: 'legacy-brand-new-id', name: 'Legacy New', firebaseUid: 'legacy-real-uid',
      rating: 400, wins: 0, losses: 0, gamesPlayed: 0, peakRating: 0,
    }));
  });
  await check('cannot self-heal-create by claiming a firebaseUid that is not your own', async () => {
    await assertFails(eve.doc('players/forged-legacy-id').set({
      id: 'forged-legacy-id', name: 'Forged', firebaseUid: 'alice-uid',
      rating: 400, wins: 0, losses: 0, gamesPlayed: 0, peakRating: 0,
    }));
  });
  await check('self-heal create still can\'t seed an inflated rating via a firebaseUid claim', async () => {
    await assertFails(legacy.doc('players/legacy-inflated-id').set({
      id: 'legacy-inflated-id', name: 'Legacy Inflated', firebaseUid: 'legacy-real-uid',
      rating: 3000, wins: 0, losses: 0, gamesPlayed: 0, peakRating: 0,
    }));
  });

  // ── players: firebaseUid must be set-once, never authorization-transferable ──
  // Found in a follow-up review: firebaseUid is trusted by isOwner()/
  // claimsOwnFirebaseUid() but was never protected against being changed —
  // any current owner could repoint it to someone else (one-way ownership
  // transfer, no undo) or add it as a second owner where absent.
  await check('current owner cannot repoint their own doc\'s firebaseUid to someone else', async () => {
    await assertFails(legacy.doc('players/legacy-old-id').update({ firebaseUid: 'eve-uid' }));
  });
  await check('...so the doc is never actually handed over: eve still cannot edit it', async () => {
    await assertFails(eve.doc('players/legacy-old-id').update({ name: 'Hijacked' }));
  });
  await check('...and the real owner keeps access (never got locked out)', async () => {
    await assertSucceeds(legacy.doc('players/legacy-old-id').update({ name: 'Legacy Lee 3' }));
  });
  await check('normal account (docId==uid) cannot add a second owner via firebaseUid', async () => {
    await assertFails(bob.doc('players/bob-uid').update({ firebaseUid: 'eve-uid' }));
  });
  await check('a stranger cannot squat an unlinked legacy doc by claiming its absent firebaseUid via update', async () => {
    // This is the rejected "obvious fix" — allowing ADD-when-absent via update
    // would let anyone claim ANY not-yet-linked legacy player's doc with zero
    // prior relationship to it. Must stay blocked; see firestore.rules comment.
    const stranger = testEnv.authenticatedContext('stranger-uid', { email: 'stranger@example.com' }).firestore();
    await assertFails(stranger.doc('players/legacy-unlinked-id').update({ firebaseUid: 'stranger-uid' }));
  });
  await check('not even claiming your own real uid makes an update-based claim safe to allow', async () => {
    // Same call, but the "real" account this legacy doc actually belongs to —
    // still rejected, because rules can't tell the two cases apart; the fix
    // is a Cloud Function that verifies identity server-side, not a rule.
    const trueOwner = testEnv.authenticatedContext('true-owner-uid', { email: 'trueowner@example.com' }).firestore();
    await assertFails(trueOwner.doc('players/legacy-unlinked-id').update({ firebaseUid: 'true-owner-uid' }));
  });
  await check('admin can still correct firebaseUid on an already-linked doc (botched-migration escape hatch)', async () => {
    await assertSucceeds(admin.doc('players/legacy-old-id').update({ firebaseUid: 'corrected-real-uid' }));
  });

  await check('H. admin can CREATE a seeded demo player with a real (non-default) rating', async () => {
    await assertSucceeds(admin.doc('players/demo-judge').set({ id: 'demo-judge', name: 'Judge', rating: 1800, wins: 12, losses: 3, gamesPlayed: 15, peakRating: 1850 }));
  });
  await check('admin can UPDATE a seeded demo player\'s rating directly', async () => {
    await assertSucceeds(admin.doc('players/demo-judge').update({ rating: 1900 }));
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

  // ── listener/query shape for rollout step 7 (read cutover) ──
  // Participant-only rules can't be satisfied by a bare collection-wide
  // listener/query; Firestore rejects it because it can't prove every
  // possible result satisfies the read rule. Step 7 must issue two scoped
  // queries per collection (fromId==me, toId==me) merged client-side.
  await check('D. whole-collection listener on messages is rejected', async () => {
    await assertFails(alice.collection('messages').get());
  });
  await check('E. scoped query where toId == me succeeds (messages)', async () => {
    await assertSucceeds(bob.collection('messages').where('toId', '==', 'bob-uid').get());
  });
  await check('F. scoped query where fromId == me succeeds (messages)', async () => {
    await assertSucceeds(alice.collection('messages').where('fromId', '==', 'alice-uid').get());
  });
  await check('G. whole-collection listener on friendRequests is rejected', async () => {
    await assertFails(alice.collection('friendRequests').get());
  });
  await check('scoped query where toId == me succeeds (friendRequests)', async () => {
    await assertSucceeds(bob.collection('friendRequests').where('toId', '==', 'bob-uid').get());
  });
  await check('scoped query where fromId == me succeeds (friendRequests)', async () => {
    await assertSucceeds(alice.collection('friendRequests').where('fromId', '==', 'alice-uid').get());
  });

  await testEnv.cleanup();
  console.log(`\n${passed} checks passed.`);
}

main().catch((e) => { console.error('FAILED:', e); process.exit(1); });
