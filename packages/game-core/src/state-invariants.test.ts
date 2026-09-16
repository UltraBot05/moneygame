import { describe, expect, it } from "vitest";
import standardFixture from "../../../boards/world-tour/standard.json";
import { parseBoardDefinition } from "./board";
import { applyGameplayCommand } from "./gameplay";
import { createInitialGameState, parseGameState } from "./state";

const board = parseBoardDefinition(standardFixture);
const playerIds = ["google:alice", "google:bob", "google:carol"];

function started() {
  const initial = createInitialGameState({ gameId: "game-1", board, playerIds });
  const result = applyGameplayCommand(initial, {
    type: "START_GAME",
    gameId: initial.gameId,
    actionId: "start",
    expectedGameVersion: initial.gameVersion,
    payload: {},
  }, { board, actorUserId: playerIds[0]!, rng: () => 0 });
  if (result.kind !== "ACCEPTED") throw new Error("start must succeed");
  return result.state;
}

function landedOnFirstProperty() {
  const active = started();
  const positioned = parseGameState({
    ...active,
    players: active.players.map((player, index) => index === 0
      ? { ...player, position: board.tileCount - 2 }
      : player),
  }, board);
  const values = [0, 0.2];
  let calls = 0;
  const result = applyGameplayCommand(positioned, {
    type: "ROLL_DICE",
    gameId: positioned.gameId,
    actionId: "roll",
    expectedGameVersion: positioned.gameVersion,
    payload: {},
  }, { board, actorUserId: playerIds[0]!, rng: () => values[calls++] as number });
  if (result.kind !== "ACCEPTED") throw new Error("roll must succeed");
  return result.state;
}

function doubledOntoFirstProperty() {
  const active = started();
  const positioned = parseGameState({
    ...active,
    players: active.players.map((player, index) => index === 0
      ? { ...player, position: board.tileCount - 1 }
      : player),
  }, board);
  const result = applyGameplayCommand(positioned, {
    type: "ROLL_DICE",
    gameId: positioned.gameId,
    actionId: "double",
    expectedGameVersion: positioned.gameVersion,
    payload: {},
  }, { board, actorUserId: playerIds[0]!, rng: () => 0 });
  if (result.kind !== "ACCEPTED") throw new Error("double must succeed");
  return result.state;
}

