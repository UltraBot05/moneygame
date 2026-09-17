import { describe, expect, it } from "vitest";
import standardFixture from "../../../boards/world-tour/standard.json";
import { parseBoardDefinition } from "./board";
import { CommandValidationError } from "./command";
import { applyGameplayCommand, type GameplayCommandContext } from "./gameplay";
import {
  evaluateTaxRule,
  mortgageValue,
  parseTaxRule,
  rentForAsset,
  unmortgageCost,
} from "./rules";
import {
  createInitialGameState,
  parseGameState,
  type AssetState,
  type GameState,
} from "./state";

const board = parseBoardDefinition(standardFixture);
const players = ["google:alice", "google:bob", "google:carol"];

function command(
  type: string,
  actionId: string,
  gameVersion: number,
  payload: Record<string, unknown> = {},
) {
  return { type, gameId: "rules-game", actionId, expectedGameVersion: gameVersion, payload };
}

function context(
  actorUserId: string,
  values: readonly number[] = [0, 0.2],
  appliedActions?: GameplayCommandContext["appliedActions"],
): GameplayCommandContext {
  let index = 0;
  return {
    actorUserId,
    board,
    rng: () => values[index++] ?? 0,
    currentTime: 1000,
    auctionDecisionDeadlineAt: 2000,
    ...(appliedActions === undefined ? {} : { appliedActions }),
  };
}

function accepted(result: ReturnType<typeof applyGameplayCommand>) {
  expect(result.kind).toBe("ACCEPTED");
  if (result.kind !== "ACCEPTED") throw new Error("expected accepted command");
  return result;
}

function initial(startingCash = 2000) {
  return createInitialGameState({
    gameId: "rules-game",
    board,
    playerIds: players,
    startingCash,
  });
}

function started() {
  const state = initial();
  return accepted(applyGameplayCommand(
    state,
    command("START_GAME", "start", state.gameVersion),
    context(players[0]!),
  )).state;
}

function assetAt(state: GameState, tileIndex: number): AssetState {
  const asset = state.assets.find((candidate) => candidate.tileIndex === tileIndex);
  if (asset === undefined) throw new Error("missing asset at tile " + tileIndex);
  return asset;
}

function configuredState(input: Readonly<{
  owners?: Readonly<Record<number, string | null>>;
  mortgages?: readonly number[];
  development?: Readonly<Record<number, number>>;
  cash?: Readonly<Record<string, number>>;
  holding?: readonly string[];
}> = {}): GameState {
  const state = started();
  return parseGameState({
    ...state,
    players: state.players.map((player) => ({
      ...player,
      cash: input.cash?.[player.userId] ?? player.cash,
      inHolding: input.holding?.includes(player.userId) ?? player.inHolding,
    })),
    assets: state.assets.map((asset) => ({
      ...asset,
      ownerUserId: Object.prototype.hasOwnProperty.call(input.owners ?? {}, asset.tileIndex)
        ? input.owners?.[asset.tileIndex] ?? null
        : asset.ownerUserId,
      mortgaged: input.mortgages?.includes(asset.tileIndex) ?? asset.mortgaged,
      ...(asset.kind === "PROPERTY"
        ? { developmentLevel: input.development?.[asset.tileIndex] ?? asset.developmentLevel }
        : {}),
    })),
  }, board);
}

function landOn(state: GameState, tileIndex: number, values: readonly number[] = [0, 0.2]) {
  const diceTotal = Math.floor(values[0]! * 6) + 1 + Math.floor(values[1]! * 6) + 1;
  const positioned = parseGameState({
    ...state,
    players: state.players.map((player) => player.userId === players[0]
      ? { ...player, position: (tileIndex - diceTotal + board.tileCount) % board.tileCount }
      : player),
  }, board);
  return accepted(applyGameplayCommand(
    positioned,
    command("ROLL_DICE", "land-" + tileIndex, positioned.gameVersion),
    context(players[0]!, values),
  ));
}

