import { describe, expect, it } from "vitest";
import standardFixture from "../../../boards/world-tour/standard.json";
import { parseBoardDefinition } from "./board";
import { LobbyStartError } from "./lobby";
import * as publicApi from "./index";
import { createInitialGameState, GameStateValidationError, parseGameState } from "./state";

const board = parseBoardDefinition(standardFixture);
const players = ["google:alice", "google:bob", "google:carol"];

describe("CORE-002 canonical initial GameState", () => {
  it("builds strict initial players, property state, identity, and integer money", () => {
    const state = createInitialGameState({ gameId: "game-1", board, playerIds: players });

    expect(state).toMatchObject({
      gameId: "game-1",
      gameVersion: 0,
      board: {
        ref: "world-tour-standard@1",
        boardId: "world-tour-standard",
        boardVersion: 1,
        tileCount: 40,
      },
      phase: "STARTING",
      turn: null,
    });
    expect(state.players.map((player) => player.seatIndex)).toEqual([0, 1, 2]);
    expect(state.players.every((player) => player.cash === 2000)).toBe(true);
    expect(state.properties).toHaveLength(22);
    expect(state.properties.every((property) =>
      property.ownerUserId === null
      && property.developmentLevel === 0
      && property.mortgaged === false
    )).toBe(true);
    expect(Object.isFrozen(state)).toBe(true);
    expect(Object.isFrozen(state.players)).toBe(true);

    const other = createInitialGameState({ gameId: "game-2", board, playerIds: players });
    expect(other).not.toBe(state);
    expect(other.board).not.toBe(state.board);
    expect(other.players).not.toBe(state.players);
    expect(other.players[0]).not.toBe(state.players[0]);
    expect(other.properties).not.toBe(state.properties);
  });

  it("rejects invalid monetary values and duplicate player identities", () => {
    for (const invalidCash of [Number.NaN, Number.POSITIVE_INFINITY, -1, 1999.5]) {
      expect(() =>
        createInitialGameState({
          gameId: "game-1",
          board,
          playerIds: players,
          startingCash: invalidCash,
        }),
      ).toThrow(GameStateValidationError);
    }

    expect(() =>
      createInitialGameState({
        gameId: "game-1",
        board,
        playerIds: ["google:alice", "google:alice", "google:carol"],
      }),
    ).toThrow(/unique/);

    const state = createInitialGameState({ gameId: "game-1", board, playerIds: players });
    const negativeCash = {
      ...state,
      players: state.players.map((player, index) => ({
        ...player,
        cash: index === 0 ? -1 : player.cash,
      })),
    };
    expect(() => parseGameState(negativeCash, board)).toThrow(/cash/);
  });

  it("rejects stale board identity and impossible property state", () => {
    const state = createInitialGameState({ gameId: "game-1", board, playerIds: players });
    expect(() => parseGameState({ ...state, gameId: "" }, board)).toThrow(/gameId/);

    expect(() =>
      parseGameState(
        { ...state, board: { ...state.board, boardVersion: 2 } },
        board,
      ),
    ).toThrow(/supplied board/);

    const impossibleProperty = {
      ...state,
      properties: state.properties.map((property, index) => ({
        ...property,
        ownerUserId: index === 0 ? null : property.ownerUserId,
        developmentLevel: index === 0 ? 1 : property.developmentLevel,
      })),
    };
    expect(() => parseGameState(impossibleProperty, board)).toThrow(/unowned property/);
  });

  it("applies the 3-10 rule only when constructing a new game", () => {
    expect(() =>
      createInitialGameState({ gameId: "game-1", board, playerIds: players.slice(0, 2) }),
    ).toThrow(LobbyStartError);

    const initial = createInitialGameState({ gameId: "game-1", board, playerIds: players });
    const runningWithOnePlayer = {
      ...initial,
      players: initial.players.slice(0, 1),
    };
    expect(parseGameState(runningWithOnePlayer, board).players).toHaveLength(1);
  });

  it("publishes only the canonical game-state constructor", () => {
    expect(publicApi.createInitialGameState).toBe(createInitialGameState);
    expect("createGame" in publicApi).toBe(false);
  });
});
