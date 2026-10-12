// (C) Emulator rules test: side track A (2026-10-12).
// uploadQuotas/{playerId} and uploadQuotaTotals/{day} are the signClipUpload
// callable's daily counters. Only the Admin SDK touches them: no client, not
// even the player the counter belongs to or the admin, may read or write.
//
// Run: npm run test:rules

import { initializeTestEnvironment, assertFails } from '@firebase/rules-unit-testing';
import { readFileSync } from 'fs';

const rules = readFileSync('firestore.rules', 'utf8');

let passed = 0;
async function check(name, fn) {
  await fn();
  passed++;
  console.log(`  ok - ${name}`);
}

async function main() {
  const testEnv = await initializeTestEnvironment({ projectId: 'demo-test-sidea', firestore: { rules } });
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    const d = ctx.firestore();
    await d.doc('players/bob-uid').set({ name: 'Bob', rating: 450 });
    await d.doc('uploadQuotas/bob-uid').set({ day: '2026-10-12', count: 10 });
    await d.doc('uploadQuotaTotals/2026-10-12').set({ count: 150 });
  });

  const bob = testEnv.authenticatedContext('bob-uid').firestore();
  const admin = testEnv.authenticatedContext('admin-uid', { email: 'ashtonattar@gmail.com' }).firestore();
  const anon = testEnv.unauthenticatedContext().firestore();

  for (const [who, f] of [['owner', bob], ['admin', admin], ['signed-out', anon]]) {
    await check(`${who}: cannot read their uploadQuotas doc`, () => assertFails(f.doc('uploadQuotas/bob-uid').get()));
    await check(`${who}: cannot reset uploadQuotas`, () =>
      assertFails(f.doc('uploadQuotas/bob-uid').set({ day: '2026-10-12', count: 0 })));
    await check(`${who}: cannot delete uploadQuotas`, () => assertFails(f.doc('uploadQuotas/bob-uid').delete()));
    await check(`${who}: cannot list uploadQuotas`, () => assertFails(f.collection('uploadQuotas').get()));
    await check(`${who}: cannot read uploadQuotaTotals`, () =>
      assertFails(f.doc('uploadQuotaTotals/2026-10-12').get()));
    await check(`${who}: cannot reset uploadQuotaTotals`, () =>
      assertFails(f.doc('uploadQuotaTotals/2026-10-12').set({ count: 0 })));
    await check(`${who}: cannot create a future day's total`, () =>
      assertFails(f.doc('uploadQuotaTotals/2026-10-13').set({ count: 0 })));
  }

  await testEnv.cleanup();
  console.log(`\nside track A rules: ${passed}/${passed} passed`);
}

main().catch((e) => { console.error(e); process.exit(1); });
