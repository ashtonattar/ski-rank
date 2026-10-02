// (C) Emulator rules test: rollout step 7 read cutover (2026-10-01).
// The client replaces the state/global arrays with two scoped listeners per
// participant-only collection: where('fromId','==',me) and
// where('toId','==',me). These must work for a native account (player id ==
// auth uid) AND a legacy one (player id != auth uid, linked through
// players/{id}.firebaseUid), and must still be refused for anyone else.
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
  const testEnv = await initializeTestEnvironment({ projectId: 'demo-test-7', firestore: { rules } });

  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    await db.doc('players/legacy-1').set({ id: 'legacy-1', firebaseUid: 'legacy-auth-1', name: 'Legacy' });
    await db.doc('players/legacy-2').set({ id: 'legacy-2', firebaseUid: 'legacy-auth-2', name: 'Legacy Two' });
    await db.doc('players/bob-uid').set({ id: 'bob-uid', name: 'Bob' });
    await db.doc('players/carol-uid').set({ id: 'carol-uid', name: 'Carol' });
    for (const coll of ['messages', 'friendRequests']) {
      await db.doc(`${coll}/${coll}-lb`).set({ id: `${coll}-lb`, fromId: 'legacy-1', toId: 'bob-uid', status: 'pending', text: 'a', date: 1 });
      await db.doc(`${coll}/${coll}-bl`).set({ id: `${coll}-bl`, fromId: 'bob-uid', toId: 'legacy-1', status: 'accepted', text: 'b', date: 2 });
      await db.doc(`${coll}/${coll}-cl2`).set({ id: `${coll}-cl2`, fromId: 'carol-uid', toId: 'legacy-2', status: 'pending', text: 'c', date: 3 });
    }
  });

  const as = (uid, email) => testEnv.authenticatedContext(uid, email ? { email } : {}).firestore();
  const legacy = as('legacy-auth-1');
  const legacyOutsider = as('legacy-auth-2');
  const bob = as('bob-uid');
  const carol = as('carol-uid');
  const anon = testEnv.unauthenticatedContext().firestore();
  const admin = as('admin-uid', 'ashtonattar@gmail.com');

  for (const coll of ['messages', 'friendRequests']) {
    const sent = (db, me) => db.collection(coll).where('fromId', '==', me).get();
    const recv = (db, me) => db.collection(coll).where('toId', '==', me).get();

    await check(`${coll}: legacy account's fromId query succeeds and returns its doc`, async () => {
      const snap = await assertSucceeds(sent(legacy, 'legacy-1'));
      if (snap.size !== 1) throw new Error(`expected 1, got ${snap.size}`);
    });
    await check(`${coll}: legacy account's toId query succeeds and returns its doc`, async () => {
      const snap = await assertSucceeds(recv(legacy, 'legacy-1'));
      if (snap.size !== 1) throw new Error(`expected 1, got ${snap.size}`);
    });
    await check(`${coll}: native account's fromId/toId queries succeed`, async () => {
      const a = await assertSucceeds(sent(bob, 'bob-uid'));
      const b = await assertSucceeds(recv(bob, 'bob-uid'));
      if (a.size !== 1 || b.size !== 1) throw new Error(`expected 1/1, got ${a.size}/${b.size}`);
    });
    await check(`${coll}: a different legacy account can't query someone else's id`, async () => {
      await assertFails(sent(legacyOutsider, 'legacy-1'));
      await assertFails(recv(legacyOutsider, 'legacy-1'));
    });
    await check(`${coll}: a native outsider can't query someone else's id`, async () => {
      await assertFails(sent(carol, 'bob-uid'));
      await assertFails(recv(carol, 'legacy-1'));
    });
    await check(`${coll}: an unfiltered collection query is still refused for a non-admin`, async () => {
      await assertFails(legacy.collection(coll).get());
      await assertFails(bob.collection(coll).get());
    });
    await check(`${coll}: signed-out reads are refused`, async () => {
      await assertFails(sent(anon, 'legacy-1'));
      await assertFails(anon.doc(`${coll}/${coll}-lb`).get());
    });
    await check(`${coll}: single-doc get: legacy participant allowed, legacy outsider denied`, async () => {
      await assertSucceeds(legacy.doc(`${coll}/${coll}-bl`).get());
      await assertFails(legacyOutsider.doc(`${coll}/${coll}-bl`).get());
      await assertSucceeds(legacyOutsider.doc(`${coll}/${coll}-cl2`).get());
    });
    await check(`${coll}: admin can still read the whole collection`, async () => {
      await assertSucceeds(admin.collection(coll).get());
    });
  }

  await check('players and games stay publicly readable (single listener shape)', async () => {
    await assertSucceeds(anon.collection('players').get());
    await assertSucceeds(anon.collection('games').get());
  });

  await testEnv.cleanup();
  console.log(`step7 rules: ${passed}/${passed} passed`);
}

main().catch((e) => { console.error(e); process.exit(1); });
