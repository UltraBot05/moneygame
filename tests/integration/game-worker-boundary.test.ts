import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import {
  createInitialGameState,
  parseBoardDefinition,
} from "../../packages/game-core/src/index";
import standard from "../../boards/world-tour/standard.json";
import grand from "../../boards/world-tour/grand.json";
import { nodeDb } from "../../app/worker/src/sqlite.testkit";
import {
  ensureSchema,
  startGame as startSqlGame,
  handleIncrement,
  readState,
  currentGameId,
  type NewGame,
} from "../../app/worker/src/transition";

/**
 * GOV-004 — Cross-boundary integration test. Proves that game-core's board
 * validation and state creation work end-to-end with the worker's SQLite
 * persistence layer over real node:sqlite. This is the foundation QA-012
 * extends with socket/room lifecycle tests.
 */
describe("game-core → worker persistence boundary", () => {
  function setup() {
    const db = new DatabaseSync(":memory:");
    const sql = nodeDb(db);
    ensureSchema(sql);
    return { db, sql };
  }

  it("game-core creates valid state; worker persists and reads it back", () => {
    const { sql } = setup();
    const board = parseBoardDefinition(standard);
    const state = createInitialGameState({
      gameId: "integration-1",
      board,
      playerIds: ["alice", "bob", "charlie"],
    });

    expect(state.gameId).toBe("integration-1");
    expect(state.board.tileCount).toBe(40);
    expect(state.players).toHaveLength(3);
    expect(state.phase).toBe("STARTING");

    const sqlGame: NewGame = {
      gameId: state.gameId,
      boardId: state.board.boardId,
      boardVersion: state.board.boardVersion,
      tileCount: state.board.tileCount,
    };
    startSqlGame(sql, sqlGame, Date.now());

    expect(currentGameId(sql)).toBe("integration-1");
    const persisted = readState(sql, "integration-1");
    expect(persisted.gameVersion).toBe(0);
  });

  it("Grand board works through the same boundary", () => {
    const { sql } = setup();
    const board = parseBoardDefinition(grand);
    const state = createInitialGameState({
      gameId: "integration-grand",
      board,
      playerIds: ["p1", "p2", "p3", "p4", "p5", "p6"],
    });

    expect(state.board.tileCount).toBe(52);
    expect(state.players).toHaveLength(6);

    const sqlGame: NewGame = {
      gameId: state.gameId,
      boardId: state.board.boardId,
      boardVersion: state.board.boardVersion,
      tileCount: state.board.tileCount,
    };
    startSqlGame(sql, sqlGame, Date.now());

    const result = handleIncrement(sql, "integration-grand", "action-1");
    expect(result.duplicate).toBe(false);
    expect(result.current.gameVersion).toBe(1);
  });
});
