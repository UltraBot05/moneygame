import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { createSeededRandom } from "@moneygame/game-core";
import { DEFAULT_ROOM_SETTINGS } from "@moneygame/shared";
import {
  admit,
  AUCTION_DECISION_MS,
  DEBT_WINDOW_MS,
  disconnect,
  ensureRoomSchema,
  grantReconnectExtension,
  handleCommand,
  handleLobby,
  initializeRoom,
  nextAlarmAt,
  roomView,
  runDueTimeouts,
  viewerGame,
  type RuntimeDeps,
} from "./room-runtime";
import { nodeDb } from "./sqlite.testkit";
import type { SqlDb } from "./transition";

const T0 = 1_000_000;
const HOST = { userId: "u-host", displayName: "Host" };
const BEN = { userId: "u-ben", displayName: "Ben" };
const CY = { userId: "u-cy", displayName: "Cy" };

/** Dice faces for the next rolls, then a seeded stream. */
function deps(now: number, faces: readonly number[] = []): RuntimeDeps {
  const queue = faces.map((face) => (face - 1) / 6 + 0.001);
  const seeded = createSeededRandom(3);
  return { now, rng: () => queue.shift() ?? seeded(), newGameId: () => "game-1" };
}

function fresh(): { db: DatabaseSync; sql: SqlDb } {
  const db = new DatabaseSync(":memory:");
  const sql = nodeDb(db);
  ensureRoomSchema(sql);
  initializeRoom(sql, "ROOM42", HOST, T0);
  return { db, sql };
}

function lobbyWithThree(): { db: DatabaseSync; sql: SqlDb } {
  const room = fresh();
  for (const user of [HOST, BEN, CY]) {
    admit(room.sql, user, T0);
    handleLobby(room.sql, user.userId, { kind: "SET_READY", ready: true }, deps(T0));
  }
  return room;
}

function startedRoom() {
  const room = lobbyWithThree();
  expect(handleLobby(room.sql, HOST.userId, { kind: "START" }, deps(T0))).toMatchObject({ kind: "COMMITTED" });
  return room;
}

function game(sql: SqlDb) {
  const state = viewerGame(sql, HOST.userId);
  if (state === null) throw new Error("no game");
  return state;
}

/** Test-only: edits the stored canonical state (still fully revalidated on the next load). */
function patchHost(sql: SqlDb, changes: Readonly<{ position?: number; cash?: number }>) {
  const row = sql.get<{ state_json: string }>("SELECT state_json FROM games WHERE game_id = 'game-1';");
  const state = JSON.parse(row?.state_json ?? "{}");
  state.players[0] = { ...state.players[0], ...changes };
  sql.run("UPDATE games SET state_json = ? WHERE game_id = 'game-1';", JSON.stringify(state));
}

function command(sql: SqlDb, type: string, payload: unknown = {}, actionId = type + ":" + game(sql).gameVersion) {
  const state = game(sql);
  return { type, gameId: state.gameId, actionId, expectedGameVersion: state.gameVersion, payload };
}

