# Architecture Freeze Candidate v0.4.1
## Free Real-Time Property-Trading Board Game

**Date:** 2026-08-31  
**Status:** Freeze candidate; freeze only after the architecture spikes in `TASKS.md` pass.  
**Source baseline:** project spec v0.4 plus the hardening decisions recorded here.  
**Budget:** ₹0 under normal personal/friend-group use.  
**Supported match start:** 3–10 players.  
**Launch boards:** World Tour Standard v1 (40) and World Tour Grand v1 (52).

---

# 1. Freeze rule

Architecture is not accepted because an AI or human finds it convincing. Every load-bearing claim needs an experiment, observable result, falsifier, and recorded PASS / MODIFY / FAIL decision.

After freeze, architecture changes only when:
- a spike fails;
- a real bug falsifies an invariant;
- a provider/API limitation changes;
- measured performance/resource usage breaks a threshold;
- human playtesting falsifies a game-design assumption.

"An agent had a better idea" is not a reason to redesign frozen architecture.

---

# 2. Product boundaries

- A normal match may start only with **3–10 players**.
- The 3-player minimum is a lobby/start rule only.
- A valid running match can naturally reach a final 1v1 and then one winner.
- Sandbox/dev tests may use fewer players.
- No gameplay paywalls.
- Private/shareable friend rooms first.
- Not v1: matchmaking, ranked ladder, voice, paid infra by default, Redis, microservices, public map marketplace, Three.js/R3F, payments.

---

# 3. Board architecture

A board is an immutable, versioned definition.

```text
boardId
boardVersion
tileCount
orderedTiles[]
propertySets[]
decks[]
economyProfile
supportedRules[]
theme metadata
```

`tileCount` never changes during a game. There is **no board-size slider**.

## Standard

```text
world-tour-standard@1
40 fixed tiles
3–6 recommended
22 country/property tiles
8 property sets
4 transit hubs
2 utilities
3 Surprise
3 Treasure Chest
2 Tax
4 structural corners
```

Standard stays familiar and teachable.

Its familiar four mechanical corner roles may remain in the first implementation:
- Start;
- detention/visiting;
- rest/free space;
- go-to-detention.

All naming, illustration, typography, icons, cards and visual identity must be original. Public-release trade-dress review is a release concern, not a software architecture gate.

## Grand

```text
world-tour-grand@1
52 fixed tiles
6–10 recommended
30 country/property tiles
12 sets
3 property sets per side
4 transit hubs
3 utilities
3 Surprise
3 Treasure Chest
2 Tax
1 Auction Hub
1 Gift/Choice
1 Transit Pass space
4 structural corners
```

Initial 30-property set hypothesis:
- six 2-property sets;
- six 3-property sets.

This is not considered balanced until simulation and human playtesting.

Grand's four corner semantics are **not frozen**. They may stay familiar or become more original later.

## State isolation

Standard and Grand may share code, but never mutable:
- tile arrays;
- set indices;
- deck state;
- economy state;
- ownership arrays;
- building arrays;
- per-game caches.

Every match stores `boardId` + `boardVersion`.

---

# 4. New-game/rematch isolation

Every match has a new `gameId`.

Never mutate an ended `GameState` back into an initial state.

```text
Room
├── completed GameSummary(gameId=A)
└── current GameState(gameId=B)
```

Caches are namespaced by at least:

```text
roomId
gameId
boardId
boardVersion
gameVersion
```

A rematch may copy room membership, teams, board selection and immutable room settings. It must not copy mutable match state.

---

# 5. Pure game core

`packages/game-core` is pure TypeScript.

It must not import React, DOM/browser APIs, Cloudflare, D1, Google auth, WebSockets or UI libraries.

Conceptual interface:

```ts
applyCommand(state, command, context)
```

Returns:
- accepted/rejected;
- next state;
- domain events;
- timer intents.

`context` supplies authenticated actor identity, injected RNG, server time and board/rules definitions.

---

# 6. Authoritative commands

Client sends intents only.

Examples:

```text
ROLL_DICE
BUY_PROPERTY
DECLINE_PROPERTY
PLACE_BID
BUILD
SELL_BUILDING
MORTGAGE
UNMORTGAGE
CREATE_TRADE
ACCEPT_TRADE
USE_CARD
END_TURN
```

Each mutation includes a unique `actionId` and optional `expectedGameVersion`.

Actor identity comes from authenticated connection context, never a trusted payload `playerId`.

Accepted mutation order:

```text
authenticate
→ connection epoch
→ payload schema
→ actionId/idempotency
→ phase/version
→ game-core transition
→ durable commit
→ gameVersion++
→ broadcast committed result
```

---

# 7. Runtime

