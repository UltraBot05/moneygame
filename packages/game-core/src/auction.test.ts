import { describe, expect, it } from "vitest";
import standardFixture from "../../../boards/world-tour/standard.json";
import { parseBoardDefinition } from "./board";
import { applyGameplayCommand, type GameplayCommandContext } from "./gameplay";
import { createInitialGameState, parseGameState, type GameState } from "./state";

const board = parseBoardDefinition(standardFixture);
const players = ["google:alice", "google:bob", "google:carol"];

function command(
  type: string,
  actionId: string,
  gameVersion: number,
  payload: Record<string, unknown>,
  gameId = "auction-game",
) {
  return { type, gameId, actionId, expectedGameVersion: gameVersion, payload };
}

function context(
  actorUserId: string,
  options: Readonly<{
    deadline?: number;
    now?: number;
    appliedActions?: GameplayCommandContext["appliedActions"];
    dice?: readonly number[];
  }> = {},
): GameplayCommandContext {
  let index = 0;
  const dice = options.dice ?? [0, 0.2];
  return {
    actorUserId,
    board,
    rng: () => dice[index++] ?? 0,
    auctionDecisionDeadlineAt: options.deadline ?? 200,
    ...(options.now === undefined ? {} : { currentTime: options.now }),
    ...(options.appliedActions === undefined ? {} : { appliedActions: options.appliedActions }),
  };
}

function accepted(result: ReturnType<typeof applyGameplayCommand>) {
  expect(result.kind).toBe("ACCEPTED");
  if (result.kind !== "ACCEPTED") throw new Error("expected accepted auction command");
  return result;
}

function startAuction(cash: Readonly<Record<string, number>> = {}) {
  const initial = createInitialGameState({
    gameId: "auction-game", board, playerIds: players,
  });
  let state = accepted(applyGameplayCommand(
    initial,
    command("START_GAME", "start", initial.gameVersion, {}),
    context(players[0]!),
  )).state;
  state = parseGameState({
    ...state,
    players: state.players.map((player) => ({
      ...player,
      cash: cash[player.userId] ?? player.cash,
      position: player.userId === players[0] ? 3 : player.position,
    })),
  }, board);
  state = accepted(applyGameplayCommand(
    state,
    command("ROLL_DICE", "roll", state.gameVersion, {}),
    context(players[0]!),
  )).state;
  const resolutionId = state.pendingResolution!.resolutionId;
  return accepted(applyGameplayCommand(
    state,
    command("DECLINE_PROPERTY", "decline", state.gameVersion, { resolutionId }),
    context(players[0]!, { deadline: 100 }),
  )).state;
}

function auctionCommand(
  state: GameState,
  type: "PLACE_BID" | "PASS_AUCTION",
  actorUserId: string,
  actionId: string,
  amount?: number,
  deadline = 200,
) {
  const auctionId = state.auction!.auctionId;
  return applyGameplayCommand(
    state,
    command(type, actionId, state.gameVersion, {
      auctionId,
      ...(amount === undefined ? {} : { amount }),
    }),
    context(actorUserId, { deadline }),
  );
}

function timeout(state: GameState, actionId: string, now: number, decisionDeadlineAt = state.auction!.decisionDeadlineAt) {
  return applyGameplayCommand(
    state,
    command("AUCTION_TIMEOUT", actionId, state.gameVersion, { auctionId: state.auction!.auctionId, decisionDeadlineAt }),
    context("runtime:alarm", { now }),
  );
}

