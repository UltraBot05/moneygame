import { describe, expect, it } from "vitest";
import grandFixture from "../../../boards/world-tour/grand.json";
import standardFixture from "../../../boards/world-tour/standard.json";
import { parseBoardDefinition, type BoardDefinition } from "./board";
import { applyGameplayCommand } from "./gameplay";
import {
  assertPendingDecisionOwner,
  createInitialGameState,
  parseGameState,
  type GameState,
  type PendingResolution,
} from "./state";

const standard = parseBoardDefinition(standardFixture);
const grand = parseBoardDefinition(grandFixture);
const players = ["google:alice", "google:bob", "google:carol"];

function initial(board: BoardDefinition, gameId = "game-1") {
  return createInitialGameState({ board, gameId, playerIds: players });
}

function command(type: string, actionId: string, gameVersion: number) {
  return {
    type,
    gameId: "game-1",
    actionId,
    expectedGameVersion: gameVersion,
    payload: {},
  };
}

function started(board: BoardDefinition) {
  const state = initial(board);
  const result = applyGameplayCommand(
    state,
    command("START_GAME", "start", state.gameVersion),
    { board, actorUserId: players[0]!, rng: () => 0 },
  );
  if (result.kind !== "ACCEPTED") throw new Error("start must succeed");
  return result.state;
}

function landed(board: BoardDefinition, tileIndex: number, rollTotal = 3) {
  const state = started(board);
  const positioned = parseGameState({
    ...state,
    players: state.players.map((player, index) => index === 0
      ? { ...player, position: (tileIndex - rollTotal + board.tileCount) % board.tileCount }
      : player),
  }, board);
  const rngValues = rollTotal === 2 ? [0, 0] : [0, (rollTotal - 2) / 6];
  let calls = 0;
  const result = applyGameplayCommand(
    positioned,
    command("ROLL_DICE", "roll", positioned.gameVersion),
    { board, actorUserId: players[0]!, rng: () => rngValues[calls++] as number },
  );
  if (result.kind !== "ACCEPTED") throw new Error("roll must succeed");
  return result.state;
}

function ownedRentState() {
  const state = landed(standard, 1);
  return parseGameState({
    ...state,
    pendingResolution: { ...state.pendingResolution!, kind: "RENT" },
    assets: state.assets.map((asset) => asset.tileIndex === 1
      ? { ...asset, ownerUserId: players[1] }
      : asset),
  }, standard);
}

function withPending(
  board: BoardDefinition,
  pending: PendingResolution,
  state: GameState = landed(board, 1),
) {
  return parseGameState({ ...state, pendingResolution: pending }, board);
}