describe("CORE-014 canonical cross-state invariants", () => {
  it("authorizes ROLL_AGAIN only from canonical doubles continuation state", () => {
    const preRoll = started();
    const forgedWithoutRoll = {
      ...preRoll,
      players: preRoll.players.map((player, index) => index === 0
        ? { ...player, position: 10 }
        : player),
      pendingResolution: {
        resolutionId: "turn-1:detention-fee",
        kind: "DETENTION_FEE",
        actorUserId: playerIds[0],
        decisionOwnerUserId: playerIds[0],
        source: { type: "TILE", tileIndex: 10 },
        continuation: { type: "ROLL_AGAIN" },
        roll: null,
        obligation: {
          debtorUserId: playerIds[0],
          creditor: { type: "BANK" },
          amount: 50,
          continuation: { type: "ROLL_AGAIN" },
        },
      },
    };
    expect(() => parseGameState(forgedWithoutRoll, board)).toThrow(
      /ROLL_AGAIN requires canonical doubles continuation/,
    );

    const nonDouble = landedOnFirstProperty();
    expect(nonDouble.turn).toMatchObject({ rollAgain: false, consecutiveDoubles: 0 });
    expect(nonDouble.pendingResolution).toMatchObject({
      continuation: { type: "END_TURN" },
      roll: { doubles: false },
    });
    expect(parseGameState(JSON.parse(JSON.stringify(nonDouble)), board)).toEqual(nonDouble);
    expect(() => parseGameState({
      ...nonDouble,
      pendingResolution: {
        ...nonDouble.pendingResolution!,
        continuation: { type: "ROLL_AGAIN" },
      },
    }, board)).toThrow(/ROLL_AGAIN requires canonical doubles continuation/);

    const validDouble = doubledOntoFirstProperty();
    expect(validDouble.turn).toMatchObject({ rollAgain: true, consecutiveDoubles: 1 });
    expect(validDouble.pendingResolution).toMatchObject({
      continuation: { type: "ROLL_AGAIN" },
      roll: { doubles: true, consecutiveDoubles: 1 },
    });
    expect(parseGameState(JSON.parse(JSON.stringify(validDouble)), board)).toEqual(validDouble);
  });

  it("rejects an active turn owned by a bankrupt player", () => {
    const state = started();
    expect(() => parseGameState({
      ...state,
      players: state.players.map((player, index) => index === 0
        ? { ...player, status: "BANKRUPT" }
        : player),
    }, board)).toThrow(/active turn owner must be an eligible player/);
  });

  it("rejects invalid and duplicate canonical player/asset relationships", () => {
    const state = createInitialGameState({ gameId: "game-1", board, playerIds });
    expect(() => parseGameState({
      ...state,
      players: state.players.map((player, index) => index === 1
        ? { ...player, seatIndex: 0 }
        : player),
    }, board)).toThrow(/seatIndex/);
    expect(() => parseGameState({
      ...state,
      assets: state.assets.map((asset, index) => index === 1
        ? { ...asset, assetId: state.assets[0]!.assetId }
        : asset),
    }, board)).toThrow(/asset identity/);
    expect(() => parseGameState({
      ...state,
      assets: [state.assets[1], state.assets[0], ...state.assets.slice(2)],
    }, board)).toThrow(/canonical board order/);
    expect(() => parseGameState({
      ...state,
      assets: state.assets.map((asset, index) => index === 0
        ? { ...asset, ownerUserId: "google:missing" }
        : asset),
    }, board)).toThrow(/owner/);
  });

  it("rejects cross-field-invalid pending player, tile, effect, and creditor context", () => {
    const state = landedOnFirstProperty();
    expect(() => parseGameState({
      ...state,
      players: state.players.map((player, index) => index === 0
        ? { ...player, position: 2 }
        : player),
    }, board)).toThrow(/landing source must match actor position/);
    expect(() => parseGameState({
      ...state,
      pendingResolution: {
        ...state.pendingResolution!,
        source: { type: "EFFECT", effectId: "effect:bad-origin", originTileIndex: 1 },
      },
    }, board)).toThrow(/effect origin must be a card tile/);

    const auction = {
      ...state,
      players: state.players.map((player, index) => index === 1
        ? { ...player, status: "BANKRUPT" }
        : player),
      pendingResolution: {
        ...state.pendingResolution!,
        kind: "AUCTION",
        decisionOwnerUserId: playerIds[1],
      },
    };
    expect(() => parseGameState(auction, board)).toThrow(/decision owner must be an eligible player/);

    const rent = {
      ...state,
      assets: state.assets.map((asset) => asset.tileIndex === 1
        ? { ...asset, ownerUserId: playerIds[1] }
        : asset),
      pendingResolution: {
        ...state.pendingResolution!,
        kind: "RENT",
        obligation: {
          debtorUserId: playerIds[0],
          creditor: { type: "PLAYER", userId: "google:missing" },
          amount: 10,
          continuation: { type: "END_TURN" },
        },
      },
    };
    expect(() => parseGameState(rent, board)).toThrow(/unknown creditor player/);
  });

  it("rejects impossible phase/pending and game-over/turn combinations", () => {
    const state = landedOnFirstProperty();
    expect(() => parseGameState({ ...state, phase: "GAME_OVER" }, board)).toThrow(
      /turn identity is required only during ACTIVE_TURN/,
    );
    expect(() => parseGameState({ ...state, turn: null }, board)).toThrow(
      /turn identity is required only during ACTIVE_TURN/,
    );
    expect(() => parseGameState({
      ...state,
      phase: "GAME_OVER",
      turn: null,
    }, board)).toThrow(/pending resolution requires an active turn/);
  });

  it("rejects mismatched board identity, roll continuation, and non-integer versions", () => {
    const state = landedOnFirstProperty();
    expect(() => parseGameState({
      ...state,
      board: { ...state.board, boardVersion: state.board.boardVersion + 1 },
    }, board)).toThrow(/identity does not match/);
    expect(() => parseGameState({
      ...state,
      gameVersion: 1.5,
    }, board)).toThrow(/gameVersion/);
    expect(() => parseGameState({
      ...state,
      turn: { ...state.turn!, rollAgain: true, consecutiveDoubles: 1 },
    }, board)).toThrow(/consecutiveDoubles|roll continuation/);
  });
});
