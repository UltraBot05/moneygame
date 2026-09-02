import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import {
  applyIncrement,
  checkGameScoped,
  currentGameId,
  ensureSchema,
  handleIncrement,
  readState,
  recordedResult,
  resolveDueAlarm,
  startGame,
  StaleGameError,
  type NewGame,
  type SqlDb,
} from "./transition";
import { nodeDb } from "./sqlite.testkit";

/**
 * SPIKE-005 — rematch persistence isolation at the runtime boundary. Proves the
 * game-scoped SQLite persistence cannot alias/collide across games: gameId
 * namespace on idempotency + deadlines, atomic new-game transition, stale-game
 * command rejection, and cross-game action/deadline isolation — after
 * reconstruction too. Real `node:sqlite`.
 */

const GAME_A: NewGame = {
  gameId: "A",
  boardId: "world-tour-standard",
  boardVersion: 1,
  tileCount: 40,
};
const GAME_B: NewGame = {
  gameId: "B",
  boardId: "world-tour-grand",
  boardVersion: 1,
  tileCount: 52,
};

function seed(): { db: DatabaseSync; sql: SqlDb } {
  const db = new DatabaseSync(":memory:");
  const sql = nodeDb(db);
  ensureSchema(sql);
  return { db, sql };
}

describe("SPIKE-005 fresh game identity + atomic rematch", () => {
  it("a rematch installs a new current gameId with fresh state", () => {
    const { sql } = seed();
    startGame(sql, GAME_A, 0);
    handleIncrement(sql, "A", "x1");
    handleIncrement(sql, "A", "x2");
    expect(readState(sql, "A")).toEqual({ gameVersion: 2, value: 2 });

    startGame(sql, GAME_B, 10);
    expect(currentGameId(sql)).toBe("B");
    // Fresh baseline; game A untouched and still readable in its own namespace.
    expect(readState(sql, "B")).toEqual({ gameVersion: 0, value: 0 });
    expect(readState(sql, "A")).toEqual({ gameVersion: 2, value: 2 });
  });

  it("never exposes new-gameId+old-state or old-gameId+new-state (atomic)", () => {
    const { db, sql } = seed();
    startGame(sql, GAME_A, 0);
    handleIncrement(sql, "A", "x1");
    startGame(sql, GAME_B, 10);
    // After reconstruction, current pointer and its state row are coherent.
    const fresh = nodeDb(db);
    const current = currentGameId(fresh);
    expect(current).toBe("B");
    expect(readState(fresh, current as string)).toEqual({ gameVersion: 0, value: 0 });
  });
});

describe("SPIKE-005 D: actionId collision across games", () => {
  it("the same actionId in game B is not treated as game A's duplicate", () => {
    const { db, sql } = seed();
    startGame(sql, GAME_A, 0);
    const a = handleIncrement(sql, "A", "X");
    expect(a.duplicate).toBe(false);
    expect(a.broadcast).toEqual({ gameVersion: 1, value: 1 });

    startGame(sql, GAME_B, 10);
    // Same actionId "X", now in game B — must APPLY, not dedup against game A.
    const b = handleIncrement(sql, "B", "X");
    expect(b.duplicate).toBe(false);
    expect(b.broadcast).toEqual({ gameVersion: 1, value: 1 });

    // Each game keeps its own idempotency record.
    expect(recordedResult(sql, "A", "X")).toEqual({ gameVersion: 1, value: 1 });
    expect(recordedResult(sql, "B", "X")).toEqual({ gameVersion: 1, value: 1 });

    // Holds after reconstruction; a genuine B-retry still dedups within B.
    const fresh = nodeDb(db);
    const bRetry = handleIncrement(fresh, "B", "X");
    expect(bRetry.duplicate).toBe(true);
    expect(bRetry.broadcast).toBeNull();
    expect(readState(fresh, "B")).toEqual({ gameVersion: 1, value: 1 });
  });
});

describe("SPIKE-005 C: delayed old-game command after rematch", () => {
  it("is rejected as STALE_GAME and cannot touch the new game", () => {
    const { db, sql } = seed();
    startGame(sql, GAME_A, 0);
    startGame(sql, GAME_B, 10);

    expect(() => handleIncrement(sql, "A", "late")).toThrow(StaleGameError);
    // No mutation, no idempotency record, no version advance in game B.
    expect(readState(sql, "B")).toEqual({ gameVersion: 0, value: 0 });
    expect(recordedResult(sql, "B", "late")).toBeUndefined();
    // And nothing leaked into game A's namespace either.
    expect(recordedResult(sql, "A", "late")).toBeUndefined();

    // Same after reconstruction.
    const fresh = nodeDb(db);
    expect(() => handleIncrement(fresh, "A", "late")).toThrow(StaleGameError);
    expect(readState(fresh, "B")).toEqual({ gameVersion: 0, value: 0 });
  });
});

