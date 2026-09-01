# Spike Result — SPIKE-002 (persistence fault injection)

**Date:** 2026-09-02
**Builder:** Claude Code
**Reviewer:** _pending independent review_
**Commit:** _pending — one logical commit on `task/spike-002` (see Builder Handoff)_

## Hypothesis

The server-authoritative persist-before-broadcast pipeline (ADR-003) recovers
safely from failures at every meaningful persistence boundary without: reporting
uncommitted state as authoritative; losing committed state; applying one action
twice; corrupting `gameVersion`; or depending on stale resident memory.

## Falsifier

Any of: success/broadcast before commit; a torn/mixed state after an incomplete
write; a retry of a committed `actionId` advancing `gameVersion` again; a
committed action's idempotency record not persisted atomically with the state;
idempotency provable only from in-memory state; correctness depending on the old
DO instance retaining memory.

## Setup

- **Real persistence path.** The authoritative transition
  ([transition.ts](../../app/worker/src/transition.ts)) runs over a small
  transaction-capable `SqlDb` seam. The Durable Object
  ([room.ts](../../app/worker/src/room.ts)) implements it over `SqlStorage` with
  `ctx.storage.transactionSync`; the tests
  ([transition.test.ts](../../app/worker/src/transition.test.ts)) implement it
  over `node:sqlite` with real `BEGIN`/`COMMIT`/`ROLLBACK` — the same SQL
  statements in both.
- **Minimum persisted idempotency mechanism (architecture finding).** SPIKE-001
  committed state with a single `UPDATE … RETURNING` but persisted **no**
  idempotency metadata, so a retry could not be recognised from durable state —
  the ADR-003 `actionId` requirement was unmet. SPIKE-002 adds the minimum:
  a table `applied_actions(action_id PRIMARY KEY, game_version, value)` recording
  each committed action's result, written in the **same transaction** as the
  `game_state` mutation. `SpikeRoom` INCREMENT now takes an optional `actionId`
  and routes through `applyIncrement`; a retry returns the recorded result
  without re-applying. No new dependency; no generic command/retry framework.
- **Fault injection is test-only.** `applyIncrement(db, actionId, opts?)` takes
  an optional `opts.fault` hook (throws `FaultInjected` at a named boundary) and
  an `opts.brokenOrdering` toggle (negative sanity only). Production callers in
  `room.ts` pass neither, so no fault path is reachable at runtime.

## Fault matrix (directly automated evidence)

Starting state `gameVersion=0, value=0`; single action `a1`.

| Fault point | Commit occurred? | Client observed success? | version before → after | Retry (same actionId) | Final state | Result |
|---|---|---|---|---|---|---:|
| `BEFORE_WRITE` | no | no (throws) | 0 → 0 | applies once → v1 | v1 | PASS |
| `DURING_WRITE` (after UPDATE) | no (rolled back) | no (throws) | 0 → 0 | applies once → v1 | v1 | PASS |
| `DURING_WRITE` (after INSERT, pre-commit) | no (rolled back) | no (throws) | 0 → 0 | applies once → v1 | v1 | PASS |
| `AFTER_WRITE_BEFORE_BROADCAST` | **yes** | no (broadcast lost) | 0 → 1 | duplicate → recovers v1, **no** re-advance | v1 | PASS |
| `AFTER_COMMIT_RESPONSE_LOSS` | **yes** | ack lost | 0 → 1 | duplicate → **no** re-advance | v1 | PASS |

Interpretation vs the required invariants:

1. **BEFORE_WRITE** — previous state intact, `gameVersion` unchanged, no
   success/broadcast; a later retry executes once. ✓
2. **DURING_WRITE** — the `UPDATE` and the `applied_actions` insert are in one
   transaction; a throw at either inner boundary rolls **both** back, so
   reconstruction shows the complete previous state (never torn), and the retry
   applies exactly once. ✓
3. **AFTER_WRITE_BEFORE_BROADCAST** — state + record are durable, `gameVersion`
   advanced exactly once; the retry returns the recorded result and does **not**
   mutate again. A missed broadcast never becomes a duplicated mutation. ✓
4. **AFTER_COMMIT_RESPONSE_LOSS** — same `actionId` → same committed outcome, no
   second increment, no second version advance. ✓

## Delayed duplicate — historical result vs current snapshot (B1)

A committed action result is retained as durable idempotency metadata, but a
retry must never publish that (possibly stale) snapshot as current room state.
`handleIncrement` separates the two: a fresh commit broadcasts the new state; a
duplicate broadcasts **nothing** and returns the *current* authoritative
snapshot to the requester only.

Scenario (automated, reconstructed from persisted SQLite between steps):

| Step | Action | Canonical after | Broadcast | Requester sees |
|---|---|---|---|---|
| 1 | `a1` commit | v1 | v1 (to all) | v1 |
| 2 | `a2` commit | v2 | v2 (to all) | v2 |
| 3 | retry `a1` | **v2 (unchanged)** | **none** | v2 (current) |
| 4 | `a3` commit | v3 | v3 (to all) | v3 |