```text
Browser
   |
HTTPS + WebSocket
   |
Cloudflare Worker
   |
GameRoom Durable Object
   |
SQLite-backed DO storage
   |
finalized profile/game updates -> D1
```

One room maps to one `GameRoom` Durable Object.

## Hibernation is mandatory

Use the **Hibernation WebSocket API**.

In-memory state may be cached while resident; SQLite is the durable source of truth after reconstruction.

Forbidden for gameplay timing unless explicitly approved:
- `setInterval`;
- `setTimeout`;
- JS keep-warm loops;
- outbound sockets that pin the DO;
- artificial JS heartbeats.

Being idle and hibernation-eligible is enough to stop duration billing; actual eviction timing is Cloudflare-controlled.

---

# 8. Durable deadlines

Persist absolute deadlines:

```ts
type DeadlineState = {
  turnDeadlineAt?: number;
  auctionDeadlineAt?: number;
  debtDeadlineAt?: number;
  reconnectDeadlines: Record<string, number>;
};
```

A DO can schedule one alarm at a time. Store all deadlines and schedule the **earliest pending** deadline.

Alarm handler:
1. rehydrates if needed;
2. resolves every due deadline;
3. persists authoritative state;
4. chooses next earliest deadline;
5. sets/clears alarm;
6. returns to hibernation eligibility.

Alarm behavior must be idempotent because alarm delivery is at-least-once.

---

# 9. Persistence commit

Authoritative commit point is the SQLite transaction.

```text
validate
→ compute
→ persist snapshot/idempotency metadata
→ broadcast
```

Persist at least:
- gameId;
- gameVersion;
- canonical state;
- recent action IDs/equivalent ledger;
- deadline schedule.

If write fails:
- command is not committed;
- do not broadcast authoritative success;
- show recoverable `ROOM_TEMPORARILY_UNAVAILABLE`;
- retries reuse the same actionId.

If commit succeeds but response is lost, retry must not apply twice.

---

# 10. Synchronization diagnostics

Development builds expose:

```text
gameVersion=428
stateHash=a1d938...
```

All 10 clients should converge to the server's version/hash after each authoritative transition.

Hash is diagnostic only.

---

# 11. Authentication

v1 uses Google OpenID Connect.

Stable external identity is Google ID-token `sub`, mapped to internal `userId`.

Application session:
- Secure;
- HttpOnly;
- appropriate SameSite;
- no long-lived Google/game bearer token in JS-readable storage.

## Invite-first auth

```text
/r/ROOMCODE
→ room-context page
→ Google only if no app session
→ OAuth callback
→ intended room
```

OAuth `state` is **not the room code**.

Use opaque one-time high-entropy state. Server temporarily maps state to:

```text
returnPath
issuedAt
expiresAt
browser/session binding
```

Callback validates, consumes and continues to room.

Google raises casual abuse cost but is not sufficient bot protection alone.

---

# 12. Reconnect

Seat binds to application `userId`, not socket/IP/tab.

```ts
DISCONNECT_GRACE_MS = 90_000;
ACTIVE_TURN_RECONNECT_EXTENSION_MS = 20_000;
```

90s is the room seat/reconnect lease, not application-session lifetime.

The 20s current-turn protection:
- applies only if disconnected player owns the active turn;
- is granted at most once per turn;
- does not pause the room;
- does not stack across repeated toggles.

Each seat has `connectionEpoch`. New connection/takeover increments it; old epoch commands are rejected; old socket receives `SESSION_REPLACED`.

IP is a weak rate-limit signal only.

---

# 13. State machine

```text
LOBBY
STARTING
ACTIVE_TURN
  PRE_ROLL
  ROLLING
  MOVING
  RESOLVING
  POST_ROLL
AUCTION
DEBT
PAUSED
GAME_OVER
```

`RESOLVING` handles purchase/rent/card/tax/utility/detention/special tiles.

Trade, chat and connection management are side subsystems.

Trade:
- blocked during auction;
- ordinary trade blocked for debtor;
- explicit debt-mode liquidation trade allowed;
- no indefinite deadline freeze.

---

# 14. Card/effect safety

Board data is declarative. No arbitrary JavaScript.

Runtime circuit breaker:

```ts
MAX_RESOLUTION_STEPS = 16;
```

Three defenses:
1. board-load validation catches invalid refs and obvious deterministic cycles;
2. seeded/fuzz simulation explores dynamic chains;
3. runtime budget prevents a live infinite loop.

Budget exhaustion is a board/rules defect and must log enough context/seed to reproduce.

---

# 15. Economy

Standard and Grand have independent authored price/rent tables.

Initial reference:

