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
| GOV-004 | DONE | integration/E2E test foundation                                                                             | GOV-002 | runnable `pnpm test:integration` command (CI-invocable); runnable `pnpm test:e2e` command (CI-invocable); at least one meaningful Worker/integration-boundary test exercising the real SQLite/DO boundary (not an unrelated fake); at least one minimal real browser smoke test against the actual web app shell; no requirement for live external Google/Cloudflare secrets in normal CI; no false-green stub suites; later QA tasks (QA-012 etc.) extend this foundation instead of replacing it |
| GOV-005 | DONE | typecheck + dependency boundary enforcement                                                                 | GOV-001 | strict TypeScript coverage for tests and test-support code currently excluded from normal package typechecking; Worker tests/testkits included in an explicit strict typecheck path; enforceable cross-layer/package dependency boundaries: game-core cannot import Worker/web runtime implementation, shared cannot import application implementation, web cannot import Worker internals, Worker cannot import React/web implementation; an intentional boundary violation produces a deterministic check/CI failure |

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

**Status:** DONE
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

**Status:** DONE
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

**Status:** DONE
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

**Status:** DONE
**Depends:** GOV-001

Acceptance:

- legal command generator
- invariant registry
- deterministic seed
- injected invariant defect detected
- failing seed replayable

## SPIKE-008 — Economy harness

**Status:** DONE
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

## ECON-001 — Pre-FREEZE board/economy reconciliation

**Status:** DONE
**Depends:** SPIKE-008

Reconcile Design and canonical counts/money; publish production candidates; validate bounded pacing and Grand A/B/C over 250 seeds per supported configuration. Preserve private sources and historical evidence. Claude reviews independently.

Evidence and builder handoff: `docs/architecture/PRE-FREEZE-ECONOMY-RECONCILIATION.md`; full per-configuration report: `docs/architecture/ECON-001-simulation.json`. Default matrix 9/9 PASS; $2500 Grand-10 retains the explicitly recorded small pacing/rent-ratio misses.

**Independent review (2026-09-08, Claude Code): APPROVE.** Reproduced lint/typecheck/test (163/163) /build, the 250-seed reconciliation matrix (candidate 9/9 PASS, one-action isolation, historical baseline) and the $2500 preset caveat exactly. Board/count/money reconciliation verified from source; two-utility conversion and 10×-fresh-dice utility card confirmed against private Design wording; integer redemption fix ($100→$110) verified with regression test. Two-development-per-turn is a legitimate, fully-specified, single-sourced newly-proposed pre-FREEZE candidate (Design authored one) — its strategic side effects and the $2500 Grand-10 miss are documented, non-blocking, and deferred to FREEZE-001 human balance approval. FREEZE-001 remains TODO.

## FREEZE-001 — Architecture review

**Status:** DONE
**Depends:** SPIKE-001..008, ECON-001

ECON-001 must be independently approved before this review begins. Card-content finalization and human balance approval are explicit review considerations; simulation alone does not freeze the product.

Human + independent Codex:

```text
PASS -> freeze
MODIFY -> amend ADR + rerun
FAIL -> redesign
```

**Builder handoff (2026-09-13): implementation baseline prepared.** `docs/architecture/ARCHITECTURE-FREEZE-v1.md` records frozen decisions, provisional launch candidates, deferred work, and non-blocking risks. Human balance validation and final card/Holding content remain explicit future tasks rather than being frozen by implication. Lint, typecheck, 164 tests, build, historical economy replay, and the 250-seed reconciliation replay pass; independent FREEZE-001 review is pending.

