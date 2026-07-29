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
- **Rating system:** ELO-style `calcRatings()` — upset wins (lower-rated player beats higher-rated) get boosted rating change (1.4×), expected wins get dampened (0.6×). This now fires automatically on every game based on pre-game ratings alone, independent of whether handicap mode was used for the match (previously it only fired inside explicit handicap-mode games — see Recent Work).
- **Tiers & badges:** skill tiers (e.g. "Developing" = 4.00–6.99 rating) with modal displays, badge unlocks.
- **Rankings/leaderboard:** weekly + all-time, filterable by sport (skier vs. boarder).
- **Profiles:** stats, rating history chart, paginated game history (10/page).
- **Social:** friends list/requests, direct chat with unread badges, explore feed (video clips, comments, swipe navigation).
- **Tournaments:** bracket and round-robin formats.
- **Challenges:** head-to-head challenge/invite flow.
- **Admin dashboard:** stats, users, games, ratings, raw data panels.
- **Mobile polish:** iOS Safari keyboard/safe-area fixes, per-tab scroll position persistence.

## Current Focus / Recent Work

As of **2026-07-29**, work has centered on stabilizing the **live judged-game state machine** and verifying the rating engine. Most recent commits (newest first):

0d. Fixed live game instant-forfeit on page reload (`719bcc0`). Found while edge-case testing the live-game abandon flow: `beforeunload`/`pagehide` fires the same `abandonedBy` signal for an actual tab close and for a simple reload, and the opponent's snapshot handler committed a forfeit (with real rating deltas via `finishLive()`) within 1-3 seconds — well before the reloading client could reconnect. Reproduced directly against production Firestore: a two-player match where one side reloaded before playing a single trick ended in a real, permanent rating loss for the reloader. Fixed with a grace period — the opponent now waits `ABANDON_GRACE_MS` (8s) and re-checks the live doc before committing the forfeit (`resolveAbandonIfStillPending()`), while the reconnecting client self-heals by clearing its own `abandonedBy` flag as soon as it resubscribes. Real abandonment (no reconnect) still forfeits correctly after the grace period. **Verified** by simulating both the reconnect-within-grace and no-reconnect-past-grace paths directly against Firestore (isolated test docs, cleaned up after) — reconnect now leaves the match live with no rating change; true abandonment still forfeits as before.
   - **Not yet cleaned up**: the initial repro left real pollution in production — a `QA Race Tester B` test account (0W-1L, rating 377) and a bogus forfeit game credited to `QA LiveGame Tester` (5W-0L, rating 510). Revert pending user confirmation.
0c. Fixed unsaved Edit Profile input (Bio/Home Mountain/Instagram) getting clobbered mid-typing. Found while testing the Profile tab: the Firestore `onSnapshot` listener calls `renderMyProfile()` on every snapshot (fires every ~1-1.5s under active background traffic), which unconditionally reset those three fields' `.value` to the last-saved data — so typing into any of them for longer than a second (or clicking between fields before hitting Save) silently wiped what you'd typed. Same root cause as the liveInvites/messages/tournaments overwrite races, just clobbering local unsaved form state instead of shared data. Fixed with a `_profileFormDirty` flag (set on `oninput` for all three fields, cleared on successful save or session change via `setSession`/`clearSession`) that gates the re-populate step in `renderMyProfile()` — the form is left alone while the user has unsaved edits, and resumes picking up fresh snapshot data once they save. Verified via direct `renderMyProfile()` re-render simulation mid-edit (value now survives), confirmed Save still persists correctly and clears the flag, and confirmed a fresh external update is picked up again once the form is clean.
0b. Fixed tournament invite/participant data loss under concurrent Firestore writes. Tested via the Tourneys tab: creating a tournament, inviting riders, and accepting invites was hitting the same snapshot-overwrite race as the pre-fix live-game/messages bugs — an accepted invite or added participant could silently revert within under a second if an unrelated snapshot arrived before the debounced write landed. Fixed with the same prev-state merge guard already used for `liveInvites` (see "Architecture decisions"). See "Testing Coverage" below for the full repro/verification.
0a. Rating engine (`992057b`): made the upset boost/dampen multiplier (`1.4×`/`0.6×`) always fire based on pre-game rating comparison (`winner.rating < loser.rating` etc.), instead of only when an explicit `handicap` object was passed in. Previously a plain upset win with no handicap mode got zero bonus — only handicap-mode games (an unrelated feature, letters-based head start) triggered it, via comparing `winner.id` to `handicap.higherId`. Renamed `HANDICAP_BOOST`/`HANDICAP_DAMPEN` → `UPSET_BOOST`/`UPSET_DAMPEN` and the result field `handicapMultiplier` → `upsetMultiplier` (not referenced elsewhere in the codebase). Net effect: strict zero-sum rating exchange (equal deltas for winner/loser) now only holds when both players have exactly equal ratings — any rating gap at all introduces the asymmetric multiplier, by design.
   - **Verified** with a 32-case Node unit-test script run against the extracted rating functions (no DOM dependency) covering: baseline symmetry, K-factor tiers, upset/expected multiplier firing with and without a handicap object, score multipliers, floor/ceiling clamps (100/1600), and the loser's delta never receiving the multiplier. All passing after the change.
