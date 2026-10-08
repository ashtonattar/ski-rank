// (C) End-to-end test for drop-global-arrays-step9.mjs against the Firestore
// emulator: runs the real script as a subprocess, the way it runs on prod.
//
// Run: npm run test:drop (wraps this in `firebase emulators:exec`).

import { execFile } from 'child_process';
import { promisify } from 'util';
import { writeFileSync, mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { makeBackup } from './drop-global-arrays-step9.fixtures.mjs';
import { canon } from './drop-global-arrays-step9.mjs';

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(__dirname, 'drop-global-arrays-step9.mjs');
const PROJECT = 'demo-step9';
if (!process.env.FIRESTORE_EMULATOR_HOST) { console.error('Needs FIRESTORE_EMULATOR_HOST (run via npm run test:drop).'); process.exit(1); }

initializeApp({ projectId: PROJECT });
const db = getFirestore();
const tmp = mkdtempSync(path.join(tmpdir(), 'step9-'));
let failed = 0, passed = 0;
const check = (name, cond, detail = '') => {
  if (cond) passed++; else { failed++; console.error(`FAIL ${name} ${detail}`); }
};

const seed = {
  players: [{ id: 'a', name: 'Al', rating: 512, friends: ['b'] }, { id: 'gone', name: 'Ghost' }],
  games: [{ id: 'g1', date: 1780879839088, winnerId: 'a' }],
  messages: [{ id: 'm1', text: 'hi', fromId: 'a', toId: 'b' }],
  friendRequests: [{ id: 'r1', fromId: 'a', toId: 'b', status: 'accepted' }],
  pending: [{ id: 'p1' }], liveInvites: [], challenges: [], tournaments: [{ id: 't1', name: 'Cup' }],
  reports: [], clips: [{ id: 'c1' }], comments: { c1: [{ id: 'x' }] }, likes: { c1: ['a'] }
};
async function reset(state = seed) {
  await fetch(`http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`, { method: 'DELETE' });
  await db.doc('state/global').set(state);
  await db.doc('players/a').set({ name: 'Al' });
  await db.doc('games/g1').set({ winnerId: 'a' });
  await db.doc('messages/m1').set({ text: 'hi' });
}
function writeBackup(name, state = seed, opts = {}) {
  const f = path.join(tmp, name);
  writeFileSync(f, JSON.stringify(makeBackup(state, { project: PROJECT, ...opts }), null, 2));
  return f;
}
async function run(args) {
  const env = { ...process.env, GCLOUD_PROJECT: PROJECT };
  try { const r = await execFileAsync('node', [SCRIPT, ...args], { env, timeout: 30000 }); return { code: 0, out: r.stdout, err: r.stderr }; }
  catch (e) { return { code: e.code ?? 1, out: String(e.stdout || ''), err: String(e.stderr || '') }; }
}
const global = async () => (await db.doc('state/global').get()).data();
const OTHER = Object.keys(seed).filter((k) => !['players', 'games', 'messages', 'friendRequests'].includes(k));

// 1. Dry run writes nothing and reports coverage.
await reset();
{
  const r = await run(['--backup', writeBackup('ok.json')]);
  check('dry run exits 0', r.code === 0, r.err);
  check('dry run reports the backup OK', /Backup OK/.test(r.out), r.out);
  check('dry run reports array ids with no doc', /gone/.test(r.out) && /r1/.test(r.out), r.out);
  check('dry run writes nothing', canon(await global()) === canon(seed));
}

// 2. Apply with a backup that doesn't match live → refused, nothing deleted.
await reset();
{
  const stale = { ...seed, games: [] };
  const r = await run(['--apply', '--backup', writeBackup('stale.json', stale)]);
  check('mismatched backup → refuses', r.code !== 0 && /NOT usable/.test(r.out), r.out + r.err);
  const g = await global();
  check('mismatched backup → nothing deleted', ['players', 'games', 'messages', 'friendRequests'].every((k) => k in g));
}

// 3. Apply with an old backup → refused.
await reset();
{
  const r = await run(['--apply', '--backup', writeBackup('old.json', seed, { takenAt: new Date(Date.now() - 48 * 3600000).toISOString() })]);
  check('old backup → refuses', r.code !== 0 && /older than/.test(r.out), r.out);
  check('old backup → nothing deleted', 'players' in (await global()));
}

// 4. Apply with a good backup → the four keys are gone, everything else is byte-identical.
await reset();
{
  const r = await run(['--apply', '--backup', writeBackup('ok2.json')]);
  check('apply exits 0', r.code === 0, r.err + r.out);
  check('apply prints Verified', /Verified/.test(r.out), r.out);
  const g = await global();
  check('the four arrays are gone', !['players', 'games', 'messages', 'friendRequests'].some((k) => k in g), Object.keys(g).join(','));
  check('every other key is untouched', OTHER.every((k) => canon(g[k]) === canon(seed[k])), JSON.stringify(g));
  check('collections untouched', (await db.doc('players/a').get()).exists && (await db.doc('games/g1').get()).exists && (await db.doc('messages/m1').get()).exists);

  // 5. Re-running is a no-op.
  const r2 = await run(['--apply', '--backup', writeBackup('ok3.json')]);
  check('re-run → nothing to do, exits 0', r2.code === 0 && /Nothing to do/.test(r2.out), r2.out + r2.err);
}

// 6. Only some keys present (friendRequests already gone) → deletes the rest.
{
  const { friendRequests, ...partial } = seed;
  await reset(partial);
  const r = await run(['--apply', '--backup', writeBackup('partial.json', partial)]);
  const g = await global();
  check('partial: exits 0 and the remaining arrays are gone', r.code === 0 && !['players', 'games', 'messages'].some((k) => k in g), r.err + r.out);
}

console.log(`drop-global-arrays-step9 (emulator): ${passed}/${passed + failed} passed`);
if (failed) process.exit(1);
