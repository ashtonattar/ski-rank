'use strict';

// Ported from index.html:7367-7457 (calcStreaks, checkBadges, BADGE_DEFS ids).
// The client version reads S.games (one in-memory array) and mutates a live
// object reference; here both are pure functions over data the caller
// supplies, because after this migration `games` lives in its own
// collection and the server doesn't hold a synced in-memory copy.

const BADGE_IDS = [
  'first_game', 'games_25',
  'first_win', 'wins_10', 'wins_25',
  'clean_sweep',
  'streak_3', 'streak_5', 'streak_10',
  'tier_developing', 'tier_intermediate', 'tier_advanced', 'tier_expert', 'tier_elite',
  'with_clip', 'resort_rat',
  'tourney_champ'
];

/**
 * games: array of { winnerId, loserId, date } for this player, any order —
 * sorted internally, same as the client's S.games.filter(...).sort(...).
 */
function calcStreaks(playerId, games) {
  const relevant = games
    .filter((g) => g.winnerId === playerId || g.loserId === playerId)
    .sort((a, b) => a.date - b.date);
  if (!relevant.length) return { current: 0, best: 0, type: null };

  const type = relevant[relevant.length - 1].winnerId === playerId ? 'W' : 'L';
  let current = 0;
  for (let i = relevant.length - 1; i >= 0; i--) {
    if ((relevant[i].winnerId === playerId ? 'W' : 'L') === type) current++;
    else break;
  }

  let best = 0;
  let run = 0;
  for (const g of relevant) {
    if (g.winnerId === playerId) {
      run++;
      best = Math.max(best, run);
    } else {
      run = 0;
    }
  }
  return { current, best, type };
}

/**
 * player: the player's state AFTER this game's counters have been applied
 *   (gamesPlayed, wins already incremented) — mirrors the client calling
 *   checkBadges() after winner.wins++/gamesPlayed++ have already run.
 * game: { winnerId, loserId, score, clipUrl, resort, player1EndRating, player2EndRating }
 * priorGames: this player's games BEFORE this one (for streak calc) — the
 *   new game is appended here internally so the just-played result counts.
 * existingBadges: string[] the player already has.
 *
 * Returns { badges: string[], earned: string[] } — badges is the full
 * deduped set to persist; earned is just the newly-unlocked ones.
 */
function checkBadgesServer(playerId, player, game, priorGames, existingBadges) {
  const badges = Array.isArray(existingBadges) ? [...existingBadges] : [];
  const earned = [];
  const has = (id) => badges.includes(id);
  const award = (id) => {
    if (!has(id)) {
      badges.push(id);
      earned.push(id);
    }
  };

  const isWinner = game.winnerId === playerId;

  if (player.gamesPlayed >= 1) award('first_game');
  if (player.gamesPlayed >= 25) award('games_25');

  if (player.wins >= 1) award('first_win');
  if (player.wins >= 10) award('wins_10');
  if (player.wins >= 25) award('wins_25');

  if (isWinner && game.score && game.score.startsWith('0')) award('clean_sweep');

  const gamesForStreak = [...priorGames, { winnerId: game.winnerId, loserId: game.loserId, date: game.date }];
  const sk = calcStreaks(playerId, gamesForStreak);
  if (sk.best >= 3) award('streak_3');
  if (sk.best >= 5) award('streak_5');
  if (sk.best >= 10) award('streak_10');

  const r = (isWinner ? game.player1EndRating : game.player2EndRating) / 100;
  if (r >= 4) award('tier_developing');
  if (r >= 7) award('tier_intermediate');
  if (r >= 10) award('tier_advanced');
  if (r >= 12) award('tier_expert');
  if (r >= 14) award('tier_elite');

  if (game.clipUrl) award('with_clip');
  if (game.resort) award('resort_rat');

  return { badges, earned };
}

module.exports = { BADGE_IDS, calcStreaks, checkBadgesServer };
