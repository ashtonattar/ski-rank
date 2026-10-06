// (C) RETIRED once the step-8b client is live: from then on nothing writes
// state/global's arrays, so every new game/message/request shows up here as
// missing from the array. That's by design, not a dropped write. Before 8b
// it's still the pre-push sanity check.
//
// (C) Step 6.5 observation-window diff: state/global's arrays (what the
// client computes and users still see) vs the new collections (what the
// Cloud Functions compute, unseen until step 7). READ-ONLY, never writes.
// Backend Migration Plan, rollout step 6.5:
//   01 Refinements/(C) Backend Migration Plan - Verified 2026-09-16.md
//
// After the step-6b migration re-run (2026-09-25) the two copies were
// identical, so ANY difference now is either a dropped dual-write or a
// divergence in the ported ELO/badge math. Step 7 (read cutover) is gated on
// this coming back clean across a meaningful number of real matches.
//
// Severity:
//   MISMATCH  a real divergence. Exit code 1. Must be explained or fixed
//             before step 7.
//   KNOWN     an expected, documented difference. Doesn't fail the run.
//   COSMETIC  a display-only field differs (tricks/notes/clip/resort).
//             Doesn't fail the run, but worth a look.
//
// Known, documented differences (not flagged as MISMATCH):
//   - players/{id} docs with no array entry: deleteAccount() doesn't remove
//     the doc yet (needs a callable, see PROJECT_STATUS.md step 6b).
// An UNRATED player taking a strike penalty (dispute or live game) used to
// be a hand-explained MISMATCH: the client started from 0, the server from
// START_RATING. Both use START_RATING since 2026-10-01, but a game played
// on a client cached from before that fix can still show it.
//
// Run against prod (read-only, no confirm flag needed):
//   GCLOUD_PROJECT=skirank-b3b70 node scripts/diff-dual-write.mjs --prod

import { pathToFileURL } from 'url';

// Rollout step 6b went live here (GitHub Pages build of 7dddf5f). Games
// dated after this are the real step-6.5 sample.
export const DUAL_WRITE_LIVE_AT = Date.parse('2026-09-25T15:19:33Z');

// Step 7 gate (Ashton, 2026-09-25): 20-30 clean real matches since 6b went
// live, with at least one live game, one handicap game and one dispute
// among them. 20 is the minimum to pass; 30 is the target.
export const GATE_MIN_GAMES = 20;
export const GATE_TARGET_GAMES = 30;

const PLAYER_STAT_FIELDS = ['rating', 'wins', 'losses', 'gamesPlayed', 'peakRating', 'logStrikes'];
const GAME_MATH_FIELDS = ['winnerId', 'loserId', 'player1StartRating', 'player1EndRating',
  'player2StartRating', 'player2EndRating', 'winnerDelta', 'loserDelta', 'score', 'handicap'];
const GAME_COSMETIC_FIELDS = ['tricks', 'notes', 'clipUrl', 'resort'];
const MESSAGE_FIELDS = ['fromId', 'toId', 'text', 'date'];
const FRIEND_REQUEST_FIELDS = ['fromId', 'toId', 'status'];

// undefined and null are the same thing for this diff: the arrays and the
// migrated docs both carry `rating: null` for unrated players, and the
// server treats absent and null alike (`?? START_RATING`). Object keys are
// sorted first: Firestore doesn't preserve map key order, so the same
// handicap object reads back as {hcap, higherId} from one copy and
// {higherId, hcap} from the other (first prod run, 2026-09-25).
function stable(v) {
  if (Array.isArray(v)) return v.map(stable);
  if (v && typeof v === 'object') {
    return Object.fromEntries(Object.keys(v).sort().map((k) => [k, stable(v[k])]));
  }
  return v;
}
function norm(v) {
  if (v === undefined || v === null) return null;
  return JSON.stringify(stable(v));
}

function fieldDiffs(a, b, fields, zeroDefault = []) {
  const val = (o, f) => (zeroDefault.includes(f) ? (o[f] ?? 0) : o[f]);
  return fields
    .filter((f) => norm(val(a, f)) !== norm(val(b, f)))
    .map((f) => `${f}: array=${norm(a[f])} server=${norm(b[f])}`);
}

// Counters a players/ doc may simply not have yet: the client's profile
// mirror strips them (only the server may write them), so a brand-new
// signup's doc has none until its first game, while its array entry carries
// explicit 0s. The server reads absent as 0 (`?? 0` throughout
// functions/lib), so absent and 0 are the same value here. Found on the
// first real post-6b signup (2026-10-01). NOT rating: absent/null rating
// means unrated (START_RATING), never 0.
const PLAYER_ZERO_DEFAULT = ['wins', 'losses', 'gamesPlayed', 'peakRating', 'logStrikes'];

