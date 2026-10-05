import { describe, expect, it } from "vitest";
import { DEFAULT_ROOM_SETTINGS, type RoomSettings } from "@moneygame/shared";
import { dueFinalizations, handleCommand, handleRoomAction, markFinalized, roomView } from "./room-runtime";
import { BEN, command, CY, deps, game, HOST, lobbyWithThree, patchHost, patchState, T0 } from "./room.testkit";
import type { SqlDb } from "./transition";

/** QA-004: many cross-board rematches in one room never leak state between games. */
const BOARDS: readonly RoomSettings["boardRef"][] = ["world-tour-standard@1", "world-tour-grand@1"];
const TAX_TILE: Readonly<Record<string, number>> = { "world-tour-standard@1": 14, "world-tour-grand@1": 12 };
const REMATCHES = 1000;

/** Ben is out; the host lands on Customs with $50 and declares, so Cy wins. */
function finish(sql: SqlDb, boardRef: string, now: number): void {
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
  patchHost(sql, { position: (TAX_TILE[boardRef] as number) - 3, cash: 50 });
  expect(handleCommand(sql, HOST.userId, command(sql, "ROLL_DICE", {}, "end-roll"), deps(now, [1, 2]))).toMatchObject({ kind: "COMMITTED" });
  const resolutionId = game(sql).pendingResolution?.resolutionId;
  expect(handleCommand(sql, HOST.userId, command(sql, "DECLARE_BANKRUPTCY", { resolutionId }, "end-declare"), deps(now + 1)))
    .toMatchObject({ kind: "COMMITTED" });
}

describe("QA-004 cross-board rematch soak", () => {
  it(`runs ${REMATCHES} rematches alternating boards with zero contamination`, () => {
    const { sql } = lobbyWithThree();
    const stale: ReturnType<typeof command>[] = [];
    for (let index = 0; index < REMATCHES; index += 1) {
      const now = T0 + index * 20_000; // past the 10s command rate window
      const boardRef = BOARDS[index % BOARDS.length] as RoomSettings["boardRef"];
      expect(handleRoomAction(sql, HOST.userId, { kind: "CONFIGURE", settings: { ...DEFAULT_ROOM_SETTINGS, boardRef } }, deps(now)))
        .toMatchObject({ kind: "COMMITTED" });
      for (const user of [HOST, BEN, CY]) handleRoomAction(sql, user.userId, { kind: "SET_READY", ready: true }, deps(now));
      expect(handleRoomAction(sql, HOST.userId, { kind: "START" }, deps(now + 1, [1]))).toMatchObject({ kind: "COMMITTED" }); // host moves first

      const current = game(sql);
      expect(current).toMatchObject({ gameId: "game-" + (index + 1), gameVersion: 1, phase: "ACTIVE_TURN" });
      expect(current.board.ref).toBe(boardRef);
      expect(current.board.tileCount).toBe(boardRef.includes("grand") ? 52 : 40);
      expect(current.players.every((player) => player.status === "ACTIVE" && player.cash === 2000 && player.position === 0)).toBe(true);
      expect(current.assets.every((asset) => asset.ownerUserId === null && !asset.mortgaged)).toBe(true);
      expect(current.ruleState.eliminations).toEqual([]);
      expect(current.ruleState.trades).toEqual([]);
      // A handful of commands from earlier games, replayed now, must all be refused as stale.
      for (const old of stale.slice(-3)) expect(handleCommand(sql, HOST.userId, old, deps(now + 2))).toMatchObject({ reason: "STALE_GAME" });

      stale.push(command(sql, "ROLL_DICE", {}, "old-" + index));
      finish(sql, boardRef, now + 3);
      expect(game(sql)).toMatchObject({ phase: "GAME_OVER", ruleState: { outcome: { winnerUserIds: [CY.userId] } } });
      for (const row of dueFinalizations(sql, now + 5)) markFinalized(sql, row.gameId);
      expect(handleRoomAction(sql, HOST.userId, { kind: "REMATCH" }, deps(now + 6))).toMatchObject({ kind: "COMMITTED" });
      expect(roomView(sql, now + 6)).toMatchObject({ phase: "LOBBY" });
    }
    const games = sql.get<{ count: number }>("SELECT COUNT(*) AS count FROM games;")?.count ?? 0;
    const actions = sql.get<{ count: number }>("SELECT COUNT(*) AS count FROM applied_actions;")?.count ?? 0;
    expect(games).toBeLessThanOrEqual(REMATCHES);
    expect(actions).toBeLessThanOrEqual(500);
  }, 300_000);
});