describe("RULE-020 match settings contract", () => {
  it("stores only approved settings and reconstructs them canonically", () => {
    const state = initial();
    const configured = accepted(applyGameplayCommand(
      state,
      command("CONFIGURE_MATCH", "configure", state.gameVersion, {
        matchMode: "TEAMS",
        winMode: "LAST_STANDING",
        startingCash: 2500,
      }),
      context(players[0]!),
    )).state;

    expect(configured.settings).toEqual({
      matchMode: "TEAMS",
      winMode: "LAST_STANDING",
      startingCash: 2500,
      pacing: "CORE",
    });
    expect(configured.players.every((player) => player.cash === 2500)).toBe(true);
    expect(parseGameState(JSON.parse(JSON.stringify(configured)), board)).toEqual(configured);
  });

  it("locks settings after start and rejects unsupported or Design-only input", () => {
    const active = started();
    expect(applyGameplayCommand(
      active,
      command("CONFIGURE_MATCH", "late", active.gameVersion, {
        matchMode: "FFA", winMode: "LAST_STANDING", startingCash: 2000,
      }),
      context(players[0]!),
    )).toMatchObject({ kind: "REJECTED", reason: "SETTINGS_LOCKED", state: active });

    const state = initial();
    expect(() => applyGameplayCommand(
      state,
      command("CONFIGURE_MATCH", "unsupported", state.gameVersion, {
        matchMode: "COOPERATIVE", winMode: "LAST_STANDING", startingCash: 2000,
      }),
      context(players[0]!),
    )).toThrow(CommandValidationError);
    expect(() => applyGameplayCommand(
      state,
      command("CONFIGURE_MATCH", "design-toggle", state.gameVersion, {
        matchMode: "FFA", winMode: "LAST_STANDING", startingCash: 2000, turbo: true,
      }),
      context(players[0]!),
    )).toThrow(/unexpected field/);
    expect(() => createInitialGameState({
      gameId: "too-few", board, playerIds: players.slice(0, 2),
    })).toThrow(/TOO_FEW_PLAYERS/);
  });
});

describe("RULE-001 buy and decline", () => {
  it("buys atomically from a canonical pending decision and is duplicate-safe", () => {
    const landed = landOn(started(), 1).state;
    const resolutionId = landed.pendingResolution!.resolutionId;
    expect(applyGameplayCommand(
      landed,
      command("BUY_PROPERTY", "wrong", landed.gameVersion, { resolutionId }),
      context(players[1]!),
    )).toMatchObject({ kind: "REJECTED", reason: "RESOLUTION_NOT_PENDING", state: landed });

    const bought = accepted(applyGameplayCommand(
      landed,
      command("BUY_PROPERTY", "buy", landed.gameVersion, { resolutionId }),
      context(players[0]!),
    )).state;
    expect(bought.players[0]?.cash).toBe(2140);
    expect(assetAt(bought, 1)).toMatchObject({ ownerUserId: players[0], mortgaged: false });
    expect(bought.pendingResolution).toBeNull();

    const duplicate = applyGameplayCommand(
      bought,
      command("BUY_PROPERTY", "buy", landed.gameVersion, { resolutionId }),
      context(players[0]!, [0, 0.2], [{
        gameId: bought.gameId,
        actionId: "buy",
        resultingGameVersion: bought.gameVersion,
      }]),
    );
    expect(duplicate).toMatchObject({
      kind: "DUPLICATE_ACTION", committedGameVersion: bought.gameVersion, state: bought,
    });
  });

  it("does not partially mutate on insufficient cash and decline hands off once", () => {
    const landed = landOn(configuredState({ cash: { [players[0]!]: 0 } }), 6).state;
    const resolutionId = landed.pendingResolution!.resolutionId;
    expect(applyGameplayCommand(
      landed,
      command("BUY_PROPERTY", "poor", landed.gameVersion, { resolutionId }),
      context(players[0]!),
    )).toMatchObject({ kind: "REJECTED", reason: "INSUFFICIENT_FUNDS", state: landed });

    const auction = accepted(applyGameplayCommand(
      landed,
      command("DECLINE_PROPERTY", "decline", landed.gameVersion, { resolutionId }),
      context(players[0]!),
    )).state;
    expect(auction.pendingResolution).toMatchObject({ kind: "AUCTION", resolutionId });
    expect(assetAt(auction, 6).ownerUserId).toBeNull();
    expect(applyGameplayCommand(
      auction,
      command("DECLINE_PROPERTY", "decline-again", auction.gameVersion, { resolutionId }),
      context(players[0]!),
    )).toMatchObject({ kind: "REJECTED", reason: "RESOLUTION_NOT_PENDING" });
  });

  it("rejects reconstruction of a forged buy decision for an already-owned asset", () => {
    const landed = landOn(started(), 1).state;
    expect(() => parseGameState({
      ...landed,
      assets: landed.assets.map((asset) => asset.tileIndex === 1
        ? { ...asset, ownerUserId: players[1] }
        : asset),
    }, board)).toThrow(/purchase or auction source must be unowned/);
  });
});