function sortedBadges(p) {
  return Array.isArray(p.badges) ? [...p.badges].sort() : [];
}

/**
 * Pure comparison. `state` is state/global's data; `cols` holds a Map of
 * id -> data for players, games, messages, friendRequests and resolutions.
 * Returns { findings: [{severity, section, id, detail}], stats }.
 */
export function compareDualWrite(state, cols) {
  const findings = [];
  const add = (severity, section, id, detail) => findings.push({ severity, section, id, detail });
  const nameOf = (id) => (state.players || []).find((p) => p.id === id)?.name || id;

  // ── games ──
  const arrayGames = new Map((state.games || []).map((g) => [g.id, g]));
  let gamesMatched = 0;
  let sampleMatched = 0;
  let sampleTotal = 0;
  const coverage = { live: 0, handicap: 0, disputes: 0 };
  for (const [id, a] of arrayGames) {
    const isSample = (a.date || 0) >= DUAL_WRITE_LIVE_AT;
    if (isSample) sampleTotal++;
    const s = cols.games.get(id);
    const label = `${id} (${nameOf(a.winnerId)} beat ${nameOf(a.loserId)})`;
    if (!s) {
      add('MISMATCH', 'games', label, 'in state/global only: the server write was dropped (old-build tab? game started before 6b? function error?)');
      continue;
    }
    const math = fieldDiffs(a, s, GAME_MATH_FIELDS);
    if (math.length) add('MISMATCH', 'games', label, math.join('; '));
    const cosmetic = fieldDiffs(a, s, GAME_COSMETIC_FIELDS);
    if (cosmetic.length) add('COSMETIC', 'games', label, cosmetic.join('; '));
    if (!math.length) {
      gamesMatched++;
      if (isSample) {
        sampleMatched++;
        if (Array.isArray(a.liveLog) && a.liveLog.length) coverage.live++;
        if (a.handicap) coverage.handicap++;
      }
    }
  }
  for (const [id, s] of cols.games) {
    if (!arrayGames.has(id)) {
      add('MISMATCH', 'games', `${id} (${nameOf(s.winnerId)} beat ${nameOf(s.loserId)})`,
        'in games/ only: the server recorded a result state/global never got');
    }
  }

  // ── players ──
  const arrayPlayers = new Map((state.players || []).map((p) => [p.id, p]));
  let playersMatched = 0;
  for (const [id, a] of arrayPlayers) {
    const s = cols.players.get(id);
    const label = `${id} (${a.name || '?'})`;
    if (!s) {
      add('MISMATCH', 'players', label, 'no players/ doc: the profile mirror never created it');
      continue;
    }
    const diffs = fieldDiffs(a, s, PLAYER_STAT_FIELDS, PLAYER_ZERO_DEFAULT);
    if (norm(sortedBadges(a)) !== norm(sortedBadges(s))) {
      diffs.push(`badges: array=${norm(sortedBadges(a))} server=${norm(sortedBadges(s))}`);
    }
    if (diffs.length) add('MISMATCH', 'players', label, diffs.join('; '));
    else playersMatched++;
  }
  for (const [id, s] of cols.players) {
    if (!arrayPlayers.has(id)) {
      add('KNOWN', 'players', `${id} (${s.name || '?'})`,
        'players/ doc with no array entry: deleted account, whose doc deleteAccount() does not remove yet');
    }
  }

  // ── resolutions → games ──
  for (const [key, r] of cols.resolutions) {
    if (r.kind === 'disputed' && (r.resolvedAt || 0) >= DUAL_WRITE_LIVE_AT) coverage.disputes++;
    if ((r.kind === 'confirmed' || r.kind === 'live') && !cols.games.has(r.gameId)) {
      add('MISMATCH', 'resolutions', key, `settled as ${r.kind} with gameId ${r.gameId}, but games/${r.gameId} does not exist`);
    }
  }

  // ── messages / friendRequests ──
  function compareSimple(section, arr, col, fields) {
    const arrayMap = new Map((arr || []).map((x) => [x.id, x]));
    let matched = 0;
    for (const [id, a] of arrayMap) {
      const s = col.get(id);
      if (!s) { add('MISMATCH', section, id, 'in state/global only: the mirror write was dropped'); continue; }
      const diffs = fieldDiffs(a, s, fields);
      if (diffs.length) add('MISMATCH', section, id, diffs.join('; '));
      else matched++;
    }
    for (const id of col.keys()) {
      if (!arrayMap.has(id)) add('MISMATCH', section, id, `in ${section}/ only: state/global never got it (or dropped it)`);
    }
    return matched;
  }
  const messagesMatched = compareSimple('messages', state.messages, cols.messages, MESSAGE_FIELDS);
  const friendRequestsMatched = compareSimple('friendRequests', state.friendRequests, cols.friendRequests, FRIEND_REQUEST_FIELDS);

  const mismatchCount = findings.filter((f) => f.severity === 'MISMATCH').length;
  const gate = {
    clean: mismatchCount === 0,
    enoughGames: sampleMatched >= GATE_MIN_GAMES,
    coverage,
    covered: coverage.live > 0 && coverage.handicap > 0 && coverage.disputes > 0
  };
  gate.passed = gate.clean && gate.enoughGames && gate.covered;

  return {
    findings,
    gate,
    stats: {
      games: { array: arrayGames.size, server: cols.games.size, matched: gamesMatched },
      sinceDualWrite: { games: sampleTotal, matched: sampleMatched },
      players: { array: arrayPlayers.size, server: cols.players.size, matched: playersMatched },
      messages: { array: (state.messages || []).length, server: cols.messages.size, matched: messagesMatched },
      friendRequests: { array: (state.friendRequests || []).length, server: cols.friendRequests.size, matched: friendRequestsMatched },
      resolutions: cols.resolutions.size
    }
  };
}

