// (C) Emulator rules test: rollout step 6b client dual-write shapes
// (2026-09-25). Every write index.html now sends to the new collections,
// in the exact shape it sends it, for a native account (player id == auth
// uid) and a legacy one (player id != auth uid, linked via firebaseUid).
// The player-mirror skip list is read out of index.html itself, so this
// breaks if the two drift apart.
//
// Run: npm run test:rules

import { initializeTestEnvironment, assertFails, assertSucceeds } from '@firebase/rules-unit-testing';
import { readFileSync } from 'fs';

const rules = readFileSync('firestore.rules', 'utf8');
const html = readFileSync('index.html', 'utf8');

const skipMatch = html.match(/const _PLAYER_MIRROR_SKIP = (\[[^\]]*\]);/);
if (!skipMatch) throw new Error('_PLAYER_MIRROR_SKIP not found in index.html');
const PLAYER_MIRROR_SKIP = JSON.parse(skipMatch[1].replace(/'/g, '"'));

// Same transform as _mirrorMyPlayer() in index.html.
function mirrorShape(player) {
  const data = JSON.parse(JSON.stringify(player));
  PLAYER_MIRROR_SKIP.forEach((k) => delete data[k]);
  return data;
}

// The shape doSignup() pre-seeds and the self-heal path creates.
function signupPlayer(id) {
  return {
    id, name: 'New Rider', email: `${id}@example.com`, riderType: 'skier',
    homeResort: 'Killington', location: 'Killington',
    rating: null, wins: 0, losses: 0, gamesPlayed: 0,
    badges: [], friends: [], following: [], createdAt: 1758800000000
  };
}

let passed = 0;
async function check(name, fn) {
  await fn();
  passed++;
  console.log(`  ok - ${name}`);
}

async function main() {
  const testEnv = await initializeTestEnvironment({ projectId: 'demo-test-6b', firestore: { rules } });

  const legacyPlayer = {
    id: 'legacy-1', firebaseUid: 'legacy-auth-1', name: 'Legacy Rider', email: 'l@example.com',
    riderType: 'skier', homeResort: 'Stowe', rating: 612, wins: 9, losses: 4, gamesPlayed: 13,
    peakRating: 640, logStrikes: 1, badges: ['first-win'], friends: [], following: []
  };

  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    await db.doc('players/legacy-1').set(legacyPlayer);
    await db.doc('players/bob-uid').set({ id: 'bob-uid', name: 'Bob', rating: 450, wins: 1, losses: 0, gamesPlayed: 1 });
    await db.doc('friendRequests/fr-accepted').set({ id: 'fr-accepted', fromId: 'legacy-1', toId: 'bob-uid', status: 'accepted', date: 1 });
    await db.doc('friendRequests/fr-pending-in').set({ id: 'fr-pending-in', fromId: 'bob-uid', toId: 'legacy-1', status: 'pending', date: 1 });
  });

  const as = (uid) => testEnv.authenticatedContext(uid).firestore();

  // ── players mirror ──
  await check('mirror skip list covers every server-owned field plus firebaseUid/avatarUrl', async () => {
    for (const k of ['rating', 'wins', 'losses', 'gamesPlayed', 'peakRating', 'logStrikes', 'badges', 'firebaseUid', 'avatarUrl']) {
      if (!PLAYER_MIRROR_SKIP.includes(k)) throw new Error(`missing ${k}`);
    }
  });
  await check('the raw signup shape (rating: null) is rejected, so the strip is load-bearing', async () => {
    await assertFails(as('new-uid').doc('players/new-uid').set(signupPlayer('new-uid'), { merge: true }));
  });
  await check('native signup: mirrored shape creates players/{authUid}', async () => {
    await assertSucceeds(as('new-uid').doc('players/new-uid').set(mirrorShape(signupPlayer('new-uid')), { merge: true }));
  });
  await check('native: a later profile edit (name, friends) merges', async () => {
    const edited = { ...signupPlayer('new-uid'), name: 'Renamed', friends: ['bob-uid'] };
    await assertSucceeds(as('new-uid').doc('players/new-uid').set(mirrorShape(edited), { merge: true }));
  });
  await check('legacy owner: profile mirror merges onto the migrated doc', async () => {
    const edited = { ...legacyPlayer, name: 'Legacy Renamed', bio: 'hi', avatarUrl: 'data:x', rating: 999 };
    await assertSucceeds(as('legacy-auth-1').doc('players/legacy-1').set(mirrorShape(edited), { merge: true }));
  });
  await check('legacy owner: server-owned fields and firebaseUid survive the merge untouched', async () => {
    let snap;
    await testEnv.withSecurityRulesDisabled(async (ctx) => { snap = await ctx.firestore().doc('players/legacy-1').get(); });
    const d = snap.data();
    const want = { rating: 612, wins: 9, losses: 4, gamesPlayed: 13, peakRating: 640, logStrikes: 1, firebaseUid: 'legacy-auth-1', name: 'Legacy Renamed' };
    for (const [k, v] of Object.entries(want)) {
      if (d[k] !== v) throw new Error(`${k}: expected ${v}, got ${d[k]}`);
    }
    if (JSON.stringify(d.badges) !== '["first-win"]') throw new Error('badges changed');
    if ('avatarUrl' in d) throw new Error('avatarUrl leaked into the doc');
  });
  await check('an unchanged re-mirror (no affected keys) is allowed', async () => {
    const same = { ...legacyPlayer, name: 'Legacy Renamed', bio: 'hi' };
    await assertSucceeds(as('legacy-auth-1').doc('players/legacy-1').set(mirrorShape(same), { merge: true }));
  });
  await check("a stranger can't mirror onto someone else's doc", async () => {
    await assertFails(as('eve-uid').doc('players/legacy-1').set({ name: 'pwned' }, { merge: true }));
  });

  // ── live joins (_writeLiveJoin) ──
  await check('sender can join before the liveGames doc exists', async () => {
    await assertSucceeds(as('legacy-auth-1').doc('liveGames/not-yet/joins/legacy-auth-1').set({ joinedAt: Date.now() }));
  });
  await check('a second set on an existing join is denied (why the client get()s first)', async () => {
    await assertFails(as('legacy-auth-1').doc('liveGames/not-yet/joins/legacy-auth-1').set({ joinedAt: Date.now() }));
  });
  await check('the join get() is readable by a signed-in user', async () => {
    await assertSucceeds(as('legacy-auth-1').doc('liveGames/not-yet/joins/legacy-auth-1').get());
  });
  await check("can't join as someone else's auth uid", async () => {
    await assertFails(as('eve-uid').doc('liveGames/not-yet/joins/bob-uid').set({ joinedAt: Date.now() }));
  });

  // ── messages (sendMessage) ──
  const msg = (id, fromId, toId) => ({ id, fromId, fromName: 'x', toId, text: 'yo', date: Date.now() });
  await check('native sender: message set()', async () => {
    await assertSucceeds(as('bob-uid').doc('messages/m1').set(msg('m1', 'bob-uid', 'legacy-1')));
  });
  await check('legacy sender: message set()', async () => {
    await assertSucceeds(as('legacy-auth-1').doc('messages/m2').set(msg('m2', 'legacy-1', 'bob-uid')));
  });
  await check("can't send a message as someone else", async () => {
    await assertFails(as('eve-uid').doc('messages/m3').set(msg('m3', 'bob-uid', 'legacy-1')));
  });

  // ── friendRequests (send/cancel/accept/decline/unfriend) ──
  const fr = (id, fromId, toId) => ({ id, fromId, fromName: 'x', toId, toName: 'y', status: 'pending', date: Date.now() });
  await check('legacy sender: sendFriendRequest set()', async () => {
    await assertSucceeds(as('legacy-auth-1').doc('friendRequests/fr-new').set(fr('fr-new', 'legacy-1', 'bob-uid')));
  });
  await check('legacy sender: cancelFriendRequest delete()', async () => {
    await assertSucceeds(as('legacy-auth-1').doc('friendRequests/fr-new').delete());
  });
  await check('native signup: referral request set()', async () => {
    await assertSucceeds(as('new-uid').doc('friendRequests/fr-ref').set(fr('fr-ref', 'new-uid', 'legacy-1')));
  });
  await check('legacy recipient: acceptFriendRequest update({status})', async () => {
    await assertSucceeds(as('legacy-auth-1').doc('friendRequests/fr-ref').update({ status: 'accepted' }));
  });
  await check('legacy recipient: declineFriendRequest update({status})', async () => {
    await assertSucceeds(as('legacy-auth-1').doc('friendRequests/fr-pending-in').update({ status: 'declined' }));
  });
  await check('native recipient: unfriend delete() of a settled request', async () => {
    await assertSucceeds(as('bob-uid').doc('friendRequests/fr-accepted').delete());
  });
  await check('legacy recipient: unfriend delete() of a settled request', async () => {
    await assertSucceeds(as('legacy-auth-1').doc('friendRequests/fr-ref').delete());
  });
  await check('native sender: delete() of their own settled (declined) request', async () => {
    await assertSucceeds(as('bob-uid').doc('friendRequests/fr-pending-in').delete());
  });

  console.log(`\n${passed} checks passed.\n`);
  await testEnv.cleanup();
}

main().catch((e) => { console.error(e); process.exit(1); });