`a1` is not re-applied and `gameVersion` never regresses; its historical result
(v1) remains in `applied_actions`. The regression test asserts the step-3
broadcast is `null` and `current` is v2 — it fails under the previous code,
which broadcast the historical v1 snapshot as current.

## Alarm resolution atomicity (B2)

Deadline resolution and the canonical mutation it triggers now commit in ONE
transaction (`resolveDueAlarm`), broadcasting only after commit. Batch semantics
(as in SPIKE-001): one firing with ≥1 due deadline resolves them all and
advances `gameVersion` exactly once. Fault matrix (automated, real SQLite):

| Fault point | Deadline resolved? | State/version | Broadcast? | Replay-safe | Result |
|---|---|---|---|---|---:|
| `BEFORE_WRITE` | no | unchanged | no | resolves once later | PASS |
| after resolve, before state write | no (rolled back) | unchanged | no | resolves once later | PASS |
| after state write, before commit | no (rolled back) | unchanged | no | resolves once later | PASS |
| success | yes | +1 exactly once | after commit | — | PASS |
| replay after success | already resolved | unchanged (+0) | no | `resolved=0` guard | PASS |

The rollback tests (rows 2–3) assert the deadline is **not** left resolved when
the state write is missing — they fail if resolution were committed separately
from the mutation, which is the exact B2 defect. Batch: two due + one future
deadline → both due resolved, one state advance, the future deadline untouched.

## Idempotency / atomicity / reconstruction / version invariant

- **Idempotency from persisted state:** duplicate detection reads
  `applied_actions`, proven after commit, after response loss, and after
  reconstruction. Also proven: a *different* `actionId` still executes (v1→v2).
- **Atomicity:** state mutation + idempotency record commit in one
  `transaction`; there is no crash window where one lands without the other.
- **Reconstruction:** a brand-new `SqlDb` over the same persisted database
  (sharing no JS state — the DO-eviction/wake analogue) recognises the duplicate
  and reads the committed state. Correctness does not depend on resident memory.
- **`gameVersion` invariant:** +1 for a unique action; +0 for a failed
  uncommitted action; +0 for a retry of a committed action. Explicitly asserted.

## Negative sanity proof (the suite CAN fail on a broken pipeline)

`transition.test.ts` runs the SAME crash scenario two ways:

- **Broken ordering** (`brokenOrdering: true`): state and record commit in
  *separate* transactions with a crash between them → state at v1 but **no**
  record → the retry is not seen as a duplicate → `gameVersion` advances to
  **2** (double application).
- **Correct atomic ordering:** the same crash rolls the single transaction back
  → the retry applies exactly once → `gameVersion` = 1.

The `toEqual({gameVersion:1,...})` assertion that passes on the correct path
would **fail** (observed v2) under non-atomic ordering — demonstrating the test
detects a broken commit ordering. The defect exists only behind the test-only
`brokenOrdering` toggle and is never in the production path.

## Evidence classes

- **Directly automated (real SQLite):** the entire client-action + alarm fault
  matrices, the B1 delayed-duplicate scenario, idempotency, atomicity,
  reconstruction, version-invariant, and negative-sanity results — 18 tests,
  real `BEGIN`/`COMMIT`/`ROLLBACK`.
- **Deployed:** none. Fault injection is test-only and cannot be triggered on a
  deployed DO, so a deployment would add no fault evidence; the DO executes the
  same `transition.ts` proven here.
- **Inferred:** the DO's `ctx.storage.transactionSync` rollback-on-throw is
  taken to match SQLite `ROLLBACK` semantics modelled in the tests. The
  transition logic itself is identical (shared module).

## Reproduction

```text
pnpm test        # 69 tests total; app/worker/src/transition.test.ts = 18
pnpm typecheck
pnpm lint
pnpm build
```

## Limitations

- The alarm path now resolves deadlines and mutates canonical state in one
  transaction (`resolveDueAlarm`), with batch-per-firing = one advance. Choosing
  a different per-deadline economic effect is RT-007 game-logic work, not a
  persistence-recovery question.
- `applied_actions` grows unbounded in this spike (no pruning); a production
  bound/GC is later work, not required to prove recovery.
- Fault boundaries are modelled at the transition-module seam that `room.ts`
  actually calls; they are faithful to the DO's statement order but are not
  triggered against a live deployment (fault hooks are test-only).

## Decision

`PASS` — every fault point (client-action AND alarm) recovers within the
ADR-003 invariants on the real SQLite persistence path: no uncommitted state
reported/committed, no torn state, no lost committed state, idempotent retries
from persisted metadata, exactly-once `gameVersion`, and correctness independent
of resident memory. A delayed duplicate never broadcasts a stale snapshot as
current state (B1), and deadline resolution commits atomically with its canonical
mutation (B2). The negative-sanity and rollback tests confirm the suite fails if
commit ordering is broken.

## Architecture impact

- ADR-003 satisfied. SPIKE-002 surfaced and fixed a real gap: SPIKE-001 lacked
  persisted `actionId` idempotency metadata. The minimum mechanism
  (`applied_actions`, committed atomically with state) is now in place for RT-005
  to build on. No ADR amendment required.
