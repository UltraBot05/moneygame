# Spike Result — SPIKE-005 (rematch / board contamination)

**Date:** 2026-09-02
**Builder:** Claude Code
**Reviewer:** _pending independent review_
**Branch:** `task/spike-004-005` (working tree; see Builder Handoff)

## Hypothesis

Ending a game and starting a rematch in the same room creates a genuinely fresh
game whose mutable state cannot alias, inherit, collide with, or be mutated by
the previous game — including when switching board sizes (Standard 40 ↔ Grand 52).

## Falsifier

Any of: a reused `gameId`; a nested array/map shared between two games; a
mutation of the canonical board definition; an `actionId` in game B deduped
against game A; an old-game deadline mutating the new game; a `gameVersion`
collision across games; an old-game command accepted after a rematch; a
non-atomic new-game persistence exposing `newGameId+oldState` or the reverse;
a game-scoped table missing the `gameId` namespace.

## Fresh-game creation model

`createGame` ([game.ts](../../packages/game-core/src/game.ts)) is pure and
framework-free (ARCHITECTURE §5). It builds a `GameState` in which **every**
mutable structure — `ownership`, `buildings`, `mortgaged`, `players`, `decks`,
`deckPointers`, `trades`, `auction`, `debts`, `turn` — is freshly allocated and
shares no reference with the caller's inputs, the immutable board, or any prior
game. Board identity is copied in as primitives (`boardId`/`boardVersion`/
`tileCount`), so the board definition is never aliased into mutable state.
Deck order uses an injected deterministic seed (`mulberry32`), never
`Math.random` (PROJECT_RULES §10). No authored country/card/economy content is
invented — decks are opaque synthetic ids (`s0…`, `c0…`) and starting cash is a
labelled spike fixture, not the ADR-004 economy table.

Rich gameplay that fills these fields arrives in CORE-/RULE- tasks; this spike
uses the minimum fixtures needed to prove lifecycle isolation.

## gameId namespace model (runtime persistence)

The SPIKE-001/002 persistence was audited: it keyed `game_state` by a single
`id = 1` row, `applied_actions` by `action_id` alone, and `deadlines` by `id`
alone — **not** sufficient across independent games. Every game-scoped table in
[transition.ts](../../app/worker/src/transition.ts) now carries `game_id`:

| Table | Key | Scope |
|---|---|---|
| `game_state` | `game_id` PK | canonical counter + gameVersion per game |
| `applied_actions` | `(game_id, action_id)` PK | idempotency per game |
| `deadlines` | `(game_id, id)` PK | timers per game |
| `active_turn` / `turn_extensions` | `game_id` | turn state per game |
| `games` | `game_id` PK | immutable identity (board id/version/tile count) |
| `room_state` | `id = 1` | pointer to `current_game_id` |

Isolation is by **namespace + current-game guard**, not by fragile cleanup: old
games' rows may remain, harmlessly, because every read is filtered by `game_id`
and every command/alarm is scoped to `current_game_id`. `startGame` installs the
new `games` row, the fresh `game_state` row, and the `room_state` pointer in **one
transaction**, so no reader ever sees `newGameId+oldState` or `oldGameId+newState`.

## Mandatory gameId on every game-scoped mutation (protocol invariant)

Every client-originated game-scoped mutation must carry the originating `gameId`,
validated **before any write** by a single guard, `checkGameScoped`:

- `gameId` missing → reject `GAME_ID_REQUIRED` (never substitute the current
  game);
- `gameId` present but ≠ `current_game_id` → reject `STALE_GAME`;
- otherwise → proceed with the validated gameId.

`room.ts` routes **all** game-scoped commands through this guard before touching
persistence: `INCREMENT`, `SET_TURN`, `SET_DEADLINE`, `REMATCH`, and the
`DEADLINE_STRESS` measurement. `REMATCH` is not special-cased to "whatever game
is current" — it carries the gameId of the game being rematched, so a delayed
`REMATCH(A)` after A→B is rejected `STALE_GAME` and starts no game C. The
server-internal alarm needs no client gameId: it reads `current_game_id` and
resolves only that game's deadlines (SPIKE-002 B2 / SPIKE-005 E). The guard is
read-only, so a rejected command performs **zero** writes and creates no
`applied_actions` record.

### Stale / missing-game command matrix (after rematch A→B, incl. reconstruction)

| Command | gameId | Result | B side-effects |
|---|---|---|---|
| INCREMENT | `A` (old) | `STALE_GAME` | none — v unchanged, no record |
| INCREMENT | missing | `GAME_ID_REQUIRED` | none |
| SET_TURN | `A` | `STALE_GAME` | none |
| SET_DEADLINE | `A` | `STALE_GAME` | none |
| REMATCH | `A` | `STALE_GAME` | no game C; B stays current/unchanged |
| any of the above | `B` (current) | accepted | applies normally |
| same `actionId` X | A commits, then B | independent — B may commit X | per-game record |

The regression tests assert the reject codes and that a rejected command leaves
canonical state and `applied_actions` untouched — they fail under the previous
"missing gameId defaults to current game" / "REMATCH always applies to current"
behavior.

## Board-switch matrix (deterministic, 300 cycles each)

`game.test.ts` runs ≥300 rematch cycles per class, aggressively dirtying the
outgoing game before creating the next and asserting the fresh game is pristine,
uniquely identified, and shares no nested reference with the dirtied predecessor:

