'use strict';

// Side track A (2026-10-12): signed Cloudinary clip uploads.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { getDb, clearEmulatorData, fakeRequest } = require('./testUtils');
const {
  signClipUploadHandler, signParams, PER_PLAYER_DAILY_LIMIT, GLOBAL_DAILY_LIMIT, ALLOWED_FORMATS
} = require('../lib/signClipUpload');

const KEY = 'test-key';
const SECRET = 'test-secret';
const NOW = Date.UTC(2026, 9, 12, 15, 30, 0); // 2026-10-12T15:30:00Z
const TODAY = '2026-10-12';
const DAY_MS = 24 * 60 * 60 * 1000;

const sign = (db, uid, now = NOW) =>
  signClipUploadHandler(db, fakeRequest(uid, {}), { apiKey: KEY, apiSecret: SECRET, now });
const exhausted = (limit) => (err) => err.code === 'resource-exhausted' && err.details?.limit === limit;

// Independent recompute, written out longhand rather than via signParams.
function recompute(res) {
  const s = `allowed_formats=${res.allowedFormats}` +
    (res.assetFolder ? `&asset_folder=${res.assetFolder}` : '') +
    `&overwrite=${res.overwrite}&public_id=${res.publicId}&timestamp=${res.timestamp}${SECRET}`;
  return crypto.createHash('sha1').update(s).digest('hex');
}

test('signParams matches the worked example in Cloudinary\'s docs', () => {
  const sig = signParams({
    eager: 'w_400,h_300,c_pad|w_260,h_200,c_crop',
    public_id: 'sample_image',
    timestamp: 1315060510
  }, 'abcd');
  assert.strictEqual(sig, 'bfd09f95f331f558cbd1320e67aa8d488770583e');
});

test('signClipUpload callable', async (t) => {
  const db = getDb();
  t.beforeEach(async () => { await clearEmulatorData(); });

  const quota = async (id) => (await db.collection('uploadQuotas').doc(id).get()).data();
  const total = async (day = TODAY) => (await db.collection('uploadQuotaTotals').doc(day).get()).data();

  await t.test('rejects an unauthenticated caller', async () => {
    await assert.rejects(() => sign(db, null), (e) => e.code === 'unauthenticated');
    assert.strictEqual(await total(), undefined);
  });

  await t.test('refuses to sign when the secrets are missing', async () => {
    await assert.rejects(
      () => signClipUploadHandler(db, fakeRequest('a', {}), { apiKey: '', apiSecret: '', now: NOW }),
      (e) => e.code === 'failed-precondition');
  });

  await t.test('a signed-in caller gets a valid signature and the expected params', async () => {
    await db.collection('players').doc('a').set({ name: 'a' });
    const res = await sign(db, 'a');
    assert.strictEqual(res.apiKey, KEY);
    assert.strictEqual(res.signature, recompute(res));
    assert.match(res.publicId, /^skirank\/clips\/a\/\d+_[0-9a-f]{12}$/);
    assert.strictEqual(res.assetFolder, 'skirank/clips/a'); // Dynamic Folders account
    assert.strictEqual(res.allowedFormats, ALLOWED_FORMATS);
    assert.strictEqual(res.overwrite, 'false');
    assert.strictEqual(res.timestamp, Math.floor(NOW / 1000)); // seconds, not ms
    assert.ok(!('uploadPreset' in res) && !('upload_preset' in res));
    assert.ok(!JSON.stringify(res).includes(SECRET));
    assert.deepStrictEqual(await quota('a'), { day: TODAY, count: 1 });
    assert.deepStrictEqual(await total(), { count: 1 });
  });

  await t.test('two calls get different public_ids', async () => {
    const [r1, r2] = [await sign(db, 'a'), await sign(db, 'a')];
    assert.notStrictEqual(r1.publicId, r2.publicId);
  });

  await t.test('a legacy account (player id != auth uid) signs into its player id folder', async () => {
    await db.collection('players').doc('legacy-1').set({ name: 'L', firebaseUid: 'auth-xyz' });
    const res = await sign(db, 'auth-xyz');
    assert.match(res.publicId, /^skirank\/clips\/legacy-1\//);
    assert.strictEqual(res.assetFolder, 'skirank/clips/legacy-1');
    assert.strictEqual((await quota('legacy-1')).count, 1);
    assert.strictEqual(await quota('auth-xyz'), undefined);
  });

  await t.test(`calls 1-${PER_PLAYER_DAILY_LIMIT} succeed, the next is refused (player limit)`, async () => {
    for (let i = 0; i < PER_PLAYER_DAILY_LIMIT; i++) await sign(db, 'a');
    await assert.rejects(() => sign(db, 'a'), exhausted('player'));
    assert.strictEqual((await quota('a')).count, PER_PLAYER_DAILY_LIMIT); // the refused call didn't count
    assert.strictEqual((await total()).count, PER_PLAYER_DAILY_LIMIT);
  });

  await t.test('the next UTC day resets the player count', async () => {
    await db.collection('uploadQuotas').doc('a').set({ day: TODAY, count: PER_PLAYER_DAILY_LIMIT });
    await assert.rejects(() => sign(db, 'a'), exhausted('player'));
    await sign(db, 'a', NOW + DAY_MS);
    assert.deepStrictEqual(await quota('a'), { day: '2026-10-13', count: 1 });
    assert.deepStrictEqual(await total('2026-10-13'), { count: 1 });
  });

  await t.test('two players have separate counters', async () => {
    await db.collection('uploadQuotas').doc('a').set({ day: TODAY, count: PER_PLAYER_DAILY_LIMIT });
    await assert.rejects(() => sign(db, 'a'), exhausted('player'));
    await sign(db, 'b');
    assert.strictEqual((await quota('b')).count, 1);
  });

  await t.test('the global cap refuses even a fresh player, and the refusal counts nothing', async () => {
    await db.collection('uploadQuotaTotals').doc(TODAY).set({ count: GLOBAL_DAILY_LIMIT - 1 });
    await sign(db, 'a');
    assert.strictEqual((await total()).count, GLOBAL_DAILY_LIMIT);
    await assert.rejects(() => sign(db, 'fresh'), exhausted('global'));
    assert.strictEqual((await total()).count, GLOBAL_DAILY_LIMIT);
    assert.strictEqual(await quota('fresh'), undefined);
  });

  await t.test('yesterday\'s global total doesn\'t block today', async () => {
    await db.collection('uploadQuotaTotals').doc('2026-10-11').set({ count: GLOBAL_DAILY_LIMIT });
    await sign(db, 'a');
    assert.strictEqual((await total()).count, 1);
  });
});
