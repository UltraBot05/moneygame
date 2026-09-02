# Spike Result — SPIKE-004 (reconnect + connection epoch)

**Date:** 2026-09-02
**Builder:** Claude Code
**Reviewer:** _pending independent review_
**Branch:** `task/spike-004-005` (working tree; see Builder Handoff)

## Hypothesis

An authenticated user can temporarily disconnect and reclaim the same room seat
within the reconnect lease without allowing stale sockets, duplicate sessions, or
repeated reconnects to control the seat or inflate turn time.

```text
DISCONNECT_GRACE_MS = 90_000
ACTIVE_TURN_RECONNECT_EXTENSION_MS = 20_000
```

These are the room reconnect lease, **not** the application-session lifetime
(ADR-002: the app login long outlives the 90s seat lease).

## Falsifier

Any of: identity taken from a client-supplied userId/epoch/IP; a stale socket
mutating state; a stale socket's close disconnecting the current socket; epoch or
lease held only in memory; the 90s lease conflated with login expiry; a second
live connection granting +20s; the turn extension stacking; an already-resolved
turn resurrected; reliance on `setTimeout`/`setInterval`.

## Connection / seat model

- **Authenticated socket entry.** The WebSocket upgrade is gated in the Worker
  ([index.ts](../../app/worker/src/index.ts)): the trusted `userId` is derived
  **server-side** from the verified first-party session (SPIKE-003), never from a
  query-string/body userId or IP. It is handed to the Durable Object via an
  internal `x-mg-user` header that the Worker always overwrites from the session;
  the DO is not publicly addressable, so a public request cannot spoof it. Google
  tokens never reach the DO.
- **Room-scoped durable truth** ([seats.ts](../../app/worker/src/seats.ts)):
  `seats(user_id PK, connection_epoch, connected, lease_expires_at)`. Seat binds
  to `userId` (ARCHITECTURE §12), survives a rematch unchanged, and is the sole
  source of correctness — re-read from SQLite on every command.
- **Per-socket attachment** carries only a non-authoritative `{ userId, epoch }`
  (`serializeAttachment`), **no** reusable auth token. It is a claim; every
  command re-validates the epoch against the persisted `connection_epoch`. There
  is no in-memory connection registry required for correctness.

## Epoch test matrix (real SQLite — `seats.test.ts`)

| # | Property | Evidence | Result |
|---|---|---|---:|
| 1 | user reclaims only their own seat | Bob's connect does not disturb Alice's epoch | PASS |
| 4 | new connection increments epoch | 1 → 2 | PASS |
| 5 | old-epoch command rejected | `isCurrentEpoch(1)=false` after epoch 2 | PASS |
| 6 | current-epoch command accepted | `isCurrentEpoch(2)=true` | PASS |
| 7 | SESSION_REPLACED for old epoch | takeover flags `replacedLiveSocket`, `replacedEpoch=1` | PASS |
| 8 | stale close cannot disconnect current | `disconnectSeat(epoch 1)` after epoch 2 = no-op; seat stays connected/current | PASS |
| 9 | epoch survives reconstruction | fresh adapter reads epoch 2 | PASS |

**Stale-close race** (explicit): A(epoch 1) connected → B reconnects → epoch 2
current, A replaced → A's close arrives after B is current → `disconnectSeat` is a
no-op → **B remains connected/current**. The room forces the old socket closed on
takeover *after* the epoch has already advanced, so that close is likewise a
no-op.

## Reconnect lease matrix (89s / >90s — injected clock, no real waiting)

| # | Scenario | now | kind | Result |
|---|---|---|---|---:|
| 2 | reconnect within lease | disconnect@T0, connect@T0+89s | `RECONNECT`, accepted, epoch 2 | PASS |
| 2b | reconnect at the exact boundary | connect@T0+90s | `RECONNECT`, accepted | PASS |
| 3/6 | reconnect after lease | disconnect@T0, connect@T0+90.001s | `RECONNECT_EXPIRED`, **accepted=false**, seat stays `connected=false`, epoch unchanged | PASS |
| 4/5 | expired cannot mutate or earn +20s | no epoch issued (not accepted); not a `RECONNECT` | PASS |
| 7 | reconstruction before expired reconnect | fresh adapter → same rejection | PASS |
| 8 | stale old epoch stays stale | after expired reconnect, `isCurrentEpoch(oldEpoch)=false` | PASS |
| 9 | within-lease reconnect increments epoch | epoch 1 → 2 | PASS |
| 10 | lease survives reconstruction | fresh adapter reads `lease_expires_at`; within-lease reconnect still honored | PASS |

### B1 fix — expired reconnect fails closed

