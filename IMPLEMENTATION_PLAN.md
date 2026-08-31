# Implementation Plan

The implementation is staged so feature work does not land on an unproven realtime/persistence foundation.

# Phase 0 — Repository bootstrap

Create:

```text
/
├─ app/
│  ├─ web/
│  └─ worker/
├─ packages/
│  ├─ game-core/
│  └─ shared/
├─ boards/
│  └─ world-tour/
├─ docs/
│  ├─ adr/
│  └─ templates/
├─ .github/
├─ AGENTS.md
├─ CLAUDE.md
├─ ARCHITECTURE.md
├─ PROJECT_RULES.md
├─ IMPLEMENTATION_PLAN.md
└─ TASKS.md
```

Defaults:
- TypeScript strict
- pnpm workspace
- React + Vite web app
- Cloudflare Worker
- SQLite Durable Object
- Vitest
- Playwright

Expected root scripts:
```text
lint
typecheck
test
build
test:integration
test:e2e
```

Exit: fresh clone/install/checks work.

---

# Phase 1 — Architecture spikes

No polished board implementation yet.

## 1. DO hibernation + 10 clients
Minimal hibernatable room, SQLite snapshot, gameVersion/counter, broadcast and one durable alarm. Measure real provider counters.

## 2. Persistence fault injection
Inject failures around commit/broadcast and prove actionId retry cannot double-apply.

## 3. OIDC invite round trip
Invite -> opaque state -> Google -> app session -> same room. Replay/wrong/missing/expired state tests.

## 4. Reconnect + epoch
89s reconnect, >90s expiry, second-tab takeover, old epoch reject, one 20s active-turn extension.

## 5. Rematch contamination torture
Repeated Standard/Grand transitions with synthetic heavy mutable state. New game always pristine.

## 6. Dual-board renderer
Crude 40/52 layouts, no final art. Test 10 same-tile tokens, long names, mobile, 200% zoom.

## 7. Seeded fuzz harness
Permanent deterministic legal-command/invariant harness.

## 8. Economy simulation harness
Permanent board/player-count metrics harness.

---

# Freeze checkpoint

Human + independent Codex review evidence.

```text
PASS -> mark architecture frozen
MODIFY -> amend ADR + rerun affected spike
FAIL -> redesign affected component
```

Do not continue broad feature work with a failed gate.

---

# Phase 2 — Pure game core

Build in dependency order.

## Foundation
- board schema/validation
- game/player/property state
- RNG
- command envelopes
- gameVersion/actionId

## Turn/movement
- lobby start
- turn order
- dice/doubles
- movement
- pass Start
- tile dispatcher

## Economy
- property buy/decline
- rent/sets
- transit
- utilities
- auctions
- buildings
- mortgage

## Resolution systems
- deck engine
- effects
- Surprise
- Treasure Chest
- tax
- detention

## Player interactions
- trade
- debt
- bankruptcy
- teams
- win conditions

Exit: game-core passes unit/invariant/fuzz tests without UI/runtime imports.

---

# Phase 3 — Realtime room

Wrap proven game-core.

Order:
1. room create/join
2. authenticated WS upgrade
3. seat assignment
4. shared protocol
5. serialized command adapter
6. transactional snapshot
7. broadcast
8. reconstruction after hibernation
9. earliest-deadline alarm scheduler
10. reconnect/epoch
11. host/co-host
12. pause
13. chat
14. finalization to D1

---

# Phase 4 — Standard playable UI

Standard is the teaching/baseline board.

Build:
1. tokens/typography/layout
2. lobby
3. 40-tile board
4. 3–6 player HUD
5. dice/action tray
6. property details
7. auction
8. buildings/mortgage
9. trade
10. cards/tax/detention
11. debt/bankruptcy
12. reconnect
13. end/rematch
14. mobile/reduced motion

Exit: full Standard game playable end-to-end.

---

# Phase 5 — Grand baseline

- 52-tile immutable definition
- 12 set identities
- 30-property economy
- 3 utilities
- Grand core special spaces
- 10-player HUD/overlap

Run simulation + human alpha.

---

# Phase 6 — Grand pacing decision

A/B/C:
```text
A core
B + Turbo candidate
C + Transit Pass candidate
```

Use metrics plus structured human feedback.

If A wins, launch Grand with no extra pacing mechanic.

Other Mega-inspired modules remain later backlog.

---

# Phase 7 — Profiles/progression

D1:
- profile
- XP
- coins
- game history
- achievements
- inventory
- aggregate stats

Finalization idempotent by gameId. Sandbox/test games do not reward.

---

# Phase 8 — Polish/accessibility/performance

- final board art
- cosmetics
- animation tuning
- sound
- reduced motion
- keyboard/focus
- responsive layout
- profiling
- reconnect polish
- end-game presentation

Effects lose before responsiveness.

---

# Phase 9 — Release hardening

- 10-browser full match
- reconnect chaos
- persistence failure suite
- rematch torture
- large fuzz run
- deployed free-tier measurement
- accessibility
- cross-browser
- auth/security
- public-release IP/trade-dress review
