// (C) Tests for scripts/diff-dual-write.mjs. No emulator needed.
// Starts from two identical copies (must be CLEAN), then applies one
// mutation per case and asserts the diff flags it at the right severity.
// A diff that stays quiet on a real divergence is worse than no diff, so
// every failure mode it claims to catch has a case here. The entrypoint
// guards are exercised as real subprocesses, same reasoning as
// entrypoint.test.mjs.
//
// Run: node scripts/diff-dual-write.test.mjs

import { execFile } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import { fileURLToPath } from 'url';
import { compareDualWrite, DUAL_WRITE_LIVE_AT } from './diff-dual-write.mjs';

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

let passed = 0;
let failed = 0;
function check(name, ok, detail = '') {
  if (ok) { passed++; console.log(`  ok - ${name}`); }
  else { failed++; console.log(`  FAIL - ${name} ${detail}`); }
}

const AFTER = DUAL_WRITE_LIVE_AT + 60_000;

function fixture() {
  const players = [
    { id: 'legacy-1', name: 'A', rating: 419, wins: 54, losses: 41, gamesPlayed: 95, peakRating: 494, logStrikes: 1, badges: ['b2', 'b1'], friends: [] },
    { id: 'native-uid', name: 'B', rating: null, wins: 0, losses: 1, gamesPlayed: 1, badges: [] }
  ];
  const games = [
    { id: 'g-old', winnerId: 'legacy-1', loserId: 'native-uid', player1StartRating: 400, player1EndRating: 410, player2StartRating: 400, player2EndRating: 390, winnerDelta: 10, loserDelta: -10, score: '', handicap: null, tricks: [], notes: '', clipUrl: '', resort: '', date: 1 },
    { id: 'g-new', winnerId: 'legacy-1', loserId: 'native-uid', player1StartRating: 413, player1EndRating: 419, player2StartRating: 325, player2EndRating: 319, winnerDelta: 6, loserDelta: -6, score: 'S — SKI', handicap: null, tricks: ['a'], notes: 'n', clipUrl: '', resort: 'Stowe', date: AFTER, liveLog: [{ msg: 'x' }] }
  ];
  const messages = [{ id: 'm1', fromId: 'legacy-1', toId: 'native-uid', text: 'yo', date: 5 }];
  const friendRequests = [{ id: 'f1', fromId: 'legacy-1', toId: 'native-uid', status: 'pending', date: 5 }];
  const state = { players, games, messages, friendRequests };
  const clone = (x) => JSON.parse(JSON.stringify(x));
  const toMap = (arr) => new Map(clone(arr).map((x) => [x.id, x]));
  const cols = {
    players: toMap(players),
    games: toMap(games),
    messages: toMap(messages),
    friendRequests: toMap(friendRequests),
    resolutions: new Map([['pending_p1', { kind: 'confirmed', gameId: 'g-new' }], ['pending_p2', { kind: 'disputed' }]])
  };
  // Server copies differ in ways that must NOT be flagged: no liveLog
  // compare, a different date, an absent (vs null) rating, badge order.
  cols.games.get('g-new').date = AFTER + 5;
  delete cols.games.get('g-new').liveLog;
  delete cols.players.get('native-uid').rating;
  cols.players.get('legacy-1').badges = ['b1', 'b2'];
  cols.players.get('legacy-1').firebaseUid = 'legacy-auth-1';
  // Same handicap, different key order (Firestore doesn't keep map order).
  state.games[1].handicap = { higherId: 'legacy-1', hcap: 1 };
  cols.games.get('g-new').handicap = { hcap: 1, higherId: 'legacy-1' };
  return { state, cols };
}

const sev = (r, s, section) => r.findings.filter((f) => f.severity === s && (!section || f.section === section));

{
  const r = compareDualWrite(...Object.values(fixture()));
  check('identical copies are CLEAN (null≡absent, badge order, map key order, date, liveLog ignored)', r.findings.length === 0, JSON.stringify(r.findings));
  check('sample counts only games since 6b went live', r.stats.sinceDualWrite.games === 1 && r.stats.sinceDualWrite.matched === 1);
}

