import { DatabaseSync } from "node:sqlite";
import { expect } from "vitest";
import { createSeededRandom } from "@moneygame/game-core";
import {
  admit,
  ensureRoomSchema,
  handleRoomAction,
  initializeRoom,
  viewerGame,
  type RuntimeDeps,
} from "./room-runtime";
import { nodeDb } from "./sqlite.testkit";
import type { SqlDb } from "./transition";

/** Shared room-runtime fixtures over real node:sqlite. Test-only. */
export const T0 = 1_000_000;
export const HOST = { userId: "u-host", displayName: "Host" };
export const BEN = { userId: "u-ben", displayName: "Ben" };
export const CY = { userId: "u-cy", displayName: "Cy" };

let gameCounter = 0;

/** Dice faces for the next rolls, then a seeded stream; each start mints `game-1`, `game-2`, … */
export function deps(now: number, faces: readonly number[] = []): RuntimeDeps {
  const queue = faces.map((face) => (face - 1) / 6 + 0.001);
  const seeded = createSeededRandom(3);
  return { now, rng: () => queue.shift() ?? seeded(), newGameId: () => "game-" + (gameCounter += 1) };
}

export function fresh(): { db: DatabaseSync; sql: SqlDb } {
  gameCounter = 0;
  const db = new DatabaseSync(":memory:");
  const sql = nodeDb(db);
  ensureRoomSchema(sql);
  initializeRoom(sql, "ROOM42", HOST, T0);
  return { db, sql };
}

export function lobbyWithThree(): { db: DatabaseSync; sql: SqlDb } {
  const room = fresh();
  for (const user of [HOST, BEN, CY]) {
    admit(room.sql, user, T0);
    handleRoomAction(room.sql, user.userId, { kind: "SET_READY", ready: true }, deps(T0));
  }
  return room;
}

export function startedRoom(): { db: DatabaseSync; sql: SqlDb } {
  const room = lobbyWithThree();
  // The first rng draw picks who moves first; face 1 (offset 0) keeps the host first for these tests.
  expect(handleRoomAction(room.sql, HOST.userId, { kind: "START" }, deps(T0, [1]))).toMatchObject({ kind: "COMMITTED" });
  return room;
}

export function game(sql: SqlDb) {
  const view = viewerGame(sql, HOST.userId);
  if (view === null) throw new Error("no game");
  return view.game;
}

/** Test-only: edits the stored canonical state (still fully revalidated on the next load). */
export function patchState(sql: SqlDb, edit: (state: Record<string, unknown> & { players: Record<string, unknown>[] }) => void): void {
  const gameId = game(sql).gameId;
  const row = sql.get<{ state_json: string }>("SELECT state_json FROM games WHERE game_id = ?;", gameId);
  const state = JSON.parse(row?.state_json ?? "{}");
  edit(state);
  sql.run("UPDATE games SET state_json = ? WHERE game_id = ?;", JSON.stringify(state), gameId);
}

export function patchHost(sql: SqlDb, changes: Readonly<{ position?: number; cash?: number }>): void {
  patchState(sql, (state) => {
    state.players[0] = { ...state.players[0], ...changes };
  });
}

export function command(sql: SqlDb, type: string, payload: unknown = {}, actionId = type + ":" + game(sql).gameVersion) {
  const state = game(sql);
  return { type, gameId: state.gameId, actionId, expectedGameVersion: state.gameVersion, payload };
}
