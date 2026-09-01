# TASKS.md

## Claude Code builds; independent reviewer closes

Statuses:

```text
TODO
IN_PROGRESS
READY_FOR_REVIEW
CHANGES_REQUESTED
BLOCKED
DONE
```

Builder: TODO -> IN_PROGRESS -> READY_FOR_REVIEW/BLOCKED
Reviewer: READY_FOR_REVIEW -> DONE/CHANGES_REQUESTED/ARCHITECTURE_BLOCKED

---

# A. Bootstrap

| ID      | Status | Task                                                                                                        | Depends | Acceptance                    |
| ------- | ------ | ----------------------------------------------------------------------------------------------------------- | ------- | ----------------------------- |
| GOV-001 | DONE   | pnpm strict TypeScript workspace (`app/web`, `app/worker`, `packages/game-core`, `packages/shared`) | —      | fresh install + checks        |
| GOV-002 | DONE   | CI lint/typecheck/test/build                                                                                | GOV-001 | intentional failure blocks CI |
| GOV-003 | DONE   | separate Standard/Grand board data dirs/refs                                                                | GOV-001 | immutable refs; no slider     |

---

# B. Architecture spikes

## SPIKE-001 — DO hibernation + 10 clients

**Status:** DONE
**Depends:** GOV-001

Build minimal deployed room:

- 10 hibernatable WS clients
- gameVersion/counter
- SQLite snapshot
- one alarm
- broadcast

Record DO requests, GB-s, SQL reads/writes and Worker requests.

Acceptance:

- Hibernation API
- no gameplay setTimeout/setInterval
- idle becomes hibernation-eligible
- wake/reconstruct correct
- 10-client convergence
- <=10% desired; >20% any relevant daily quota = architecture FAIL

Deliver `docs/spikes/SPIKE-001-results.md`.

## SPIKE-002 — Persistence fault injection

**Status:** DONE
**Depends:** SPIKE-001

Fault points:

```text
BEFORE_WRITE
DURING_WRITE
AFTER_WRITE_BEFORE_BROADCAST
AFTER_COMMIT_RESPONSE_LOSS
```

Acceptance:

- uncommitted state never authoritative-success
- committed state survives
- retry same actionId never duplicates
- before/after gameVersion evidence

## SPIKE-003 — Google OIDC invite-first

**Status:** DONE
**Depends:** GOV-001

Acceptance:

- `/r/:roomCode` context preserved
- opaque state != room code
- state one-time/expiring
- replay/missing/wrong state fail
- valid app session skips Google
- no Google token in JS-readable storage

## SPIKE-004 — Reconnect + epoch

**Status:** TODO
**Depends:** SPIKE-001,003

Acceptance:

- 89s reconnect
- > 90s expiry policy
  >
- userId seat binding
- second connection increments epoch
- old epoch command rejected
- SESSION_REPLACED
- current-turn extension max 20s once
- repeated toggles do not stack

## SPIKE-005 — Rematch/board contamination

**Status:** TODO
**Depends:** GOV-003

Run hundreds+ deterministic:

```text
Standard -> end -> Standard
Standard -> end -> Grand
Grand -> end -> Standard
```

Every new game:

- new gameId
- correct board/version/tile count
- no ownership/buildings/mortgages
- fresh decks
- no trade/auction/debt
- initial timers/version

## SPIKE-006 — Dual-board renderer

**Status:** TODO
**Depends:** GOV-001,003

Standard 40 + Grand 52 rough renderer.

Test:

- 10 same-tile tokens
- long names
- huge balances
- mobile
- 200% zoom
- 12 set identities

## SPIKE-007 — Seeded fuzz harness

**Status:** TODO
**Depends:** GOV-001

Acceptance:

- legal command generator
- invariant registry
- deterministic seed
- injected invariant defect detected
- failing seed replayable

## SPIKE-008 — Economy harness

**Status:** TODO
**Depends:** SPIKE-007,GOV-003

Metrics:

- turns
- laps
- Start income
- ownership saturation
- first set/build/bankruptcy
- auction/list ratio
- rent concentration
- winner correlations

## FREEZE-001 — Architecture review

**Status:** TODO
**Depends:** SPIKE-001..008

Human + independent Codex:

```text
PASS -> freeze
MODIFY -> amend ADR + rerun
FAIL -> redesign
```

---

# C. Game core