const cases = [
  ['game rating math differs', ({ cols }) => { cols.games.get('g-new').player1EndRating = 420; }, 'MISMATCH', 'games'],
  ['game handicap value differs', ({ cols }) => { cols.games.get('g-new').handicap = { hcap: 2, higherId: 'legacy-1' }; }, 'MISMATCH', 'games'],
  ['game score differs', ({ cols }) => { cols.games.get('g-new').score = '0 — SKI'; }, 'MISMATCH', 'games'],
  ['game only in state/global (dropped server write)', ({ cols }) => { cols.games.delete('g-new'); }, 'MISMATCH', 'games'],
  ['game only in games/', ({ state }) => { state.games.pop(); }, 'MISMATCH', 'games'],
  ['cosmetic field differs', ({ cols }) => { cols.games.get('g-new').resort = 'Killington'; }, 'COSMETIC', 'games'],
  ['player rating differs', ({ cols }) => { cols.players.get('legacy-1').rating = 418; }, 'MISMATCH', 'players'],
  ['player logStrikes differs (dispute path)', ({ cols }) => { cols.players.get('legacy-1').logStrikes = 0; }, 'MISMATCH', 'players'],
  ['player badges differ', ({ cols }) => { cols.players.get('legacy-1').badges = ['b1']; }, 'MISMATCH', 'players'],
  ['player with no players/ doc', ({ cols }) => { cols.players.delete('native-uid'); }, 'MISMATCH', 'players'],
  ['players/ doc with no array entry is KNOWN (deleted account)', ({ state }) => { state.players.pop(); }, 'KNOWN', 'players'],
  ['resolution pointing at a missing game', ({ cols }) => { cols.resolutions.set('live_x', { kind: 'live', gameId: 'nope' }); }, 'MISMATCH', 'resolutions'],
  ['message dropped from collection', ({ cols }) => { cols.messages.delete('m1'); }, 'MISMATCH', 'messages'],
  ['message only in collection', ({ cols }) => { cols.messages.set('m2', { fromId: 'a', toId: 'b', text: 't', date: 1 }); }, 'MISMATCH', 'messages'],
  ['friend request status differs (accept not mirrored)', ({ state }) => { state.friendRequests[0].status = 'accepted'; }, 'MISMATCH', 'friendRequests'],
  ['friend request dropped from collection', ({ cols }) => { cols.friendRequests.delete('f1'); }, 'MISMATCH', 'friendRequests']
];

for (const [name, mutate, severity, section] of cases) {
  const f = fixture();
  mutate(f);
  const r = compareDualWrite(f.state, f.cols);
  const hits = sev(r, severity, section);
  const otherMismatch = severity !== 'MISMATCH' && sev(r, 'MISMATCH').length > 0;
  check(`flags: ${name} → ${severity}`, hits.length === 1 && !otherMismatch, JSON.stringify(r.findings));
}

// Entrypoint guards, as real subprocesses: must refuse (non-zero) before
// touching Firestore. Never passes --prod with a real project.
async function runScript(args, env) {
  try {
    await execFileAsync(process.execPath, [path.join(__dirname, 'diff-dual-write.mjs'), ...args], {
      cwd: path.join(__dirname, '..'),
      env: { ...process.env, FIRESTORE_EMULATOR_HOST: '', GCLOUD_PROJECT: '', GOOGLE_CLOUD_PROJECT: '', ...env }
    });
    return 0;
  } catch (e) { return e.code; }
}
check('no emulator and no --prod → refuses', (await runScript([], {})) !== 0);
check('--prod without GCLOUD_PROJECT → refuses', (await runScript(['--prod'], {})) !== 0);
check('--prod with FIRESTORE_EMULATOR_HOST set → refuses', (await runScript(['--prod'], { FIRESTORE_EMULATOR_HOST: 'localhost:1' })) !== 0);

console.log(`\n${passed} check(s) passed${failed ? `, ${failed} FAILED` : ''}.`);
process.exit(failed ? 1 : 0);
