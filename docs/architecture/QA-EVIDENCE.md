# Section I evidence (automated QA)

Date: 2026-09-29. What each automated release check proves and where it lives. Human and deploy
gates are in `RELEASE-GATES.md`.

| Task | Evidence | Result |
| --- | --- | --- |
| QA-001 10-browser full match | `pnpm test:e2e:live` with `LIVE_PLAYERS=10 LIVE_FULL=1`: ten Chromium contexts against `wrangler dev` play one Grand match through the real UI; after **every** action all ten clients must show the same game version and state fingerprint | partial, see "Live runs" |
| QA-002 reconnect chaos | Same suite: a player's tab is closed and reopened (rejoin, same seat), then a second tab for the same account replaces the first ("Opened somewhere else"), with convergence asserted after each. During the first local 10-browser run the Worker was also hot-reloaded five times by code edits (the runtime restarted, every socket dropped and reconnected, Durable Object state reloaded from storage) and all ten clients kept converging through turn 463 | pass |
| QA-003 persistence/deadline failures | `app/worker/src/persistence-faults.test.ts`: storage failures injected inside a command commit and a turn-timeout commit roll back completely; the retry (same actionId or same due deadline) applies exactly once, including through a fresh adapter | pass |
| QA-004 1000+ cross-board rematches | `app/worker/src/rematch-soak.test.ts`: 1,000 rematches in one room alternating Standard and Grand; every new game is fresh (id, version 1, board, cash, owners, eliminations, trades) and replayed commands from older games are refused as stale | pass |
| QA-005 large seeded fuzz | `pnpm fuzz:production` at 100 seeds for each of 9 configurations: 900 games, 3.0 million commands (2.15M accepted, 776k refused, 41k malformed, 45k duplicate replays) | **0 invariant failures** (`PRODUCTION-FUZZ.json`) |
| QA-008 cross-browser | Smoke suite on Chromium, Firefox and WebKit in CI (Edge is Chromium) | 15/15 in CI |
| QA-011 production fuzz/sim | `production-fuzz.ts` and `production-simulator.ts` drive the real transition function; invariants: card conservation, fixed asset set, non-negative cash, version +1 per commit, refusals and malformed input change nothing, replayed actionIds are duplicates, seeds replay exactly | pass |
| QA-012 runtime/browser foundation | `pnpm test:e2e:live` runs in CI (Worker, Durable Objects, local D1, several browsers) | 1/1 in CI |
| QA-013 Collusion Guard adversarial | `app/worker/src/collusion-guard.test.ts`: private warning, retried acceptance counted once, public removal and bank return, pairs counted in both directions; fair trades, sub-floor gifts and 25%-line trades never flagged | pass |
| QA-007 / QA-009 | Reviews with fixes: `QA-007-ACCESSIBILITY-REVIEW.md`, `QA-009-SECURITY-REVIEW.md` | no blocker |

Economy with the final mechanics (feeds QA-015): `GRAND-G.md`, 9/9 configurations inside the
SPIKE-008 bands at 250 seeds.

## Live runs

- 4 browsers, 60 actions, chat, rejoin and session replacement: pass (local and CI).
- 4 browsers, **complete Standard match**: finished after 439 actions (v443) in 3.4 minutes;
  every client converged after every action, all four showed the final standings, then rejoin
  and replacement passed.
- 10 browsers, Standard, driver without trading: 4,700+ actions (turn 2018) all converged, but
  nobody went bankrupt, because without trades almost no set completes. Recorded as a balance
  caveat in `RELEASE-GATES.md`; the driver now trades like the simulation bots.
- 10 browsers, Grand, driver with trading: the first attempt found the trade-dialog overflow
  (fixed, FINAL-AUDIT #9) after 600 converged actions with six players out. The rerun played
  **4,391 committed actions to turn 1793, with 8 of 10 players bankrupted through the real UI and
  all ten clients converged after every action, with no error**. It stopped at its 3-hour cap in
  a two-player endgame: the scripted driver slows as the survivors own most deeds (it rescans
  them every turn), so it did not reach the final standings.

QA-001 status: convergence through a long 10-browser match is shown and a complete match is
shown with 4 browsers, but a *complete* 10-browser match is not yet recorded. Close it with the
GRAND-005 human session at 10 players (or a longer unattended run).
