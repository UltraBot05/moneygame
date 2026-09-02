import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import {
  applyIncrement,
  ensureSchema,
  FaultInjected,
  handleIncrement,
  readState,
  recordedResult,
  resolveDueAlarm,
  startGame,
  type FaultPoint,
  type NewGame,
  type SqlDb,
} from "./transition";
import { nodeDb } from "./sqlite.testkit";

/**
 * Fault-injection proof for the ADR-003 persist-before-broadcast pipeline,
 * exercised against REAL SQLite (`node:sqlite`) with real BEGIN/COMMIT/ROLLBACK.
 * SPIKE-005 made this persistence game-scoped; these SPIKE-002 tests thread a
 * single fixed `gameId` (behaviour is unchanged for one game).
 */

const GID = "gameA";
const GAME_A: NewGame = {
  gameId: GID,
  boardId: "world-tour-standard",
  boardVersion: 1,
  tileCount: 40,
};

function seed(): { db: DatabaseSync; sql: SqlDb } {
  const db = new DatabaseSync(":memory:");
  const sql = nodeDb(db);
  ensureSchema(sql);
  startGame(sql, GAME_A, 0);
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
      applyIncrement(sql, GID, "a1", { fault: faultAt("BEFORE_WRITE") }),
    ).toThrow(FaultInjected);
    expect(readState(sql, GID)).toEqual(ZERO);
    expect(recordedResult(sql, GID, "a1")).toBeUndefined();

    const retry = applyIncrement(sql, GID, "a1");
    expect(retry).toEqual({ state: ONE, duplicate: false });
    expect(readState(sql, GID)).toEqual(ONE);
  });

  it("DURING_WRITE (after UPDATE): transaction rolls back, no torn state", () => {
    const { sql } = seed();
    expect(() =>
      applyIncrement(sql, GID, "a1", { fault: faultAt("DURING_WRITE_AFTER_UPDATE") }),
    ).toThrow(FaultInjected);
    expect(readState(sql, GID)).toEqual(ZERO);
    expect(recordedResult(sql, GID, "a1")).toBeUndefined();

    const retry = applyIncrement(sql, GID, "a1");
    expect(retry.duplicate).toBe(false);
    expect(readState(sql, GID)).toEqual(ONE);
  });

  it("DURING_WRITE (after INSERT, pre-commit): both statements roll back", () => {
    const { sql } = seed();
    expect(() =>
      applyIncrement(sql, GID, "a1", { fault: faultAt("DURING_WRITE_AFTER_INSERT") }),
    ).toThrow(FaultInjected);
    expect(readState(sql, GID)).toEqual(ZERO);
    expect(recordedResult(sql, GID, "a1")).toBeUndefined();

    const retry = applyIncrement(sql, GID, "a1");
    expect(retry.state).toEqual(ONE);
    expect(recordedResult(sql, GID, "a1")).toEqual(ONE);
  });

  it("AFTER_WRITE_BEFORE_BROADCAST: committed once; retry recovers, no re-apply", () => {
    const { sql } = seed();
    expect(() =>
      applyIncrement(sql, GID, "a1", {
        fault: faultAt("AFTER_WRITE_BEFORE_BROADCAST"),
      }),
    ).toThrow(FaultInjected);
    expect(readState(sql, GID)).toEqual(ONE);
    expect(recordedResult(sql, GID, "a1")).toEqual(ONE);

    const retry = applyIncrement(sql, GID, "a1");
    expect(retry).toEqual({ state: ONE, duplicate: true });
    expect(readState(sql, GID)).toEqual(ONE);
  });

  it("AFTER_COMMIT_RESPONSE_LOSS: client retry is idempotent", () => {
    const { sql } = seed();
    const first = applyIncrement(sql, GID, "a1");
    expect(first).toEqual({ state: ONE, duplicate: false });

    const retry = applyIncrement(sql, GID, "a1");
    expect(retry).toEqual({ state: ONE, duplicate: true });
    expect(readState(sql, GID)).toEqual(ONE);
  });

  it("a different actionId still executes normally", () => {
    const { sql } = seed();
    applyIncrement(sql, GID, "a1");
    applyIncrement(sql, GID, "a2");
    expect(readState(sql, GID)).toEqual({ gameVersion: 2, value: 2 });
  });

  it("idempotency survives reconstruction (fresh instance, no resident memory)", () => {
    const { db, sql } = seed();
    applyIncrement(sql, GID, "a1");

    const reconstructed = nodeDb(db);
    const retry = applyIncrement(reconstructed, GID, "a1");
    expect(retry).toEqual({ state: ONE, duplicate: true });
    expect(readState(reconstructed, GID)).toEqual(ONE);
  });

  it("gameVersion invariant: +1 unique, +0 failed, +0 committed-retry", () => {
    const { sql } = seed();
    expect(readState(sql, GID).gameVersion).toBe(0);

    applyIncrement(sql, GID, "a1");
    expect(readState(sql, GID).gameVersion).toBe(1);

    expect(() =>
      applyIncrement(sql, GID, "a2", { fault: faultAt("BEFORE_WRITE") }),
    ).toThrow(FaultInjected);
    expect(readState(sql, GID).gameVersion).toBe(1);

    applyIncrement(sql, GID, "a1");
    expect(readState(sql, GID).gameVersion).toBe(1);
  });
});

