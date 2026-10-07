// (C) Emulator rules test: rollout step 8c (2026-10-07).
// state/global: a non-admin write may not change players/games/messages/
// friendRequests (the arrays are frozen there until step 9), but every write
// index.html still sends to that doc after 8b must keep working.
// players/: `friends` is server-only (the step-8a callables own it).
//
// Run: npm run test:rules

import { initializeTestEnvironment, assertFails, assertSucceeds } from '@firebase/rules-unit-testing';
import { readFileSync } from 'fs';
import firebase from 'firebase/compat/app';

const rules = readFileSync('firestore.rules', 'utf8');
const { arrayUnion, arrayRemove } = firebase.firestore.FieldValue;

let passed = 0;
async function check(name, fn) {
  await fn();
  passed++;
  console.log(`  ok - ${name}`);
}

const frozen = {
  players: [{ id: 'bob-uid', name: 'Bob', rating: 450 }, { id: 'legacy-1', name: 'Legacy', rating: 612 }],
  games: [{ id: 'g1', winnerId: 'bob-uid', loserId: 'legacy-1' }],
  messages: [{ id: 'm1', fromId: 'bob-uid', toId: 'legacy-1', text: 'hi' }],
  friendRequests: [{ id: 'fr1', fromId: 'bob-uid', toId: 'legacy-1', status: 'pending' }],
};

function seedGlobal() {
  return {
    ...JSON.parse(JSON.stringify(frozen)),
    tournaments: [], challenges: [{ id: 'c1', fromId: 'bob-uid', toId: 'carol-uid' }],
    liveInvites: [], pending: [], reports: [], comments: {}, likes: {}, commentLikes: {},
  };
}

