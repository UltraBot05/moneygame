import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { admit, ensureRoomSchema, handleCommand, handleRoomAction, initializeRoom, runDueTimeouts, viewerGame } from "./room-runtime";
import { BEN, command, CY, deps, HOST, T0 } from "./room.testkit";
import { nodeDb } from "./sqlite.testkit";
import type { SqlDb } from "./transition";

/**
 * QA-003 persistence and deadline failure regression on the production room runtime: a write
 * that fails inside the commit transaction leaves no torn state, and the same actionId (or the
 * same due deadline) applies exactly once on retry, including after reconstruction.
 */
function faultyRoom() {
  const raw = new DatabaseSync(":memory:");
  const base = nodeDb(raw);
  let failOn: RegExp | null = null;
  const sql: SqlDb = {
    ...base,
    run: (query, ...params) => {
      if (failOn !== null && failOn.test(query)) {
        failOn = null;
        throw new Error("injected storage failure");
      }
      return base.run(query, ...params);
    },
  };
  ensureRoomSchema(sql);
  initializeRoom(sql, "ROOM42", HOST, T0);
  for (const user of [HOST, BEN, CY]) {
    admit(sql, user, T0);
    handleRoomAction(sql, user.userId, { kind: "SET_READY", ready: true }, deps(T0));
  }
  handleRoomAction(sql, HOST.userId, { kind: "START" }, deps(T0));
  return { raw, sql, failNext: (pattern: RegExp) => { failOn = pattern; } };
}

const snapshot = (sql: SqlDb) => ({
  state: sql.get<{ state_json: string; game_version: number }>("SELECT state_json, game_version FROM games;"),
  actions: sql.all("SELECT game_id, action_id, game_version FROM applied_actions ORDER BY action_id;"),
  deadline: sql.get("SELECT turn_id, deadline_at, extended FROM turn_deadline;"),
});

describe("QA-003 persistence failure regression", () => {
  for (const [stage, pattern] of [
    ["after the state write, before the idempotency row", /INSERT INTO applied_actions/],
    ["after the idempotency row, before the next turn's deadline", /INSERT INTO turn_deadline/],
  ] as const) {
    it("rolls back a command that fails " + stage + ", then applies its retry exactly once", () => {
      const { raw, sql, failNext } = faultyRoom();
      // Roll 4+6 to Holding (just visiting): nothing to decide, so END_TURN is next.
      expect(handleCommand(sql, HOST.userId, command(sql, "ROLL_DICE", {}, "roll-1"), deps(T0 + 5, [4, 6]))).toMatchObject({ kind: "COMMITTED" });
      const before = snapshot(sql);
      const end = command(sql, "END_TURN", {}, "end-1");
      failNext(pattern);
      expect(() => handleCommand(sql, HOST.userId, end, deps(T0 + 10))).toThrow("injected storage failure");
      expect(snapshot(sql)).toEqual(before);

      // Reconstruction: a fresh adapter over the same storage sees only committed truth.
      const rebuilt = nodeDb(raw);
      expect(handleCommand(rebuilt, HOST.userId, end, deps(T0 + 20))).toMatchObject({ kind: "COMMITTED" });
      expect(handleCommand(rebuilt, HOST.userId, end, deps(T0 + 30))).toMatchObject({ kind: "DUPLICATE" });
      expect(viewerGame(rebuilt, null)?.game).toMatchObject({ gameVersion: (before.state?.game_version as number) + 1, turn: { activePlayerId: BEN.userId } });
      expect(snapshot(rebuilt).deadline).not.toEqual(before.deadline);
    });
  }

  it("retries a due turn timeout that failed to commit, and auto-plays the turn once", () => {
    const { sql, failNext } = faultyRoom();
    const due = T0 + 91_000;
    const before = snapshot(sql);
    failNext(/UPDATE games SET/);
    expect(() => runDueTimeouts(sql, deps(due, [4, 6]))).toThrow("injected storage failure");
    expect(snapshot(sql)).toEqual(before);
    const events = runDueTimeouts(sql, deps(due, [4, 6]));
    expect(events.map((event) => event.type)).toEqual(["TURN_AUTO_PLAYED"]);
    expect(runDueTimeouts(sql, deps(due + 1))).toEqual([]);
    expect(viewerGame(sql, null)?.game.turn?.activePlayerId).toBe(BEN.userId);
  });
});