describe("SPIKE-002 B1: duplicate retry never broadcasts a stale snapshot", () => {
  it("keeps canonical state current when an old actionId is retried", () => {
    const { db, sql } = seed();
    expect(handleIncrement(sql, GID, "a1").broadcast).toEqual(ONE);
    expect(handleIncrement(sql, GID, "a2").broadcast).toEqual({ gameVersion: 2, value: 2 });

    const fresh = nodeDb(db);
    const retry = handleIncrement(fresh, GID, "a1");
    expect(retry.duplicate).toBe(true);
    expect(retry.broadcast).toBeNull();
    expect(retry.current).toEqual({ gameVersion: 2, value: 2 });
    expect(readState(fresh, GID)).toEqual({ gameVersion: 2, value: 2 });
    expect(recordedResult(fresh, GID, "a1")).toEqual(ONE);

    expect(handleIncrement(fresh, GID, "a3").broadcast).toEqual({ gameVersion: 3, value: 3 });
  });
});

// --- alarm (B2) helpers ------------------------------------------------------

const ALARM_NOW = 1000;

function addDeadline(sql: SqlDb, id: string, fireAt: number, resolved = 0): void {
  sql.run(
    `INSERT INTO deadlines (game_id, id, fire_at, resolved) VALUES (?, ?, ?, ?);`,
    GID,
    id,
    fireAt,
    resolved,
  );
}

function isResolved(sql: SqlDb, id: string): number {
  const row = sql.get<{ resolved: number }>(
    `SELECT resolved FROM deadlines WHERE game_id = ? AND id = ?;`,
    GID,
    id,
  );
  return row === undefined ? -1 : row.resolved;
}