export async function loadFromFirestore(db) {
  const globalSnap = await db.doc('state/global').get();
  if (!globalSnap.exists) throw new Error('state/global does not exist');
  const cols = {};
  for (const c of ['players', 'games', 'messages', 'friendRequests', 'resolutions']) {
    const snap = await db.collection(c).get();
    cols[c] = new Map(snap.docs.map((d) => [d.id, d.data()]));
  }
  return { state: globalSnap.data(), cols };
}

export function printReport({ findings, stats, gate }) {
  const s = stats;
  console.log('Counts (array / server / matched):');
  for (const k of ['games', 'players', 'messages', 'friendRequests']) {
    console.log(`  ${k.padEnd(15)} ${s[k].array} / ${s[k].server} / ${s[k].matched}`);
  }
  console.log(`  resolutions     ${s.resolutions}`);
  console.log(`\nStep 6.5 sample: ${s.sinceDualWrite.matched} of ${s.sinceDualWrite.games} games since 6b went live match exactly.\n`);

  for (const sev of ['MISMATCH', 'KNOWN', 'COSMETIC']) {
    const list = findings.filter((f) => f.severity === sev);
    if (!list.length) continue;
    console.log(`${sev} (${list.length})`);
    for (const f of list) console.log(`  [${f.section}] ${f.id}\n      ${f.detail}`);
    console.log('');
  }
  const mismatches = findings.filter((f) => f.severity === 'MISMATCH').length;
  console.log(mismatches ? `${mismatches} MISMATCH(ES): not clean for step 7.` : 'CLEAN: no mismatches.');

  const c = gate.coverage;
  const tick = (ok) => (ok ? 'x' : ' ');
  console.log(`\nStep 7 gate (${GATE_MIN_GAMES}-${GATE_TARGET_GAMES} clean matches):`);
  console.log(`  [${tick(gate.clean)}] no mismatches`);
  console.log(`  [${tick(gate.enoughGames)}] ${s.sinceDualWrite.matched}/${GATE_MIN_GAMES} clean matches since 6b (target ${GATE_TARGET_GAMES})`);
  console.log(`  [${tick(c.live > 0)}] live game (${c.live})`);
  console.log(`  [${tick(c.handicap > 0)}] handicap game (${c.handicap})`);
  console.log(`  [${tick(c.disputes > 0)}] dispute (${c.disputes})`);
  console.log(gate.passed ? '  GATE PASSED: step 7 (read cutover) is unblocked.' : '  Gate not passed yet.');
  return mismatches;
}

async function main() {
  const { initializeApp } = await import('firebase-admin/app');
  const { getFirestore } = await import('firebase-admin/firestore');
  const emulatorHost = process.env.FIRESTORE_EMULATOR_HOST;
  const allowProd = process.argv.includes('--prod');

  if (!emulatorHost && !allowProd) {
    console.error('Refusing to run: pass --prod with GCLOUD_PROJECT set to diff real production (read-only), or set FIRESTORE_EMULATOR_HOST.');
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
    console.warn(`Diffing REAL project "${projectId}" (read-only).\n`);
    initializeApp({ projectId });
  } else {
    initializeApp({ projectId: process.env.GCLOUD_PROJECT || 'demo-diff' });
  }

  const { state, cols } = await loadFromFirestore(getFirestore());
  const mismatches = printReport(compareDualWrite(state, cols));
  process.exit(mismatches ? 1 : 0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
