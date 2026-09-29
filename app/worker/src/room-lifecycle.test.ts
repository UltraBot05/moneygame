import { describe, expect, it } from "vitest";
import { memoryD1 } from "./d1.testkit";
import { deliverFinalization, reserveRoomCreation } from "./finalization";
import {
  admit,
  AUCTION_DECISION_MS,
  disconnect,
  dueFinalizations,
  FINALIZATION_RETRY_MS,
  handleCommand,
  handleRoomAction,
  markFinalizationFailed,
  markFinalized,
  MAX_SPECTATORS,
  nextAlarmAt,
  postChat,
  recentChat,
  roomView,
  runDueTimeouts,
  viewerGame,
} from "./room-runtime";
import { BEN, command, CY, deps, fresh, game, HOST, patchHost, patchState, startedRoom, T0 } from "./room.testkit";
import type { SqlDb } from "./transition";

/** Ben is already out; the host then owes $100 Customs with $50 and declares, so Cy wins. */
function endGame(sql: SqlDb) {
  patchState(sql, (state) => {
    state.players[1] = { ...state.players[1], status: "BANKRUPT", cash: 0 };
    state.ruleState = {
      ...(state.ruleState as Record<string, unknown>),
      eliminations: [{
        userId: BEN.userId, reason: "DECLARED", resolutionId: "debt-ben", creditor: { type: "BANK" },
        obligationAmount: 1, cashTransferred: 0, assetIds: [], gameVersion: 1, actionId: "ben-out",
      }],
    };
  });
  patchHost(sql, { position: 11, cash: 50 });
  handleCommand(sql, HOST.userId, command(sql, "ROLL_DICE", {}, "end-roll"), deps(T0 + 10, [1, 2]));
  const resolutionId = game(sql).pendingResolution?.resolutionId;
  return handleCommand(sql, HOST.userId, command(sql, "DECLARE_BANKRUPTCY", { resolutionId }, "end-declare"), deps(T0 + 11));
}

describe("RT-009 host migration", () => {
  it("moves hosting to the lowest-seat connected member when the host leaves or goes away", () => {
    const lobby = fresh();
    for (const user of [HOST, BEN, CY]) admit(lobby.sql, user, T0);
    expect(handleRoomAction(lobby.sql, HOST.userId, { kind: "LEAVE" }, deps(T0))).toMatchObject({ kind: "COMMITTED" });
    expect(roomView(lobby.sql, T0)?.hostUserId).toBe(BEN.userId);

    const { sql } = startedRoom();
    disconnect(sql, HOST.userId, 1, T0 + 1_000);
    runDueTimeouts(sql, deps(T0 + 50_000));
    expect(roomView(sql, T0)?.hostUserId).toBe(HOST.userId);
    runDueTimeouts(sql, deps(T0 + 91_001));
    expect(roomView(sql, T0)?.hostUserId).toBe(BEN.userId);
    expect(handleRoomAction(sql, HOST.userId, { kind: "PAUSE" }, deps(T0 + 91_002))).toMatchObject({ reason: "NOT_HOST" });
  });
});