describe("RULE-005 open timed auction (owner decision 2026-10-06)", () => {
  it("opens to every active player, including the decliner, and reconstructs exactly", () => {
    const state = startAuction();
    expect(state.pendingResolution).toMatchObject({ kind: "AUCTION", decisionOwnerUserId: players[0] });
    expect(state.auction).toEqual({
      auctionId: state.pendingResolution!.resolutionId,
      assetId: "property:MA-1",
      originatingPlayerId: players[0],
      continuation: state.pendingResolution!.continuation,
      participantOrder: [players[1], players[2], players[0]],
      passedPlayerIds: [],
      highBid: null,
      highBidderUserId: null,
      hasBid: false,
      decisionDeadlineAt: 100,
      history: [expect.objectContaining({ type: "STARTED", actorUserId: players[0], actionId: "decline" })],
    });
    expect(parseGameState(JSON.parse(JSON.stringify(state)), board)).toEqual(state);
    expect(applyGameplayCommand(
      state,
      command("DECLINE_PROPERTY", "decline-again", state.gameVersion, {
        resolutionId: state.pendingResolution!.resolutionId,
      }),
      context(players[0]!),
    )).toMatchObject({ kind: "REJECTED", reason: "RESOLUTION_NOT_PENDING", state });
  });

  it("lets anyone still in bid in any order, with the $2 opening bid and $2 increments", () => {
    const initial = startAuction();
    for (const amount of [0, 1]) {
      expect(auctionCommand(initial, "PLACE_BID", players[2]!, "low-" + amount, amount))
        .toMatchObject({ kind: "REJECTED", reason: "BID_TOO_LOW", state: initial });
    }
    // Carol is not first in seat order and bids anyway; the decliner may bid too.
    const carol = accepted(auctionCommand(initial, "PLACE_BID", players[2]!, "carol-2", 2)).state;
    expect(carol.auction).toMatchObject({ highBid: 2, highBidderUserId: players[2] });
    expect(auctionCommand(carol, "PLACE_BID", players[2]!, "carol-again", 6))
      .toMatchObject({ kind: "REJECTED", reason: "ALREADY_HIGH_BIDDER", state: carol });
    expect(auctionCommand(carol, "PLACE_BID", players[0]!, "alice-3", 3))
      .toMatchObject({ kind: "REJECTED", reason: "BID_TOO_LOW", state: carol });
    const alice = accepted(auctionCommand(carol, "PLACE_BID", players[0]!, "alice-4", 4)).state;
    const bob = accepted(auctionCommand(alice, "PLACE_BID", players[1]!, "bob-6", 6)).state;
    expect(bob.auction).toMatchObject({ highBid: 6, highBidderUserId: players[1], passedPlayerIds: [] });
    expect(bob.auction?.history.map((fact) => fact.type)).toEqual(["STARTED", "BID", "BID", "BID"]);
    expect(parseGameState(JSON.parse(JSON.stringify(bob)), board)).toEqual(bob);
  });

  it("accepts cash-exact bids, rejects over-cash bids, and never creates auction debt", () => {
    const state = startAuction({ [players[1]!]: 2 });
    expect(auctionCommand(state, "PLACE_BID", players[1]!, "over-cash", 3))
      .toMatchObject({ kind: "REJECTED", reason: "BID_EXCEEDS_CASH", state });
    const exact = accepted(auctionCommand(state, "PLACE_BID", players[1]!, "cash-exact", 2)).state;
    expect(exact.players[1]?.cash).toBe(2);
    expect(exact.pendingResolution?.obligation).toBeNull();
    expect(exact.auction?.highBid).toBe(2);
  });

  it("makes opting out optional and permanent, and the leader cannot withdraw", () => {
    let state = accepted(auctionCommand(startAuction(), "PLACE_BID", players[1]!, "bob-bid", 10)).state;
    expect(auctionCommand(state, "PASS_AUCTION", players[1]!, "bob-pass"))
      .toMatchObject({ kind: "REJECTED", reason: "HIGH_BIDDER_CANNOT_PASS", state });
    state = accepted(auctionCommand(state, "PASS_AUCTION", players[2]!, "carol-pass")).state;
    for (const type of ["PLACE_BID", "PASS_AUCTION"] as const) {
      expect(auctionCommand(state, type, players[2]!, "carol-again", type === "PLACE_BID" ? 20 : undefined))
        .toMatchObject({ kind: "REJECTED", reason: "NOT_AUCTION_PARTICIPANT", state });
    }
    expect(state.auction).toMatchObject({ passedPlayerIds: [players[2]], highBidderUserId: players[1] });
    expect(parseGameState(JSON.parse(JSON.stringify(state)), board)).toEqual(state);
  });

  it("settles early once only the leader is left, atomically, and rejects later commands", () => {
    let state = accepted(auctionCommand(startAuction(), "PLACE_BID", players[1]!, "bob-bid", 10)).state;
    state = accepted(auctionCommand(state, "PASS_AUCTION", players[2]!, "carol-pass")).state;
    const settled = accepted(auctionCommand(state, "PASS_AUCTION", players[0]!, "alice-pass"));
    expect(settled.event).toMatchObject({
      type: "AUCTION_UPDATED", action: "PASS",
      facts: [{ type: "PASS" }, { type: "WINNER", actorUserId: players[1], amount: 10 }],
    });
    expect(settled.state.players[1]?.cash).toBe(1990);
    expect(settled.state.assets.find((asset) => asset.assetId === "property:MA-1")?.ownerUserId).toBe(players[1]);
    expect(settled.state.auction).toBeNull();
    expect(settled.state.pendingResolution).toBeNull();
    expect(applyGameplayCommand(
      settled.state,
      command("PASS_AUCTION", "after-close", settled.state.gameVersion, { auctionId: state.auction!.auctionId }),
      context(players[1]!),
    )).toMatchObject({ kind: "REJECTED", reason: "AUCTION_NOT_ACTIVE" });
  });

  it("ends with nobody owning the deed when everyone opts out", () => {
    let state = startAuction();
    state = accepted(auctionCommand(state, "PASS_AUCTION", players[0]!, "alice-pass")).state;
    state = accepted(auctionCommand(state, "PASS_AUCTION", players[2]!, "carol-pass")).state;
    const closed = accepted(auctionCommand(state, "PASS_AUCTION", players[1]!, "bob-pass"));
    expect(closed.event).toMatchObject({ facts: [{ type: "PASS" }, { type: "NO_BID", actorUserId: null }] });
    expect(closed.state.assets.find((asset) => asset.assetId === "property:MA-1")?.ownerUserId).toBeNull();
    expect(closed.state.auction).toBeNull();
  });

  it("keeps at least the bid window on the clock after a bid, never cutting it", () => {
    const state = startAuction();
    const early = accepted(auctionCommand(state, "PLACE_BID", players[1]!, "early", 2, 50)).state;
    expect(early.auction?.decisionDeadlineAt).toBe(100);
    const late = accepted(auctionCommand(early, "PLACE_BID", players[2]!, "late", 4, 150)).state;
    expect(late.auction?.decisionDeadlineAt).toBe(150);
  });

  it("lets the clock decide: nobody gets it without a bid, the leader wins with one", () => {
    const open = startAuction();
    expect(timeout(open, "early", 99)).toMatchObject({ kind: "REJECTED", reason: "AUCTION_DEADLINE_NOT_EXPIRED", state: open });
    expect(timeout(open, "stale", 100, 99)).toMatchObject({ kind: "REJECTED", reason: "STALE_AUCTION_TIMEOUT", state: open });
    const unsold = accepted(timeout(open, "due", 100));
    expect(unsold.event).toMatchObject({ type: "AUCTION_UPDATED", action: "TIMEOUT", facts: [{ type: "NO_BID" }] });
    expect(unsold.state.assets.find((asset) => asset.assetId === "property:MA-1")?.ownerUserId).toBeNull();
    expect(unsold.state.auction).toBeNull();

    const bid = accepted(auctionCommand(open, "PLACE_BID", players[2]!, "carol-bid", 30, 90)).state;
    const sold = accepted(timeout(bid, "due-with-bid", 100));
    expect(sold.event).toMatchObject({ action: "TIMEOUT", facts: [{ type: "WINNER", actorUserId: players[2], amount: 30 }] });
    expect(sold.state.players[2]?.cash).toBe(bid.players[2]!.cash - 30);
    expect(sold.state.assets.find((asset) => asset.assetId === "property:MA-1")?.ownerUserId).toBe(players[2]);
    expect(applyGameplayCommand(
      sold.state,
      command("AUCTION_TIMEOUT", "after-close", sold.state.gameVersion, { auctionId: bid.auction!.auctionId, decisionDeadlineAt: 100 }),
      context("runtime:alarm", { now: 200 }),
    )).toMatchObject({ kind: "REJECTED", reason: "AUCTION_NOT_ACTIVE" });
  });

  it("preserves duplicate and stale game/version precedence", () => {
    const state = startAuction();
    expect(applyGameplayCommand(
      state,
      command("PLACE_BID", "stale-game", state.gameVersion, { auctionId: state.auction!.auctionId, amount: 2 }, "old-game"),
      context(players[1]!),
    )).toMatchObject({ kind: "REJECTED", reason: "STALE_GAME" });
    expect(applyGameplayCommand(
      state,
      command("PLACE_BID", "stale-version", state.gameVersion - 1, { auctionId: state.auction!.auctionId, amount: 2 }),
      context(players[1]!),
    )).toMatchObject({ kind: "REJECTED", reason: "STALE_GAME_VERSION" });
    const bid = accepted(auctionCommand(state, "PLACE_BID", players[1]!, "duplicate-bid", 2)).state;
    const duplicate = applyGameplayCommand(
      bid,
      command("PLACE_BID", "duplicate-bid", state.gameVersion, { auctionId: state.auction!.auctionId, amount: 2 }),
      context(players[1]!, { appliedActions: [{ gameId: bid.gameId, actionId: "duplicate-bid", resultingGameVersion: bid.gameVersion }] }),
    );
    expect(duplicate).toMatchObject({ kind: "DUPLICATE_ACTION", state: bid, committedGameVersion: bid.gameVersion });
    expect(bid.auction?.history.filter((fact) => fact.type === "BID")).toHaveLength(1);
  });

  it("rejects reconstruction when the active high bidder cannot cover the bid", () => {
    const state = accepted(auctionCommand(startAuction({ [players[1]!]: 10 }), "PLACE_BID", players[1]!, "bob-bid", 10)).state;
    expect(state.players[1]?.cash).toBe(10);
    expect(parseGameState(JSON.parse(JSON.stringify(state)), board)).toEqual(state);
    expect(() => parseGameState({
      ...state,
      players: state.players.map((player) => player.userId === players[1] ? { ...player, cash: 9 } : player),
    }, board)).toThrow(/active high bidder must be able to cover the high bid/);
  });

  it("rejects forged auction references, participant omissions, and history drift", () => {
    const state = startAuction();
    expect(() => parseGameState({ ...state, auction: { ...state.auction!, assetId: "property:missing" } }, board))
      .toThrow(/unowned pending auction asset/);
    expect(() => parseGameState({
      ...state,
      auction: { ...state.auction!, participantOrder: state.auction!.participantOrder.slice(0, 2) },
    }, board)).toThrow(/every eligible game player/);
    expect(() => parseGameState({
      ...state,
      auction: { ...state.auction!, hasBid: true, highBid: 2, highBidderUserId: players[1] },
    }, board)).toThrow(/match history replay/);
    expect(() => parseGameState({
      ...state,
      auction: { ...state.auction!, history: state.auction!.history.map((fact) => ({ ...fact, gameVersion: state.gameVersion + 1 })) },
    }, board)).toThrow(/cannot exceed canonical gameVersion/);
    // A bid from a player who already opted out cannot appear in history.
    const passed = accepted(auctionCommand(state, "PASS_AUCTION", players[2]!, "carol-pass")).state;
    const forged = {
      type: "BID", auctionId: passed.auction!.auctionId, assetId: passed.auction!.assetId, actorUserId: players[2],
      amount: 2, gameVersion: passed.gameVersion + 1, actionId: "forged",
    };
    expect(() => parseGameState({
      ...passed,
      gameVersion: passed.gameVersion + 1,
      auction: { ...passed.auction!, hasBid: true, highBid: 2, highBidderUserId: players[2], history: [...passed.auction!.history, forged] },
    }, board)).toThrow(/unpassed participant who is not leading|high bid fields/);
  });
});