```text
Start salary = 200
default starting cash = 2000
complete-set unimproved rent = 2x base
mortgage = 50% purchase
unmortgage = principal + 10%
building sell-back = 50%
```

Host starting cash: 1500 / 2000 / 2500 / bounded custom.

Balance matrix:

```text
Standard: 3,4,5,6
Grand:    6,7,8,9,10
```

Use distributions, not only averages.

---

# 16. Grand pacing

Grand does not automatically need a special pacing mechanic.

Compare:

```text
A = Grand core
B = Grand + Turbo candidate
C = Grand + Transit Pass candidate
```

Simulation: lap rate, acquisition, Start income, rent exposure, match length, variance.

Human playtest: waiting, clarity, strategic agency, frustration, fun.

Decision is simulation-informed **and human-approved**. "None" is a valid winner.

Other Mega-inspired systems stay post-launch and need interaction tests.

---

# 17. Frontend

Working stack:
- TypeScript;
- React;
- Vite;
- Fluent UI v9 or MUI for generic controls after UI spike;
- custom game UI;
- DOM/CSS/SVG board;
- Canvas only for optional particles.

No Three.js/R3F in v1.

Never optimistically mutate authoritative money/property state.

Allowed:

```text
Buy -> "Buying..." -> server commit -> ownership animation
```

Not:

```text
Buy -> client subtracts cash/changes owner before commit
```

---

# 18. Anti-slop visual baseline

Do not ship:
- default component-library demo appearance;
- generic SaaS/admin board;
- every surface as a rounded card;
- arbitrary glow/gradient overload;
- inconsistent spacing/radius;
- raw feature hex colors everywhere;
- emoji as final product icons;
- fake placeholder stats;
- critical hover-only controls;
- animations contradicting server state.

Use design tokens. Ownership cannot depend on color alone. Reduced motion required.

Target stable 60 FPS for common board interaction on a normal modern laptop; effects lose before responsiveness does.

---

# 19. Resource budget and falsification

Representative stress game:

```text
10 players
World Tour Grand
~90 minutes
chat + auctions + trades + reconnects
```

Current free-tier reference:

```text
DO requests:     100,000/day
DO duration:     13,000 GB-s/day
DO SQL reads:    5,000,000/day
DO SQL writes:   100,000/day
D1 reads:        5,000,000/day
D1 writes:       100,000/day
```

These are provider limits, not product targets.

## Desired per representative game: <=10%

```text
DO requests      <= 10,000
DO duration      <= 1,300 GB-s
DO SQL reads     <= 500,000
DO SQL writes    <= 10,000
```

D1 should be far lower because it is primarily profile/finalized-game storage.

## Hard falsifier: >20%

```text
DO requests      > 20,000      => FAIL
DO duration      > 2,600 GB-s  => FAIL
DO SQL reads     > 1,000,000   => FAIL
DO SQL writes    > 20,000      => FAIL
```

10–20% => optimize/modify and rerun.  
<=10% => PASS target.

Measure deployed provider counters; local estimates do not freeze architecture.

---

# 20. Freeze gates

## A — DO runtime
Prove 10 clients, hibernation eligibility, idle billing stop, wake/reconstruction, alarms, and resource thresholds.

## B — crash atomicity
Inject failures before/during/after commit and around broadcast. No uncommitted authoritative success; retry never doubles.

## C — auth/reconnect
Test opaque one-time OAuth state, replay rejection, 89s reconnect, >90s expiry, 20s one-time current-turn extension, epoch takeover.

## D — rematch/board isolation
Repeated Standard -> Standard -> Grand -> Standard. Zero mutable leakage.

## E — renderer destruction test
10 same-tile tokens, long names, large balances, 12 sets, reconnect badges, 10 bidders, mobile, 200% zoom, reduced motion.

## F — engine fuzzing
Large seeded legal-command runs. No invariant failure/deadlock/unbounded chain.

## G — economy
Standard 3–6 and Grand 6–10 simulation + human alpha.

## H — Grand pacing
A/B/C simulation + human evaluation. "None" allowed.

---

# 21. Invariants

- server owns authoritative game state;
- money is integer;
- every property has at most one owner;
- board geometry immutable mid-game;
- normal match starts with 3–10;
- running game may reach 2 then 1;
- gameVersion monotonic;
- action retries idempotent;
- old connection epochs cannot mutate;
- held card cannot also be in draw pile;
- board references resolve;
- timers are server deadlines;
- client timers are presentation only;
- every rematch gets new gameId;
- board version recorded with match;
- no arbitrary executable board/card scripts.

---

# 22. Change control

Load-bearing decisions live under `docs/adr/`.

If code conflicts with architecture, builder must stop, mark task BLOCKED, provide evidence, and propose the smallest change. Do not silently code around the architecture.