describe("RT-010 pause and resume", () => {
  it("freezes commands and clocks, then shifts every deadline by the paused time", () => {
    const { sql } = startedRoom();
    expect(handleRoomAction(sql, BEN.userId, { kind: "PAUSE" }, deps(T0))).toMatchObject({ reason: "NOT_HOST" });
    const lobby = fresh();
    admit(lobby.sql, HOST, T0);
    expect(handleRoomAction(lobby.sql, HOST.userId, { kind: "PAUSE" }, deps(T0))).toMatchObject({ reason: "NOT_IN_GAME" });

    const deadline = roomView(sql, T0)?.turnDeadlineAt ?? 0;
    expect(handleRoomAction(sql, HOST.userId, { kind: "PAUSE" }, deps(T0 + 10))).toMatchObject({ kind: "COMMITTED" });
    expect(roomView(sql, T0 + 10)).toMatchObject({ paused: true, turnDeadlineAt: null });
    expect(handleCommand(sql, HOST.userId, command(sql, "ROLL_DICE"), deps(T0 + 20))).toMatchObject({ reason: "ROOM_PAUSED" });
    expect(nextAlarmAt(sql)).toBeNull();
    expect(runDueTimeouts(sql, deps(T0 + 10_000_000))).toEqual([]);
    expect(postChat(sql, BEN.userId, "brb", T0 + 30)).toMatchObject({ kind: "POSTED" });

    expect(handleRoomAction(sql, HOST.userId, { kind: "RESUME" }, deps(T0 + 30_010))).toMatchObject({ kind: "COMMITTED" });
    expect(roomView(sql, T0)).toMatchObject({ paused: false, turnDeadlineAt: deadline + 30_000 });
    expect(handleRoomAction(sql, HOST.userId, { kind: "RESUME" }, deps(T0 + 30_020))).toMatchObject({ reason: "NOT_PAUSED" });
  });

  it("gives an auction bidder back exactly the paused time", () => {
    const { sql } = startedRoom();
    handleCommand(sql, HOST.userId, command(sql, "ROLL_DICE", {}, "r1"), deps(T0, [2, 4]));
    const resolutionId = game(sql).pendingResolution?.resolutionId;
    handleCommand(sql, HOST.userId, command(sql, "DECLINE_PROPERTY", { resolutionId }, "d1"), deps(T0 + 5));
    const before = game(sql).auction?.decisionDeadlineAt ?? 0;
    expect(before).toBe(T0 + 5 + AUCTION_DECISION_MS);
    handleRoomAction(sql, HOST.userId, { kind: "PAUSE" }, deps(T0 + 6));
    handleRoomAction(sql, HOST.userId, { kind: "RESUME" }, deps(T0 + 5_006));
    expect(game(sql).auction?.decisionDeadlineAt).toBe(before + 5_000);
    expect(nextAlarmAt(sql)).toBe(before + 5_000);
  });
});

describe("RT-011 chat", () => {
  it("accepts bounded member chat, rate-limits bursts, and keeps the last 100", () => {
    const { sql } = startedRoom();
    expect(postChat(sql, BEN.userId, "  good   luck\u0007 ", T0)).toMatchObject({
      kind: "POSTED", message: { userId: BEN.userId, displayName: "Ben", text: "good luck" },
    });
    expect(postChat(sql, BEN.userId, "   ", T0)).toEqual({ kind: "REJECTED", reason: "INVALID_CHAT" });
    expect(postChat(sql, "u-stranger", "hi", T0)).toEqual({ kind: "REJECTED", reason: "NOT_A_MEMBER" });
    for (let index = 0; index < 4; index += 1) postChat(sql, BEN.userId, "m" + index, T0 + index);
    expect(postChat(sql, BEN.userId, "one too many", T0 + 5)).toEqual({ kind: "REJECTED", reason: "RATE_LIMITED" });
    expect(postChat(sql, BEN.userId, "later", T0 + 11_000)).toMatchObject({ kind: "POSTED" });
    for (let index = 0; index < 110; index += 1) postChat(sql, CY.userId, "flood " + index, T0 + 20_000 + index * 3_000);
    const history = recentChat(sql);
    expect(history).toHaveLength(100);
    expect(history.at(-1)?.text).toBe("flood 109");
    expect(game(sql).gameVersion).toBe(1);
  });
});