describe("CORE-010 all-ownable canonical asset state", () => {
  it.each([
    ["Standard", standard, 28],
    ["Grand", grand, 36],
  ] as const)("represents all %s ownables once from board tiles", (_name, board, count) => {
    const state = initial(board);
    const ownables = board.economyProfile.tiles.filter(
      (tile) => tile.type === "property" || tile.type === "transit" || tile.type === "utility",
    );
    expect(state.assets).toHaveLength(count);
    expect(state.assets.map((asset) => asset.tileIndex)).toEqual(
      ownables.map((tile) => tile.index),
    );
    expect(new Set(state.assets.map((asset) => asset.assetId)).size).toBe(count);
    expect(state.assets.filter((asset) => asset.kind === "TRANSIT")).toHaveLength(4);
    expect(state.assets.filter((asset) => asset.kind === "UTILITY")).toHaveLength(2);
    expect(state.assets.every((asset) =>
      asset.ownerUserId === null && !asset.mortgaged
      && (asset.kind !== "PROPERTY" || asset.developmentLevel === 0)
    )).toBe(true);

    const fresh = initial(board, "game-2");
    expect(fresh.assets).not.toBe(state.assets);
    expect(fresh.assets[0]).not.toBe(state.assets[0]);
    expect(parseGameState(JSON.parse(JSON.stringify(state)), board)).toEqual(state);
  });

  it.each([standard, grand])("rejects missing, duplicated, and stale ownable references", (board) => {
    const state = initial(board);
    expect(() => parseGameState({
      ...state,
      assets: state.assets.slice(1),
    }, board)).toThrow(/every board ownable/);
    expect(() => parseGameState({
      ...state,
      assets: [state.assets[0], state.assets[0], ...state.assets.slice(2)],
    }, board)).toThrow(/duplicate asset/);
    expect(() => parseGameState({
      ...state,
      assets: state.assets.map((asset, index) => index === 0
        ? { ...asset, tileIndex: board.tileCount }
        : asset),
    }, board)).toThrow(/tileIndex/);
    expect(() => parseGameState({
      ...state,
      assets: state.assets.map((asset, index) => index === 0
        ? { ...asset, ownerUserId: "google:stale" }
        : asset),
    }, board)).toThrow(/owner/);
  });

  it.each([standard, grand])("keeps mortgages for transit/utilities without buildings", (board) => {
    const state = initial(board);
    for (const kind of ["TRANSIT", "UTILITY"] as const) {
      const asset = state.assets.find((candidate) => candidate.kind === kind)!;
      const changed = parseGameState({
        ...state,
        assets: state.assets.map((candidate) => candidate.tileIndex === asset.tileIndex
          ? { ...candidate, ownerUserId: players[0], mortgaged: true }
          : candidate),
      }, board);
      expect(changed.assets.find((candidate) => candidate.tileIndex === asset.tileIndex))
        .toMatchObject({ kind, ownerUserId: players[0], mortgaged: true });
      expect(() => parseGameState({
        ...changed,
        assets: changed.assets.map((candidate) => candidate.tileIndex === asset.tileIndex
          ? { ...candidate, developmentLevel: 1 }
          : candidate),
      }, board)).toThrow(/unexpected field/);
      expect(() => parseGameState({
        ...state,
        assets: state.assets.map((candidate) => candidate.tileIndex === asset.tileIndex
          ? { ...candidate, mortgaged: true }
          : candidate),
      }, board)).toThrow(/unowned asset/);
    }
  });

  it("rejects owned developed mortgages and unowned development", () => {
    const state = initial(standard);
    const developed = {
      ...state,
      assets: state.assets.map((asset, index) => index === 0
        ? { ...asset, ownerUserId: players[0], developmentLevel: 1 }
        : asset),
    };
    expect(parseGameState(developed, standard).assets[0]).toMatchObject({
      ownerUserId: players[0], developmentLevel: 1,
    });
    expect(() => parseGameState({
      ...developed,
      assets: developed.assets.map((asset, index) => index === 0
        ? { ...asset, mortgaged: true }
        : asset),
    }, standard)).toThrow(/mortgaged property/);
    expect(() => parseGameState({
      ...state,
      assets: state.assets.map((asset, index) => index === 0
        ? { ...asset, developmentLevel: 1 }
        : asset),
    }, standard)).toThrow(/unowned property/);
  });
});