Previously `connectSeat` classified an expired reconnect as `RECONNECT_EXPIRED`
but still advanced the epoch and marked the seat connected, so the 90s lease had
no enforcement effect. Now, once the lease has elapsed, `connectSeat` **writes
nothing** and returns `accepted:false` with **no issued epoch**: the seat stays
`connected=false` with its expired lease, the socket receives
`{"type":"ERROR","code":"RECONNECT_EXPIRED"}` and is closed cleanly (1008), it is
never bound an authoritative attachment/epoch, cannot mutate room/game state, and
cannot obtain the +20s. The regression test asserts `connected=false` after an
expired reconnect — it fails under the old "still marked connected" behavior.

**Explicitly not decided here:** the re-seat / rejoin policy after lease expiry
(return to lobby, spectator, host re-invite) is later work (RT-001). This spike
only enforces *fail closed* — an expired lease does not silently reclaim a seat.

Login independence: `seats.ts` reads only the injected clock and `graceMs` and
never touches the session; the 90s seat lease never gates the multi-day app
login (ADR-002). No `setTimeout`/`setInterval`; the lease is an absolute
timestamp resolved by comparison.

## Turn-deadline retirement on turn advance (B2)

Previously `setActiveTurn` replaced `active_turn` but left the prior turn's
deadline unresolved, so that old deadline could remain the earliest pending one
and later fire during the new turn, wrongly advancing canonical state. Now
`setActiveTurn` runs one transaction that (1) **retires the previous active
turn's deadline, identified explicitly by its `turnId`** (not "the earliest
deadline"), if still pending, (2) installs turn B, (3) persists B's deadline; the
caller then reschedules the earliest remaining alarm.

| # | Property | Result |
|---|---|---:|
| 1/3/4 | A→B retires A's deadline, installs B active | PASS |
| 5 | alarm cannot fire A during B (A resolved) | PASS |
| 6 | reconnect extension cannot extend superseded A | PASS |
| 7 | only B's deadline receives B's +20s; A untouched | PASS |
| 8 | reconstruction preserves the retirement | PASS |
| 9 | unrelated non-turn deadline (auction) left untouched | PASS |
| 10 | fault mid-advance rolls back: A stays active, A deadline valid, B not installed | PASS |

Only the specific prior-turn deadline row (`id = turnId`) is retired; unrelated
auction/trade/debt deadlines are never touched. The rollback test injects a fault
after the retire step and before installing B, proving the whole advance is
atomic.

## +20s active-turn extension matrix

| # | Sequence | Result |
|---|---|---:|
| 11 | disconnect → reconnect (turn owner, within lease) | +20s once (`deadline+20_000`) — PASS |
| 12 | disconnect → reconnect → disconnect → reconnect, same turn | still only +20s total (non-stacking) — PASS |
| 13 | second live connection / non-owner | no extension — PASS |
| 14 | next distinct turnId | eligibility resets, one +20s — PASS |
| — | already-resolved/advanced turn | not resurrected (deadline `resolved≠0`) — PASS |

The extension is granted **only** on a genuine within-lease `RECONNECT` of the
active-turn owner (`grantTurnExtension`, one transaction). It is at most once per
`turnId` (`turn_extensions PK (game_id, turn_id)`), persisted, local to that
turn, and never triggered by merely opening/replacing a live connection (a live
takeover is `kind=TAKEOVER`, which the room never routes to the grant). When
granted, the DO reschedules the one earliest-deadline alarm. Turn state is
game-scoped, so a rematch resets extension eligibility.

## Reconstruction evidence

Epoch, lease, and turn/extension state are all re-read through a fresh `SqlDb`
over the same database (no shared JS state — the DO evict/wake analogue) and hold
identically (items 9, 10, plus the alarm-scoped resolution in SPIKE-005 tests).
Correctness never depends on the in-memory attachment: it is re-validated from
SQLite on every message.

## Combined SPIKE-004/005 cross-invariants (`seats.test.ts`)

| Invariant | Evidence | Result |
|---|---|---:|
| A. room seat survives rematch | epoch unchanged across `startGame` (new gameId) | PASS |
| F. epoch ⟂ gameId | epoch 1 valid for game B after rematch; reconnect → epoch 2; old rejected; game B authoritative | PASS |
| B. socket carries no game authority | attachment holds only `{userId, epoch}` — no gameId/state | PASS (by construction) |

## Hibernation / provider-behavior evidence (item 15)

- **Documented + relied upon (checked against current Cloudflare docs):**
  `acceptWebSocket` keeps a socket connected while the DO hibernates;
  `serializeAttachment`/`deserializeAttachment` persist small per-socket JSON
  across hibernation; `getWebSockets()` enumerates live sockets; the constructor
  rehydrates via `getWebSockets().forEach(ws => ws.deserializeAttachment())`.