describe("RT-001 rooms, membership and lobby", () => {
  it("creates a room once and seats up to ten players before spectators", () => {
    const { sql } = fresh();
    expect(initializeRoom(sql, "ROOM42", BEN, T0)).toBe(false);
    expect(admit(sql, HOST, T0)).toMatchObject({ role: "PLAYER", kind: "NEW" });
    for (let index = 1; index < 10; index += 1) {
      expect(admit(sql, { userId: "u" + index, displayName: "P" + index }, T0).role).toBe("PLAYER");
    }
    expect(admit(sql, { userId: "u-late", displayName: "Late" }, T0).role).toBe("SPECTATOR");
    expect(roomView(sql, T0)?.members).toHaveLength(10);

    const empty = nodeDb(new DatabaseSync(":memory:"));
    ensureRoomSchema(empty);
    expect(admit(empty, HOST, T0).role).toBe("REFUSED");
  });

  it("lets only the host configure and start, and only with three or more ready members", () => {
    const room = fresh();
    admit(room.sql, HOST, T0);
    admit(room.sql, BEN, T0);
    const grand = { ...DEFAULT_ROOM_SETTINGS, boardRef: "world-tour-grand@1" as const, turnSeconds: 45 as const };
    expect(handleLobby(room.sql, BEN.userId, { kind: "CONFIGURE", settings: grand }, deps(T0)))
      .toMatchObject({ reason: "NOT_HOST" });
    expect(handleLobby(room.sql, HOST.userId, { kind: "LEAVE" }, deps(T0))).toMatchObject({ reason: "HOST_CANNOT_LEAVE" });
    expect(handleLobby(room.sql, HOST.userId, { kind: "CONFIGURE", settings: { ...grand, startingCash: 900 } }, deps(T0)))
      .toMatchObject({ reason: "INVALID_SETTINGS" });
    expect(handleLobby(room.sql, HOST.userId, { kind: "CONFIGURE", settings: grand }, deps(T0))).toMatchObject({ kind: "COMMITTED" });
    expect(roomView(room.sql, T0)?.settings).toEqual(grand);
    expect(handleLobby(room.sql, HOST.userId, { kind: "START" }, deps(T0))).toMatchObject({ reason: "NOT_ENOUGH_READY_PLAYERS" });

    admit(room.sql, CY, T0);
    for (const user of [HOST, BEN, CY]) handleLobby(room.sql, user.userId, { kind: "SET_READY", ready: true }, deps(T0));
    const teams = { ...grand, matchMode: "TEAMS" as const, teams: [{ teamId: "solo", memberUserIds: [HOST.userId] }] };
    handleLobby(room.sql, HOST.userId, { kind: "CONFIGURE", settings: teams }, deps(T0));
    for (const user of [HOST, BEN, CY]) handleLobby(room.sql, user.userId, { kind: "SET_READY", ready: true }, deps(T0));
    expect(handleLobby(room.sql, HOST.userId, { kind: "START" }, deps(T0))).toMatchObject({ reason: "INVALID_SETTINGS" });
  });

  it("starts a game from the lobby and arms the first turn clock", () => {
    const { sql } = startedRoom();
    const view = roomView(sql, T0);
    expect(view).toMatchObject({ phase: "IN_GAME", turnDeadlineAt: T0 + 90_000 });
    expect(game(sql)).toMatchObject({ phase: "ACTIVE_TURN", turn: { activePlayerId: HOST.userId } });
    expect(admit(sql, { userId: "u-new", displayName: "New" }, T0).role).toBe("SPECTATOR");
    expect(handleLobby(sql, HOST.userId, { kind: "START" }, deps(T0))).toMatchObject({ reason: "NOT_IN_LOBBY" });
  });
});

describe("RT-004/005/006 authoritative command path", () => {
  it("commits atomically, dedupes retries, and rejects stale or unauthorised commands without writes", () => {
    const { db, sql } = startedRoom();
    const roll = command(sql, "ROLL_DICE", {}, "roll-1");
    expect(handleCommand(sql, BEN.userId, roll, deps(T0))).toMatchObject({ kind: "REJECTED", reason: "NOT_YOUR_TURN" });
    const before = game(sql);
    expect(handleCommand(sql, HOST.userId, roll, deps(T0 + 1, [1, 2]))).toMatchObject({ kind: "COMMITTED" });
    const after = game(sql);
    expect(after.gameVersion).toBe(before.gameVersion + 1);
    expect(handleCommand(sql, HOST.userId, roll, deps(T0 + 2))).toEqual({ kind: "DUPLICATE" });
    expect(handleCommand(sql, HOST.userId, { ...roll, actionId: "roll-2" }, deps(T0 + 2)))
      .toMatchObject({ kind: "REJECTED", reason: "STALE_GAME_VERSION", currentGameVersion: after.gameVersion });
    expect(handleCommand(sql, HOST.userId, command(sql, "TURN_TIMEOUT", { turnId: "turn-1" }), deps(T0)))
      .toMatchObject({ reason: "SYSTEM_COMMAND" });
    expect(handleCommand(sql, HOST.userId, command(sql, "START_GAME"), deps(T0))).toMatchObject({ reason: "SYSTEM_COMMAND" });
    expect(handleCommand(sql, "u-stranger", command(sql, "END_TURN"), deps(T0))).toMatchObject({ reason: "NOT_A_MEMBER" });
    expect(handleCommand(sql, HOST.userId, command(sql, "BUY_PROPERTY", { nope: true }), deps(T0)))
      .toMatchObject({ reason: "MALFORMED_COMMAND" });
    expect(game(sql)).toEqual(after);

    const woken = nodeDb(db);
    expect(viewerGame(woken, HOST.userId)).toEqual(after);
  });

  it("never sends deck order to any viewer", () => {
    const { sql } = startedRoom();
    expect(JSON.stringify(viewerGame(sql, null))).not.toContain("drawPile");
  });
});