describe("SPIKE-002 B2: alarm resolution + canonical mutation are atomic", () => {
  it("1. failure BEFORE the alarm transaction: no resolution, no state change", () => {
    const { sql } = seed();
    addDeadline(sql, "d1", ALARM_NOW);
    expect(() =>
      resolveDueAlarm(sql, ALARM_NOW, { fault: faultAt("BEFORE_WRITE") }),
    ).toThrow(FaultInjected);
    expect(isResolved(sql, "d1")).toBe(0);
    expect(readState(sql, GID)).toEqual(ZERO);
  });

  it("2. failure AFTER resolve, BEFORE state write: whole transaction rolls back", () => {
    const { sql } = seed();
    addDeadline(sql, "d1", ALARM_NOW);
    expect(() =>
      resolveDueAlarm(sql, ALARM_NOW, {
        fault: faultAt("DURING_WRITE_AFTER_UPDATE"),
      }),
    ).toThrow(FaultInjected);
    expect(isResolved(sql, "d1")).toBe(0);
    expect(readState(sql, GID)).toEqual(ZERO);
  });

  it("3. failure AFTER state update, BEFORE commit: whole transaction rolls back", () => {
    const { sql } = seed();
    addDeadline(sql, "d1", ALARM_NOW);
    expect(() =>
      resolveDueAlarm(sql, ALARM_NOW, {
        fault: faultAt("DURING_WRITE_AFTER_INSERT"),
      }),
    ).toThrow(FaultInjected);
    expect(isResolved(sql, "d1")).toBe(0);
    expect(readState(sql, GID)).toEqual(ZERO);
  });

  it("4. successful alarm: deadline resolved, state advanced exactly once", () => {
    const { sql } = seed();
    addDeadline(sql, "d1", ALARM_NOW);
    const outcome = resolveDueAlarm(sql, ALARM_NOW);
    expect(outcome.resolved).toBe(1);
    expect(outcome.broadcast).toEqual(ONE);
    expect(isResolved(sql, "d1")).toBe(1);
    expect(readState(sql, GID)).toEqual(ONE);
  });

  it("5. alarm replay: no duplicate mutation, no extra gameVersion advance", () => {
    const { sql } = seed();
    addDeadline(sql, "d1", ALARM_NOW);
    resolveDueAlarm(sql, ALARM_NOW);
    const replay = resolveDueAlarm(sql, ALARM_NOW);
    expect(replay.resolved).toBe(0);
    expect(replay.broadcast).toBeNull();
    expect(readState(sql, GID)).toEqual(ONE);
  });

  it("6. reconstruction (fresh adapter) reflects persisted truth", () => {
    const { db, sql } = seed();
    addDeadline(sql, "d1", ALARM_NOW);
    resolveDueAlarm(sql, ALARM_NOW);
    const fresh = nodeDb(db);
    const replay = resolveDueAlarm(fresh, ALARM_NOW);
    expect(replay.broadcast).toBeNull();
    expect(readState(fresh, GID)).toEqual(ONE);
    expect(isResolved(fresh, "d1")).toBe(1);
  });

  it("7. broadcast only after commit: a failing alarm yields no outcome", () => {
    const { sql } = seed();
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
    expect(readState(sql, GID)).toEqual(ZERO);
  });

  it("batch: multiple due deadlines resolve together; state advances once", () => {
    const { sql } = seed();
    addDeadline(sql, "d1", ALARM_NOW);
    addDeadline(sql, "d2", ALARM_NOW - 1);
    addDeadline(sql, "d3", ALARM_NOW + 10_000);
    const outcome = resolveDueAlarm(sql, ALARM_NOW);
    expect(outcome.resolved).toBe(2);
    expect(readState(sql, GID)).toEqual(ONE);
    expect(isResolved(sql, "d3")).toBe(0);
  });
});

describe("SPIKE-002 negative sanity (the suite CAN detect broken ordering)", () => {
  it("non-atomic actionId ordering duplicates on retry; atomic ordering does not", () => {
    const broken = seed();
    expect(() =>
      applyIncrement(broken.sql, GID, "a1", {
        brokenOrdering: true,
        fault: faultAt("DURING_WRITE_AFTER_UPDATE"),
      }),
    ).toThrow(FaultInjected);
    expect(readState(broken.sql, GID)).toEqual(ONE);
    expect(recordedResult(broken.sql, GID, "a1")).toBeUndefined();
    const brokenRetry = applyIncrement(broken.sql, GID, "a1");
    expect(brokenRetry.duplicate).toBe(false);
    expect(readState(broken.sql, GID)).toEqual({ gameVersion: 2, value: 2 });

    const ok = seed();
    expect(() =>
      applyIncrement(ok.sql, GID, "a1", {
        fault: faultAt("DURING_WRITE_AFTER_UPDATE"),
      }),
    ).toThrow(FaultInjected);
    applyIncrement(ok.sql, GID, "a1");
    expect(readState(ok.sql, GID)).toEqual(ONE);
  });
});