describe("CORE-011 persistent pending resolution and obligation", () => {
  it.each([standard, grand])("persists landing context and blocks bypass on %s", (board) => {
    const state = landed(board, 1);
    expect(state.pendingResolution).toMatchObject({
      kind: "BUY_DECISION",
      actorUserId: players[0],
      decisionOwnerUserId: players[0],
      source: { type: "TILE", tileIndex: 1 },
      continuation: { type: "END_TURN" },
      roll: { dice: [1, 2], total: 3 },
      obligation: null,
    });
    const restored = parseGameState(JSON.parse(JSON.stringify(state)), board);
    expect(restored.pendingResolution).toEqual(state.pendingResolution);
    for (const type of ["END_TURN", "ROLL_DICE"]) {
      const rejected = applyGameplayCommand(
        restored,
        command(type, type, restored.gameVersion),
        { board, actorUserId: players[0]!, rng: () => 0 },
      );
      expect(rejected).toMatchObject({
        kind: "REJECTED", reason: "PENDING_RESOLUTION",
        state: { gameVersion: restored.gameVersion },
      });
      expect(rejected.state).toEqual(restored);
    }
    const cleared = parseGameState({ ...restored, pendingResolution: null }, board);
    expect(cleared.pendingResolution).toBeNull();
    const ended = applyGameplayCommand(
      cleared,
      command("END_TURN", "end-cleared", cleared.gameVersion),
      { board, actorUserId: players[0]!, rng: () => 0 },
    );
    expect(ended.kind).toBe("ACCEPTED");
    if (ended.kind === "ACCEPTED") expect(ended.state.pendingResolution).toBeNull();
  });

  it("requires the decision owner and rejects stale resolution identity", () => {
    const state = landed(standard, 1);
    const id = state.pendingResolution!.resolutionId;
    expect(assertPendingDecisionOwner(state, id, players[0]!)).toEqual(
      state.pendingResolution,
    );
    expect(() => assertPendingDecisionOwner(state, id, players[1]!)).toThrow(/wrong actor/);
    expect(() => assertPendingDecisionOwner(state, "stale", players[0]!)).toThrow(/no longer pending/);
    expect(state.gameVersion).toBe(2);
  });

  it("persists an unpaid positive obligation separately from nonnegative cash", () => {
    const state = ownedRentState();
    const pending = {
      ...state.pendingResolution!,
      kind: "RENT" as const,
      obligation: {
        debtorUserId: players[0]!,
        creditor: { type: "PLAYER" as const, userId: players[1]! },
        amount: 2500,
        continuation: { type: "END_TURN" as const },
      },
    };
    const owed = withPending(standard, pending, state);
    expect(owed.players[0]?.cash).toBeGreaterThanOrEqual(0);
    expect(owed.pendingResolution?.obligation?.amount).toBe(2500);
    expect(parseGameState(JSON.parse(JSON.stringify(owed)), standard)).toEqual(owed);
  });

  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    "rejects invalid obligation amount %s", (amount) => {
      const state = landed(standard, 14);
      expect(() => withPending(standard, {
        ...state.pendingResolution!,
        kind: "TAX",
        source: { type: "TILE", tileIndex: 14 },
        obligation: {
          debtorUserId: players[0]!,
          creditor: { type: "BANK" },
          amount,
          continuation: { type: "END_TURN" },
        },
      }, state)).toThrow();
    },
  );

  it("rejects malformed creditors, continuations, references, and roll context", () => {
    const state = landed(standard, 1);
    const pending = state.pendingResolution!;
    const base = {
      ...pending,
      kind: "RENT" as const,
      obligation: {
        debtorUserId: players[0]!,
        creditor: { type: "PLAYER" as const, userId: players[1]! },
        amount: 10,
        continuation: { type: "END_TURN" as const },
      },
    };
    expect(() => withPending(standard, {
      ...base,
      obligation: { ...base.obligation, creditor: { type: "PLAYER", userId: "stale" } },
    }, state)).toThrow(/creditor/);
    expect(() => parseGameState({
      ...state,
      pendingResolution: {
        ...base,
        obligation: { ...base.obligation, creditor: { type: "UNKNOWN" } },
      },
    }, standard)).toThrow(/creditor/);
    expect(() => withPending(standard, {
      ...base,
      obligation: { ...base.obligation, continuation: { type: "RESUME_EFFECT", effectId: "x" } },
    }, state)).toThrow(/continuation/);
    expect(() => withPending(standard, {
      ...pending, source: { type: "TILE", tileIndex: standard.tileCount },
    }, state)).toThrow(/tileIndex/);
    expect(() => withPending(standard, {
      ...pending, actorUserId: "google:stale",
    }, state)).toThrow(/actor/);
    expect(() => withPending(standard, {
      ...pending, roll: { ...pending.roll!, total: 12 },
    }, state)).toThrow(/roll/);
  });

  it.each([
    [9, "CARD"],
    [5, "BUY_DECISION"],
    [29, "BUY_DECISION"],
  ] as const)("records unresolved landing at tile %i as %s", (tileIndex, kind) => {
    expect(landed(standard, tileIndex).pendingResolution?.kind).toBe(kind);
  });
  it("rejects DEBT without an obligation without changing command or version semantics", () => {
    const card = landed(standard, 9);
    const malformed = {
      ...card,
      pendingResolution: {
        ...card.pendingResolution!,
        kind: "DEBT",
        source: { type: "EFFECT", effectId: "card-effect-1", originTileIndex: 9 },
        continuation: { type: "RESUME_EFFECT", effectId: "card-effect-1" },
        roll: null,
        obligation: null,
      },
    };
    expect(() => parseGameState(malformed, standard)).toThrow(
      /DEBT requires an outstanding monetary obligation/,
    );

    const beforeVersion = card.gameVersion;
    const rejected = applyGameplayCommand(
      card,
      command("END_TURN", "after-malformed-debt", beforeVersion),
      { board: standard, actorUserId: players[0]!, rng: () => 0 },
    );
    expect(rejected).toMatchObject({
      kind: "REJECTED",
      reason: "PENDING_RESOLUTION",
      state: { gameVersion: beforeVersion },
    });
    expect(rejected.state).toEqual(card);
    expect(card.gameVersion).toBe(beforeVersion);
  });

  it("parses and reconstructs DEBT with a valid persisted obligation", () => {
    const card = landed(standard, 9);
    const debt = withPending(standard, {
      ...card.pendingResolution!,
      kind: "DEBT",
      source: { type: "EFFECT", effectId: "card-effect-1", originTileIndex: 9 },
      continuation: { type: "RESUME_EFFECT", effectId: "card-effect-1" },
      roll: null,
      obligation: {
        debtorUserId: players[0]!,
        creditor: { type: "BANK" },
        amount: 3000,
        continuation: { type: "RESUME_EFFECT", effectId: "card-effect-1" },
      },
    }, card);

    expect(parseGameState(JSON.parse(JSON.stringify(debt)), standard)).toEqual(debt);
  });

  it("continues to reject invalid DEBT creditors and amounts", () => {
    const card = landed(standard, 9);
    const debt = {
      ...card.pendingResolution!,
      kind: "DEBT",
      source: { type: "EFFECT", effectId: "card-effect-1", originTileIndex: 9 },
      continuation: { type: "RESUME_EFFECT", effectId: "card-effect-1" },
      roll: null,
      obligation: {
        debtorUserId: players[0]!,
        creditor: { type: "BANK" },
        amount: 3000,
        continuation: { type: "RESUME_EFFECT", effectId: "card-effect-1" },
      },
    };

    expect(() => parseGameState({
      ...card,
      pendingResolution: {
        ...debt,
        obligation: {
          ...debt.obligation,
          creditor: { type: "PLAYER", userId: "google:stale" },
        },
      },
    }, standard)).toThrow(/creditor/);

    for (const amount of [0, -1, 1.5]) {
      expect(() => parseGameState({
        ...card,
        pendingResolution: {
          ...debt,
          obligation: { ...debt.obligation, amount },
        },
      }, standard)).toThrow(/amount/);
    }
  });
  it("represents auction handoff, detention fee, and card-origin debt without rule execution", () => {
    const purchase = landed(standard, 1);
    const declined = applyGameplayCommand(
      purchase,
      {
        type: "DECLINE_PROPERTY",
        gameId: purchase.gameId,
        actionId: "decline-for-auction-contract",
        expectedGameVersion: purchase.gameVersion,
        payload: { resolutionId: purchase.pendingResolution!.resolutionId },
      },
      {
        board: standard,
        actorUserId: players[0]!,
        rng: () => 0,
        auctionDecisionDeadlineAt: 2000,
      },
    );
    if (declined.kind !== "ACCEPTED") throw new Error("decline must start auction");
    const auction = declined.state;
    expect(parseGameState(JSON.parse(JSON.stringify(auction)), standard)).toEqual(auction);
    expect(() => assertPendingDecisionOwner(auction, auction.pendingResolution!.resolutionId, players[0]!))
      .toThrow(/wrong actor/);
    expect(assertPendingDecisionOwner(
      auction, auction.pendingResolution!.resolutionId, players[1]!,
    ).kind).toBe("AUCTION");

    const card = landed(standard, 9);
    const debt = withPending(standard, {
      ...card.pendingResolution!,
      kind: "DEBT",
      source: { type: "EFFECT", effectId: "card-effect-1", originTileIndex: 9 },
      continuation: { type: "RESUME_EFFECT", effectId: "card-effect-1" },
      roll: null,
      obligation: {
        debtorUserId: players[0]!,
        creditor: { type: "BANK" },
        amount: 3000,
        continuation: { type: "RESUME_EFFECT", effectId: "card-effect-1" },
      },
    }, card);
    expect(parseGameState(JSON.parse(JSON.stringify(debt)), standard)).toEqual(debt);
    expect(() => withPending(standard, {
      ...debt.pendingResolution!,
      source: { type: "EFFECT", effectId: "bad", originTileIndex: 1 },
    }, card)).toThrow(/originTileIndex/);

    const corner = landed(standard, 10);
    const detentionFee = withPending(standard, {
      resolutionId: "turn-1:detention-fee",
      kind: "DETENTION_FEE",
      actorUserId: players[0]!,
      decisionOwnerUserId: players[0]!,
      source: { type: "TILE", tileIndex: 10 },
      continuation: { type: "END_TURN" },
      roll: null,
      obligation: {
        debtorUserId: players[0]!,
        creditor: { type: "BANK" },
        amount: 50,
        continuation: { type: "END_TURN" },
      },
    }, corner);
    expect(parseGameState(JSON.parse(JSON.stringify(detentionFee)), standard)).toEqual(
      detentionFee,
    );
  });

  it("preserves duplicate and stale decisions ahead of pending command blocking", () => {
    const state = landed(standard, 1);
    expect(applyGameplayCommand(
      state,
      command("END_TURN", "stale", state.gameVersion - 1),
      { board: standard, actorUserId: players[0]!, rng: () => 0 },
    )).toMatchObject({ kind: "REJECTED", reason: "STALE_GAME_VERSION" });
    expect(applyGameplayCommand(
      state,
      command("END_TURN", "repeat", state.gameVersion - 1),
      {
        board: standard, actorUserId: players[0]!, rng: () => 0,
        appliedActions: [{
          gameId: state.gameId,
          actionId: "repeat",
          resultingGameVersion: state.gameVersion,
        }],
      },
    )).toMatchObject({
      kind: "DUPLICATE_ACTION", committedGameVersion: state.gameVersion,
    });
  });
  it("blocks a new roll even when the unresolved action precedes the first roll", () => {
    const active = started(standard);
    const pending = parseGameState({
      ...active,
      players: active.players.map((player, index) => index === 0
        ? { ...player, position: 10 }
        : player),
      pendingResolution: {
        resolutionId: "turn-1:fee",
        kind: "DETENTION_FEE",
        actorUserId: players[0],
        decisionOwnerUserId: players[0],
        source: { type: "TILE", tileIndex: 10 },
        continuation: { type: "END_TURN" },
        roll: null,
        obligation: {
          debtorUserId: players[0],
          creditor: { type: "BANK" },
          amount: 50,
          continuation: { type: "END_TURN" },
        },
      },
    }, standard);
    let rngCalls = 0;
    const rejected = applyGameplayCommand(
      pending,
      command("ROLL_DICE", "bypass-pre-roll", pending.gameVersion),
      {
        board: standard,
        actorUserId: players[0]!,
        rng: () => { rngCalls += 1; return 0; },
      },
    );
    expect(rejected).toMatchObject({ kind: "REJECTED", reason: "PENDING_RESOLUTION" });
    expect(rejected.state).toEqual(pending);
    expect(rngCalls).toBe(0);
  });
});
