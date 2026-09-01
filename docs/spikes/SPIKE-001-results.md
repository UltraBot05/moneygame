# Spike Result — SPIKE-001

**Date:** 2026-09-01
**Builder:** Claude Code (Anthropic Opus)
**Reviewer:** (pending independent review)
**Commit:** (this branch: `task/spike-001`)

## 1. Hypothesis / Falsifier

**Hypothesis:** Worker → one SQLite-backed Durable Object per room → WebSocket
Hibernation API → persisted canonical state → Alarm API → wake/reconstruction,
with authoritative state persisted **before** broadcast, **all** pending absolute
deadlines persisted and the Alarm API scheduled for the **earliest** one (using
indexed, `resolved = 0`-filtered queries so reads do not grow with history), and
**no** gameplay `setTimeout`/`setInterval`/heartbeat/keep-warm loop in the DO.

**Falsifier:**
- Functional: 10 clients cannot converge on a committed `gameVersion`; state does
  not survive reconstruction; the earliest deadline is not the one scheduled; a
  retried alarm double-applies; deadline reads scale with resolved history;
  correctness needs stale in-memory state.
- Resource (representative game): exceeds **>20%** of any daily free-tier quota —
  DO requests > 20,000; DO duration > 2,600 GB-s; SQL reads > 1,000,000;
  SQL writes > 20,000. 10–20% ⇒ MODIFY. ≤10% ⇒ PASS.

## Cost-safety

This account also carries an unrelated **R2 Paid** subscription. SPIKE-001 used
**only** Workers Free + SQLite-backed Durable Objects + workers.dev. No R2
bucket/binding/API was created or touched; no paid product was enabled; no
billing/subscription setting was changed. Every `wrangler deploy` completed on the
free plan without any paid-product prompt; account DO billing shows **$0.00**.

## 2. Deployment

- **Current deployment (all evidence below unless labelled historical):** Worker
  `moneygame-worker`, **Version ID `b8c1b1f5-a89a-41be-8e97-9cab640bc200`**,
  DO binding `SPIKE_ROOM` / class `SpikeRoom` / namespace `moneygame-worker_SpikeRoom`.
- URL: `https://moneygame-worker.moneygame-worker.workers.dev`
- Historical (superseded): `1c697be0…` (first), `664c18ef…` (earliest-deadline
  fix). The `1c697be0` dashboard is reused ONLY as the GB-s base in §11, labelled.
- Tooling: node `v22.23.2`, pnpm `9.15.4`, wrangler `4.127.1`,
  workerd `1.20260828.1`, `compatibility_date = "2025-01-01"`.
- Command: `pnpm exec wrangler deploy`. Account: `Tlauncherati@gmail.com's Account`
  (Workers Free). No auth token recorded.

## 3. 10-client convergence (deployed, current version)

`ROOM=spike-r3 node scripts/spike-client.mjs wss://…workers.dev full`
(window 04:18:29Z–04:18:40Z):

```
connected=10 initialVersions=[0,0,0,0,0,0,0,0,0,0]
metricsBASELINE {"rowsRead":15,"rowsWritten":7,"setAlarmCount":0,"connections":10}
afterINCREMENT versions=[1,1,1,1,1,1,1,1,1,1] converged=true
deltaINCREMENT rowsRead=2 rowsWritten=1
afterALARM  versions=[2,2,2,2,2,2,2,2,2,2] converged=true expected=2
deltaDEADLINE+ALARM rowsRead=5 rowsWritten=6 setAlarmCount=1
metricsFINAL {"rowsRead":22,"rowsWritten":14,"setAlarmCount":1,"connections":10}
FUNCTIONAL_PASS
```

Persist-before-broadcast is guaranteed by construction (`commitIncrement()` runs
`UPDATE … RETURNING`; only the returned row is broadcast).

## 4. Reconstruction ASSERTION evidence (M1 of prior round; still enforced)

`read` mode **asserts** expected `gameVersion`/`value` and exits non-zero on
missing/mismatch. Deployed, after ~45 s idle on `spike-r3`:

```
$ ROOM=spike-r3 node scripts/spike-client.mjs wss://…workers.dev read 2 2
expected gameVersion = 2
expected value = 2
observed gameVersion = 2
observed value = 2
RECONSTRUCTION_PASS            # exit 0
```

Proof it fails non-zero (local, non-mutating, wrong expectation):

```
$ node scripts/spike-client.mjs ws://127.0.0.1:8787 read 99 99
observed gameVersion = 2
RECONSTRUCTION_FAIL            # exit 1
```

