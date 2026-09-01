import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import {
  applyIncrement,
  DEADLINES_SCHEMA,
  ensureSchema,
  FaultInjected,
  handleIncrement,
  readState,
  recordedResult,
  resolveDueAlarm,
  type FaultPoint,
  type SqlDb,
} from "./transition";

/**
 * Fault-injection proof for the ADR-003 persist-before-broadcast pipeline,
 * exercised against REAL SQLite (`node:sqlite`) with real BEGIN/COMMIT/ROLLBACK
 * transaction semantics — the same statements the Durable Object runs.
 */

/** A `SqlDb` over a real SQLite connection; `transaction` rolls back on throw. */
function nodeDb(db: DatabaseSync): SqlDb {
  return {
    run: (query: string, ...params: (string | number)[]): number =>
      Number(db.prepare(query).run(...params).changes),
    get: <T extends Record<string, string | number>>(
      query: string,
      ...params: (string | number)[]
    ): T | undefined => db.prepare(query).get(...params) as T | undefined,
    transaction: <T>(fn: () => T): T => {
      db.exec("BEGIN");
      try {
        const result = fn();
        db.exec("COMMIT");
        return result;
      } catch (err) {
        db.exec("ROLLBACK");
        throw err;
      }
    },
  };
}

function seed(): { db: DatabaseSync; sql: SqlDb } {
  const db = new DatabaseSync(":memory:");
  const sql = nodeDb(db);
  ensureSchema(sql);
  return { db, sql };
}

const faultAt =
  (target: FaultPoint) =>
  (point: FaultPoint): void => {
    if (point === target) throw new FaultInjected(point);
  };

const ZERO = { gameVersion: 0, value: 0 };
const ONE = { gameVersion: 1, value: 1 };

describe("SPIKE-002 persistence fault injection", () => {
  it("BEFORE_WRITE: nothing commits; retry applies once", () => {
    const { sql } = seed();
    expect(() =>
      applyIncrement(sql, "a1", { fault: faultAt("BEFORE_WRITE") }),
    ).toThrow(FaultInjected);
    expect(readState(sql)).toEqual(ZERO);
    expect(recordedResult(sql, "a1")).toBeUndefined();

    const retry = applyIncrement(sql, "a1");
    expect(retry).toEqual({ state: ONE, duplicate: false });
    expect(readState(sql)).toEqual(ONE);
  });

  it("DURING_WRITE (after UPDATE): transaction rolls back, no torn state", () => {
    const { sql } = seed();
    expect(() =>
      applyIncrement(sql, "a1", { fault: faultAt("DURING_WRITE_AFTER_UPDATE") }),
    ).toThrow(FaultInjected);
    // The UPDATE inside the transaction is undone.
    expect(readState(sql)).toEqual(ZERO);
    expect(recordedResult(sql, "a1")).toBeUndefined();

    const retry = applyIncrement(sql, "a1");
    expect(retry.duplicate).toBe(false);
    expect(readState(sql)).toEqual(ONE);
  });

  it("DURING_WRITE (after INSERT, pre-commit): both statements roll back", () => {
    const { sql } = seed();
    expect(() =>
      applyIncrement(sql, "a1", { fault: faultAt("DURING_WRITE_AFTER_INSERT") }),
    ).toThrow(FaultInjected);
    expect(readState(sql)).toEqual(ZERO);
    expect(recordedResult(sql, "a1")).toBeUndefined();

    const retry = applyIncrement(sql, "a1");
    expect(retry.state).toEqual(ONE);
    expect(recordedResult(sql, "a1")).toEqual(ONE);
  });

  it("AFTER_WRITE_BEFORE_BROADCAST: committed once; retry recovers, no re-apply", () => {
    const { sql } = seed();
    expect(() =>
      applyIncrement(sql, "a1", {
        fault: faultAt("AFTER_WRITE_BEFORE_BROADCAST"),
      }),
    ).toThrow(FaultInjected);
    // Persisted before the (lost) broadcast: state advanced exactly once.
    expect(readState(sql)).toEqual(ONE);
    expect(recordedResult(sql, "a1")).toEqual(ONE);

    const retry = applyIncrement(sql, "a1");
    expect(retry).toEqual({ state: ONE, duplicate: true });
    expect(readState(sql)).toEqual(ONE); // no second advance
  });

  it("AFTER_COMMIT_RESPONSE_LOSS: client retry is idempotent", () => {
    const { sql } = seed();
    const first = applyIncrement(sql, "a1"); // commits; client "loses" the ack
    expect(first).toEqual({ state: ONE, duplicate: false });

    const retry = applyIncrement(sql, "a1");
    expect(retry).toEqual({ state: ONE, duplicate: true });
    expect(readState(sql)).toEqual(ONE);
  });

  it("a different actionId still executes normally", () => {
    const { sql } = seed();
    applyIncrement(sql, "a1");
    applyIncrement(sql, "a2");
    expect(readState(sql)).toEqual({ gameVersion: 2, value: 2 });
  });

  it("idempotency survives reconstruction (fresh instance, no resident memory)", () => {
    const { db, sql } = seed();
    applyIncrement(sql, "a1");

    // Simulate DO eviction + wake: a brand-new SqlDb over the SAME persisted
    // database, sharing no JS state. The duplicate is recognised from rows.
    const reconstructed = nodeDb(db);
    const retry = applyIncrement(reconstructed, "a1");
    expect(retry).toEqual({ state: ONE, duplicate: true });
    expect(readState(reconstructed)).toEqual(ONE);
  });

  it("gameVersion invariant: +1 unique, +0 failed, +0 committed-retry", () => {
    const { sql } = seed();
    expect(readState(sql).gameVersion).toBe(0);

    applyIncrement(sql, "a1");
    expect(readState(sql).gameVersion).toBe(1); // unique -> +1

    expect(() =>
      applyIncrement(sql, "a2", { fault: faultAt("BEFORE_WRITE") }),
    ).toThrow(FaultInjected);
    expect(readState(sql).gameVersion).toBe(1); // failed -> +0

    applyIncrement(sql, "a1");
    expect(readState(sql).gameVersion).toBe(1); // committed retry -> +0
  });
});

