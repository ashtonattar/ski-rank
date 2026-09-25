// (C) Emulator rules test for Backend Migration Plan, rollout step 6a
// (2026-09-24): forgery gate + legacy-safe social rules.
//   - legacy accounts (player id != auth uid) can create messages and
//     friend requests and accept them, via callerIsPlayer()
//   - unfriend(): either party may delete a settled request, only the
//     sender may delete a pending one
//   - logStrikes/badges are locked on players/{id}
//   - pendingResults is function-only for writes, participant-only for reads
//   - liveGames/{id}/joins/{authUid}: only your own join, nothing else in it
// Plus two REPORT-ONLY probes (printed, not asserted): the suspected
// pre-existing legacy liveGames update bug, and the self-heal create shape.
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
async function probe(name, promise) {
  try { await promise; console.log(`  PROBE - ${name}: ALLOWED`); }
  catch (e) { console.log(`  PROBE - ${name}: DENIED (${e.code || e.message})`); }
}

async function main() {
  const testEnv = await initializeTestEnvironment({ projectId: 'demo-test-6a', firestore: { rules } });

  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    await db.doc('players/bob-uid').set({ id: 'bob-uid', name: 'Bob', rating: 400, logStrikes: 2, badges: ['first_game'] });
    await db.doc('players/legacy-old-id').set({ id: 'legacy-old-id', name: 'Legacy Lee', firebaseUid: 'legacy-real-uid', rating: 400 });
    await db.doc('friendRequests/fr-pending').set({ id: 'fr-pending', fromId: 'bob-uid', toId: 'legacy-old-id', status: 'pending' });
    await db.doc('friendRequests/fr-accepted').set({ id: 'fr-accepted', fromId: 'bob-uid', toId: 'legacy-old-id', status: 'accepted' });
    await db.doc('friendRequests/fr-accepted2').set({ id: 'fr-accepted2', fromId: 'legacy-old-id', toId: 'bob-uid', status: 'accepted' });
    await db.doc('pendingResults/pr1').set({ reporterId: 'bob-uid', opponentId: 'legacy-old-id', winnerId: 'bob-uid', loserId: 'legacy-old-id' });
    await db.doc('liveGames/lg1').set({ id: 'lg1', p1: 'bob-uid', p2: 'legacy-old-id', judgeId: null });
  });

  const bob = testEnv.authenticatedContext('bob-uid').firestore();
  const legacy = testEnv.authenticatedContext('legacy-real-uid').firestore();
  const eve = testEnv.authenticatedContext('eve-uid').firestore();

  // ── legacy-safe social writes (finding 1) ──
  await check('legacy sender can create a message as their player id', async () => {
    await assertSucceeds(legacy.doc('messages/m1').set({ id: 'm1', fromId: 'legacy-old-id', toId: 'bob-uid', text: 'hi', date: 1 }));
  });
  await check('a stranger cannot send as the legacy player', async () => {
    await assertFails(eve.doc('messages/m2').set({ id: 'm2', fromId: 'legacy-old-id', toId: 'bob-uid', text: 'x', date: 1 }));
  });
  await check('a message from a nonexistent player id is rejected (no players doc to link)', async () => {
    await assertFails(eve.doc('messages/m3').set({ id: 'm3', fromId: 'ghost-id', toId: 'bob-uid', text: 'x', date: 1 }));
  });
  await check('native sender still works', async () => {
    await assertSucceeds(bob.doc('messages/m4').set({ id: 'm4', fromId: 'bob-uid', toId: 'legacy-old-id', text: 'yo', date: 1 }));
  });
  await check('legacy sender can create a friend request', async () => {
    await assertSucceeds(legacy.doc('friendRequests/fr-new').set({ id: 'fr-new', fromId: 'legacy-old-id', toId: 'bob-uid', status: 'pending' }));
  });
  await check('legacy recipient can accept a pending request', async () => {
    await assertSucceeds(legacy.doc('friendRequests/fr-pending').update({ status: 'accepted' }));
  });

  // ── unfriend delete (finding 2) ──
  await check('recipient can delete an ACCEPTED request (unfriend)', async () => {
    await assertSucceeds(legacy.doc('friendRequests/fr-accepted').delete());
  });
  await check('sender can delete an ACCEPTED request (unfriend)', async () => {
    await assertSucceeds(legacy.doc('friendRequests/fr-accepted2').delete());
  });
  await check('recipient cannot delete a PENDING request (only the sender can cancel)', async () => {
    await assertFails(bob.doc('friendRequests/fr-new').delete());
  });
  await check('legacy sender can cancel their own pending request', async () => {
    await assertSucceeds(legacy.doc('friendRequests/fr-new').delete());
  });
  await check('a stranger cannot delete a settled request', async () => {
    await testEnv.withSecurityRulesDisabled((ctx) => ctx.firestore().doc('friendRequests/fr-x').set({ fromId: 'bob-uid', toId: 'legacy-old-id', status: 'accepted' }));
    await assertFails(eve.doc('friendRequests/fr-x').delete());
  });

  // ── locked logStrikes/badges (finding 3) ──
  await check('owner cannot reset their own logStrikes', async () => {
    await assertFails(bob.doc('players/bob-uid').update({ logStrikes: 0 }));
  });
  await check('owner cannot grant themselves badges', async () => {
    await assertFails(bob.doc('players/bob-uid').update({ badges: ['first_game', 'legend'] }));
  });
  await check('owner can still edit a non-locked field', async () => {
    await assertSucceeds(bob.doc('players/bob-uid').update({ bio: 'hello' }));
  });
  await check('self-create with logStrikes > 0 rejected', async () => {
    await assertFails(eve.doc('players/eve-uid').set({ id: 'eve-uid', logStrikes: 1 }));
  });
  await check('self-create with non-empty badges rejected', async () => {
    await assertFails(eve.doc('players/eve-uid').set({ id: 'eve-uid', badges: ['legend'] }));
  });
  await check('self-create with badges: [] and no logStrikes allowed (signup/heal shape)', async () => {
    await assertSucceeds(eve.doc('players/eve-uid').set({ id: 'eve-uid', name: 'Eve', badges: [], friends: [] }));
  });

  // ── pendingResults ──
  await check('clients cannot create pendingResults', async () => {
    await assertFails(eve.doc('pendingResults/pr-forged').set({ reporterId: 'eve-uid', opponentId: 'eve-uid', winnerId: 'eve-uid', loserId: 'bob-uid' }));
  });
  await check('clients cannot edit pendingResults', async () => {
    await assertFails(bob.doc('pendingResults/pr1').update({ score: 'SK — SKI' }));
  });
  await check('reporter can read their pending result', async () => {
    await assertSucceeds(bob.doc('pendingResults/pr1').get());
  });
  await check('legacy opponent can read it', async () => {
    await assertSucceeds(legacy.doc('pendingResults/pr1').get());
  });
  await check('a stranger cannot read it', async () => {
    await assertFails(eve.doc('pendingResults/pr1').get());
  });

  // ── liveGames joins ──
  await check('a user can create their own join', async () => {
    await assertSucceeds(legacy.doc('liveGames/lg1/joins/legacy-real-uid').set({ joinedAt: 1 }));
  });
  await check('a user cannot create someone else\'s join', async () => {
    await assertFails(eve.doc('liveGames/lg1/joins/bob-uid').set({ joinedAt: 1 }));
  });
  await check('a join cannot carry extra fields', async () => {
    await assertFails(bob.doc('liveGames/lg1/joins/bob-uid').set({ joinedAt: 1, playerId: 'legacy-old-id' }));
  });
  await check('a join cannot be updated or deleted by a client', async () => {
    await assertFails(legacy.doc('liveGames/lg1/joins/legacy-real-uid').update({ joinedAt: 2 }));
    await assertFails(legacy.doc('liveGames/lg1/joins/legacy-real-uid').delete());
  });

  console.log(`\n${passed} checks passed.\n`);

  // ── Report-only probes (not asserted) ──
  console.log('Report-only probes:');
  await probe('legacy participant (p2 = legacy-old-id) updates their live game via saveLiveGame-style set()',
    legacy.doc('liveGames/lg1').set({ id: 'lg1', p1: 'bob-uid', p2: 'legacy-old-id', judgeId: null, rev: 2 }));
  await probe('native participant (p1 = bob-uid) updates the same live game',
    bob.doc('liveGames/lg1').set({ id: 'lg1', p1: 'bob-uid', p2: 'legacy-old-id', judgeId: null, rev: 3 }));
  await probe('self-heal create with rating: null (index.html ~4310 healedPlayer shape)',
    testEnv.authenticatedContext('heal-uid').firestore().doc('players/heal-uid').set({
      id: 'heal-uid', name: 'Heal', rating: null, wins: 0, losses: 0, gamesPlayed: 0, badges: [], friends: [], following: []
    }));

  await testEnv.cleanup();
}

main().catch((e) => { console.error(e); process.exit(1); });