Missing state also fails (`undefined` ≠ finite expected). State survived
reconstruction.

## 5. Earliest-deadline correctness + bounded reads (M2)

The DO persists **all** deadlines as unique-id rows and schedules the Alarm API
for the earliest unresolved one. Scheduling/resolution query only `resolved = 0`
rows, backed by an index, so **reads do not grow with resolved history**:

- index `idx_deadlines_pending (resolved, fire_at)`;
- earliest: `SELECT fire_at FROM deadlines WHERE resolved = 0 ORDER BY fire_at LIMIT 1;`
- due: `SELECT id FROM deadlines WHERE resolved = 0 AND fire_at <= ?;`
- resolve: `UPDATE deadlines SET resolved = 1 WHERE id = ?;`

**Correctness tests** (`app/worker/src/deadlines.test.ts`, run against real SQLite
via Node's built-in `node:sqlite` — no dependency added; `pnpm test`, 5 tests):
later-then-earlier → earliest; earlier-then-later → earliest; next earliest after
resolve; `due` excludes resolved (idempotent alarm retry); and `EXPLAIN QUERY
PLAN` for the earliest query uses the index (not a full `SCAN`).

**Bounded `rowsRead` stress (deployed, real `cursor.rowsRead`)** — 300 rows
(295 resolved history + 5 pending):

```
$ ROOM=spike-stress node scripts/spike-client.mjs wss://…workers.dev stress 295 5
{"totalRows":300,"resolved":295,"pending":5,
 "readFullScanAll":300,"readEarliestPending":1,"readDuePending":6,
 "readResolveOne":1,"readNextPending":1}
```

A naive `SELECT id FROM deadlines` reads **300**, but the actual queries read
**1** (earliest), **6** (due = 5 pending + 1), **1** (resolve), **1** (next) —
independent of the 295-row resolved history. The previous O(history) full-table
scan is gone. No `setTimeout`/`setInterval` in the DO.

## 6. Bounded error-status evidence (no-fault lifecycle)

One deployed full run captured live via `wrangler tail --format json`
(room `spike-r3`, deployment `b8c1b1f5`, window 04:18:29Z–04:18:40Z, no unrelated
requests):

| outcome | count |
|---|---:|
| `ok` | 16 |
| `canceled` | 20 |
| `exception` / CPU / memory / internal | **0** |

36 invocation records, `exceptions: []` on every record. Every non-`ok` outcome
is the WebSocket disconnect lifecycle (`canceled` — the harness closes all 10
sockets), which the dashboard surfaces as "Client disconnected". **Zero fault
outcomes** → no unexplained runtime fault. (Harness close behaviour unchanged.)

## 7. Direct provider measurement

- **Current deployment (`b8c1b1f5`):** live `wrangler tail` categorisation above
  (36 invocations, 0 faults). Aggregate dashboard analytics (requests/GB-s) are
  not reachable programmatically here (this Wrangler OAuth has no `analytics:read`
  scope; no `CLOUDFLARE_API_TOKEN`; no token extracted; tail carries no
  `cpuTime`/`wallTime`).
- **Historical (`1c697be0`) user-supplied dashboard** — used ONLY as the GB-s base
  in §11: DO requests **48** (runtime invocations), billable duration
  **0.01 GB-sec**, storage operations 56, request wall time ~0.29 ms, median
  0.41 ms, invocation status Client disconnected 10 / exception 0 / CPU 0 /
  memory 0 / internal 0, account billable usage **$0.00**.

## 8. Instrumented SQL billing counters (measured, current deployment)

From `SqlStorageCursor.rowsRead`/`.rowsWritten` (exact billed SQL values;
`setAlarm()` counted separately as one row write):

| Operation (measured) | rows read | rows written | setAlarm (billed write) |
|---|---:|---:|---:|
| One `INCREMENT` | 2 | 1 | 0 |
| One deadline set + alarm resolution | 5 | 6 | 1 |
| One client connect (`readState`) | 1 | 0 | 0 |

## 9. Logical/runtime activity estimate (representative game)

Target: 10 players / World Tour Grand / ~90 min / chat + auctions + trades +
reconnects. Assumed event counts (ASSUMPTION):

- state-committing authoritative actions: **2,000**
- chat messages: **1,000**
- connects + reconnects: **60**
- deadline+alarm cycles: **300**

```
inbound WS messages = 2,000 + 1,000 + 300 = 3,300
connections         = 60
alarm invocations   = 300
total logical/runtime invocations ≈ 3,660
```

## 10. Cloudflare quota-billed DO requests

Cloudflare bills **incoming WebSocket messages at 20:1** (20 messages = 1 billed
request); WebSocket **connections** and **alarm** invocations bill 1:1. The
~3,660 above is logical activity, **not** billed requests:

```
WS messages : 3,300 / 20 = 165
connections : 60    × 1   = 60
alarms      : 300   × 1   = 300
billed DO requests ≈ 165 + 60 + 300 = 525
```

### SQL estimate (measured per-op §8 × assumed counts §9)

Per-action multipliers (reads ×5, writes ×2) are ASSUMPTIONS — real actions are
heavier than the toy counter. Deadline+alarm uses the measured 5 reads and
6 SQL writes + 1 setAlarm (= 7 billed writes) per cycle; deadline reads are
**bounded by the index**, not by history (§5).

```
SQL reads  ≈ 2,000×5 + 300×5 + 60×1 + 1,000×1 ≈ 12,560
SQL writes ≈ 2,000×2 + 300×7 + 1,000×1        ≈ 7,100
```

| Dimension | Estimate | Desired ≤ | FAIL > | Verdict |
|---|---:|---:|---:|---|
| Billed DO requests | ≈ 525 | 10,000 | 20,000 | within desired |
| SQL reads | ≈ 12,560 | 500,000 | 1,000,000 | within desired (large margin) |
| SQL writes | ≈ 7,100 | 10,000 | 20,000 | within desired (**tightest**) |

SQL writes is the tightest metric: each `SET_DEADLINE` now inserts a distinct
indexed row (+ setAlarm), so write-heavy deadline churn is the dimension to watch;
under these assumptions it stays under the 10,000 desired mark and far below the
20,000 fail line.

## 11. Duration sanity extrapolation (rough — NOT a measurement)

Dimensionally consistent scaling on **logical/runtime invocations** (both the base
count and the representative count are runtime invocations — no billed-request
units are mixed in):

```
48 runtime invocations  -> 0.01 GB-sec   (historical dashboard base, §7)
3,660 / 48              = 76.25
0.01 GB-sec × 76.25    ≈ 0.76 GB-sec
```

**≈ 0.76 GB-sec** is a rough sanity extrapolation, **not** a measured 90-minute
duration and **not** based on billed-request units. It is ~0.06% of the 1,300
GB-sec desired budget and far below the 2,600 GB-sec fail line, consistent with
the hibernation design (idle DOs bill ~nothing). The M2 change alters deadline
query shape, not the compute/hibernation duration profile.

## 12. Assumptions / limitations

- Representative event counts (§9) are assumptions; the real game core is heavier
  than an integer counter (hence the ×5/×2 per-action multipliers).
- GB-s has no fresh dashboard reading for `b8c1b1f5`; the 0.01 GB-sec base is from
  historical deployment `1c697be0` and used only for the §11 extrapolation.
- Reconstruction used a ~45 s idle + reconnect (hibernation-eligible window), a
  wake opportunity rather than a guaranteed observed eviction.
- Tail categorises outcomes (ok/canceled/fault) but does not attribute each
  `canceled` invocation to a specific lifecycle step; the material fact is zero
  fault outcomes.

## 13. Decision

**PASS.**

- Functional falsifiers did not trigger on the current deployment: 10-client
  convergence, alarm resolution, SQLite persistence, **asserted** idle
  reconstruction, earliest-deadline scheduling (unit-tested), idempotent alarm
  retry, bounded deadline reads (indexed; stress proves reads stay ~1 with 300
  historical rows), Hibernation API, and no gameplay timers.
- Resource: billed DO requests ≈ 525, SQL reads ≈ 12,560, SQL writes ≈ 7,100 —
  all below desired; duration sanity extrapolation ≈ 0.76 GB-sec — far below
  desired. Billing $0.00 on Workers Free. Zero fault outcomes.

### Follow-ups (non-blocking)

- Read a fresh dashboard GB-s for `b8c1b1f5` from a longer, representative session
  before the architecture freeze (FREEZE-001) to replace the §11 extrapolation.

## Reviewer notes

- (pending)

## Architecture impact

- None. SPIKE-001 PASS supports ADR-001 (Cloudflare room runtime) as designed;
  no ADR change proposed. The architecture freeze remains a separate human +
  independent-review gate (FREEZE-001).
