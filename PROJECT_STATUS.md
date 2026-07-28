# Slope Battles (ski-rank) — Project Status

> Living document. Update this file whenever meaningful changes are made to the app (features, fixes, architecture decisions). Keep the "Recent Work" section current and prune it periodically into a summarized history further down.

## Overview

- **App name:** Slope Battles — Freestyle Trick Duels
- **Repo:** `ashtonattar/ski-rank` (GitHub), single `main` branch
- **What it is:** A web app for freestyle skiers/snowboarders to log 1v1 trick "duels," get judged/scored live, and build a competitive ranking (ELO-style rating, tiers, badges, leaderboards, tournaments).

## Tech Stack & Architecture

- **Entirely client-side, single-file app:** all HTML/CSS/JS lives in `index.html` (~11,700 lines). No build step, no bundler, no `package.json`.
- **Backend:** Firebase (via CDN, `firebase-*-compat.js` v9.23.0)
  - **Firestore** — primary data store and real-time sync.
    - `state/global` doc — rankings, profiles, tournaments, chat, invites, etc. Written via a debounced full-document `.set()` (see `save()`/`_saveToFirestore()`).
    - `liveGames/{gameId}` collection — one doc per active/finished 1v1 match (split out from the global doc — see "Architecture decisions" below). Written via `saveLiveGame()`; `gameId` is the id of the invite that started the game.
  - **Firebase Auth** — email/password sign-in, plus a local/guest mode fallback (password hash stored when no Firebase UID).
  - **Firebase Storage** — stores uploaded trick clips.
- **Local dev server:** `python3 -m http.server 3400` (config in `.claude/launch.json`).
- **`.env`:** holds `GITHUB_TOKEN` (gitignored) — used for repo/deploy tooling, not consumed by the app itself.
- Firebase web API key is intentionally hardcoded client-side in `index.html` (~line 3345) — normal for Firebase web apps; security boundary is Firestore rules, not key secrecy.

## Core Features

- **Auth:** sign in / sign up / guest mode, nav bar reflects auth state.
- **Trick builder:** pick trick components by category (Grabs, Spins, Flips, etc.) and difficulty.
- **Live 1v1 games:** setup screen, optional neutral judge invite, pick-setter vote phase, dispute phase, forfeit-on-abandon, judge/player-left screens, reconnect handling via Firestore snapshots + a polling fallback.
- **Rating system:** ELO-style `calcRatings()` — upset wins (lower-rated player beats higher-rated) get boosted rating change (1.4×), expected wins get dampened (0.6×).
- **Tiers & badges:** skill tiers (e.g. "Developing" = 4.00–6.99 rating) with modal displays, badge unlocks.
- **Rankings/leaderboard:** weekly + all-time, filterable by sport (skier vs. boarder).
- **Profiles:** stats, rating history chart, paginated game history (10/page).
- **Social:** friends list/requests, direct chat with unread badges, explore feed (video clips, comments, swipe navigation).
- **Tournaments:** bracket and round-robin formats.
- **Challenges:** head-to-head challenge/invite flow.
- **Admin dashboard:** stats, users, games, ratings, raw data panels.
- **Mobile polish:** iOS Safari keyboard/safe-area fixes, per-tab scroll position persistence.

## Current Focus / Recent Work

As of **2026-07-28**, work has centered on stabilizing the **live judged-game state machine**. Most recent commits (newest first):