| ID       | Status | Task                         | Depends      | Acceptance                          |
| -------- | ------ | ---------------------------- | ------------ | ----------------------------------- |
| CORE-001 | TODO   | Board schema + validator     | FREEZE-001   | invalid refs/groups/decks reject    |
| CORE-002 | TODO   | Game/player/property schemas | CORE-001     | strict initial state; integer money |
| CORE-003 | TODO   | injected RNG/shuffle         | CORE-002     | same seed same outcome              |
| CORE-004 | TODO   | command/actionId/gameVersion | CORE-002     | duplicate action test               |
| CORE-005 | TODO   | lobby 3–10 start rule       | CORE-002     | 1/2 reject, 3+ valid                |
| CORE-006 | TODO   | turn order/start/end         | CORE-003,004 | one active owner                    |
| CORE-007 | TODO   | dice/doubles                 | CORE-006     | server/deterministic                |
| CORE-008 | TODO   | movement + pass Start        | CORE-007     | correct 40/52 wrap                  |
| CORE-009 | TODO   | tile dispatcher              | CORE-008     | typed resolution                    |

---

# D. Rules

| ID       | Status | Task                              | Depends           | Acceptance                     |
| -------- | ------ | --------------------------------- | ----------------- | ------------------------------ |
| RULE-001 | TODO   | buy/decline property              | CORE-009          | atomic cash/ownership          |
| RULE-002 | TODO   | base rent/set multiplier          | RULE-001          | authored tables                |
| RULE-003 | TODO   | transit                           | RULE-001          | scaling tested                 |
| RULE-004 | TODO   | utility                           | CORE-007,RULE-001 | authoritative dice rent        |
| RULE-005 | TODO   | auction                           | RULE-001          | concurrent/duplicate safe      |
| RULE-006 | TODO   | buildings/even-build              | RULE-002          | legal build invariant          |
| RULE-007 | TODO   | mortgage/unmortgage               | RULE-006          | rent restrictions/cost         |
| RULE-008 | TODO   | tax                               | CORE-009          | fixed/percent/choice framework |
| RULE-009 | TODO   | deck/held-card engine             | CORE-003,009      | deterministic + held invariant |
| RULE-010 | TODO   | effect primitives/16-step breaker | RULE-009          | cycle-safe/reproducible        |
| RULE-011 | TODO   | Surprise v1                       | RULE-010          | board data only                |
| RULE-012 | TODO   | Treasure Chest v1                 | RULE-010          | board data only                |
| RULE-013 | TODO   | detention                         | RULE-010          | release paths                  |
| RULE-014 | TODO   | trade                             | RULE-001,007      | atomic stale revalidation      |
| RULE-015 | TODO   | debt/liquidation                  | RULE-007,014      | explicit creditor/deadline     |
| RULE-016 | TODO   | bankruptcy to player              | RULE-015          | deterministic transfer         |
| RULE-017 | TODO   | bankruptcy to bank                | RULE-015,005      | return/auction semantics       |
| RULE-018 | TODO   | teams baseline                    | RULE-002,014,017  | explicit team semantics        |
| RULE-019 | TODO   | win conditions                    | RULE-017,018      | last-standing + time/round     |

---

# E. Runtime

| ID     | Status | Task                               | Depends             | Acceptance                   |
| ------ | ------ | ---------------------------------- | ------------------- | ---------------------------- |
| RT-001 | TODO   | room create/join                   | FREEZE-001,CORE-005 | authenticated 3–10 seats    |
| RT-002 | TODO   | shared protocol schemas            | CORE-004            | one definition web/worker    |
| RT-003 | TODO   | socket upgrade/auth                | SPIKE-003,RT-002    | app session required         |
| RT-004 | TODO   | serialized command adapter         | RT-003,RULE-019     | no logical parallel mutation |
| RT-005 | TODO   | transactional snapshot/idempotency | RT-004,SPIKE-002    | fault tests preserved        |
| RT-006 | TODO   | hibernation reconstruction         | RT-005,SPIKE-001    | constructor wake safe        |
| RT-007 | TODO   | earliest-deadline alarm scheduler  | RT-006              | no pinning timers            |
| RT-008 | TODO   | reconnect/epoch                    | RT-003,SPIKE-004    | spike behavior real room     |
| RT-009 | TODO   | host/co-host migration             | RT-008              | host loss no game loss       |
| RT-010 | TODO   | pause/resume                       | RT-007,009          | deadlines correct            |
| RT-011 | TODO   | chat/rate limit                    | RT-003              | bounded; no game mutation    |
| RT-012 | TODO   | finalization to D1                 | RT-005              | idempotent gameId            |

---

# F. Standard UI

