'use strict';

// Hand-computed vectors: expected values derived independently from the
// formulas in the Step 5 doc (kFactor/expected/scoreMultiplier/calcRatings),
// not by importing or trusting lib/elo.js. Where a case reduces to exact
// integer arithmetic (equal pre-game ratings -> hm=1, no transcendental
// functions involved) the expected values are exact by hand. Where a case
// needs kFactor/expected/tanh, the expected values were derived by a
// from-scratch reimplementation of the same formula, run once, and the
// result hardcoded here — see the git history / PR description for that
// derivation script. This test's job is to catch a wrong constant, wrong
// order of operations, or a mis-transcribed formula in lib/elo.js; it is
// independent of and complementary to elo.differential.test.js, which
// catches drift from the client's own copy.

const test = require('node:test');
const assert = require('node:assert/strict');
const { calcRatings, kFactor } = require('../lib/elo');

test('kFactor(5) === 32 (K_DECAY is solved to pass through this point)', () => {
  assert.strictEqual(kFactor(5), 32);
});

test('clean sweep (0 — SKI, 1.5x), two unrated players', () => {
  const r = calcRatings({ gamesPlayed: 0 }, { gamesPlayed: 0 }, '0 — SKI');
  assert.strictEqual(r.winnerDelta, 48);
  assert.strictEqual(r.loserDelta, -48);
  assert.strictEqual(r.winnerNew, 448);
  assert.strictEqual(r.loserNew, 352);
});

test('one-letter win (S — SKI, 1.25x), two rated-equal players', () => {
  const r = calcRatings({ rating: 400, gamesPlayed: 5 }, { rating: 400, gamesPlayed: 5 }, 'S — SKI');
  assert.strictEqual(r.winnerDelta, 20);
  assert.strictEqual(r.loserDelta, -20);
  assert.strictEqual(r.winnerNew, 420);
  assert.strictEqual(r.loserNew, 380);
});

test('large upset: low-rated (200) beats high-rated (1000), baseline score', () => {
  const r = calcRatings({ rating: 200, gamesPlayed: 10 }, { rating: 1000, gamesPlayed: 10 }, '');
  assert.strictEqual(r.winnerDelta, 28);
  assert.strictEqual(r.loserDelta, -21);
  assert.strictEqual(r.winnerNew, 228);
  assert.strictEqual(r.loserNew, 979);
});

test('expected win: high-rated (700) beats low-rated (300), dampened', () => {
  const r = calcRatings({ rating: 700, gamesPlayed: 10 }, { rating: 300, gamesPlayed: 10 }, '');
  assert.strictEqual(r.winnerDelta, 1);
  assert.strictEqual(r.loserDelta, -2);
  assert.strictEqual(r.winnerNew, 701);
  assert.strictEqual(r.loserNew, 298);
});

test('unrated winner (rating field absent) defaults to START_RATING (400)', () => {
  const r = calcRatings({ gamesPlayed: 0 }, { rating: 400, gamesPlayed: 0 }, '');
  assert.strictEqual(r.winnerStartRating, 400);
  assert.strictEqual(r.winnerDelta, 32);
  assert.strictEqual(r.loserDelta, -32);
  assert.strictEqual(r.winnerNew, 432);
  assert.strictEqual(r.loserNew, 368);
});

test('explicitly-null-rating loser defaults to START_RATING (400), same as absent', () => {
  const r = calcRatings({ rating: 400, gamesPlayed: 0 }, { rating: null, gamesPlayed: 0 }, '');
  assert.strictEqual(r.loserStartRating, 400);
  assert.strictEqual(r.winnerDelta, 32);
  assert.strictEqual(r.loserDelta, -32);
  assert.strictEqual(r.winnerNew, 432);
  assert.strictEqual(r.loserNew, 368);
});

test('rating clamp: winner cannot exceed 1600', () => {
  const r = calcRatings({ rating: 1599, gamesPlayed: 50 }, { rating: 100, gamesPlayed: 50 }, '0 — SKI');
  assert.ok(r.winnerNew <= 1600);
});

test('rating clamp: loser cannot drop below 100', () => {
  const r = calcRatings({ rating: 1500, gamesPlayed: 50 }, { rating: 101, gamesPlayed: 50 }, '0 — SKI');
  assert.ok(r.loserNew >= 100);
});

test('gamesPlayed ?? 0 divergence: undefined gamesPlayed no longer produces NaN', () => {
  // Client bug this deliberately fixes: kFactor(undefined) === NaN there.
  const r = calcRatings({ rating: 400 }, { rating: 400 }, '');
  assert.ok(Number.isFinite(r.winnerNew));
  assert.ok(Number.isFinite(r.loserNew));
  assert.strictEqual(r.winnerNew, 432); // same shape as the absent-rating case: kFactor(0)=64
});