0. **(uncommitted)** Architecture fix: moved live-game state out of the single shared `state/global` doc into its own `liveGames/{gameId}` collection, so a mid-match write can no longer collide with an unrelated write from another user (a comment, a logged game, a tournament edit). See "Architecture decisions" below. **Tested 2026-07-28** with two real accounts in separate browser tabs against production Firestore: invite → accept → real-time board sync → trick submit → dispute (confirm/deny) → abandon/forfeit → game-over with correct rating deltas, all synced correctly with no console errors. Required adding a Firestore security rule for `liveGames/{gameId}` (previously default-denied — rules aren't tracked in this repo, only in the Firebase Console).
1. Fix live game permanently stuck in dispute phase, and mislabeled dispute caller
2. Fix Rankings table showing literal "undefined" in Games column
3. Fix nav bar not updating to signed-in state after login from guest mode
4. Fix auth submit buttons stuck in loading state on reopen
5. Fix live game being force-cancelled on page reload
6. Fix 6 reported UI bugs
7. Improve judge waiting screen when P2 hasn't accepted yet

Earlier waves of work (see `git log` for full history) covered: judge invite/waiting-room flow, abandon/forfeit handling, comments on the explore feed, friends/riders list, rankings sport-filter UX, and profile pagination.

## Architecture decisions

- **2026-07-28 — Live games split into their own Firestore doc.** Previously the entire app (players, games, tournaments, messages, *and* the currently-active 1v1 match) was one `state/global` doc, saved via a full-document `.set()` on every change. This meant the whole app could only support **one live game at a time, globally**, and any two users writing within the same ~500ms window (e.g. one submitting a dispute vote while another posts an explore comment) could clobber each other — the actual root cause behind several of the bug-fix commits above (rankings showing "undefined", tournament status reverting, invite status flipping back to pending).
  - Fix: `S.live` is now backed by `liveGames/{gameId}` (`gameId` = the id of the invite that started the match). `save()` auto-routes `S.live` there via `saveLiveGame()`; the ~12 gameplay functions (`setterSubmitTrick`, `voteForSetter`, `judgePickSetter`, dispute handlers, `finishLive`, etc.) were untouched since they all go through the same `save()` entrypoint.
  - New/changed functions: `subscribeLiveGame(gameId)` / `unsubscribeLiveGame()` (dedicated per-game `onSnapshot` listener, replacing the live-game logic that used to live inline in the global listener), `_tryResumeLiveGame()` (resumes the right game after reload/relogin by reading `gameId` off an accepted invite in `S.liveInvites`, which still lives on the global doc), `saveLiveGame(liveObj, immediate)`.
  - Multiple concurrent live games across different pairs of users are now possible for the first time (previously impossible by construction).
  - **Not yet fixed / follow-up candidates:** `_gameOverDismissed`, `_disputeResolved`, `_abandonHandled` are still local, unsynced JS flags gating shared game state — a real double-resolve race in the dispute flow (both clients calling `resolveDisputeIfReady()` independently) still exists in principle, just with lower blast radius now that it only affects the two/three people in that one match instead of the whole app's shared doc.
  - **Fixed 2026-07-28:** `voteForSetter()` (the "who sets first" vote) had the same class of bug the dispute-phase fix (`54ae785`) addressed — it only resolved from the vote-casting client's own click handler, so two near-simultaneous votes could leave the game stuck on the vote screen. Fixed the same way: votes now write via a targeted `setterVotes.{uid}` field update instead of a full save, and resolution was extracted into `resolveSetterVoteIfReady()` (guarded by `_setterVoteResolved`), called both from `voteForSetter()` and from the live-game snapshot handler. Verified in the same two-tab test — both players voting simultaneously for the same option now resolves instantly with no nudge needed.

## Testing Coverage & Bugs Found

> Note: there is no committed Playwright test suite in this repo (no `*.spec.ts`/`playwright.config.*` found). The table below is reconstructed from recent bug-fix commits (browser-driven manual/agent testing), grouped by app area, as a stand-in until real Playwright specs exist. Update this table directly as new areas get tested going forward.

| App Area | Bug Found | Status |
|---|---|---|
| Live game — dispute phase | Game could get permanently stuck in dispute phase; dispute caller was mislabeled | Fixed (`54ae785`) |
| Live game — reconnect/reload | Live game was force-cancelled on page reload instead of reconnecting | Fixed (`39774ba`) |
| Rankings table | "Games" column showed literal string `undefined` instead of a count | Fixed (`4b08f97`) |
| Nav bar / auth | Nav bar didn't update to signed-in state after logging in from guest mode | Fixed (`5fc886b`) |
| Auth forms | Sign-in/sign-up submit buttons stayed stuck in loading state if the form was reopened | Fixed (`f33e596`) |
| General UI (6 reports) | Batch of 6 reported UI bugs (see `a804dfa` for details) | Fixed (`a804dfa`) |
| Judge waiting screen | Waiting screen didn't clearly reflect state while P2 hadn't yet accepted | Fixed (`14d09dd`) |

## Known Gotchas

- No automated test suite — verify changes by running the local server and manually testing in-browser (multiple tabs/incognito to simulate player vs. judge). The Firebase project (`skirank-b3b70`) is the real production backend — there is no staging environment, so manual multi-tab testing writes to real data.
- Live-game bugs are almost always Firestore snapshot race conditions (stale reads clobbering fresh local state) — check `_firestoreUnsub`/`_liveGameUnsub` and their `onSnapshot` handlers first.
- Because it's one giant file, search by function name (e.g. `grep -n "function renderX"`) rather than assuming a modular file layout.

## How to Run

```
python3 -m http.server 3400
# open http://localhost:3400
```

---
*Last updated: 2026-07-28 (moved live games to their own `liveGames/{gameId}` Firestore collection — see Architecture decisions). Update this file after any further app changes so future sessions start with accurate context.*
