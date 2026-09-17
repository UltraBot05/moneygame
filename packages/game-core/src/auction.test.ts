import { describe, expect, it } from "vitest";
import standardFixture from "../../../boards/world-tour/standard.json";
import { parseBoardDefinition } from "./board";
import { CommandValidationError } from "./command";
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

describe("RULE-005 persisted deterministic auction", () => {
  it("starts in rotated seat order, includes the decliner, and reconstructs exactly", () => {
    const state = startAuction();
    expect(state.pendingResolution).toMatchObject({
      kind: "AUCTION", decisionOwnerUserId: players[1],
    });
    expect(state.auction).toMatchObject({
      auctionId: state.pendingResolution!.resolutionId,
      assetId: "property:MA-1",
      originatingPlayerId: players[0],
      participantOrder: [players[1], players[2], players[0]],
      passedPlayerIds: [],
      currentActorUserId: players[1],
      highBid: null,
      highBidderUserId: null,
      hasBid: false,
      decisionDeadlineAt: 100,
      history: [{ type: "STARTED", actorUserId: players[0], actionId: "decline" }],
    });
    expect(parseGameState(JSON.parse(JSON.stringify(state)), board)).toEqual(state);
    expect(auctionCommand(
      state, "PASS_AUCTION", players[0]!, "duplicate-auction",
    )).toMatchObject({ kind: "REJECTED", reason: "NOT_AUCTION_ACTOR", state });
    expect(applyGameplayCommand(
      state,
      command("DECLINE_PROPERTY", "decline-again", state.gameVersion, {
        resolutionId: state.pendingResolution!.resolutionId,
      }),
      context(players[0]!),
    )).toMatchObject({ kind: "REJECTED", reason: "RESOLUTION_NOT_PENDING", state });
  });

  it("enforces the $2 opening bid and $2 later increment", () => {
    const initial = startAuction();
    for (const amount of [0, 1]) {
      expect(auctionCommand(
        initial, "PLACE_BID", players[1]!, "low-" + amount, amount,
      )).toMatchObject({ kind: "REJECTED", reason: "BID_TOO_LOW", state: initial });
    }
    const two = accepted(auctionCommand(
      initial, "PLACE_BID", players[1]!, "bid-2", 2,
    )).state;
    expect(two.auction).toMatchObject({ highBid: 2, highBidderUserId: players[1] });
    expect(two.auction?.currentActorUserId).toBe(players[2]);
    for (const amount of [2, 3]) {
      expect(auctionCommand(
        two, "PLACE_BID", players[2]!, "low-after-2-" + amount, amount,
      )).toMatchObject({ kind: "REJECTED", reason: "BID_TOO_LOW", state: two });
    }
    const four = accepted(auctionCommand(
      two, "PLACE_BID", players[2]!, "bid-4", 4,
    )).state;
    expect(four.auction).toMatchObject({ highBid: 4, highBidderUserId: players[2] });
    expect(auctionCommand(
      four, "PLACE_BID", players[0]!, "equal-4", 4,
    )).toMatchObject({ kind: "REJECTED", reason: "BID_TOO_LOW", state: four });

    for (const amount of [1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => auctionCommand(
        initial, "PLACE_BID", players[1]!, "malformed-" + String(amount), amount,
      )).toThrow(CommandValidationError);
    }
  });

  it("accepts cash-exact bids, rejects over-cash bids, and never creates auction debt", () => {
    const state = startAuction({ [players[1]!]: 2 });
    expect(auctionCommand(
      state, "PLACE_BID", players[1]!, "over-cash", 3,
    )).toMatchObject({ kind: "REJECTED", reason: "BID_EXCEEDS_CASH", state });
    const exact = accepted(auctionCommand(
      state, "PLACE_BID", players[1]!, "cash-exact", 2,
    )).state;
    expect(exact.players[1]?.cash).toBe(2);
    expect(exact.pendingResolution?.obligation).toBeNull();
    expect(exact.auction?.highBid).toBe(2);
  });

  it("makes passes permanent, skips them deterministically, and lets the decliner bid", () => {
    let state = startAuction();
    state = accepted(auctionCommand(
      state, "PASS_AUCTION", players[1]!, "bob-pass",
    )).state;
    expect(state.auction).toMatchObject({
      passedPlayerIds: [players[1]], currentActorUserId: players[2],
    });
    expect(auctionCommand(
      state, "PLACE_BID", players[1]!, "bob-reenter", 2,
    )).toMatchObject({ kind: "REJECTED", reason: "NOT_AUCTION_ACTOR", state });
    state = accepted(auctionCommand(
      state, "PASS_AUCTION", players[2]!, "carol-pass",
    )).state;
    expect(state.auction).toMatchObject({
      passedPlayerIds: [players[1], players[2]], currentActorUserId: players[0], hasBid: false,
    });
    const settled = accepted(auctionCommand(
      state, "PLACE_BID", players[0]!, "decliner-bid", 2,
    ));
    expect(settled.state.auction).toBeNull();
    expect(settled.state.pendingResolution).toBeNull();
    expect(settled.state.players[0]?.cash).toBe(1998);
    expect(settled.state.assets.find((asset) => asset.assetId === "property:MA-1"))
      .toMatchObject({ ownerUserId: players[0], mortgaged: false, developmentLevel: 0 });
    expect(settled.event).toMatchObject({
      type: "AUCTION_UPDATED",
      facts: [
        { type: "BID", actorUserId: players[0], amount: 2 },
        { type: "WINNER", actorUserId: players[0], amount: 2 },
      ],
    });
  });

  it("settles one remaining high bidder atomically and rejects post-completion commands", () => {
    let state = startAuction();
    state = accepted(auctionCommand(
      state, "PLACE_BID", players[1]!, "bob-bid", 10,
    )).state;
    state = accepted(auctionCommand(
      state, "PASS_AUCTION", players[2]!, "carol-pass",
    )).state;
    const settled = accepted(auctionCommand(
      state, "PASS_AUCTION", players[0]!, "alice-pass",
    ));
    expect(settled.state.players[1]?.cash).toBe(1990);
    expect(settled.state.assets.find((asset) => asset.assetId === "property:MA-1")?.ownerUserId)
      .toBe(players[1]);
    expect(settled.state.auction).toBeNull();
    expect(settled.state.pendingResolution).toBeNull();
    expect(applyGameplayCommand(
      settled.state,
      command("PASS_AUCTION", "after-close", settled.state.gameVersion, {
        auctionId: state.auction!.auctionId,
      }),
      context(players[1]!),
    )).toMatchObject({ kind: "REJECTED", reason: "AUCTION_NOT_ACTIVE" });
  });

  it("requires an explicit final no-bid turn and leaves the asset unowned", () => {
    let state = startAuction();
    state = accepted(auctionCommand(
      state, "PASS_AUCTION", players[1]!, "bob-pass",
    )).state;
    state = accepted(auctionCommand(
      state, "PASS_AUCTION", players[2]!, "carol-pass",
    )).state;
    expect(state.auction).toMatchObject({
      currentActorUserId: players[0], hasBid: false, passedPlayerIds: [players[1], players[2]],
    });
    const noBid = accepted(auctionCommand(
      state, "PASS_AUCTION", players[0]!, "alice-pass",
    ));
    expect(noBid.state.auction).toBeNull();
    expect(noBid.state.pendingResolution).toBeNull();
    expect(noBid.state.assets.find((asset) => asset.assetId === "property:MA-1")?.ownerUserId)
      .toBeNull();
    expect(noBid.event).toMatchObject({
      type: "AUCTION_UPDATED",
      facts: [{ type: "PASS", actorUserId: players[0] },
        { type: "NO_BID", actorUserId: null, amount: null }],
    });
  });

  it("auto-passes only at expiry and rejects stale repeated timeout delivery", () => {
    const state = startAuction();
    const payload = {
      auctionId: state.auction!.auctionId,
      actorUserId: state.auction!.currentActorUserId,
      decisionDeadlineAt: state.auction!.decisionDeadlineAt,
    };
    expect(applyGameplayCommand(
      state,
      command("AUCTION_TIMEOUT", "early", state.gameVersion, payload),
      context("runtime:alarm", { now: 99, deadline: 200 }),
    )).toMatchObject({ kind: "REJECTED", reason: "AUCTION_DEADLINE_NOT_EXPIRED", state });

    const timedOut = accepted(applyGameplayCommand(
      state,
      command("AUCTION_TIMEOUT", "due", state.gameVersion, payload),
      context("runtime:alarm", { now: 100, deadline: 200 }),
    )).state;
    expect(timedOut.auction).toMatchObject({
      passedPlayerIds: [players[1]], currentActorUserId: players[2], decisionDeadlineAt: 200,
      history: [{ type: "STARTED" }, { type: "AUTO_PASS", actorUserId: players[1] }],
    });
    expect(applyGameplayCommand(
      timedOut,
      command("AUCTION_TIMEOUT", "repeat-different-id", timedOut.gameVersion, payload),
      context("runtime:alarm", { now: 200, deadline: 300 }),
    )).toMatchObject({ kind: "REJECTED", reason: "STALE_AUCTION_TIMEOUT", state: timedOut });
    expect(parseGameState(JSON.parse(JSON.stringify(timedOut)), board)).toEqual(timedOut);
    expect(timedOut.auction?.passedPlayerIds).toContain(players[1]);
  });

  it("preserves duplicate, stale game/version, wrong-actor, and audit precedence", () => {
    const state = startAuction();
    expect(auctionCommand(
      state, "PLACE_BID", players[2]!, "wrong-actor", 2,
    )).toMatchObject({ kind: "REJECTED", reason: "NOT_AUCTION_ACTOR", state });
    expect(applyGameplayCommand(
      state,
      command("PLACE_BID", "stale-game", state.gameVersion, {
        auctionId: state.auction!.auctionId, amount: 2,
      }, "old-game"),
      context(players[1]!),
    )).toMatchObject({ kind: "REJECTED", reason: "STALE_GAME" });
    expect(applyGameplayCommand(
      state,
      command("PLACE_BID", "stale-version", state.gameVersion - 1, {
        auctionId: state.auction!.auctionId, amount: 2,
      }),
      context(players[1]!),
    )).toMatchObject({ kind: "REJECTED", reason: "STALE_GAME_VERSION" });

    const bid = accepted(auctionCommand(
      state, "PLACE_BID", players[1]!, "duplicate-bid", 2,
    )).state;
    const duplicate = applyGameplayCommand(
      bid,
      command("PLACE_BID", "duplicate-bid", state.gameVersion, {
        auctionId: state.auction!.auctionId, amount: 2,
      }),
      context(players[1]!, { appliedActions: [{
        gameId: bid.gameId,
        actionId: "duplicate-bid",
        resultingGameVersion: bid.gameVersion,
      }] }),
    );
    expect(duplicate).toMatchObject({
      kind: "DUPLICATE_ACTION", state: bid, committedGameVersion: bid.gameVersion,
    });
    expect(bid.auction?.history.filter((fact) => fact.type === "BID")).toHaveLength(1);
  });

  it("rejects reconstruction when the active high bidder cannot cover the bid", () => {
    let state = startAuction({ [players[1]!]: 10 });
    state = accepted(auctionCommand(
      state, "PLACE_BID", players[1]!, "bob-bid", 10,
    )).state;
    expect(() => parseGameState({
      ...state,
      players: state.players.map((player) => player.userId === players[1]
        ? { ...player, cash: 9 }
        : player),
    }, board)).toThrow(/active high bidder must be able to cover the high bid/);
  });

  it("reconstructs an active high bid when cash exactly covers it", () => {
    let state = startAuction({ [players[1]!]: 10 });
    state = accepted(auctionCommand(
      state, "PLACE_BID", players[1]!, "bob-bid", 10,
    )).state;
    expect(state.players[1]?.cash).toBe(10);
    expect(parseGameState(JSON.parse(JSON.stringify(state)), board)).toEqual(state);
  });

  it("rejects the former deadlock shape before any gameplay transition", () => {
    let state = startAuction({ [players[0]!]: 11, [players[1]!]: 10 });
    state = accepted(auctionCommand(
      state, "PLACE_BID", players[1]!, "bob-bid", 10,
    )).state;
    state = accepted(auctionCommand(
      state, "PASS_AUCTION", players[2]!, "carol-pass",
    )).state;
    expect(state.auction).toMatchObject({
      highBid: 10,
      highBidderUserId: players[1],
      passedPlayerIds: [players[2]],
      currentActorUserId: players[0],
    });
    expect(state.players[0]?.cash).toBe(11);
    expect(() => parseGameState({
      ...state,
      players: state.players.map((player) => player.userId === players[1]
        ? { ...player, cash: 9 }
        : player),
    }, board)).toThrow(/active high bidder must be able to cover the high bid/);
  });

  it("rejects forged auction references, participant omissions, and history drift", () => {
    const state = startAuction();
    expect(() => parseGameState({
      ...state,
      auction: { ...state.auction!, assetId: "property:missing" },
    }, board)).toThrow(/unowned pending auction asset/);
    expect(() => parseGameState({
      ...state,
      auction: {
        ...state.auction!,
        participantOrder: state.auction!.participantOrder.slice(0, 2),
      },
    }, board)).toThrow(/every eligible game player/);
    expect(() => parseGameState({
      ...state,
      auction: {
        ...state.auction!, hasBid: true, highBid: 2, highBidderUserId: players[1],
      },
    }, board)).toThrow(/current actor|deterministic history replay/);
    expect(() => parseGameState({
      ...state,
      auction: {
        ...state.auction!,
        history: state.auction!.history.map((fact) => ({
          ...fact, gameVersion: state.gameVersion + 1,
        })),
      },
    }, board)).toThrow(/cannot exceed canonical gameVersion/);
  });
});
