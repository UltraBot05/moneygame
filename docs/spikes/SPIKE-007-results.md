# Spike Result — SPIKE-007 (seeded fuzz harness)

**Date:** 2026-09-03 (independent review 2026-09-04)
**Builder:** Claude Code
**Reviewer:** Claude Code (independent-integrator pass) — **APPROVE**
**Branch:** working tree on `main` @ `af6cdff` (unstaged; see Builder Handoff)

## Independent review (2026-09-04)

Independently executed and attempted to falsify the harness. Confirmed: the seed
is deterministic (`runFuzz(3)` twice → identical command log **and** world hash;
different seed → different hash); `FUZZ_SEED` reruns the identical sequence; the
generator reaches non-trivial paths (current/stale/missing gameIds, a 5-value
action pool forcing idempotency + cross-game collisions, rematches, deadlines,
alarms, connect/disconnect); invalid commands are rejected by `checkGameScoped`
**before** any write (the `mutation-matches-tag` invariant would catch a write on
a rejected/duplicate/no-op tag); and both negative controls genuinely fail the
registry (direct retired-game corruption → `retired-game-frozen`; fuzzed
stale-guard bypass → a `FuzzViolation` across the CI seeds). No `Math.random`, no
React import, no UI coupling. Full suite: **144 tests PASS** incl. this file's 9;
observed fuzz test-body runtime ~1.8 s. No correctness or test-quality defect
found — harness preserved unchanged. Verdict: **APPROVE**.

## Acceptance (TASKS.md)

Legal command generator · invariant registry · deterministic seed · injected
invariant defect detected · failing seed replayable.

## Hypothesis / falsifier

A seeded generator of legal-and-invalid command sequences, run against the real
authoritative transition + seat logic, upholds a registry of invariants
deterministically and reproducibly; and the registry can actually detect a
violation. **Falsifier:** a seed is non-deterministic; a failure cannot be
reproduced from its seed; the generator only reaches trivial paths; or the
negative control does not fail.

## What it drives (no fake path)

The harness ([fuzz.testkit.ts](../../app/worker/src/fuzz.testkit.ts)) calls the
**same** exported functions the Durable Object (`room.ts`) calls —
`checkGameScoped`, `handleIncrement`, `startGame`, `resolveDueAlarm`,
`setActiveTurn`, `connectSeat`, `disconnectSeat` — over real `node:sqlite` via
the `SqlDb` seam. No React, no Cloudflare runtime, no game rules invented beyond
what SPIKE-002/004/005 already implement. Because it reaches only through the
real APIs, it cannot pass by mirroring internals.

## RNG / seed model

`mulberry32(seed)` — a pure, injected deterministic PRNG. All command choices,
gameId/actionId selection and the advancing clock derive from it, so a seed fully
determines the run (no `Math.random`, no wall clock). gameIds are generated
deterministically (`g0`, `g1`, …), not `crypto.randomUUID`, so runs are
byte-for-byte reproducible.

## Command generation (legal + intentionally invalid)

Weighted mix of `INCREMENT`, `REMATCH`, `SET_DEADLINE`, `SET_TURN`, `ALARM`,
`CONNECT`, `DISCONNECT`. Each game-scoped command's `gameId` is drawn as **current
(~65%)**, a **random known/stale game (~25%)**, or **missing (~10%)**; `actionId`
comes from a 5-value pool so duplicates and cross-game collisions occur
frequently. This deliberately exercises the reject paths (`STALE_GAME`,
`GAME_ID_REQUIRED`) and idempotency, not just the happy path.

## Invariant registry

| Invariant | What it catches |
|---|---|
| `mutation-matches-tag` | a rejected/duplicate/no-op command that nonetheless moved `gameVersion`; a commit that moved it by ≠1 |
| `value-equals-gameVersion` | non-atomic mutation (state and version must advance together) |
| `gameVersion-monotonic` | any per-game version regression |
| `retired-game-frozen` | an ended game mutating after a rematch (cross-game contamination) |
| `current-game-coherent` | current pointer drift / current game with no state row |
| `unique-game-ids` | a reused gameId |
| `board-immutable` | mutation of the frozen canonical board identity/tile counts |
| `epoch-monotonic` | a per-user connection epoch regression |

