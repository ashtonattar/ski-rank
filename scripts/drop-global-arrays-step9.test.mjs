// (C) Tests for drop-global-arrays-step9.mjs: the pure backup check and
// coverage report, plus the prod guards run as real subprocesses (see
// entrypoint.test.mjs for why). No emulator needed; nothing here ever passes
// a real project with --apply. The emulator end-to-end run is
// drop-global-arrays-step9.emu.test.mjs.
//
// Run: node scripts/drop-global-arrays-step9.test.mjs

import { execFile } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import { fileURLToPath } from 'url';
import { decodeValue, canon, checkBackup, coverage, backupSha } from './drop-global-arrays-step9.mjs';
import { encodeValue, makeBackup } from './drop-global-arrays-step9.fixtures.mjs';

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
let failed = 0, passed = 0;
const check = (name, cond, detail = '') => {
  if (cond) passed++; else { failed++; console.error(`FAIL ${name} ${detail}`); }
};

// ── decode / canon ──
{
  const v = { a: 1, b: 2.5, c: 'x', d: true, e: null, f: [1, { g: 'h' }], big: 1780879839088, empty: [] };
  check('decode round-trips encode', canon(decodeValue(encodeValue(v))) === canon(v));
  check('canon ignores key order', canon({ a: 1, b: 2 }) === canon({ b: 2, a: 1 }));
  check('canon keeps array order', canon([1, 2]) !== canon([2, 1]));
  check('decode empty arrayValue', Array.isArray(decodeValue({ arrayValue: {} })) && decodeValue({ arrayValue: {} }).length === 0);
  check('decode timestamp matches admin Timestamp', canon(decodeValue({ timestampValue: '2026-10-08T00:00:00Z' })) ===
    canon({ toDate: () => new Date('2026-10-08T00:00:00Z'), seconds: 1 }));
  let threw = false; try { decodeValue({ weirdValue: 1 }); } catch (_) { threw = true; }
  check('unknown value type throws (never silently compares)', threw);
}

// ── checkBackup ──
const state = {
  players: [{ id: 'a', name: 'Al', rating: 512 }], games: [{ id: 'g1', date: 1 }],
  messages: [{ id: 'm1', text: 'hi' }], friendRequests: [], pending: [], tournaments: [{ id: 't' }]
};
const opts = { projectId: 'demo-step9' };
{
  check('fresh matching backup → no problems', checkBackup(makeBackup(state), state, opts).length === 0,
    JSON.stringify(checkBackup(makeBackup(state), state, opts)));
  const p1 = checkBackup(makeBackup(state, { project: 'other' }), state, opts);
  check('wrong project refused', p1.some((p) => /project/.test(p)));
  const old = makeBackup(state, { takenAt: new Date(Date.now() - 25 * 3600000).toISOString() });
  check('backup older than 24h refused', checkBackup(old, state, opts).some((p) => /older than/.test(p)));
  const future = makeBackup(state, { takenAt: new Date(Date.now() + 3600000).toISOString() });
  check('backup from the future refused', checkBackup(future, state, opts).some((p) => /older than|unreadable/.test(p)));
  const tampered = makeBackup(state); tampered.docs['state/global'].fields.games = encodeValue([]);
  check('edited backup fails sha256', checkBackup(tampered, state, opts).some((p) => /sha256/.test(p)));
  const noCols = makeBackup(state); delete noCols.collections.games; noCols._meta.sha256 = backupSha(noCols);
  check('backup without games/ collection refused', checkBackup(noCols, state, opts).some((p) => /games\/ collection/.test(p)));
  const errCol = makeBackup(state, { cols: { messages: { _error: 'denied' } } });
  check('backup whose collection read errored refused', checkBackup(errCol, state, opts).some((p) => /messages\/ collection/.test(p)));
  const drift = { ...state, games: [...state.games, { id: 'g2' }] };
  check('live array differs from backup → refused', checkBackup(makeBackup(state), drift, opts).some((p) => /games differs/.test(p)));
  const renamed = { ...state, players: [{ id: 'a', name: 'Changed', rating: 512 }] };
  check('a single changed field is a difference', checkBackup(makeBackup(state), renamed, opts).some((p) => /players differs/.test(p)));
  const reordered = { ...state, players: [{ rating: 512, name: 'Al', id: 'a' }] };
  check('key order inside an entry is not a difference', checkBackup(makeBackup(state), reordered, opts).length === 0);
  const { friendRequests, ...noFr } = state;
  check('key absent in both → fine', checkBackup(makeBackup(noFr), noFr, opts).length === 0);
  check('key absent live but present in backup → difference', checkBackup(makeBackup(state), noFr, opts).some((p) => /friendRequests differs/.test(p)));
  check('null backup → problems, no throw', checkBackup(null, state, opts).length > 0);
}

// ── coverage ──
{
  const ids = { players: new Set(['a']), games: new Set([]), messages: new Set(['m1']), friendRequests: new Set() };
  const c = coverage(state, ids);
  check('coverage lists array ids with no doc', JSON.stringify(c.games.missing) === '["g1"]' && c.players.missing.length === 0);
  check('coverage tolerates absent arrays', coverage({}, ids).players.total === 0);
}

// ── guards (subprocess) ──
const SCRIPT = path.join(__dirname, 'drop-global-arrays-step9.mjs');
async function run(args, env) {
  const clean = { ...process.env };
  delete clean.FIRESTORE_EMULATOR_HOST; delete clean.GCLOUD_PROJECT; delete clean.GOOGLE_CLOUD_PROJECT; delete clean.DROP_ARRAYS_CONFIRM_PROD;
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
  const r4 = await run(['--prod', '--apply'], { GCLOUD_PROJECT: 'demo-never-real', DROP_ARRAYS_CONFIRM_PROD: 'yes-i-am-sure' });
  check('--apply without --backup → refuses', r4.code !== 0 && /--backup/.test(r4.stderr), r4.stderr);
  const r5 = await run(['--prod', '--apply', '--backup', '/nonexistent'], { GCLOUD_PROJECT: 'demo-never-real' });
  check('--prod --apply without the confirm env → refuses', r5.code !== 0 && /DROP_ARRAYS_CONFIRM_PROD/.test(r5.stderr), r5.stderr);
  const r6 = await run(['--apply'], { FIRESTORE_EMULATOR_HOST: 'localhost:1' });
  check('emulator --apply without --backup → refuses', r6.code !== 0 && /--backup/.test(r6.stderr), r6.stderr);
}

console.log(`drop-global-arrays-step9: ${passed}/${passed + failed} passed`);
if (failed) process.exit(1);
