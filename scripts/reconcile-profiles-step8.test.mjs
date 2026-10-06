// (C) Tests for reconcile-profiles-step8.mjs: the pure plan, plus the prod
// guards run as real subprocesses (see entrypoint.test.mjs for why). No
// emulator needed; nothing here ever passes a real project with --apply.
//
// Run: node scripts/reconcile-profiles-step8.test.mjs

import { execFile } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import { fileURLToPath } from 'url';
import { planReconcile } from './reconcile-profiles-step8.mjs';

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
let failed = 0, passed = 0;
const check = (name, cond, detail = '') => {
  if (cond) passed++; else { failed++; console.error(`FAIL ${name} ${detail}`); }
};

// ── plan ──
{
  const arr = [
    { id: 'a', name: 'Al', bio: 'new', friends: ['b', 'c'], rating: 999, wins: 9, firebaseUid: 'x', avatarUrl: 'data:', lastRead: { b: 200, c: 50 } },
    { id: 'b', name: 'Bo', friends: ['a'], following: ['c', 'a'] },
    { id: 'gone', name: 'Ghost' }
  ];
  const docs = new Map([
    ['a', { name: 'Al', bio: 'old', friends: ['b'], rating: 512, onlyOnDoc: 1, lastRead: { b: 100, c: 80 } }],
    ['b', { name: 'Bo', friends: ['a'], following: ['a', 'c'] }]
  ]);
  const { updates, noDoc } = planReconcile(arr, docs);
  const a = updates.find((u) => u.id === 'a');
  check('array value wins for bio', a?.fields.bio === 'new');
  check('friends taken from the array', JSON.stringify(a?.fields.friends) === '["b","c"]');
  check('server-owned/identity/cache fields never written', !('rating' in a.fields) && !('wins' in a.fields) && !('firebaseUid' in a.fields) && !('avatarUrl' in a.fields));
  check('doc-only fields untouched', !('onlyOnDoc' in a.fields));
  check('lastRead merged per friend (newest wins)', JSON.stringify(a.fields.lastRead) === JSON.stringify({ b: 200, c: 80 }));
  check('reordered friends/following is not a diff', !updates.some((u) => u.id === 'b'));
  check('array entry with no doc is reported, not planned', noDoc.length === 1 && noDoc[0].id === 'gone' && !updates.some((u) => u.id === 'gone'));
  check('a matching profile produces nothing', planReconcile([{ id: 'b', name: 'Bo' }], new Map([['b', { name: 'Bo' }]])).updates.length === 0);
  check('lastRead already newer on doc → no diff', planReconcile([{ id: 'a', lastRead: { b: 1 } }], new Map([['a', { lastRead: { b: 5 } }]])).updates.length === 0);
  check('null array/doc tolerated', planReconcile(undefined, new Map()).updates.length === 0);
}

// ── guards (subprocess) ──
const SCRIPT = path.join(__dirname, 'reconcile-profiles-step8.mjs');
async function run(args, env) {
  const clean = { ...process.env };
  delete clean.FIRESTORE_EMULATOR_HOST; delete clean.GCLOUD_PROJECT; delete clean.GOOGLE_CLOUD_PROJECT; delete clean.RECONCILE_CONFIRM_PROD;
  try { await execFileAsync('node', [SCRIPT, ...args], { env: { ...clean, ...env }, timeout: 20000 }); return { code: 0, stderr: '' }; }
  catch (e) { return { code: e.code ?? 1, stderr: String(e.stderr || '') }; }
}
{
  const r1 = await run([], {});
  check('no emulator and no --prod → refuses', r1.code !== 0 && /Refusing/.test(r1.stderr), r1.stderr);
  const r2 = await run(['--prod'], {});
  check('--prod without GCLOUD_PROJECT → refuses', r2.code !== 0 && /GCLOUD_PROJECT/.test(r2.stderr), r2.stderr);
  const r3 = await run(['--prod'], { FIRESTORE_EMULATOR_HOST: 'localhost:1' });
  check('--prod with emulator host → refuses', r3.code !== 0 && /contradictory/.test(r3.stderr), r3.stderr);
  const r4 = await run(['--prod', '--apply'], { GCLOUD_PROJECT: 'demo-never-real' });
  check('--prod --apply without confirm → refuses before any write', r4.code !== 0 && /RECONCILE_CONFIRM_PROD/.test(r4.stderr), r4.stderr);
}

console.log(`${passed} check(s) passed.`);
if (failed) { console.error(`${failed} failed.`); process.exit(1); }
