// (C) Emulator rules test for UI refinement 21 (2026-11-13): iMessage-style
// message likes, replies and unsend.
//   - either participant may add/remove ONLY their own id in likedBy
//   - text and every other field stay immutable; strangers can't like
//   - a reply is just a new message carrying replyTo (create rule unchanged)
//   - only the sender (or admin) may delete; legacy ids work via callerIsPlayer()
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
  const testEnv = await initializeTestEnvironment({ projectId: 'demo-test-ui21', firestore: { rules } });

  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    await db.doc('players/bob-uid').set({ id: 'bob-uid', name: 'Bob' });
    await db.doc('players/legacy-old-id').set({ id: 'legacy-old-id', name: 'Legacy Lee', firebaseUid: 'legacy-real-uid' });
    await db.doc('messages/m1').set({ id: 'm1', fromId: 'bob-uid', toId: 'legacy-old-id', text: 'hi', date: 1 });
    await db.doc('messages/m2').set({ id: 'm2', fromId: 'legacy-old-id', toId: 'bob-uid', text: 'yo', date: 2 });
    await db.doc('messages/m3').set({ id: 'm3', fromId: 'bob-uid', toId: 'legacy-old-id', text: 'liked', date: 3, likedBy: ['legacy-old-id'] });
  });

  const bob = testEnv.authenticatedContext('bob-uid').firestore();
  const legacy = testEnv.authenticatedContext('legacy-real-uid').firestore();
  const eve = testEnv.authenticatedContext('eve-uid').firestore();
  const admin = testEnv.authenticatedContext('admin-uid', { email: 'ashtonattar@gmail.com' }).firestore();

  // ── likes ──
  await check('recipient (legacy id) can like a message', async () => {
    await assertSucceeds(legacy.doc('messages/m1').update({ likedBy: ['legacy-old-id'] }));
  });
  await check('sender can like their own message too', async () => {
    await assertSucceeds(bob.doc('messages/m1').update({ likedBy: ['legacy-old-id', 'bob-uid'] }));
  });
  await check('recipient can unlike', async () => {
    await assertSucceeds(legacy.doc('messages/m3').update({ likedBy: [] }));
  });
  await check("you can't add someone else's like", async () => {
    await assertFails(bob.doc('messages/m2').update({ likedBy: ['legacy-old-id'] }));
  });
  await check("you can't remove someone else's like", async () => {
    await assertFails(bob.doc('messages/m1').update({ likedBy: ['bob-uid'] }));
  });
  await check('a stranger cannot like', async () => {
    await assertFails(eve.doc('messages/m2').update({ likedBy: ['eve-uid'] }));
  });
  await check('text is still immutable, alone or alongside a like', async () => {
    await assertFails(bob.doc('messages/m2').update({ text: 'edited' }));
    await assertFails(bob.doc('messages/m2').update({ likedBy: ['bob-uid'], text: 'edited' }));
  });
  await check('likedBy must be a list', async () => {
    await assertFails(bob.doc('messages/m2').update({ likedBy: 'bob-uid' }));
  });

  // ── replies ──
  await check('a reply is a normal create with replyTo', async () => {
    await assertSucceeds(bob.doc('messages/m4').set({
      id: 'm4', fromId: 'bob-uid', toId: 'legacy-old-id', text: 'same', date: 4,
      replyTo: { id: 'm2', fromId: 'legacy-old-id', text: 'yo' }
    }));
  });

  // ── unsend ──
  await check('recipient cannot delete the sender\'s message', async () => {
    await assertFails(bob.doc('messages/m2').delete());
  });
  await check('a stranger cannot delete', async () => {
    await assertFails(eve.doc('messages/m1').delete());
  });
  await check('legacy sender can delete their own message', async () => {
    await assertSucceeds(legacy.doc('messages/m2').delete());
  });
  await check('native sender can delete their own message', async () => {
    await assertSucceeds(bob.doc('messages/m4').delete());
  });
  await check('admin can still bulk-delete', async () => {
    await assertSucceeds(admin.doc('messages/m3').delete());
  });

  console.log(`\n${passed} checks passed.\n`);
  await testEnv.cleanup();
}

main().catch((e) => { console.error(e); process.exit(1); });