describe("SPIKE-002 B1: duplicate retry never broadcasts a stale snapshot", () => {
  it("keeps canonical state current when an old actionId is retried", () => {
    const { db, sql } = seed();
    expect(handleIncrement(sql, "a1").broadcast).toEqual(ONE); // v1
    expect(handleIncrement(sql, "a2").broadcast).toEqual({ gameVersion: 2, value: 2 }); // v2

    // Reconstruct from persisted SQLite, then retry the OLD action a1.
    const fresh = nodeDb(db);
    const retry = handleIncrement(fresh, "a1");
    expect(retry.duplicate).toBe(true);
    expect(retry.broadcast).toBeNull(); // no stale v1 broadcast as current state
    expect(retry.current).toEqual({ gameVersion: 2, value: 2 }); // current authority
    expect(readState(fresh)).toEqual({ gameVersion: 2, value: 2 }); // not mutated/regressed
    // Historical action-result metadata is retained, not discarded.
    expect(recordedResult(fresh, "a1")).toEqual(ONE);

    // A new action still advances.
    expect(handleIncrement(fresh, "a3").broadcast).toEqual({ gameVersion: 3, value: 3 });
  });
});

// --- alarm (B2) helpers ------------------------------------------------------

const ALARM_NOW = 1000;

function seedAlarm(): { db: DatabaseSync; sql: SqlDb } {
  const s = seed();
  s.sql.run(DEADLINES_SCHEMA);
  return s;
}

function addDeadline(sql: SqlDb, id: string, fireAt: number, resolved = 0): void {
  sql.run(
    `INSERT INTO deadlines (id, fire_at, resolved) VALUES (?, ?, ?);`,
    id,
    fireAt,
    resolved,
  );
}

function isResolved(sql: SqlDb, id: string): number {
  const row = sql.get<{ resolved: number }>(
    `SELECT resolved FROM deadlines WHERE id = ?;`,
    id,
  );
  return row === undefined ? -1 : row.resolved;
}

