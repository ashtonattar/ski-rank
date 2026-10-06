// (C) Rollout step 8b, run ONCE right before the 8b client push: copy profile
// fields from state/global.players onto players/{id}.
//
// Why: from 8b, players/ is the only place the app reads profiles from, and
// state/global.players is no longer written. Until then the array was the
// newer copy:
//   - acceptFriendRequest()/unfriend() edited the OTHER player's `friends`
//     only in the array (a client may only write its own players/ doc), and
//   - _mirrorMyPlayer() only ran after a successful array save, and is denied
//     outright for an account whose doc it can't write.
// So for every profile field the array value wins. lastRead is merged per
// friend (newest timestamp), so nothing read is marked unread again.
//
// Never touched: server-owned stats (the Cloud Functions own them), the
// identity field firebaseUid, the avatarUrl cache, and fields that exist only
// on the doc. Never creates or deletes a doc: an array entry with no doc is
// only reported (accounts deleted before the 2026-10-01 fix).
//
// Dry run (read-only, the default):
//   GCLOUD_PROJECT=skirank-b3b70 node scripts/reconcile-profiles-step8.mjs --prod
// Apply (writes prod):
//   RECONCILE_CONFIRM_PROD=yes-i-am-sure GCLOUD_PROJECT=skirank-b3b70 node scripts/reconcile-profiles-step8.mjs --prod --apply

import { pathToFileURL } from 'url';

export const SKIP_FIELDS = new Set([
  'id', 'rating', 'wins', 'losses', 'gamesPlayed', 'peakRating', 'logStrikes', 'badges',
  'firebaseUid', 'avatarUrl'
]);
// Order doesn't matter for these: compared sorted so a reorder isn't a diff.
const SET_FIELDS = new Set(['friends', 'following']);

function stable(v) {
  if (Array.isArray(v)) return v.map(stable);
  if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().map((k) => [k, stable(v[k])]));
  return v;
}
function same(field, a, b) {
  const n = (v) => {
    if (v === undefined || v === null) return 'null';
    if (SET_FIELDS.has(field) && Array.isArray(v)) return JSON.stringify([...v].sort());
    return JSON.stringify(stable(v));
  };
  return n(a) === n(b);
}

function mergeLastRead(arr, doc) {
  const out = { ...(doc || {}) };
  Object.entries(arr || {}).forEach(([k, ts]) => { if (!(out[k] >= ts)) out[k] = ts; });
  return out;
}

// Pure: what to write. arrayPlayers = state/global.players, docs = Map id → doc data.
export function planReconcile(arrayPlayers, docs) {
  const updates = [];   // { id, name, fields: {field: value}, changed: [field] }
  const noDoc = [];     // array entries with no players/ doc (reported only)
  for (const p of arrayPlayers || []) {
    if (!p || typeof p.id !== 'string' || !p.id) continue;
    const d = docs.get(p.id);
    if (!d) { noDoc.push({ id: p.id, name: p.name }); continue; }
    const fields = {};
    for (const [k, v] of Object.entries(p)) {
      if (SKIP_FIELDS.has(k) || v === undefined) continue;
      const want = k === 'lastRead' ? mergeLastRead(v, d.lastRead) : v;
      if (!same(k, want, d[k])) fields[k] = want;
    }
    if (Object.keys(fields).length) updates.push({ id: p.id, name: p.name, fields, changed: Object.keys(fields).sort() });
  }
  return { updates, noDoc };
}

export function printPlan({ updates, noDoc }, docs) {
  console.log(`Profiles to update: ${updates.length}`);
  for (const u of updates) {
    console.log(`  ${u.name || '?'} (${u.id}): ${u.changed.join(', ')}`);
    if (u.fields.friends) {
      const before = [...((docs.get(u.id) || {}).friends || [])].sort();
      console.log(`    friends: doc ${JSON.stringify(before)} -> ${JSON.stringify([...u.fields.friends].sort())}`);
    }
  }
  if (noDoc.length) {
    console.log(`\nArray entries with NO players/ doc (not created; likely accounts deleted before the 2026-10-01 fix): ${noDoc.length}`);
    noDoc.forEach((n) => console.log(`  ${n.name || '?'} (${n.id})`));
  }
}

async function main() {
  const { initializeApp } = await import('firebase-admin/app');
  const { getFirestore } = await import('firebase-admin/firestore');
  const emulatorHost = process.env.FIRESTORE_EMULATOR_HOST;
  const allowProd = process.argv.includes('--prod');
  const apply = process.argv.includes('--apply');

  if (!emulatorHost && !allowProd) {
    console.error('Refusing to run: pass --prod with GCLOUD_PROJECT set, or set FIRESTORE_EMULATOR_HOST.');
    process.exit(1);
  }
  if (emulatorHost && allowProd) {
    console.error(`Refusing to run: --prod was passed but FIRESTORE_EMULATOR_HOST is set (${emulatorHost}), which is contradictory intent.`);
    process.exit(1);
  }
  if (allowProd) {
    const projectId = process.env.GCLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT;
    if (!projectId) {
      console.error('Set GCLOUD_PROJECT explicitly when running with --prod. Refusing to guess a project id.');
      process.exit(1);
    }
    if (apply && process.env.RECONCILE_CONFIRM_PROD !== 'yes-i-am-sure') {
      console.error('Refusing to write production: --apply with --prod also needs RECONCILE_CONFIRM_PROD=yes-i-am-sure.');
      process.exit(1);
    }
    console.warn(`${apply ? 'WRITING TO' : 'Dry run against'} REAL project "${projectId}".\n`);
    initializeApp({ projectId });
  } else {
    initializeApp({ projectId: process.env.GCLOUD_PROJECT || 'demo-reconcile' });
  }

  const db = getFirestore();
  const state = (await db.doc('state/global').get()).data() || {};
  const docs = new Map((await db.collection('players').get()).docs.map((d) => [d.id, d.data()]));
  const plan = planReconcile(state.players, docs);
  printPlan(plan, docs);

  if (!apply) {
    console.log(plan.updates.length ? '\nDry run: nothing written. Re-run with --apply to write.' : '\nNothing to do.');
    return;
  }
  const batch = db.batch();
  plan.updates.forEach((u) => batch.update(db.collection('players').doc(u.id), u.fields));
  if (plan.updates.length) await batch.commit();
  console.log(`\nWrote ${plan.updates.length} profile(s).`);
  const after = new Map((await db.collection('players').get()).docs.map((d) => [d.id, d.data()]));
  const left = planReconcile(state.players, after).updates.length;
  console.log(left ? `VERIFY FAILED: ${left} profile(s) still differ.` : 'Verified: every profile now matches the array.');
  if (left) process.exit(1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => { console.error(err); process.exit(1); });
}