describe("RT-007 alarm-driven deadlines", () => {
  it("auto-plays an expired turn once, even if the alarm is delivered twice", () => {
    const { sql } = startedRoom();
    expect(nextAlarmAt(sql)).toBe(T0 + 90_000);
    expect(runDueTimeouts(sql, deps(T0 + 89_999))).toEqual([]);
    const late = T0 + 90_000;
    const events = runDueTimeouts(sql, deps(late, [1, 2, 3, 4]));
    expect(events.map((event) => event.type)).toContain("TURN_AUTO_PLAYED");
    const after = game(sql);
    expect(runDueTimeouts(sql, deps(late))).toEqual([]);
    expect(game(sql)).toEqual(after);
    expect(nextAlarmAt(sql)).not.toBeNull();
  });

  it("hands an auction to its own 20 s clock and stops the turn clock meanwhile", () => {
    const { sql } = startedRoom();
    // 2+4 from START lands on MA-1 (tile 6), which is unowned.
    handleCommand(sql, HOST.userId, command(sql, "ROLL_DICE", {}, "r1"), deps(T0, [2, 4]));
    const buying = game(sql);
    expect(buying.pendingResolution?.kind).toBe("BUY_DECISION");
    handleCommand(sql, HOST.userId, command(sql, "DECLINE_PROPERTY", { resolutionId: buying.pendingResolution?.resolutionId }, "d1"), deps(T0 + 5));
    expect(nextAlarmAt(sql)).toBe(T0 + 5 + AUCTION_DECISION_MS);
    expect(roomView(sql, T0 + 5)?.turnDeadlineAt).toBeNull();
    const passes = runDueTimeouts(sql, deps(T0 + 5 + AUCTION_DECISION_MS));
    expect(passes[0]).toMatchObject({ type: "AUCTION_UPDATED", action: "AUTO_PASS" });
  });

  it("forces bankruptcy when the persisted debt deadline passes", () => {
    const { sql } = startedRoom();
    patchHost(sql, { position: 11, cash: 50 });
    // 1+2 from tile 11 lands on Customs (tile 14): $100 owed with $50.
    handleCommand(sql, HOST.userId, command(sql, "ROLL_DICE", {}, "r1"), deps(T0 + 10, [1, 2]));
    expect(game(sql).pendingResolution?.obligation).toMatchObject({ amount: 100 });
    expect(nextAlarmAt(sql)).toBe(T0 + 10 + DEBT_WINDOW_MS);
    const events = runDueTimeouts(sql, deps(T0 + 10 + DEBT_WINDOW_MS));
    expect(events[0]).toMatchObject({ type: "PLAYER_BANKRUPT", fact: { userId: HOST.userId, reason: "DEADLINE" } });
    expect(game(sql).turn?.activePlayerId).toBe(BEN.userId);
    expect(roomView(sql, T0)?.turnDeadlineAt).toBe(T0 + 10 + DEBT_WINDOW_MS + 90_000);
  });
});

describe("RT-008 reconnect, extension and rejoin", () => {
  it("extends the owner's turn once on a genuine reconnect and never on a rejoin", () => {
    const { sql } = startedRoom();
    disconnect(sql, HOST.userId, 1, T0 + 1_000);
    expect(roomView(sql, T0 + 1_000)?.members[0]).toMatchObject({ connected: false, away: false });
    expect(admit(sql, HOST, T0 + 30_000)).toMatchObject({ kind: "RECONNECT" });
    expect(grantReconnectExtension(sql, HOST.userId)).toBe(true);
    expect(roomView(sql, T0)?.turnDeadlineAt).toBe(T0 + 90_000 + 20_000);
    expect(grantReconnectExtension(sql, HOST.userId)).toBe(false);

    disconnect(sql, BEN.userId, 1, T0);
    expect(roomView(sql, T0 + 90_001)?.members[1]).toMatchObject({ away: true });
    const rejoin = admit(sql, BEN, T0 + 200_000);
    expect(rejoin).toMatchObject({ role: "PLAYER", kind: "REJOIN", epoch: 2 });
    expect(grantReconnectExtension(sql, BEN.userId)).toBe(false);
    expect(roomView(sql, T0 + 200_000)?.members[1]).toMatchObject({ connected: true, away: false });
  });
});