**Independently reviewed, approved, and merged (2026-09-13, PR #8).** Builder handoff text above predates the review. Evidence reconciliation: `docs/architecture/ARCH-AUDIT-RECONCILIATION.md`.

---

# B-2. Architecture audit

| ID       | Status           | Task                                      | Depends    | Acceptance                                                                                    |
| -------- | ---------------- | ----------------------------------------- | ---------- | --------------------------------------------------------------------------------------------- |
| ARCH-001 | DONE   | spike/freeze evidence reconciliation      | FREEZE-001 | stale status updated; deferred items have concrete owners; historical evidence preserved       |
| ARCH-002 | DONE   | production spike-to-runtime ownership map | ARCH-001   | every spike outcome mapped to subsystem; PROVEN/IMPLEMENTED/FUTURE distinguished; no orphans  |
| ARCH-003 | DONE   | production fuzz/economy parity plan       | ARCH-001   | QA-011 transition defined; seed replay preserved; human gate explicit; ECON-001 not rewritten |
| ARCH-004 | DONE   | hibernation/quota evidence refresh plan   | ARCH-001   | SPIKE-001 preserved; QA-006 assigned; no re-freeze unless threshold breached                  |

Evidence: `docs/architecture/ARCH-AUDIT-RECONCILIATION.md`

---

# C. Game core

| ID       | Status | Task                                     | Depends          | Acceptance                                                                   |
| -------- | ------ | ---------------------------------------- | ---------------- | ---------------------------------------------------------------------------- |
| CORE-001 | DONE   | Board schema + validator                 | FREEZE-001       | invalid refs/groups/decks reject                                             |
| CORE-002 | DONE   | Game/player/property schemas             | CORE-001         | strict initial state; integer money                                          |
| CORE-003 | DONE   | injected RNG/shuffle                     | CORE-002         | same seed same outcome                                                       |
| CORE-004 | DONE   | command/actionId/gameVersion             | CORE-002         | duplicate/stale/game-scoped action semantics                                 |
| CORE-005 | DONE   | lobby 3–10 start rule                   | CORE-002         | 1/2 reject; 3–10 valid; >10 reject                                          |
| CORE-006 | DONE   | turn order/start/end                     | CORE-003,004     | one active owner; pre-roll end rejected                                      |
| CORE-007 | DONE   | dice/doubles                             | CORE-006         | authoritative deterministic two-d6                                           |
| CORE-008 | DONE   | movement + pass Start                    | CORE-007         | correct 40/52 wrap; exact/pass Start accounting                              |
| CORE-009 | DONE   | tile dispatcher                          | CORE-008         | exhaustive typed resolution                                                  |
| CORE-010 | DONE   | all-ownable canonical asset state        | CORE-001,002     | countries/transit/utilities represented once with ownership + mortgage state |
| CORE-011 | DONE   | pending resolution + obligation contract | CORE-004,009,010 | pending actor/kind/continuation/charge persisted; unrelated actions blocked  |
| CORE-012 | TODO   | doubles/turn continuation integration    | CORE-006,007,011 | legitimate extra rolls deterministic; no duplicate-roll bypass               |
| CORE-013 | TODO   | declarative card/effect schema           | CORE-001         | typed deck/card/effect refs validate; executable card code rejected          |
| CORE-014 | TODO   | canonical cross-state invariants         | CORE-002,010,011 | active owner eligible; asset/pending refs valid; inconsistent state rejects  |

---

# D. Rules

| ID       | Status | Task                              | Depends                    | Acceptance                                                                         |
| -------- | ------ | --------------------------------- | -------------------------- | ---------------------------------------------------------------------------------- |
| RULE-001 | TODO   | buy/decline property              | CORE-010,011               | atomic cash/ownership; persisted decision; decline routes to auction               |
| RULE-002 | TODO   | base rent/set multiplier          | RULE-001,CORE-011          | authored tables; qualifying complete unimproved set = 2×; automatic charge        |
| RULE-003 | TODO   | transit                           | RULE-001,CORE-010,011      | canonical $20/$40/$60/$80 scaling; mortgaged hubs excluded                         |
| RULE-004 | TODO   | utility                           | CORE-007,RULE-001,CORE-011 | authoritative dice rent; canonical ownership/mortgage behavior                     |
| RULE-005 | TODO   | auction                           | RULE-001,CORE-011          | deterministic bid state; duplicate-safe; timeout/disconnect/no-bid semantics       |
| RULE-006 | TODO   | buildings/even-build              | RULE-002,CORE-011          | even-build; max 2 paid development actions/turn; no carryover                      |
| RULE-007 | TODO   | mortgage/unmortgage               | RULE-006,CORE-010          | 50% principal; canonical +10% redemption; zero rent while mortgaged                |
| RULE-008 | TODO   | tax                               | CORE-009,011               | fixed/percent/choice framework; canonical fixed tax preserved                      |
| RULE-009 | TODO   | deck/held-card engine             | CORE-003,009,013           | deterministic draw/shuffle/reshuffle; held-card invariant                          |
| RULE-010 | TODO   | effect primitives/16-step breaker | RULE-009,CORE-011          | nested effects deterministic; shared 16-step budget; cycle-safe diagnostic failure |
| RULE-011 | TODO   | Surprise v1                       | RULE-010                   | effects defined by board/card data only; no duplicated hardcoded deck              |
| RULE-012 | TODO   | Treasure Chest v1                 | RULE-010                   | effects defined by board/card data only; held/multi-player effects deterministic   |
| RULE-013 | TODO   | detention                         | RULE-010,CORE-012          | entry/release paths; doubles integration; attempts/held-card/fee state             |
| RULE-014 | TODO   | trade                             | RULE-001,007,020           | atomic stale revalidation; full offer lifecycle; mode/integrity hooks              |
| RULE-015 | TODO   | debt/liquidation                  | CORE-011,RULE-007,014      | explicit creditor/amount/deadline/continuation; only legal liquidation actions     |
| RULE-016 | TODO   | bankruptcy to player              | RULE-015                   | deterministic atomic cash/assets/cards transfer; pending interactions invalidated  |
| RULE-017 | TODO   | bankruptcy to bank                | RULE-015,005               | deterministic reset/auction queue; no duplicate auctions                           |
| RULE-018 | TODO   | teams baseline                    | RULE-002,014,016,017,020   | explicit allied ownership/rent/trade/debt/elimination semantics                    |
| RULE-019 | TODO   | win conditions                    | RULE-016,017,018,020       | last-standing + time/round; deterministic tie-break; immutable final summary       |
| RULE-020 | TODO   | match mode/settings contract      | CORE-002,FREEZE-001        | immutable FFA/teams + win mode; only approved settings; no Design-only toggles     |

## Game integrity / anti-collusion

| ID      | Status | Task                                   | Depends                          | Acceptance                                                                     |
| ------- | ------ | -------------------------------------- | -------------------------------- | ------------------------------------------------------------------------------ |
| INT-001 | TODO   | FFA fair-play / Collusion Guard policy | RULE-020,FREEZE-001              | approved signals/consequences/visibility frozen; Design ambiguities resolved   |
| INT-002 | TODO   | deterministic collusion rule engine    | INT-001,RULE-005,014,016,017,019 | deterministic evidence + consequences; no ML; team-authorized play not flagged |

---

# E. Runtime

## Auth/data groundwork

| ID       | Status | Task                                   | Depends   | Acceptance                                                                |
| -------- | ------ | -------------------------------------- | --------- | ------------------------------------------------------------------------- |
| AUTH-001 | TODO   | production auth/session lifecycle      | SPIKE-003 | login/callback/session/logout; Google sub identity; expiry/error cleanup  |
| DATA-001 | TODO   | identity/profile D1 schema + migration | AUTH-001  | stable internal userId from Google sub; schema exists before finalization |

## Game runtime

| ID     | Status | Task                               | Depends                    | Acceptance                                                                          |
| ------ | ------ | ---------------------------------- | -------------------------- | ----------------------------------------------------------------------------------- |
| RT-001 | TODO   | room create/join                   | AUTH-001,CORE-005,RULE-020 | authenticated 3–10 seats; membership/readiness/host/settings authorization; select the >90s expired-reconnect disposition (rejoin/re-seat conditions for authenticated users); test the disposition; preserve current room/game integrity; never silently restore an expired seat lease |
| RT-002 | TODO   | shared protocol schemas            | CORE-004,011               | one definition web/worker; bounded typed commands/events                            |
| RT-003 | TODO   | socket upgrade/auth                | AUTH-001,RT-001,002        | valid app session + room membership required                                        |
| RT-004 | TODO   | serialized command adapter         | RT-003,RULE-019            | actor authorized before mutation/idempotent replay; no logical parallel mutation    |
| RT-005 | TODO   | transactional snapshot/idempotency | RT-004,SPIKE-002           | state + next gameVersion + idempotency + relevant deadlines commit atomically       |
| RT-006 | TODO   | hibernation reconstruction         | RT-005,SPIKE-001           | constructor wake reconstructs canonical state safely                                |
| RT-007 | TODO   | earliest-deadline alarm scheduler  | RT-006                     | no pinning timers; all due work ordered/retry-safe; obsolete deadlines cleared      |
| RT-008 | TODO   | reconnect/epoch                    | RT-003,005,007,SPIKE-004   | spike behavior integrated with gameplay/auction/debt/turn state                     |
| RT-009 | TODO   | host/co-host migration             | RT-008                     | host loss does not lose game; permissions migrate deterministically                 |
| RT-010 | TODO   | pause/resume                       | RT-007,009                 | authorized pause only; deadline semantics match frozen architecture                 |
| RT-011 | TODO   | chat/rate limit                    | RT-003                     | bounded/rate-limited; no game mutation                                              |
| RT-012 | TODO   | finalization to D1                 | RT-005,DATA-001            | durable pending delivery; idempotent gameId; retry/restart recovery                 |
| RT-013 | TODO   | production rematch lifecycle       | RT-005,012,RULE-019        | fresh gameId/GameState; old work cancelled; pending finalization preserved          |
| RT-014 | TODO   | state projection + event delivery  | RT-002,004,005             | committed ordering; bounded catch-up/full resync; role-safe/private-state filtering |
| RT-015 | TODO   | boundary abuse controls            | AUTH-001,RT-001,002,003    | payload/rate/connection bounds; membership/role checks; spike-only controls absent  |
| RT-016 | TODO   | retention + recovery cleanup       | AUTH-001,RT-005,007,012    | expired auth/action data bounded; pending finalization/recovery not lost            |
| RT-017 | TODO   | integrity evidence + enforcement   | INT-002,RT-005,007,014     | warnings/evidence/consequences persisted once; reconnect/wake safe                  |
| RT-018 | TODO   | gameplay diagnostics/audit log     | RT-005,007,014             | bounded game/action/version logs; no secrets; reproducible failure context          |

---

# F. Standard UI

| ID     | Status | Task                              | Depends                         | Acceptance                                                                    |
| ------ | ------ | --------------------------------- | ------------------------------- | ----------------------------------------------------------------------------- |
| UI-001 | TODO   | design tokens + fidelity baseline | SPIKE-006                       | Claude Design is visual source of truth; no SPIKE-006 demo-shell drift        |
| UI-002 | TODO   | landing/auth/lobby/settings shell | AUTH-001,RT-001,RULE-020,UI-001 | landing/create/join/auth/lobby/settings; only supported settings shown        |
| UI-003 | TODO   | Standard board                    | UI-001,014,SPIKE-006            | responsive/custom production board; canonical 40-tile data                    |
| UI-004 | TODO   | 3–6 HUD                          | UI-003,014                      | long names/balances/states; no document-level desktop scroll                  |
| UI-005 | TODO   | turn/dice/action tray             | UI-003,014,RULE-007,013         | server-derived legal/pending/committed/disabled states                        |
| UI-006 | TODO   | property/build/mortgage           | RULE-007,UI-003,014             | deed panel + legal/disabled clarity                                           |
| UI-007 | TODO   | auction UI                        | RULE-005,RT-007,UI-014          | 10 bidders usable; authoritative countdown/state                              |
| UI-008 | TODO   | trade UI                          | RULE-014,UI-014                 | large trade usable; stale/invalid acceptance states clear                     |
| UI-009 | TODO   | card/tax/detention UI             | RULE-008,012,013,UI-014         | clear deterministic resolution/pending states                                 |
| UI-010 | TODO   | debt/bankruptcy UI                | RULE-015,016,017,UI-014         | understandable liquidation/creditor/deadline state                            |
| UI-011 | TODO   | reconnect/replaced UI             | RT-008,UI-014                   | no raw socket errors; grace/replaced/expired states                           |
| UI-012 | TODO   | game end/rematch                  | RULE-019,RT-012,013,UI-014      | immutable result; fresh gameId; no stale old-game actions                     |
| UI-013 | TODO   | mobile/reduced-motion pass        | UI-002..012,014                 | critical flow works; reduced-motion and mobile/tablet layouts                 |
| UI-014 | TODO   | live authoritative game client    | RT-002,003,005,014              | one server-derived state source; retry reuses actionId; stale updates ignored |
| UI-015 | TODO   | room/social/game-log controls     | RT-009,010,011,014,018,RULE-020 | live chat/log; pause/host/settings; team/FFA states                           |
| UI-016 | TODO   | Collusion Guard UX                | INT-001,002,RT-017,UI-014       | server-driven warning/watch/removal/clawback/report states only               |

---

# G. Grand

| ID        | Status | Task                              | Depends                         | Acceptance                                                            |
| --------- | ------ | --------------------------------- | ------------------------------- | --------------------------------------------------------------------- |
| GRAND-001 | TODO   | Grand canonical production parity | CORE-010                        | existing frozen 52/12/30 definition integrates without reauthoring    |
| GRAND-002 | TODO   | 6–10 HUD/renderer                | UI-003,004,014,GRAND-001        | 10-player pathological cases; dense 2-line tile treatment             |
| GRAND-003 | TODO   | Grand economy production parity   | ECON-001,RULE-007,013,GRAND-001 | production rules reproduce frozen A/core economy; no silent rebalance |
| GRAND-004 | TODO   | production simulation 6/7/8/9/10  | GRAND-003                       | distributions recorded from production rule path                      |
| GRAND-005 | TODO   | human alpha core                  | GRAND-002,004,UI-013            | structured gameplay/UX feedback on playable Grand                     |
| GRAND-006 | TODO   | optional Turbo candidate          | GRAND-005                       | isolated tested module; not v1-required                               |
| GRAND-007 | TODO   | optional Transit candidate        | GRAND-005                       | isolated tested module; not v1-required                               |
| GRAND-008 | TODO   | optional A/B/C compare            | GRAND-006,007                   | simulation+humans; selecting none remains valid                       |
| GRAND-009 | TODO   | optional selected pacing behavior | GRAND-008                       | only implemented if evidence beats frozen A/core                      |

---

# H. Meta/progression

| ID       | Status | Task                       | Depends         | Acceptance                                                          |
| -------- | ------ | -------------------------- | --------------- | ------------------------------------------------------------------- |
| META-001 | TODO   | profile service/read model | DATA-001,RT-012 | stable profile load from internal userId; retry/error safe          |
| META-002 | TODO   | XP/level                   | META-001,RT-012 | server-finalized; duplicate/retry safe; test/sandbox games excluded |
| META-003 | TODO   | coins                      | META-001,RT-012 | cosmetics only; duplicate/retry safe; test/sandbox games excluded   |
| META-004 | TODO   | history                    | META-001,RT-012 | idempotent finalized-game record                                    |
| META-005 | TODO   | achievements               | META-002,004    | server-derived only; duplicate-safe                                 |
| META-006 | TODO   | cosmetic inventory         | META-003        | no gameplay advantage; server-authoritative ownership               |
| META-007 | TODO   | profile UI                 | META-001..006   | loading/error/empty states; no client-authored progression          |

---

# I. Release hardening

| ID     | Status | Task                                    | Depends                                 | Acceptance                                                                   |
| ------ | ------ | --------------------------------------- | --------------------------------------- | ---------------------------------------------------------------------------- |
| QA-001 | TODO   | 10-browser full match                   | QA-012,GRAND-002,RULE-019               | all clients converge through complete live match                             |
| QA-002 | TODO   | reconnect chaos                         | QA-001,RT-008                           | no economic/state corruption across disconnect/replacement                   |
| QA-003 | TODO   | persistence/deadline failure regression | RT-005,007,012,013                      | atomic boundaries/retry/reconstruction/finalization safe                     |
| QA-004 | TODO   | 1000+ cross-board rematches             | RT-013,GRAND-001                        | zero old-game/cross-board contamination                                      |
| QA-005 | TODO   | large production seeded fuzz run        | QA-011,RULE-019                         | no invariant break; failing seeds reproducible                               |
| QA-006 | TODO   | deployed quota rerun                    | QA-014                                  | <=10% desired; >20% fail                                                     |
| QA-007 | TODO   | accessibility review                    | UI-013                                  | critical WCAG/keyboard/reduced-motion pass                                   |
| QA-008 | TODO   | cross-browser                           | QA-001                                  | critical Chrome/Firefox/Safari/Edge flow pass                                |
| QA-009 | TODO   | auth/security review                    | AUTH-001,RT-015,META-007,UI-014         | no blocker; direct API/client tampering cases covered                        |
| QA-010 | TODO   | public-release IP review                | UI-013,GRAND-002                        | recorded human/legal decision; no copied trade dress/assets                  |
| QA-011 | TODO   | production rule fuzz/sim adaptation     | RULE-019,CORE-013,CORE-014              | real production transitions; replay seeds; money/asset/phase/card invariants |
| QA-012 | TODO   | runtime/browser verification foundation | RT-014,UI-014                           | runnable integration/E2E commands in CI                                      |
| QA-013 | TODO   | Collusion Guard adversarial suite       | INT-002,RT-017,UI-016                   | deterministic evidence; duplicate/reconnect safety; false-positive cases     |
| QA-014 | TODO   | production deploy/rollback smoke        | RT-012,013,014,015,016,UI-013,GRAND-002 | web+Worker+D1/auth/bindings smoke; rollback/recovery procedure verified      |
| QA-015 | TODO   | final gameplay balance/human gate       | RULE-019,GRAND-005,QA-011               | both boards rerun with final mechanics; human pacing/snowball caveats closed |

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

## Separate product follow-ups

- RULE-011/012: finalize card content independently of visual placeholder values; rerun production/final economy simulation after changed effects or values.
- RULE-013: full Holding choices/attempts and held release cards must replace the economy bot's pay-on-skipped-turn approximation before final balance approval.
- GRAND-005/008: human playtest frozen Grand A/core; optional B/C pacing candidates remain non-v1 unless evidence justifies selection.
- INT-001/002 + RT-017 + UI-016 + QA-013: Collusion Guard is the explicit FFA anti-collusion/integrity track. Private Design behavior is not production policy until INT-001 is approved.
- Claude Design remains the visual UX source of truth for Section F/G production UI. The existing SPIKE-006 React shell is implementation evidence, not the visual target.