0. Architecture fix (`1dcc53d`): moved live-game state out of the single shared `state/global` doc into its own `liveGames/{gameId}` collection, so a mid-match write can no longer collide with an unrelated write from another user (a comment, a logged game, a tournament edit). See "Architecture decisions" below. Required adding a Firestore security rule for `liveGames/{gameId}` (previously default-denied — rules aren't tracked in this repo, only in the Firebase Console).
   - **Tested 2026-07-28, two-player mode** (no judge): invite → accept → real-time board sync → trick submit → dispute (confirm/deny) → abandon/forfeit → game-over with correct rating deltas. All synced correctly, no console errors.
   - **Tested 2026-07-28, three-player judge mode**: judge accepts *before* players (waiting screen correct) → both players accept → judge picks setter → setter submits trick → judge rules landed/bailed/copy-landed/copy-missed → revenge-attempt flow (bail → revenge → landed, letter awarded correctly) → judge leaving cancels the match for both players with "result voided," ratings unchanged. All three clients stayed in sync throughout with no console errors; players never saw dispute-vote UI (judge calls every trick, as designed).
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

- **2026-07-28 — Chat messages fixed to use atomic writes; `_saveToFirestore()` now merges instead of overwriting.** Found while testing the Friends tab: two users messaging within ~1s of each other could lose one or both messages, same root cause as the live-game race (see above), just affecting `messages` on the shared `state/global` doc instead.
  - Fix: `sendMessage()` now writes new messages via `firebase.firestore.FieldValue.arrayUnion()` — atomic on Firestore's side, so it can't be clobbered by a concurrent write. `_saveToFirestore()` excludes `messages` (and `live`) from the regular debounced full save, and the write itself changed from `batch.set(docRef, copy)` to `batch.set(docRef, copy, { merge: true })` — so omitting a field now leaves it untouched server-side instead of deleting it.
  - **Not yet fixed / same risk elsewhere:** `friendRequests`, `challenges`, `pending`, explore-feed comments/likes, etc. are still written via the regular full-document save and are exposed to the identical race — they just haven't been proven to lose data the way messages were. If a similar bug is reported in one of those areas, the fix is the same pattern: targeted `arrayUnion`/dot-path update at the point of mutation, and exclude that field from the general save's `copy`.

- **2026-07-28 — Tournament invite/participant race fixed.** Found while testing the Tourneys tab: accepting a tournament invite (or being added as a participant) could get silently reverted by an incoming Firestore snapshot arriving before the debounced write landed — same race class as live-game/messages, but `S.tournaments` had no merge protection at all (unlike `S.liveInvites`, which already guards against this).
  - Fix: in the global `onSnapshot` handler, added a merge step for `S.tournaments` mirroring the existing `S.liveInvites` guard — before overwriting state, snapshot each tournament's previous `invitees`/`participants`; after the overwrite, restore an invitee's `accepted`/`declined` status if the incoming snapshot regressed it to `pending`, and re-add any participant present locally but missing from the incoming snapshot.
  - **Verified 2026-07-28**: reproduced the tournament bug directly (mutate `participants`/`invitees` via the real `acceptTourneyInvite()` codepath, call `save()`, watch it revert within ~300ms), applied the fix, reran the identical repro — state now stays stable indefinitely, the UI correctly reflects the accepted participants, and starting the tournament generates the bracket correctly with no console errors.

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
| Friends tab — request/accept/chat | Send friend request, accept, real-time friends-list + unread badge sync, open chat, send/receive messages — all worked correctly under normal (non-concurrent) use | Verified 2026-07-28, no fix needed |
| Friends tab — chat messages (concurrent writes) | Data loss bug: two users sending a message within ~1s of each other could silently drop one or both — reproduced directly via server reads before the fix. Root cause: `messages` still lived on the single shared `state/global` doc, written via a full-document `.set()` (same race class as the pre-refactor live-game bug). Fixed by writing new messages via an atomic `FieldValue.arrayUnion()` update instead, and excluding `messages`/`live` from the regular full-document save (now `.set(copy, {merge:true})` so omitted fields are left untouched, not deleted). Re-verified with the same two-tab concurrent-send repro (including a real UI test, not just console-injected) — both messages now arrive on both sides every time. | Fixed 2026-07-28 |
| Riders tab — search / sport filter / friend request / profile link | Name+location+resort search, ⛷️/🏂/All sport filter, Add/Cancel friend request (button state + toast), and Profile link all worked correctly, no console errors. | Verified 2026-07-28, no fix needed |
| Riders tab — provisional badge missing | Riders with <5 games (`RATED_THRESHOLD`) showed a full tier badge (e.g. "🎿 Developing") and no `*` on their rating, instead of "⏳ Provisional X/5" — because `renderPlayers()` called `tier(p.rating)` / `ratingDisplay(p.rating)` without the `gamesPlayed` argument. Same bug (missing `gamesPlayed` arg) also hit the in-game player panel (`playerPanel()`), the player-picker dropdown (`renderPickerList()`), and the friends list inside the profile modal. Fixed by passing `p.gamesPlayed`/`player.gamesPlayed`/`f.gamesPlayed` at all four call sites and rendering the same "⏳ Provisional · X/5" badge used on the Rankings tab when `t.provisional` is true. Re-verified live in-browser: provisional riders now show the badge and `*`, non-provisional riders unchanged, no console errors. | Fixed 2026-07-28 |
| Riders tab / Profile — stats inconsistency for seed accounts | Alice, Bob, and Judge (top-3 seed/demo accounts) show cached `wins`/`losses`/`gamesPlayed` on the Riders and Rankings tabs (e.g. Alice "3W 2L · 5 games"), but their Profile modal — which deliberately recomputes stats from the actual `S.games` log for consistency (see code comment at index.html:8560) — shows 0 for everything, because no matching game records exist for these three. Likely stale fixture data from before the game-log system existed; not caused by the Riders tab's own logic, but demonstrates the cached counters can silently drift from the authoritative game log with no error surfaced anywhere. | Found 2026-07-28, not yet fixed |
| Explore tab — like / comment (add + delete) / share / post clip (link) | Like toggled + count synced correctly; posted, viewed, and deleted a comment with live count updates; Share copied a link/caption with a confirmation toast; Post Clip modal (paste-link path) posted a YouTube clip that rendered correctly in-feed with delete option. All worked, no console errors. One native video (Cloudinary-hosted `.mov`) rendered as a black frame, but traced to the automated browser tool's own network access (a bare `<video>` pointing at the same URL also failed to load there, while `curl` to the identical URL succeeded) — not an app bug. | Verified 2026-07-28, no fix needed |
| Tourneys tab — create / detail / start guard | Create Tournament modal (name, format toggle, date/resort, participant picker) worked correctly; created tournament appeared in "My Tournaments" with correct format/count/status; detail modal showed participants + "Waiting for" list; Start Tournament correctly blocked with <3 accepted participants. | Verified 2026-07-28, no fix needed |
| Tourneys tab — invite acceptance / participant data loss | Accepting a tournament invite (or being added as a participant) could get silently reverted by a Firestore snapshot race — see "Architecture decisions" above for root cause and fix. | Fixed 2026-07-28 |

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
*Last updated: 2026-07-29 (Edge-case tested the live-game abandon/reload flow — found and fixed page-reload triggering an instant, unrecoverable forfeit via the `beforeunload` `abandonedBy` signal; fixed with an 8s grace period + reconnect self-heal, committed as `719bcc0`. Production has leftover pollution from the repro — a `QA Race Tester B` test account and a bogus forfeit game against `QA LiveGame Tester` — revert pending user confirmation. Prior: Profile tab tested — found and fixed the Edit Profile form clobbering unsaved Bio/Home Mountain/Instagram input on a mid-edit snapshot re-render, via a `_profileFormDirty` guard in `renderMyProfile()`; not yet committed as of this note. Earlier: live-game refactor + setter-vote fix committed as `1dcc53d`, rating-engine upset multiplier as `992057b`, chat-message data-loss fix as `04327a5`, provisional-badge fix as `3f5d720`, all verified in-browser and pushed; Explore tab tested — like/comment/share/post-clip all verified working, no fixes needed; Tourneys tab tested — found and fixed a tournament-invite/participant data-loss race (same class of bug as `friendRequests`/`challenges`/`pending`, still unfixed there), not yet committed; seed-account stats-vs-Profile inconsistency still found, not yet fixed). Update this file after any further app changes so future sessions start with accurate context.*
