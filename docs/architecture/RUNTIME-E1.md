# Runtime pass E1 — production auth, identity, and room runtime

**Date:** 2026-09-29
**Tasks:** AUTH-001, DATA-001, RT-001 … RT-008
**Status:** Decisions for the production runtime. Taken under the product owner's standing instruction to adopt the recommended option. Frozen ADR-001/002/003 constraints are unchanged.

## 1. Hosting and routes

- **One Worker, one origin.** A single Cloudflare Worker serves the built web app as static assets and owns every dynamic route. First-party cookies and WebSockets therefore share one origin, so `SameSite=Lax` works without CORS.
- **Origin** comes from the request (`url.origin`) and is never hardcoded (transfer note §18).

| Route | Purpose |
|---|---|
| `GET /auth/login?room=CODE` | Start Google OIDC. With a valid session, redirect straight back. `room` is optional and sanitised. |
| `GET /auth/callback` | Consume the one-time state, verify the ID token, map `sub` to the internal `userId`, issue the session, redirect to `/r/CODE` or `/`. |
| `POST /auth/logout` | Clear the session cookie. |
| `GET /api/me` | `{ userId, displayName }`, or 401. |
| `POST /api/rooms` | Create a room owned by the caller. Returns `{ roomCode }`. |
| `GET /api/rooms/CODE/ws` | Authenticated WebSocket upgrade into that room's `GameRoom` Durable Object. |
| anything else | Static app (single-page fallback), for example `/r/CODE`. |

## 2. Identity (AUTH-001, DATA-001)

- D1 table `users(user_id, google_sub UNIQUE, display_name, created_at, last_login_at)`.
- The internal `userId` is a random UUID created on first login. Google `sub` is only the lookup key, and email is never stored.
- The display name comes from the ID token's `name` claim (scope `openid profile`). It is truncated to 32 characters, with a neutral fallback.
- The session cookie carries the internal `userId`. It stays a stateless signed token (HMAC, 7 days, Secure/HttpOnly/SameSite=Lax). Logout clears the cookie. Server-side revocation is out of scope for v1.
- An auth transaction expires after 10 minutes, and every failure returns a plain error without token material.

## 3. Rooms (RT-001)

- **Room code:** 6 characters from an unambiguous alphabet. It is the Durable Object name, so one `GameRoom` exists per code and is reused for every rematch. The creator becomes the host.
- **Lobby:**
  - A member joins by opening the room socket while the room is in the lobby and has fewer than 10 seats.
  - Members may set ready and leave (host excepted).
  - The host configures the board (Standard or Grand), starting cash, match mode, teams, and the turn timer.
  - The host starts once 3–10 members are ready.
- **Settings freeze** at start into the game's `MatchSettings`.
- **Spectators:** anyone signed in who is not a seated member (room full, or game in progress) connects read-only as a spectator and receives the public projection.

## 4. Protocol and projection (RT-002, RT-014 foundation)

- **One shared definition.** `packages/shared` holds a bounded, versioned protocol (`PROTOCOL_VERSION = 2`) with validated client messages (16 KB cap).
- **Client messages:**
  - `COMMAND` wraps a game-core command. The actor is always the socket's authenticated user, never a payload field.
  - Lobby actions.
  - `RESYNC`.
- **Server messages:** `SNAPSHOT` (room plus projected game), `EVENT` (the committed event plus its gameVersion), `REJECTED`, `ERROR`, `SESSION_REPLACED`.
- **Projection** is the only way state leaves the room:
  - draw-pile order is redacted to counts;
  - fair-play warnings are shown only to the two players involved;
  - removals and everything else are public.

## 5. Command adapter and persistence (RT-003 … RT-006)

1. **Socket authentication.** The Worker verifies the session and room code before forwarding the upgrade. It overwrites the internal identity header, so a client cannot spoof it.
2. **Per-command checks.** Every command re-checks the socket's persisted connection epoch. It then runs `applyGameplayCommand` with the room's authoritative board and card catalog, the injected RNG, and the server time.
3. **Atomic commit.** An accepted result is committed in one `transactionSync`, and only then broadcast. The transaction writes:
   - the canonical state;
   - the next `gameVersion`;
   - the applied-action record `(gameId, actionId, gameVersion)`;
   - the deadline rows.
4. **Rejections and duplicates.** A rejected command mutates nothing, and is reported only to its sender. A duplicate `actionId` returns the recorded version.
5. **Serialisation.** All SQL is synchronous inside the Durable Object, so logical mutations cannot interleave.
6. **Hibernation.** Nothing authoritative is held in memory; each message reads state from SQLite. Hibernation and wake need no special reconstruction path, and socket attachments carry only `{ userId, epoch, role }`.

## 6. Timers and alarms (RT-007)

| Deadline | Length | On expiry |
|---|---|---|
| Turn | 90 s (host may choose 45 s) | `TURN_TIMEOUT` auto-plays the turn owner's default moves: roll (a Holding attempt if held), draw a pending card, decline an unaffordable or unwanted buy (which starts the auction), end the turn. It stops where another player must decide (auction) or a debt is outstanding. |
| Auction decision | 20 s per bidder | `AUCTION_TIMEOUT` (RULE-005 auto-pass) |
| Debt | 120 s | `DEBT_TIMEOUT` (forced bankruptcy) |

- **Where deadlines live.** They are absolute timestamps. Auction and debt deadlines live inside game state; the turn deadline lives in the room table, keyed by `(gameId, turnId)`.
- **Alarm.** After every commit the room schedules its single alarm to the earliest pending deadline.
- **Alarm handler.** It issues each due timeout as a normal command with a deterministic `actionId` (for example `timeout:turn:<gameId>:<turnId>:<deadline>`), so an at-least-once redelivery is deduplicated by the applied-action ledger. Stale timeouts are rejected by game-core's own identity checks.
- **Forbidden:** `setTimeout`, `setInterval`, and keep-warm loops.

## 7. Reconnect (RT-008)

- The frozen values are unchanged: a 90 s lease and a one-time 20 s active-turn extension. The seat is bound to `userId`.
- Every accepted connection increments the room-scoped connection epoch. Stale sockets get `SESSION_REPLACED`, and a stale close cannot disconnect the newer socket.
- **Expired lease (> 90 s):** the seat is not silently restored. While the player is away their turns are auto-played by turn timeouts. A later connection by the same authenticated member is an explicit `REJOIN`: a new epoch, a recorded rejoin, and no turn extension. Bankrupt players keep their seat's view, but the rules refuse every game command from them.