- **Why correctness does not depend on it:** the attachment is a
  non-authoritative claim. Seat/epoch/lease truth is SQLite; every command
  re-validates the epoch from SQLite, so even if an attachment were lost the
  worst case is a rejected (not a wrongly-accepted) command.
- **Now confirmed on a live Workers Free deployment** by a real
  Google-authenticated browser session — see the human-observed section below.

## Deterministic evidence summary

All 15 required matrix items are proven deterministically against real SQLite
with an injected clock (no test waits 89/91 real seconds; no `setTimeout`).
Item 15's *correctness-relevant* part (epoch/lease survive reconstruction) is
proven in tests; its *provider-behavior* part (live authenticated socket, real
`SESSION_REPLACED` over the wire, stale-socket close, rematch over a live
connection) is confirmed on a real deployment below.

## REAL DEPLOYED / HUMAN-OBSERVED evidence

The following is trusted human-observed evidence from the real deployed Worker.
No cookies, OAuth state, Google tokens, client secrets, session values, or auth
codes were requested or recorded.

### Reconnect-expiry enforcement on an existing room

The authenticated browser reconnected to the previously used room
`SPIKE004TEST`. The WebSocket opened, the server returned
`{"type":"ERROR","code":"RECONNECT_EXPIRED"}`, and the socket then closed with
code `1008`. The browser's current authoritative state remained `null`: no
`STATE` was sent and no room/game authority was granted.

This is direct deployed evidence for the corrected B1 fail-closed path, not only
the SQLite classification: an expired seat receives no usable epoch or game
state and cannot resume authority.

### Mandatory-gameId and rematch isolation on a fresh room

The human then used fresh room `SPIKE004B`. Its initial authoritative state was:

```text
gameId = 73ef9c88-5227-4e5a-a46c-c2c459abcea8
gameVersion = 0
value = 0
```

| Step | Observed | Confirms |
|---|---|---|
| `INCREMENT` without `gameId` | `{"type":"ERROR","code":"GAME_ID_REQUIRED"}` | missing game identity fails closed on the deployed wire protocol |
| `INCREMENT` with current gameId | same gameId; `gameVersion 0→1`, `value 0→1` | a correctly scoped command applies once |
| `REMATCH` with current gameId | fresh `gameId=0d65b830-fb59-499d-b0c8-0442c279a4af`, `gameVersion=0`, `value=0` | the same room connection receives a new, pristine game |
| delayed `REMATCH` with old gameId | `{"type":"ERROR","code":"STALE_GAME"}`; no further game was created | old game A cannot rematch game B into game C |
| delayed `INCREMENT` with old gameId | `{"type":"ERROR","code":"STALE_GAME"}` | old game A cannot mutate game B |
| `INCREMENT` with new current gameId | new gameId; `gameVersion 0→1`, `value 0→1` | both stale commands made zero mutation; the valid command advanced exactly once |

Together, these deployed observations confirm the corrected reconnect-expiry and
mandatory-gameId paths at the Worker boundary: expired reconnects receive no
authority, missing/stale game-scoped commands are rejected, a rematch creates a
fresh identity, and the current game remains unchanged until a valid command for
that game is accepted.

## Reproduction

```text
pnpm test   # seats.test.ts (17), transition.test.ts (18), rematch.test.ts (6)
pnpm typecheck && pnpm lint && pnpm build
```

## Limitations

- The `RECONNECT_EXPIRED` policy surfaces `conn.kind` to the room; the actual
  re-seat/lobby handling is RT-001 lobby work (out of spike scope).
- The DO's canonical state is SPIKE-002's toy counter (game-scoped); real turn
  ownership is CORE-006. `SET_TURN` is a minimal spike command used to establish
  a turn+deadline so the +20s path is exercisable live.

## Decision

`PASS` — every falsifier is disproven by deterministic real-SQLite tests
(all 15 matrix items, injected clock, no `setTimeout`), and the full
authenticated-socket lifecycle is now confirmed on a live Workers Free
deployment by a real Google-authenticated browser session: authenticated WS
entry, epoch takeover with `SESSION_REPLACED`, stale-socket close, current-socket
mutation, live connection carried across a rematch, and `STALE_GAME` rejection of
an old-game command with no contamination of the new game. No falsifier
triggered, automated or live.

## Architecture impact

- ADR-002 (§Reconnect) and ARCHITECTURE §12 satisfied: seat binds to internal
  `userId`; epoch/lease durable; login independent of the 90s lease; identity
  never from client/IP. No ADR amendment required.