describe("RULE-002 through RULE-004 rent", () => {
  it("uses base rent, the authored complete-set rent, and automatic atomic transfer", () => {
    const incomplete = configuredState({ owners: { 1: players[1]! } });
    expect(rentForAsset(incomplete, board, assetAt(incomplete, 1), 3)).toBe(6);
    const charged = landOn(incomplete, 1).state;
    expect(charged.players.map((player) => player.cash)).toEqual([2194, 2006, 2000]);
    expect(charged.pendingResolution).toBeNull();

    const complete = configuredState({ owners: { 1: players[1]!, 2: players[1]! } });
    expect(rentForAsset(complete, board, assetAt(complete, 1), 3)).toBe(12);
  });

  it("charges neither self-owned nor mortgaged assets and persists rent shortfall", () => {
    const selfOwned = configuredState({ owners: { 1: players[0]! } });
    expect(landOn(selfOwned, 1).state.players.map((player) => player.cash))
      .toEqual([2200, 2000, 2000]);
    const mortgaged = configuredState({ owners: { 1: players[1]! }, mortgages: [1] });
    expect(rentForAsset(mortgaged, board, assetAt(mortgaged, 1), 3)).toBe(0);
    expect(landOn(mortgaged, 1).state.pendingResolution).toBeNull();

    const poor = configuredState({
      owners: { 6: players[1]!, 7: players[1]!, 8: players[1]! },
      cash: { [players[0]!]: 5 },
    });
    const debt = landOn(poor, 6).state;
    expect(debt.players.map((player) => player.cash)).toEqual([5, 2000, 2000]);
    expect(debt.pendingResolution).toMatchObject({
      kind: "DEBT",
      obligation: {
        debtorUserId: players[0],
        creditor: { type: "PLAYER", userId: players[1] },
        amount: 20,
        continuation: { type: "END_TURN" },
      },
    });
  });

  it("scales transit rent by one through four unmortgaged canonical hubs", () => {
    const transitTiles = [5, 15, 25, 35];
    for (let count = 1; count <= transitTiles.length; count += 1) {
      const owners = Object.fromEntries(
        transitTiles.slice(0, count).map((tile) => [tile, players[1]!]),
      );
      const state = configuredState({ owners });
      expect(rentForAsset(state, board, assetAt(state, 5), 3)).toBe(count * 20);
    }
    const excluded = configuredState({
      owners: Object.fromEntries(transitTiles.map((tile) => [tile, players[1]!])),
      mortgages: [35],
    });
    expect(rentForAsset(excluded, board, assetAt(excluded, 5), 3)).toBe(60);
    const selfOwned = configuredState({ owners: { 5: players[0]! } });
    expect(landOn(selfOwned, 5).state.pendingResolution).toBeNull();
  });

  it("uses only authoritative dice and canonical unmortgaged utility count", () => {
    const one = configuredState({ owners: { 4: players[1]! } });
    expect(rentForAsset(one, board, assetAt(one, 4), 3)).toBe(12);
    const charged = landOn(one, 4).state;
    expect(charged.players.map((player) => player.cash)).toEqual([1988, 2012, 2000]);

    const two = configuredState({ owners: { 4: players[1]!, 29: players[1]! } });
    expect(rentForAsset(two, board, assetAt(two, 4), 3)).toBe(30);
    const excluded = configuredState({
      owners: { 4: players[1]!, 29: players[1]! }, mortgages: [29],
    });
    expect(rentForAsset(excluded, board, assetAt(excluded, 4), 3)).toBe(12);
    const mortgaged = configuredState({ owners: { 4: players[1]! }, mortgages: [4] });
    expect(rentForAsset(mortgaged, board, assetAt(mortgaged, 4), 12)).toBe(0);

    expect(() => applyGameplayCommand(
      started(),
      { ...command("ROLL_DICE", "forged", 1), payload: { total: 12 } },
      context(players[0]!, [0, 0.2]),
    )).toThrow(CommandValidationError);
  });
});