| ID     | Status | Task                       | Depends          | Acceptance                 |
| ------ | ------ | -------------------------- | ---------------- | -------------------------- |
| UI-001 | TODO   | design tokens              | SPIKE-006        | consistent system          |
| UI-002 | TODO   | lobby shell                | RT-001,UI-001    | invite/ready/start         |
| UI-003 | TODO   | Standard board             | UI-001,SPIKE-006 | responsive/custom          |
| UI-004 | TODO   | 3–6 HUD                   | UI-003           | long names/balances        |
| UI-005 | TODO   | turn/dice/action tray      | UI-003,RULE-007  | pending/commit states      |
| UI-006 | TODO   | property/build/mortgage    | RULE-007,UI-003  | legal/disabled clarity     |
| UI-007 | TODO   | auction UI                 | RULE-005,RT-007  | 10 bidders usable          |
| UI-008 | TODO   | trade UI                   | RULE-014         | large trade usable         |
| UI-009 | TODO   | card/tax/detention UI      | RULE-013         | clear resolution           |
| UI-010 | TODO   | debt/bankruptcy UI         | RULE-017         | understandable liquidation |
| UI-011 | TODO   | reconnect/replaced UI      | RT-008           | no raw socket errors       |
| UI-012 | TODO   | game end/rematch           | RT-012           | new gameId/no stale        |
| UI-013 | TODO   | mobile/reduced-motion pass | UI-002..012      | critical flow works        |

---

# G. Grand

| ID        | Status | Task                     | Depends             | Acceptance                        |
| --------- | ------ | ------------------------ | ------------------- | --------------------------------- |
| GRAND-001 | TODO   | Grand 52 definition      | CORE-001            | 52 positions/12 sets/30 countries |
| GRAND-002 | TODO   | 6–10 HUD/renderer       | UI-003,GRAND-001    | 10-player pathological cases      |
| GRAND-003 | TODO   | draft Grand economy      | SPIKE-008,GRAND-001 | versioned table                   |
| GRAND-004 | TODO   | simulate 6/7/8/9/10      | GRAND-003           | distributions recorded            |
| GRAND-005 | TODO   | human alpha core         | GRAND-004           | structured feedback               |
| GRAND-006 | TODO   | Turbo candidate          | GRAND-005           | isolated tested module            |
| GRAND-007 | TODO   | Transit candidate        | GRAND-005           | isolated tested module            |
| GRAND-008 | TODO   | A/B/C compare            | GRAND-006,007       | simulation+humans; none allowed   |
| GRAND-009 | TODO   | selected pacing behavior | GRAND-008           | interactions/UI complete          |

---

# H. Meta/progression

| ID       | Status | Task               | Depends         | Acceptance                      |
| -------- | ------ | ------------------ | --------------- | ------------------------------- |
| META-001 | TODO   | D1 user/profile    | RT-012          | internal userId from Google sub |
| META-002 | TODO   | XP/level           | META-001        | server finalized                |
| META-003 | TODO   | coins              | META-001        | cosmetics only                  |
| META-004 | TODO   | history            | META-001,RT-012 | idempotent record               |
| META-005 | TODO   | achievements       | META-002,004    | server-derived                  |
| META-006 | TODO   | cosmetic inventory | META-003        | no game advantage               |
| META-007 | TODO   | profile UI         | META-001..006   | loading/error states            |

---

# I. Release hardening

| ID     | Status | Task                           | Depends          | Acceptance                    |
| ------ | ------ | ------------------------------ | ---------------- | ----------------------------- |
| QA-001 | TODO   | 10-browser full match          | runtime/UI/Grand | convergence                   |
| QA-002 | TODO   | reconnect chaos                | QA-001           | no economic corruption        |
| QA-003 | TODO   | persistence failure regression | RT-005           | boundaries safe               |
| QA-004 | TODO   | 1000+ cross-board rematches    | GRAND-001        | zero contamination            |
| QA-005 | TODO   | large seeded fuzz run          | RULE-019         | no invariant break            |
| QA-006 | TODO   | deployed quota rerun           | QA-001           | <=10% desired; >20% fail      |
| QA-007 | TODO   | accessibility review           | UI-013           | critical pass                 |
| QA-008 | TODO   | cross-browser                  | QA-001           | critical pass                 |
| QA-009 | TODO   | auth/security review           | META/UI          | no blocker                    |
| QA-010 | TODO   | public-release IP review       | final art        | recorded human/legal decision |

---

# Post-launch module backlog

```text
POST-001 High-rise tier
POST-002 Transit hub upgrade
POST-003 alternate third-utility tuning
POST-004 near-complete development
POST-005 finite building scarcity
POST-006 stronger full-set rent
POST-007 Auction Hub late-game variant
POST-008 Gift/Choice expansion
```

Every module must test interactions with all already-shipped systems it touches.