The registry is checked after **every** step; a violation throws a
`FuzzViolation` carrying the seed, step index, offending command, invariant name,
and detail. The seed replays the full deterministic command sequence.

## Bounds (CI) + reproduction

- **Fixed CI seeds:** `[1, 7, 42, 1234, 99999]`, **400 steps** each → 2000
  command applications, each followed by the full registry. Reverified test-body
  runtime: **1.53 s** (3.52 s full Vitest process).
- **Developer seed override:** set `FUZZ_SEED` to pin a single seed.

Re-run a specific seed:

```bash
FUZZ_SEED=42 pnpm exec vitest run app/worker/src/fuzz.test.ts
```

```powershell
$env:FUZZ_SEED = "42"; pnpm exec vitest run app/worker/src/fuzz.test.ts
```

A failure prints `FUZZ_SEED=<seed> step=<n> invariant=<name>` plus the command,
which reproduces it exactly (the seed replays the identical sequence).

## Negative proof (the registry can fail)

Two controls, both green:

1. **Deterministic corruption** — build a world, commit in game A, rematch to B
   (A retired + snapshotted), then mutate the retired game A through the real API
   with the stale-game guard **bypassed** (`injectDefect`). `checkInvariants`
   then throws `retired-game-frozen`. The test asserts the clean world passes and
   the corrupted world throws.
2. **Fuzzed defect** — running the full generator with the stale-guard bypass
   across the CI seeds surfaces at least one `FuzzViolation` (stale increments now
   mutate). Deterministic (seeded), so not flaky.

Assertions test outcomes (version deltas, retired snapshots, reject tags), not a
copy of the implementation's arithmetic.

## 2026-09-03 adversarial audit

The current harness was inspected against the real transition, deadline, rematch,
SQLite, and seat APIs. The audit found:

- all generated choices derive from the seeded PRNG and deterministic clock;
- no `Math.random`, wall clock, React import, or UI coupling;
- the small action-id pool forces idempotency collisions;
- current, stale, and missing game IDs are all generated;
- rematches retain retired snapshots and create deterministic unique game IDs;
- deadlines, alarms, connection epochs, disconnects, and reconnects are exercised;
- the direct retired-game corruption and fuzzed stale-guard bypass both fail the
  registry as intended;
- the five fixed seeds and deterministic replay tests passed without flakiness.

No correctness or test-quality defect justified rewriting the harness, so the
implementation was preserved unchanged.

## Determinism evidence

`runFuzz(3)` twice yields identical command logs **and** identical final world
hashes; a different seed yields a different hash. Asserted directly.

## Reproduction

```text
pnpm test   # fuzz.test.ts = 9 tests (5 seeds + determinism + 2 negative controls)
pnpm typecheck && pnpm lint && pnpm build
```

## Limitations

- The canonical "state" under test is SPIKE-002's game-scoped counter
  (`value`/`gameVersion`), plus rematch/deadline/seat lifecycle — the invariants
  reachable through today's APIs. Rich rules (movement, rent, trades) do not
  exist yet; their invariants will be added to this same registry as CORE-/RULE-
  tasks land. No statistical guarantee is claimed — fixed seeds, bounded steps.
- Rich-`GameState` aliasing and board-JSON immutability are additionally covered
  by game-core's own 900-cycle isolation tests (`game.test.ts`); this harness
  keeps a cheap board-identity immutability check and focuses on the
  persistence/transition/seat sequence invariants.
- The harness is a `.testkit.ts` (node-builtin, vitest-only), excluded from the
  Worker runtime build like the other test utilities.

## Decision

`APPROVE — DONE` (was `PASS — READY_FOR_REVIEW`) — a seeded, deterministic, reproducible harness generates legal and
invalid command sequences against the real transition/seat logic, upholds a
named invariant registry across fixed CI seeds in ~1.4 s, prints a replayable
failing seed, and its negative controls prove the registry genuinely detects an
injected invariant defect. No falsifier triggered.

## Architecture impact

- None. SPIKE-007 adds a reusable fuzz/property harness over existing logic; the
  invariant registry is the natural home for future CORE-/RULE- invariants. No
  ADR change proposed.
