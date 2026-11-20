// (C) Emulator rules test for P1 owned channels (beta scope, 2026-11-20):
//   - usersPrivate: the owner may flip only emailOptIn/emailOptInAt; birthYear
//     stays admin-only once written; signup create still works with the opt-in
//   - config/banner: anyone (even signed out) reads it, only admin writes it
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
  const testEnv = await initializeTestEnvironment({ projectId: 'demo-test-p1', firestore: { rules } });

  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    await db.doc('usersPrivate/bob-uid').set({ birthYear: 2010, emailOptIn: false, emailOptInAt: null });
    await db.doc('config/banner').set({ active: true, text: 'Park night Fri', link: '' });
  });

  const bob = testEnv.authenticatedContext('bob-uid').firestore();
  const eve = testEnv.authenticatedContext('eve-uid').firestore();
  const admin = testEnv.authenticatedContext('admin-uid', { email: 'ashtonattar@gmail.com' }).firestore();
  const anon = testEnv.unauthenticatedContext().firestore();

  // ── usersPrivate ──
  await check('signup create carries the opt-in', async () => {
    await assertSucceeds(eve.doc('usersPrivate/eve-uid').set({ birthYear: 2009, emailOptIn: true, emailOptInAt: 1 }));
  });
  await check('owner can opt in and out (merge set)', async () => {
    await assertSucceeds(bob.doc('usersPrivate/bob-uid').set({ emailOptIn: true, emailOptInAt: 5 }, { merge: true }));
    await assertSucceeds(bob.doc('usersPrivate/bob-uid').set({ emailOptIn: false, emailOptInAt: null }, { merge: true }));
  });
  await check('owner still cannot change birthYear', async () => {
    await assertFails(bob.doc('usersPrivate/bob-uid').update({ birthYear: 2000 }));
    await assertFails(bob.doc('usersPrivate/bob-uid').update({ birthYear: 2000, emailOptIn: true }));
  });
  await check('emailOptIn must be a bool', async () => {
    await assertFails(bob.doc('usersPrivate/bob-uid').update({ emailOptIn: 'yes' }));
  });
  await check("nobody else can flip someone's opt-in", async () => {
    await assertFails(eve.doc('usersPrivate/bob-uid').update({ emailOptIn: true }));
    await assertFails(eve.doc('usersPrivate/bob-uid').get());
  });
  await check('admin can still update', async () => {
    await assertSucceeds(admin.doc('usersPrivate/bob-uid').update({ birthYear: 2011 }));
  });

  // ── config/banner ──
  await check('anyone can read the banner, even signed out', async () => {
    await assertSucceeds(anon.doc('config/banner').get());
    await assertSucceeds(bob.doc('config/banner').get());
  });
  await check('only admin can write it', async () => {
    await assertFails(bob.doc('config/banner').set({ active: true, text: 'hacked' }));
    await assertFails(anon.doc('config/banner').set({ active: true, text: 'hacked' }));
    await assertSucceeds(admin.doc('config/banner').set({ active: false, text: '' }));
  });

  await testEnv.cleanup();
  console.log(`p1: ${passed} checks passed`);
}

main().catch(e => { console.error(e); process.exit(1); });
