'use strict';

// The single highest-value test here (Step 5 doc, Testing #2): extract
// calcRatings() and its helpers straight out of index.html by source slice
// (not hand-retyped) and run both implementations over a few hundred
// generated inputs, asserting identical output. Catches transcription drift
// between the client and the Cloud Function port, so step 6.5's real-match
// diff is a formality instead of a debugging session.
//
// Deliberately excludes gamesPlayed === undefined from the random inputs:
// that's the one documented, intentional divergence (elo.js uses `?? 0`,
// the client does not) and is covered on its own in elo.vectors.test.js,
// not here — including it here would make this test fail on the very
// divergence it's supposed to flag as a false positive.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const serverElo = require('../lib/elo');

function extractClientElo() {
  const indexPath = path.join(__dirname, '..', '..', 'index.html');
  const html = fs.readFileSync(indexPath, 'utf8');

  const startMarker = 'const START_RATING     = 400;';
  const endMarker = 'function fmt(raw)';
  const startIdx = html.indexOf(startMarker);
  const endIdx = html.indexOf(endMarker);
  assert.ok(startIdx !== -1, 'RATING ENGINE start marker not found in index.html — has it moved/been renamed?');
  assert.ok(endIdx !== -1, 'RATING ENGINE end marker not found in index.html — has it moved/been renamed?');
  assert.ok(endIdx > startIdx, 'RATING ENGINE end marker precedes start marker — extraction range is wrong');

  const source = html.slice(startIdx, endIdx);
  const sandbox = {};
  vm.createContext(sandbox);
  vm.runInContext(`${source}\nthis.__calcRatings = calcRatings; this.__kFactor = kFactor; this.__expected = expected; this.__scoreMultiplier = scoreMultiplier;`, sandbox);
  return {
    calcRatings: sandbox.__calcRatings,
    kFactor: sandbox.__kFactor,
    expected: sandbox.__expected,
    scoreMultiplier: sandbox.__scoreMultiplier
  };
}

function mulberry32(seed) {
  let a = seed;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test('differential: client index.html calcRatings === functions/lib/elo calcRatings', () => {
  const client = extractClientElo();
  assert.strictEqual(client.kFactor(5), 32, 'sanity check on the extracted client function itself');

  const rand = mulberry32(20260919);
  const scores = ['', '0 — SKI', 'S — SKI', 'SK — SKI', 'unrecognised'];
  const N = 500;
  let compared = 0;

  for (let i = 0; i < N; i++) {
    const winner = {
      rating: rand() < 0.1 ? null : Math.round(100 + rand() * 1500),
      gamesPlayed: Math.floor(rand() * 60)
    };
    const loser = {
      rating: rand() < 0.1 ? null : Math.round(100 + rand() * 1500),
      gamesPlayed: Math.floor(rand() * 60)
    };
    const score = scores[Math.floor(rand() * scores.length)];

    // Spread into fresh plain objects in this realm before comparing: the
    // client function runs in a separate vm context, so its return value's
    // Object.prototype differs from this realm's — deepStrictEqual treats
    // that as a mismatch even when every field is equal.
    const a = { ...client.calcRatings(winner, loser, score) };
    const b = { ...serverElo.calcRatings(winner, loser, score) };

    assert.deepStrictEqual(
      b, a,
      `mismatch on input #${i}: winner=${JSON.stringify(winner)} loser=${JSON.stringify(loser)} score=${JSON.stringify(score)}\nclient=${JSON.stringify(a)}\nserver=${JSON.stringify(b)}`
    );
    compared++;
  }

  assert.strictEqual(compared, N);
});