describe("RULE-006 buildings and RULE-007 mortgages", () => {
  it("enforces even build, two paid actions, blockers, and turn reset", () => {
    let state = configuredState({ owners: { 1: players[0]!, 2: players[0]! } });
    const firstAssetId = assetAt(state, 1).assetId;
    const secondAssetId = assetAt(state, 2).assetId;
    state = accepted(applyGameplayCommand(
      state,
      command("BUILD", "build-1", state.gameVersion, { assetId: firstAssetId }),
      context(players[0]!),
    )).state;
    expect(state.turn?.developmentActionsUsed).toBe(1);
    expect(applyGameplayCommand(
      state,
      command("BUILD", "uneven", state.gameVersion, { assetId: firstAssetId }),
      context(players[0]!),
    )).toMatchObject({ kind: "REJECTED", reason: "UNEVEN_BUILD", state });
    state = accepted(applyGameplayCommand(
      state,
      command("BUILD", "build-2", state.gameVersion, { assetId: secondAssetId }),
      context(players[0]!),
    )).state;
    expect(state.turn?.developmentActionsUsed).toBe(2);
    expect(applyGameplayCommand(
      state,
      command("BUILD", "build-3", state.gameVersion, { assetId: firstAssetId }),
      context(players[0]!),
    )).toMatchObject({ kind: "REJECTED", reason: "DEVELOPMENT_LIMIT_REACHED", state });

    const readyToEnd = parseGameState({
      ...state,
      turn: { ...state.turn!, hasRolled: true, rollAgain: false },
    }, board);
    const next = accepted(applyGameplayCommand(
      readyToEnd,
      command("END_TURN", "end", readyToEnd.gameVersion),
      context(players[0]!),
    )).state;
    expect(next.turn).toMatchObject({ activePlayerId: players[1], developmentActionsUsed: 0 });
  });

  it("rejects non-property, incomplete, mortgage, debt, Holding, and unaffordable builds", () => {
    const transit = configuredState({ owners: { 5: players[0]! } });
    expect(applyGameplayCommand(
      transit,
      command("BUILD", "transit", transit.gameVersion, { assetId: assetAt(transit, 5).assetId }),
      context(players[0]!),
    )).toMatchObject({ kind: "REJECTED", reason: "ASSET_NOT_DEVELOPABLE" });

    const incomplete = configuredState({ owners: { 1: players[0]! } });
    expect(applyGameplayCommand(
      incomplete,
      command("BUILD", "incomplete", incomplete.gameVersion, { assetId: assetAt(incomplete, 1).assetId }),
      context(players[0]!),
    )).toMatchObject({ kind: "REJECTED", reason: "INCOMPLETE_SET" });

    const mortgaged = configuredState({
      owners: { 1: players[0]!, 2: players[0]! }, mortgages: [2],
    });
    expect(applyGameplayCommand(
      mortgaged,
      command("BUILD", "mortgaged", mortgaged.gameVersion, { assetId: assetAt(mortgaged, 1).assetId }),
      context(players[0]!),
    )).toMatchObject({ kind: "REJECTED", reason: "SET_MORTGAGED" });

    const holding = configuredState({
      owners: { 1: players[0]!, 2: players[0]! }, holding: [players[0]!],
    });
    expect(applyGameplayCommand(
      holding,
      command("BUILD", "holding", holding.gameVersion, { assetId: assetAt(holding, 1).assetId }),
      context(players[0]!),
    )).toMatchObject({ kind: "REJECTED", reason: "PLAYER_IN_HOLDING" });

    const poor = configuredState({
      owners: { 1: players[0]!, 2: players[0]! }, cash: { [players[0]!]: 0 },
    });
    expect(applyGameplayCommand(
      poor,
      command("BUILD", "poor", poor.gameVersion, { assetId: assetAt(poor, 1).assetId }),
      context(players[0]!),
    )).toMatchObject({ kind: "REJECTED", reason: "INSUFFICIENT_FUNDS", state: poor });

    const debtBlocked = landOn(configuredState({
      owners: {
        1: players[0]!, 2: players[0]!,
        6: players[1]!, 7: players[1]!, 8: players[1]!,
      },
      cash: { [players[0]!]: 0 },
    }), 6).state;
    expect(applyGameplayCommand(
      debtBlocked,
      command("BUILD", "debt", debtBlocked.gameVersion, { assetId: assetAt(debtBlocked, 1).assetId }),
      context(players[0]!),
    )).toMatchObject({ kind: "REJECTED", reason: "PENDING_RESOLUTION" });
  });

  it("uses canonical principal/redemption and preserves atomic redemption", () => {
    let state = configuredState({ owners: { 1: players[0]! } });
    const assetId = assetAt(state, 1).assetId;
    expect(mortgageValue(board, assetAt(state, 1))).toBe(30);
    expect(unmortgageCost(board, assetAt(state, 1))).toBe(33);
    state = accepted(applyGameplayCommand(
      state,
      command("MORTGAGE", "mortgage", state.gameVersion, { assetId }),
      context(players[0]!),
    )).state;
    expect(state.players[0]?.cash).toBe(2030);
    expect(assetAt(state, 1).mortgaged).toBe(true);
    state = accepted(applyGameplayCommand(
      state,
      command("UNMORTGAGE", "unmortgage", state.gameVersion, { assetId }),
      context(players[0]!),
    )).state;
    expect(state.players[0]?.cash).toBe(1997);
    expect(assetAt(state, 1).mortgaged).toBe(false);

    const poor = configuredState({
      owners: { 1: players[0]! }, mortgages: [1], cash: { [players[0]!]: 32 },
    });
    expect(applyGameplayCommand(
      poor,
      command("UNMORTGAGE", "poor-redeem", poor.gameVersion, { assetId: assetAt(poor, 1).assetId }),
      context(players[0]!),
    )).toMatchObject({ kind: "REJECTED", reason: "INSUFFICIENT_FUNDS", state: poor });
  });

  it("blocks mortgage while any property in the set is developed", () => {
    const developed = configuredState({
      owners: { 1: players[0]!, 2: players[0]! }, development: { 1: 1 },
    });
    expect(applyGameplayCommand(
      developed,
      command("MORTGAGE", "developed", developed.gameVersion, {
        assetId: assetAt(developed, 2).assetId,
      }),
      context(players[0]!),
    )).toMatchObject({ kind: "REJECTED", reason: "SET_HAS_DEVELOPMENT", state: developed });
  });
});

