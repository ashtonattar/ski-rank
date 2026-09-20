'use strict';

// ═══════════════════════════════════════════════════════
//  RATING ENGINE — ported verbatim from index.html:6126-6216
//  (kFactor, expected, scoreMultiplier, calcRatings, constants)
//
//  Any change here must be mirrored in index.html's copy (and vice versa)
//  until the client is fully cut over to reading server-computed ratings.
//  Step 6.5 diffs this module's output against the client's for real
//  matches, so this file exists specifically to be identical to the
//  client except for the one documented divergence below.
// ═══════════════════════════════════════════════════════

const START_RATING = 400;

const K_START = 64;
const K_FLOOR = 16;
const K_DECAY = 5 / Math.log(3); // solved so kFactor(5) === 32

function kFactor(games) {
  return K_FLOOR + (K_START - K_FLOOR) * Math.exp(-games / K_DECAY);
}

function expected(a, b) {
  return 1 / (1 + Math.pow(10, (b - a) / 400));
}

function scoreMultiplier(scoreStr) {
  if (!scoreStr) return 1.0;
  const winnerPart = scoreStr.split('—')[0].trim();
  if (winnerPart === '0') return 1.5;
  if (winnerPart === 'S') return 1.25;
  return 1.0;
}

const UPSET_DAMPEN = 0.6;
const UPSET_BOOST = 1.4;
const UPSET_GAP_SCALE = 600;

/**
 * winner/loser: { rating, gamesPlayed } — both fields may be absent or null.
 *
 * DELIBERATE DIVERGENCE from index.html's calcRatings (client uses
 * `winner.gamesPlayed`/`loser.gamesPlayed` directly into kFactor(), with no
 * `?? 0`): three current players (`judge-id`, `p1-id`, `judge1` — all
 * seed/judge accounts) have no gamesPlayed field at all, so kFactor(undefined)
 * returns NaN there today, propagating into a NaN rating. That bug has never
 * fired because those accounts don't play matches. Fixed here with `?? 0` for
 * gamesPlayed (matching the `?? START_RATING` treatment already used for
 * rating). This can only produce a different result than the client on an
 * account that never plays — if step 6.5's diff ever shows a mismatch here,
 * that's a real signal (one of those accounts started playing), not a
 * transcription error in this port.
 */
function calcRatings(winner, loser, score = '', handicap = null) {
  const wR = winner.rating ?? START_RATING;
  const lR = loser.rating ?? START_RATING;

  const Kw = kFactor(winner.gamesPlayed ?? 0);
  const Kl = kFactor(loser.gamesPlayed ?? 0);
  const ew = expected(wR, lR);
  const el = expected(lR, wR);
  const m = scoreMultiplier(score);

  const gap = lR - wR;
  const gt = Math.tanh(gap / UPSET_GAP_SCALE);
  const hm = gt >= 0 ? 1 + gt * (UPSET_BOOST - 1) : 1 + gt * (1 - UPSET_DAMPEN);

  const dw = Math.round(Kw * (1 - ew) * m * hm);
  const dl = Math.round(Kl * (0 - el) * m);

  return {
    winnerNew: Math.max(100, Math.min(1600, wR + dw)),
    loserNew: Math.max(100, Math.min(1600, lR + dl)),
    winnerDelta: dw,
    loserDelta: dl,
    scoreMultiplier: m,
    upsetMultiplier: hm,
    winnerStartRating: wR,
    loserStartRating: lR
  };
}

module.exports = {
  START_RATING,
  K_START,
  K_FLOOR,
  K_DECAY,
  kFactor,
  expected,
  scoreMultiplier,
  UPSET_DAMPEN,
  UPSET_BOOST,
  UPSET_GAP_SCALE,
  calcRatings
};