async function main() {
  const testEnv = await initializeTestEnvironment({ projectId: 'demo-test-8c', firestore: { rules } });
  const reseed = () => testEnv.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    await db.doc('state/global').set(seedGlobal());
    await db.doc('players/legacy-1').set({ id: 'legacy-1', firebaseUid: 'legacy-auth-1', name: 'Legacy', friends: ['bob-uid'] });
    await db.doc('players/bob-uid').set({ id: 'bob-uid', name: 'Bob', friends: ['legacy-1'] });
  });
  await reseed();

  const as = (uid, email) => testEnv.authenticatedContext(uid, email ? { email } : {}).firestore();
  const bob = as('bob-uid');
  const legacy = as('legacy-auth-1');
  const admin = as('admin-uid', 'ashtonattar@gmail.com');
  const anon = testEnv.unauthenticatedContext().firestore();
  const g = (db) => db.doc('state/global');

  // ── state/global: what index.html still writes after 8b must pass ──
  await check('8b save() shape (no migrated keys, merge:true) succeeds', async () => {
    await assertSucceeds(g(bob).set({ tournaments: [{ id: 't1', status: 'setup', rounds: '[]', matches: '[]' }], explore: [] }, { merge: true }));
  });
  await check('legacy account: same save succeeds', async () => {
    await assertSucceeds(g(legacy).set({ tournaments: [] }, { merge: true }));
  });
  await check('merge that re-sends the frozen arrays unchanged is allowed (no affected keys)', async () => {
    await assertSucceeds(g(bob).set({ players: frozen.players, games: frozen.games }, { merge: true }));
  });
  await check('challenges/pending/liveInvites arrayUnion succeed', async () => {
    await assertSucceeds(g(bob).update({ challenges: arrayUnion({ id: 'c2', fromId: 'bob-uid', toId: 'x' }) }));
    await assertSucceeds(g(bob).update({ pending: arrayUnion({ id: 'p1', winnerId: 'bob-uid', loserId: 'x' }) }));
    await assertSucceeds(g(bob).update({ pending: arrayRemove({ id: 'p1', winnerId: 'bob-uid', loserId: 'x' }) }));
  });
  await check('comments/likes/commentLikes dot-path updates succeed', async () => {
    await assertSucceeds(g(bob).update({ 'comments.clip1': arrayUnion({ id: 'k1', text: 'sick' }) }));
    await assertSucceeds(g(bob).update({ 'likes.clip1': arrayUnion('bob-uid') }));
    await assertSucceeds(g(bob).update({ 'commentLikes.k1': arrayUnion('bob-uid') }));
  });
  await check('_updateArrayField-style transaction on liveInvites succeeds', async () => {
    const ref = g(bob);
    await assertSucceeds(bob.runTransaction(async (tx) => {
      const d = (await tx.get(ref)).data();
      tx.update(ref, { liveInvites: [...(d.liveInvites || []), { id: 'li1', fromId: 'bob-uid', toId: 'x', status: 'accepted' }] });
    }));
  });
  await check('_purgeGlobalFor transaction (challenges/liveInvites/pending) succeeds', async () => {
    const ref = g(bob);
    await assertSucceeds(bob.runTransaction(async (tx) => {
      const d = (await tx.get(ref)).data();
      tx.update(ref, {
        challenges: d.challenges.filter((r) => r.fromId !== 'bob-uid' && r.toId !== 'bob-uid'),
        liveInvites: [], pending: [],
      });
    }));
  });
  await check('own report append succeeds, forged reporterId still fails', async () => {
    await assertSucceeds(g(bob).update({ reports: arrayUnion({ id: 'r1', reporterId: 'bob-uid' }) }));
    await assertFails(g(bob).update({ reports: arrayUnion({ id: 'r2', reporterId: 'carol-uid' }) }));
  });

  // ── state/global: changing a migrated key is refused for non-admins ──
  for (const key of ['players', 'games', 'messages', 'friendRequests']) {
    await check(`${key}: arrayUnion refused`, async () => {
      await assertFails(g(bob).update({ [key]: arrayUnion({ id: 'new', fromId: 'bob-uid' }) }));
    });
    await check(`${key}: merge with a modified array refused`, async () => {
      const changed = JSON.parse(JSON.stringify(frozen[key]));
      changed[0].tampered = true;
      await assertFails(g(bob).set({ [key]: changed }, { merge: true }));
    });
    await check(`${key}: emptying it refused`, async () => {
      await assertFails(g(legacy).update({ [key]: [] }));
    });
  }
  await check('self rating inflation through the players array refused (old KNOWN GAP)', async () => {
    const inflated = frozen.players.map((p) => (p.id === 'bob-uid' ? { ...p, rating: 3000 } : p));
    await assertFails(g(bob).set({ players: inflated }, { merge: true }));
  });
  await check('a save that changes an allowed key AND a migrated one is refused as a whole', async () => {
    await assertFails(g(bob).set({ tournaments: [], games: [] }, { merge: true }));
  });
  await check('a full set() without merge (drops the frozen arrays) refused', async () => {
    await assertFails(g(bob).set({ tournaments: [] }));
  });
  await check('signed-out write refused', async () => {
    await assertFails(g(anon).set({ tournaments: [] }, { merge: true }));
  });
  await check('non-admin delete refused', async () => {
    await assertFails(g(bob).delete());
  });

  // ── state/global: admin ──
  await check('admin: wipe tool set(empty) succeeds', async () => {
    await assertSucceeds(g(admin).set({ players: [], games: [], pending: [], liveInvites: [], live: null, messages: [], friendRequests: [] }));
  });
  await check('admin: can change a migrated key', async () => {
    await assertSucceeds(g(admin).update({ players: arrayUnion({ id: 'seed' }) }));
  });

  // ── state/global: doc missing (create) ──
  await testEnv.withSecurityRulesDisabled(async (ctx) => { await ctx.firestore().doc('state/global').delete(); });
  await check('create without migrated keys succeeds', async () => {
    await assertSucceeds(g(bob).set({ tournaments: [] }, { merge: true }));
  });
  await testEnv.withSecurityRulesDisabled(async (ctx) => { await ctx.firestore().doc('state/global').delete(); });
  await check('create carrying a migrated key refused', async () => {
    await assertFails(g(bob).set({ tournaments: [], players: [] }, { merge: true }));
  });
  await reseed();

  // ── players/: friends is server-only ──
  await check('native owner: adding a friend directly refused', async () => {
    await assertFails(bob.doc('players/bob-uid').update({ friends: arrayUnion('carol-uid') }));
  });
  await check('native owner: removing a friend directly refused', async () => {
    await assertFails(bob.doc('players/bob-uid').set({ friends: [] }, { merge: true }));
  });
  await check('legacy owner: friends write refused', async () => {
    await assertFails(legacy.doc('players/legacy-1').set({ friends: ['bob-uid', 'carol-uid'] }, { merge: true }));
  });
  await check('owner profile mirror without friends still succeeds (8b _mirrorMyPlayer shape)', async () => {
    await assertSucceeds(bob.doc('players/bob-uid').set({ id: 'bob-uid', name: 'Bobby', bio: 'x', following: [] }, { merge: true }));
    await assertSucceeds(legacy.doc('players/legacy-1').set({ id: 'legacy-1', name: 'Legacy 2', lastRead: { 'bob-uid': 5 } }, { merge: true }));
  });
  await check('owner merge re-sending friends unchanged is allowed', async () => {
    await assertSucceeds(bob.doc('players/bob-uid').set({ name: 'Bobby', friends: ['legacy-1'] }, { merge: true }));
  });
  await check('create: friends absent or [] allowed, pre-seeded friends refused', async () => {
    await assertSucceeds(as('new-1').doc('players/new-1').set({ id: 'new-1', name: 'N1' }));
    await assertSucceeds(as('new-2').doc('players/new-2').set({ id: 'new-2', name: 'N2', friends: [] }));
    await assertFails(as('new-3').doc('players/new-3').set({ id: 'new-3', name: 'N3', friends: ['bob-uid'] }));
  });
  await check('admin: friends write allowed', async () => {
    await assertSucceeds(admin.doc('players/bob-uid').update({ friends: arrayUnion('carol-uid') }));
  });

  console.log(`\n${passed} checks passed.\n`);
  await testEnv.cleanup();
}

main().catch((e) => { console.error(e); process.exit(1); });