| Transition class | Cycles | New gameId each | Correct tileCount | Pristine | Result |
|---|---:|---|---|---|---:|
| Standard → Standard | 300 | yes (unique set) | 40 | yes | PASS |
| Standard → Grand | 300 | yes (unique set) | 40 ↔ 52 | yes | PASS |
| Grand → Standard | 300 | yes (unique set) | 52 ↔ 40 | yes | PASS |

## Aliasing / contamination proof (beyond initial-JSON comparison)

- Mutate game A heavily → create game B → **B pristine**.
- Mutate A **after** B exists → **B unchanged**; mutate B → **A unchanged**.
- Two games share **no** nested reference (`ownership`, `buildings`, `mortgaged`,
  `players`, `players[0]`, `decks`, `decks.surprise`, `deckPointers`, `trades`,
  `debts` all `!==`).
- The immutable board is `Object.freeze`d and heavy game mutation does **not**
  throw or change it.
- `createGame` does not alias the caller's `playerIds` array.

These fail under shallow-copy contamination.

## Persistence / idempotency / deadline isolation (real SQLite)

`rematch.test.ts` (`node:sqlite`) proves at the runtime boundary:

| Cross-invariant | Evidence | Result |
|---|---|---:|
| **D** actionId collision | `X` commits in A (v1); after rematch `X` in B **applies** (v1), not deduped; each game keeps its own `applied_actions` row; a genuine B-retry still dedups within B — after reconstruction | PASS |
| **C** old-game command | `handleIncrement("A", …)` after rematch throws `StaleGameError`; no mutation, no idempotency record, no version advance in B; nothing leaks into A either — after reconstruction | PASS |
| **E** old deadline | A deadline (game A) with current game B: alarm at `now` resolves **0** (scoped to B); B unchanged; A's deadline stays unresolved in its namespace — after reconstruction | PASS |
| gameVersion isolation | A→v3, B→v1 independently; no collision/regression | PASS |
| atomic rematch | after reconstruction, `current_game_id` and its `game_state` row are coherent (fresh v0) | PASS |

## Reconstruction evidence

Each SQLite test re-reads through a brand-new `SqlDb` over the same database
(sharing no JS state — the DO evict/wake analogue). Namespace isolation,
stale-game rejection, and old-deadline non-interference all hold after
reconstruction: correctness is durable, not resident-memory-dependent.

## REAL DEPLOYED / HUMAN-OBSERVED evidence

The following is trusted human-observed evidence from the real deployed Worker
using fresh room `SPIKE004B`. No cookies, OAuth state, Google tokens, client
secrets, session values, or auth codes were requested or recorded.

Initial authoritative state:

```text
gameId = 73ef9c88-5227-4e5a-a46c-c2c459abcea8
gameVersion = 0
value = 0
```

| Step | Observed | Result |
|---|---|---:|
| `INCREMENT` without `gameId` | `{"type":"ERROR","code":"GAME_ID_REQUIRED"}` | PASS |
| `INCREMENT` with current gameId | same gameId; `gameVersion 0→1`, `value 0→1` | PASS |
| `REMATCH` with current gameId | fresh `gameId=0d65b830-fb59-499d-b0c8-0442c279a4af`, `gameVersion=0`, `value=0`; new gameId ≠ old | PASS |
| delayed `REMATCH` with old gameId | `{"type":"ERROR","code":"STALE_GAME"}`; no game C was created | PASS |
| delayed `INCREMENT` with old gameId | `{"type":"ERROR","code":"STALE_GAME"}` | PASS |
| `INCREMENT` with new current gameId | new gameId; `gameVersion 0→1`, `value 0→1` | PASS |

The final valid increment advancing the new game from version/value `0/0` to
`1/1` proves both preceding stale old-game commands produced zero mutation. This
is live wire-level confirmation that `gameId` is mandatory, a valid rematch
creates a fresh game identity, delayed `REMATCH(A)` cannot create game C after
A→B, and delayed game-A mutations cannot contaminate game B.

## Reproduction

```text
pnpm test   # game.test.ts (9), rematch.test.ts (6), transition.test.ts (18)
pnpm typecheck && pnpm lint && pnpm build
```

## Limitations

- The DO persists SPIKE-002's toy canonical counter (`value` + `gameVersion`),
  now game-scoped; the **rich** mutable `GameState` isolation is proven in the
  pure `game-core` factory, not yet persisted end-to-end in the DO. Wiring the
  full `GameState` snapshot into the game-scoped SQLite tables is RT-005/CORE
  work; this spike proves the two isolation properties at their proper layers
  (namespace/idempotency/deadline in the DO; aliasing/fresh-state in game-core),
  which is the minimal-fixture scope the task requires.
- Old games' rows are retained (namespace isolation, no GC). A production
  retention/prune bound is later work, not required to prove isolation.
- Deck fixtures are synthetic opaque ids; authored decks are GOV-003 content.

## Decision

`PASS` — a rematch always yields a new `gameId`, correct immutable board
identity/version/tile count, a fresh `gameVersion` baseline and fully fresh
mutable state, with no aliasing across games (300+ cycles per board-switch
class), and game-scoped persistence that makes cross-game `actionId`, deadline,
gameVersion, and old-command contamination impossible — proven after
reconstruction. No falsifier triggered.

## Architecture impact

- ADR-003 §Rematch satisfied and hardened: SPIKE-005 surfaced and fixed a real
  gap — SPIKE-001/002 persistence was not game-namespaced. The minimum
  `(gameId, …)` namespace + `current_game_id` guard is now in place. No ADR
  amendment required.