describe("SPIKE-005 E: old deadline after rematch", () => {
  it("an old-game deadline firing cannot mutate the new game", () => {
    const { db, sql } = seed();
    startGame(sql, GAME_A, 0);
    // A pending deadline in game A.
    sql.run(
      `INSERT INTO deadlines (game_id, id, fire_at, resolved) VALUES ('A', 'dA', 500, 0);`,
    );

    startGame(sql, GAME_B, 10);
    // The alarm fires "later" (now=1000). It resolves only the CURRENT game (B),
    // which has no due deadline → no mutation. Game A's stale deadline is left
    // untouched in its own namespace and never affects B.
    const outcome = resolveDueAlarm(sql, 1000);
    expect(outcome.resolved).toBe(0);
    expect(outcome.broadcast).toBeNull();
    expect(readState(sql, "B")).toEqual({ gameVersion: 0, value: 0 });

    // The A deadline is still unresolved (never fired against B); holds after reconstruction.
    const fresh = nodeDb(db);
    const dA = fresh.get<{ resolved: number }>(
      `SELECT resolved FROM deadlines WHERE game_id = 'A' AND id = 'dA';`,
    );
    expect(dA?.resolved).toBe(0);
    expect(resolveDueAlarm(fresh, 5000).broadcast).toBeNull();
    expect(readState(fresh, "B")).toEqual({ gameVersion: 0, value: 0 });
  });
});

describe("SPIKE-005 mandatory gameId on every game-scoped mutation", () => {
  it("missing gameId is rejected GAME_ID_REQUIRED with zero writes", () => {
    const { sql } = seed();
    startGame(sql, GAME_A, 0);
    handleIncrement(sql, "A", "x1"); // A at v1
    expect(checkGameScoped(sql, undefined)).toEqual({
      ok: false,
      code: "GAME_ID_REQUIRED",
    });
    // The guard is read-only: no state change, no idempotency record created.
    expect(readState(sql, "A")).toEqual({ gameVersion: 1, value: 1 });
    expect(recordedResult(sql, "A", "x2")).toBeUndefined();
  });

  it("a stale (non-current) gameId is rejected STALE_GAME; the current one passes", () => {
    const { sql } = seed();
    startGame(sql, GAME_A, 0);
    startGame(sql, GAME_B, 10);
    expect(checkGameScoped(sql, "A")).toEqual({ ok: false, code: "STALE_GAME" });
    expect(checkGameScoped(sql, "B")).toEqual({ ok: true, gameId: "B" });
  });

  it("never substitutes the current game for a missing/stale gameId", () => {
    const { sql } = seed();
    startGame(sql, GAME_A, 0);
    const miss = checkGameScoped(sql, undefined);
    expect(miss.ok).toBe(false); // NOT silently resolved to "A"
    expect("gameId" in miss).toBe(false);
  });

  it("delayed REMATCH targeting the old game is STALE_GAME (no game C, B unchanged)", () => {
    const { sql } = seed();
    startGame(sql, GAME_A, 0);
    startGame(sql, GAME_B, 10); // rematch A -> B
    handleIncrement(sql, "B", "b1"); // B at v1
    // The room validates gameId===current BEFORE calling startGame, so a delayed
    // REMATCH(A) is rejected and never starts a game C.
    expect(checkGameScoped(sql, "A")).toEqual({ ok: false, code: "STALE_GAME" });
    expect(currentGameId(sql)).toBe("B");
    expect(readState(sql, "B")).toEqual({ gameVersion: 1, value: 1 });
  });

  it("the guard holds after reconstruction", () => {
    const { db, sql } = seed();
    startGame(sql, GAME_A, 0);
    startGame(sql, GAME_B, 10);
    const fresh = nodeDb(db);
    expect(checkGameScoped(fresh, undefined)).toEqual({
      ok: false,
      code: "GAME_ID_REQUIRED",
    });
    expect(checkGameScoped(fresh, "A")).toEqual({ ok: false, code: "STALE_GAME" });
    expect(checkGameScoped(fresh, "B")).toEqual({ ok: true, gameId: "B" });
  });
});

describe("SPIKE-005 gameVersion isolation", () => {
  it("advancing game B never collides with or regresses game A", () => {
    const { sql } = seed();
    startGame(sql, GAME_A, 0);
    applyIncrement(sql, "A", "a1");
    applyIncrement(sql, "A", "a2");
    applyIncrement(sql, "A", "a3"); // A at v3

    startGame(sql, GAME_B, 10); // B baseline v0
    applyIncrement(sql, "B", "b1"); // B at v1

    expect(readState(sql, "A").gameVersion).toBe(3);
    expect(readState(sql, "B").gameVersion).toBe(1);
  });
});
