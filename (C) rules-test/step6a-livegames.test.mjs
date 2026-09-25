// (C) Emulator rules test: liveGames update rule for legacy accounts
// (2026-09-25). The rule used to compare request.auth.uid to p1/p2/judgeId,
// which hold PLAYER ids, so a legacy participant (player id != auth uid) had
// every saveLiveGame() update denied. Now uses callerIsPlayer().
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
  const testEnv = await initializeTestEnvironment({ projectId: 'demo-test-6a-lg', firestore: { rules } });

  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    await db.doc('players/bob-uid').set({ id: 'bob-uid' });
    for (const n of ['1', '2', '3', 'j', 'x']) {
      await db.doc(`players/legacy-${n}`).set({ id: `legacy-${n}`, firebaseUid: `legacy-auth-${n}` });
    }
    await db.doc('liveGames/lg1').set({ id: 'lg1', p1: 'bob-uid', p2: 'legacy-1', judgeId: null, rev: 1 });
    await db.doc('liveGames/lg-judge').set({ id: 'lg-judge', p1: 'bob-uid', p2: 'legacy-1', judgeId: 'legacy-j', rev: 1 });
    await db.doc('liveGames/lg-nojudge').set({ id: 'lg-nojudge', p1: 'bob-uid', p2: 'legacy-1', rev: 1 });
    await db.doc('liveGames/lg-all-legacy').set({ id: 'lg-all-legacy', p1: 'legacy-1', p2: 'legacy-2', judgeId: 'legacy-3', rev: 1 });
  });

  const as = (uid) => testEnv.authenticatedContext(uid).firestore();
  const setLive = (db, id, extra) => db.doc(`liveGames/${id}`).set({ id, ...extra });

  await check('legacy participant (p2) can update via saveLiveGame-style set()', async () => {
    await assertSucceeds(setLive(as('legacy-auth-1'), 'lg1', { p1: 'bob-uid', p2: 'legacy-1', judgeId: null, rev: 2 }));
  });
  await check('native participant (p1) is still allowed', async () => {
    await assertSucceeds(setLive(as('bob-uid'), 'lg1', { p1: 'bob-uid', p2: 'legacy-1', judgeId: null, rev: 3 }));
  });
  await check('legacy judge can update', async () => {
    await assertSucceeds(setLive(as('legacy-auth-j'), 'lg-judge', { p1: 'bob-uid', p2: 'legacy-1', judgeId: 'legacy-j', rev: 2 }));
  });
  await check('legacy participant can update a doc with no judgeId field at all', async () => {
    await assertSucceeds(setLive(as('legacy-auth-1'), 'lg-nojudge', { p1: 'bob-uid', p2: 'legacy-1', rev: 2 }));
  });
  await check('native outsider is denied', async () => {
    await assertFails(setLive(as('eve-uid'), 'lg1', { p1: 'bob-uid', p2: 'legacy-1', judgeId: null, rev: 9 }));
  });
  await check('legacy-shaped outsider (own players doc with firebaseUid, in no seat) is denied', async () => {
    await assertFails(setLive(as('legacy-auth-x'), 'lg1', { p1: 'bob-uid', p2: 'legacy-1', judgeId: null, rev: 9 }));
  });
  await check('legacy-shaped outsider is denied on a no-judge doc too', async () => {
    await assertFails(setLive(as('legacy-auth-x'), 'lg-nojudge', { p1: 'bob-uid', p2: 'legacy-1', rev: 9 }));
  });
  // get/exists budget: all three seats legacy, caller is the LAST seat
  // checked (judge), so every callerIsPlayer() call runs its exists()+get()
  // on three distinct players docs.
  await check('get/exists budget: all-legacy seats, judge caller (worst case) is evaluated and allowed', async () => {
    await assertSucceeds(setLive(as('legacy-auth-3'), 'lg-all-legacy', { p1: 'legacy-1', p2: 'legacy-2', judgeId: 'legacy-3', rev: 2 }));
  });
  await check('get/exists budget: all-legacy seats, outsider (every seat evaluated) is denied, not errored-open', async () => {
    await assertFails(setLive(as('legacy-auth-x'), 'lg-all-legacy', { p1: 'legacy-1', p2: 'legacy-2', judgeId: 'legacy-3', rev: 3 }));
  });

  console.log(`\n${passed} checks passed.\n`);
  await testEnv.cleanup();
}

main().catch((e) => { console.error(e); process.exit(1); });