describe("RT-012 finalization and RT-013 rematch", () => {
  it("records the finished game with the ending commit and delivers it to D1 exactly once", async () => {
    const { sql } = startedRoom();
    expect(endGame(sql)).toMatchObject({ kind: "COMMITTED" });
    expect(game(sql).phase).toBe("GAME_OVER");
    const [finished] = dueFinalizations(sql, T0 + 11);
    expect(finished).toMatchObject({
      gameId: "game-1",
      roomCode: "ROOM42",
      boardRef: "world-tour-standard@1",
      players: [
        { userId: CY.userId, placement: 1, winner: true },
        { userId: HOST.userId, placement: 2, winner: false },
        { userId: BEN.userId, placement: 3, winner: false },
      ],
    });
    const d1 = memoryD1();
    await deliverFinalization(d1, finished!);
    await deliverFinalization(d1, finished!);
    const rows = await d1.prepare("SELECT COUNT(*) AS count FROM finished_game_players WHERE game_id = ?").bind("game-1")
      .first<{ count: number }>();
    expect(rows?.count).toBe(3);

    markFinalizationFailed(sql, "game-1", T0 + 20);
    expect(dueFinalizations(sql, T0 + 20)).toEqual([]);
    expect(nextAlarmAt(sql)).toBe(T0 + 20 + FINALIZATION_RETRY_MS);
    markFinalized(sql, "game-1");
    expect(dueFinalizations(sql, T0 + 10_000_000)).toEqual([]);
    expect(sql.get<{ count: number }>("SELECT COUNT(*) AS count FROM applied_actions WHERE game_id = 'game-1';")?.count).toBe(0);
  });

  it("returns to the lobby and starts a fresh game that old commands cannot touch", () => {
    const { sql } = startedRoom();
    expect(handleRoomAction(sql, HOST.userId, { kind: "REMATCH" }, deps(T0))).toMatchObject({ reason: "GAME_NOT_OVER" });
    endGame(sql);
    const oldCommand = command(sql, "END_TURN", {}, "late-old");
    expect(handleRoomAction(sql, BEN.userId, { kind: "REMATCH" }, deps(T0 + 20))).toMatchObject({ reason: "NOT_HOST" });
    expect(handleRoomAction(sql, HOST.userId, { kind: "REMATCH" }, deps(T0 + 20))).toMatchObject({ kind: "COMMITTED" });
    expect(roomView(sql, T0 + 20)).toMatchObject({ phase: "LOBBY" });
    expect(roomView(sql, T0 + 20)?.members.every((row) => !row.ready)).toBe(true);
    for (const user of [HOST, BEN, CY]) handleRoomAction(sql, user.userId, { kind: "SET_READY", ready: true }, deps(T0 + 21));
    expect(handleRoomAction(sql, HOST.userId, { kind: "START" }, deps(T0 + 22))).toMatchObject({ kind: "COMMITTED" });
    expect(game(sql)).toMatchObject({ gameId: "game-2", phase: "ACTIVE_TURN", gameVersion: 1 });
    expect(game(sql).players.every((player) => player.status === "ACTIVE")).toBe(true);
    expect(handleCommand(sql, HOST.userId, oldCommand, deps(T0 + 23))).toMatchObject({ reason: "STALE_GAME" });
    expect(dueFinalizations(sql, T0 + 23).map((row) => row.gameId)).toEqual(["game-1"]);
  });
});

describe("RT-014/015/018 delivery, bounds and diagnostics", () => {
  it("fingerprints committed state and logs every command without payloads", () => {
    const { sql } = startedRoom();
    const before = viewerGame(sql, null)?.hash;
    handleCommand(sql, BEN.userId, command(sql, "ROLL_DICE", {}, "wrong-turn"), deps(T0));
    handleCommand(sql, HOST.userId, command(sql, "ROLL_DICE", {}, "right-turn"), deps(T0, [1, 2]));
    expect(viewerGame(sql, null)?.hash).not.toBe(before);
    const log = sql.all<{ action_id: string; outcome: string; state_hash: string }>(
      "SELECT action_id, outcome, state_hash FROM diagnostics ORDER BY id;",
    );
    expect(log.map((row) => [row.action_id, row.outcome])).toEqual([["wrong-turn", "NOT_YOUR_TURN"], ["right-turn", "ACCEPTED"]]);
    expect(log[1]?.state_hash).toBe(viewerGame(sql, null)?.hash);
    const columns = sql.all<{ name: string }>("PRAGMA table_info(diagnostics);").map((row) => row.name);
    expect(columns).not.toContain("payload");
  });

  it("rate-limits command bursts and caps spectators", async () => {
    const { sql } = startedRoom();
    for (let index = 0; index < 20; index += 1) {
      handleCommand(sql, BEN.userId, command(sql, "ROLL_DICE", {}, "spam-" + index), deps(T0 + index));
    }
    expect(handleCommand(sql, BEN.userId, command(sql, "ROLL_DICE", {}, "spam-x"), deps(T0 + 50)))
      .toMatchObject({ reason: "RATE_LIMITED" });
    expect(handleCommand(sql, BEN.userId, command(sql, "ROLL_DICE", {}, "spam-y"), deps(T0 + 20_000)))
      .toMatchObject({ reason: "NOT_YOUR_TURN" });
    expect(admit(sql, { userId: "u-watch", displayName: "W" }, T0, MAX_SPECTATORS - 1).role).toBe("SPECTATOR");
    expect(admit(sql, { userId: "u-watch2", displayName: "W" }, T0, MAX_SPECTATORS))
      .toEqual({ role: "REFUSED", reason: "ROOM_FULL" });

    const d1 = memoryD1();
    for (let index = 0; index < 10; index += 1) expect(await reserveRoomCreation(d1, "u-maker", T0 + index)).toBe(true);
    expect(await reserveRoomCreation(d1, "u-maker", T0 + 11)).toBe(false);
    expect(await reserveRoomCreation(d1, "u-maker", T0 + 60 * 60 * 1000 + 1)).toBe(true);
  });
});
