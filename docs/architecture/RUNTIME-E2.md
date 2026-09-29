# Runtime pass E2 — room lifecycle, social, finalization, and hardening

**Date:** 2026-09-29
**Tasks:** RT-009 … RT-018
**Status:** Decisions taken under the product owner's standing instruction to adopt the recommended option. RUNTIME-E1 and the frozen ADRs still apply.

## RT-009 Host migration

- The host is persisted. If the host leaves the lobby, or their reconnect lease expires, hosting moves to the lowest-seat member who is currently connected. The move is re-evaluated on every room interaction and alarm.
- Only the host can configure, start, pause, resume, and rematch. There is no separate co-host role.

## RT-010 Pause and resume

- Only the host can pause, and only while a game is in progress.
- While paused:
  - every game command is refused (`ROOM_PAUSED`);
  - chat keeps working;
  - no alarm fires.
- **Resume** shifts every live deadline by the time spent paused. That covers the turn clock in the room table and the auction and debt deadlines inside game state (the latter through the game-core system command `RESUME_CLOCKS`). Nobody loses time to a pause.

## RT-011 Chat

- Members may chat at any time; spectators can read but not post.
- Messages are 1–280 characters, trimmed, with control characters stripped.
- Rate limit: five messages per ten seconds per member, enforced from persisted timestamps.
- Only the last 100 messages are kept, and every snapshot includes them.
- Chat never touches game state.

## RT-012 Finalization to D1

- The transition that ends a game also writes a `finalizations` row in the same transaction: game id, board, settings, outcome, and eliminations.
- After commit, the room delivers that row to D1 idempotently:
  - `finished_games` keyed by `game_id`, written with `INSERT OR IGNORE`;
  - `finished_game_players` keyed by `(game_id, user_id)`.
- A failed delivery keeps the row and retries on a 60 s alarm. Delivery is marked done only after D1 confirms.

## RT-013 Rematch

- After a game ends, the host's `REMATCH` returns the room to the lobby with the same members and settings, and every ready flag cleared. The next start creates a fresh `gameId` and `GameState`.
- The old game's rows, applied actions, and pending finalization are kept untouched, keyed by their own `gameId`.
- Old-game commands fail `STALE_GAME`.

## RT-014 Projection and delivery

- Every commit is fanned out as a per-viewer `STATE` carrying `gameVersion` and a diagnostic `stateHash`. Clients ignore any state older than what they hold.
- Catch-up is a full `RESYNC`, since snapshots are small.

## RT-015 Abuse bounds

- **Message size:** capped at 16 KB (from E1).
- **Command rate:** 20 per 10 s per socket; excess messages are refused (`RATE_LIMITED`).
- **Spectators:** at most 20 per room.
- **Room creation:** 10 per user per hour, recorded in D1.
- The spike room, its routes, and its measurement commands are removed (a `deleted_classes` migration).

## RT-016 Retention

- Applied actions: keep the latest 500 for the current game, and delete an ended game's actions once it is finalized.
- Chat: the last 100 messages.
- Diagnostics: the last 500 entries.
- OAuth transactions: expired ones are deleted whenever a new one is created.
- Pending finalizations are never deleted before delivery.

## RT-017 Integrity evidence

- Fair-play evidence already lives in canonical state (`ruleState.fairPlay`, INT-002), so it is persisted exactly once per committed action and replays safely.
- Removals are public room notices; warnings are projected only to their pair.
- Finalization carries the incidents to D1 for later review.

## RT-018 Diagnostics

- A bounded `diagnostics` table records `(gameId, gameVersion, actionId, command type, actor, outcome, time)` for every command, rejections included.
- It stores no payload secrets, cookies, or tokens.
- Every entry carries the resulting `stateHash` (FNV-1a over the canonical JSON), so a failure can be matched to an exact state.