describe("SPIKE-002 B2: alarm resolution + canonical mutation are atomic", () => {
  it("1. failure BEFORE the alarm transaction: no resolution, no state change", () => {
    const { sql } = seedAlarm();
    addDeadline(sql, "d1", ALARM_NOW);
    expect(() =>
      resolveDueAlarm(sql, ALARM_NOW, { fault: faultAt("BEFORE_WRITE") }),
    ).toThrow(FaultInjected);
    expect(isResolved(sql, "d1")).toBe(0);
    expect(readState(sql)).toEqual(ZERO);
  });

  it("2. failure AFTER resolve, BEFORE state write: whole transaction rolls back", () => {
    const { sql } = seedAlarm();
    addDeadline(sql, "d1", ALARM_NOW);
    expect(() =>
      resolveDueAlarm(sql, ALARM_NOW, {
        fault: faultAt("DURING_WRITE_AFTER_UPDATE"),
      }),
    ).toThrow(FaultInjected);
    // The resolve is undone together with the (never-reached) state mutation:
    // no torn "deadline resolved but state missing" outcome.
    expect(isResolved(sql, "d1")).toBe(0);
    expect(readState(sql)).toEqual(ZERO);
  });

  it("3. failure AFTER state update, BEFORE commit: whole transaction rolls back", () => {
    const { sql } = seedAlarm();
    addDeadline(sql, "d1", ALARM_NOW);
    expect(() =>
      resolveDueAlarm(sql, ALARM_NOW, {
        fault: faultAt("DURING_WRITE_AFTER_INSERT"),
      }),
    ).toThrow(FaultInjected);
    expect(isResolved(sql, "d1")).toBe(0);
    expect(readState(sql)).toEqual(ZERO);
  });

  it("4. successful alarm: deadline resolved, state advanced exactly once", () => {
    const { sql } = seedAlarm();
    addDeadline(sql, "d1", ALARM_NOW);
    const outcome = resolveDueAlarm(sql, ALARM_NOW);
    expect(outcome.resolved).toBe(1);
    expect(outcome.broadcast).toEqual(ONE);
    expect(isResolved(sql, "d1")).toBe(1);
    expect(readState(sql)).toEqual(ONE);
  });

  it("5. alarm replay: no duplicate mutation, no extra gameVersion advance", () => {
    const { sql } = seedAlarm();
    addDeadline(sql, "d1", ALARM_NOW);
    resolveDueAlarm(sql, ALARM_NOW); // v1
    const replay = resolveDueAlarm(sql, ALARM_NOW);
    expect(replay.resolved).toBe(0);
    expect(replay.broadcast).toBeNull();
    expect(readState(sql)).toEqual(ONE);
  });

  it("6. reconstruction (fresh adapter) reflects persisted truth", () => {
    const { db, sql } = seedAlarm();
    addDeadline(sql, "d1", ALARM_NOW);
    resolveDueAlarm(sql, ALARM_NOW);
    const fresh = nodeDb(db); // DO evict/wake analogue, no shared memory
    const replay = resolveDueAlarm(fresh, ALARM_NOW);
    expect(replay.broadcast).toBeNull();
    expect(readState(fresh)).toEqual(ONE);
    expect(isResolved(fresh, "d1")).toBe(1);
  });

  it("7. broadcast only after commit: a failing alarm yields no outcome", () => {
    const { sql } = seedAlarm();
    addDeadline(sql, "d1", ALARM_NOW);
    let broadcast: unknown = "unset";
    try {
      broadcast = resolveDueAlarm(sql, ALARM_NOW, {
        fault: faultAt("DURING_WRITE_AFTER_INSERT"),
      }).broadcast;
    } catch {
      // no outcome to broadcast
    }
    expect(broadcast).toBe("unset");
    expect(readState(sql)).toEqual(ZERO);
  });

  it("batch: multiple due deadlines resolve together; state advances once", () => {
    const { sql } = seedAlarm();
    addDeadline(sql, "d1", ALARM_NOW);
    addDeadline(sql, "d2", ALARM_NOW - 1);
    addDeadline(sql, "d3", ALARM_NOW + 10_000); // not yet due
    const outcome = resolveDueAlarm(sql, ALARM_NOW);
    expect(outcome.resolved).toBe(2);
    expect(readState(sql)).toEqual(ONE); // one advance for the batch
    expect(isResolved(sql, "d3")).toBe(0); // future deadline untouched
  });
});

describe("SPIKE-002 negative sanity (the suite CAN detect broken ordering)", () => {
  it("non-atomic actionId ordering duplicates on retry; atomic ordering does not", () => {
    // BROKEN: state committed, then a crash before the SEPARATE record write.
    const broken = seed();
    expect(() =>
      applyIncrement(broken.sql, "a1", {
        brokenOrdering: true,
        fault: faultAt("DURING_WRITE_AFTER_UPDATE"),
      }),
    ).toThrow(FaultInjected);
    expect(readState(broken.sql)).toEqual(ONE); // state committed
    expect(recordedResult(broken.sql, "a1")).toBeUndefined(); // record lost
    // Retry is NOT seen as a duplicate -> the action is applied a second time.
    const brokenRetry = applyIncrement(broken.sql, "a1");
    expect(brokenRetry.duplicate).toBe(false);
    expect(readState(broken.sql)).toEqual({ gameVersion: 2, value: 2 }); // DOUBLE

    // CORRECT: same crash point, atomic transaction -> rolled back, retry once.
    const ok = seed();
    expect(() =>
      applyIncrement(ok.sql, "a1", {
        fault: faultAt("DURING_WRITE_AFTER_UPDATE"),
      }),
    ).toThrow(FaultInjected);
    applyIncrement(ok.sql, "a1");
    expect(readState(ok.sql)).toEqual(ONE); // exactly once

    // The `toEqual(ONE)` assertion above would FAIL (see gameVersion 2) if the
    // idempotency record were not committed atomically with the state — which
    // is exactly what the broken branch demonstrates.
  });
});