describe("RULE-008 tax framework", () => {
  it("automatically charges canonical fixed tax and persists bank debt on shortfall", () => {
    const paid = landOn(started(), 14).state;
    expect(paid.players[0]?.cash).toBe(1900);
    expect(paid.pendingResolution).toBeNull();

    const poor = configuredState({ cash: { [players[0]!]: 50 } });
    const debt = landOn(poor, 14).state;
    expect(debt.players[0]?.cash).toBe(50);
    expect(debt.pendingResolution).toMatchObject({
      kind: "DEBT",
      obligation: {
        debtorUserId: players[0], creditor: { type: "BANK" }, amount: 100,
        continuation: { type: "END_TURN" },
      },
    });
  });

  it("validates and evaluates fixed, percent, and deterministic choice rules", () => {
    expect(evaluateTaxRule(
      { type: "FIXED", amount: 100 },
      { cash: 2000, netWorth: 3000 },
    )).toEqual({ type: "AMOUNT", amount: 100 });
    expect(evaluateTaxRule(
      { type: "PERCENT", basis: "NET_WORTH", numerator: 1, denominator: 10, rounding: "CEIL" },
      { cash: 100, netWorth: 1001 },
    )).toEqual({ type: "AMOUNT", amount: 101 });
    const choice = evaluateTaxRule({
      type: "CHOICE",
      options: [
        { type: "FIXED", amount: 100 },
        { type: "PERCENT", basis: "CASH", numerator: 1, denominator: 10, rounding: "FLOOR" },
      ],
    }, { cash: 1500, netWorth: 2500 });
    expect(choice).toEqual({ type: "CHOICE_REQUIRED", amounts: [100, 150] });
    expect(JSON.parse(JSON.stringify(choice))).toEqual(choice);
  });

  it("rejects malformed and unknown tax configuration", () => {
    expect(() => parseTaxRule({ type: "PERCENT", basis: "CASH", numerator: 1,
      denominator: 0, rounding: "FLOOR" })).toThrow(/denominator/);
    expect(() => parseTaxRule({ type: "CHOICE", options: [{ type: "FIXED", amount: 10 }] }))
      .toThrow(/at least two/);
    expect(() => parseTaxRule({ type: "SCRIPT", execute: "cash = 0" })).toThrow(/not supported/);
    expect(() => parseTaxRule({ type: "FIXED", amount: 100, privateDesignRate: 0.2 }))
      .toThrow(/not supported/);
  });
});
