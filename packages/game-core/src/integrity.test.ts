import { describe, expect, it } from "vitest";
import type { TradeState } from "./advanced-rules";
import { applyGameplayCommand } from "./gameplay";
import { lopsidedTrade } from "./integrity";
import { createInitialGameState, type GameState } from "./state";
import {
  alice,
  asset,
  board,
  bob,
  bundle,
  carol,
  EG1,
  FR2,
  MA1,
  ok,
  openTradeId,
  player,
  propose,
  roundTrip,
  run,
  setup,
  started,
} from "./rules.testkit";

const dave = "google:dave";
const FR1 = "property:FR-1";
const JP3 = "property:JP-3";

function trade(offered: ReturnType<typeof bundle>, requested: ReturnType<typeof bundle>): TradeState {
  return {
    tradeId: "t", parentTradeId: null, proposerUserId: alice, recipientUserId: bob,
    offered, requested, createdGameVersion: 1, liquidationFor: null,
  };
}

/** Proposes and immediately accepts a trade, returning the accepted result. */
function trade2(state: GameState, from: string, to: string, offered: ReturnType<typeof bundle>, requested: ReturnType<typeof bundle>) {
  const proposed = ok(propose(state, from, to, offered, requested));
  return run(proposed, "ACCEPT_TRADE", to, { tradeId: openTradeId(proposed) });
}

describe("INT-002 valuation and the lopsided threshold", () => {
  const assets = setup({ owners: { [FR1]: alice, [EG1]: alice, [FR2]: alice }, mortgaged: [FR2] }).assets;

  it("matches the INT-001 worked examples exactly at the thresholds", () => {
    // FR-1 is $350: a $350 property for $50 is lopsided.
    expect(lopsidedTrade(board, assets, trade(bundle(0, [FR1]), bundle(50)), 9)).toMatchObject({
      giverUserId: alice, receiverUserId: bob, givenValue: 350, returnedValue: 50,
    });
    expect(lopsidedTrade(board, assets, trade(bundle(400), bundle(200)), 9)).toBeNull();
    expect(lopsidedTrade(board, assets, trade(bundle(500), bundle(150)), 9)).toBeNull();
    // $300 net and exactly 25% returned is lopsided; one dollar more returned is not.
    expect(lopsidedTrade(board, assets, trade(bundle(400), bundle(100)), 9)).not.toBeNull();
    expect(lopsidedTrade(board, assets, trade(bundle(400), bundle(101)), 9)).toBeNull();
    expect(lopsidedTrade(board, assets, trade(bundle(299), bundle(0)), 9)).toBeNull();
    // The larger side decides the direction, whoever proposed.
    expect(lopsidedTrade(board, assets, trade(bundle(10), bundle(600)), 9)).toMatchObject({
      giverUserId: bob, receiverUserId: alice,
    });
  });

  it("values mortgaged assets at their mortgage value", () => {
    // FR-2 costs $400 but is mortgaged for $200: gifting it is below the $300 floor.
    expect(lopsidedTrade(board, assets, trade(bundle(0, [FR2]), bundle(0)), 9)).toBeNull();
    expect(lopsidedTrade(board, assets, trade(bundle(150, [FR2]), bundle(0)), 9)).toMatchObject({ givenValue: 350 });
  });
});

describe("INT-002 pattern incidents", () => {
  it("records a single generous trade without any consequence", () => {
    const state = setup({ owners: { [FR1]: alice } });
    const result = trade2(state, alice, bob, bundle(0, [FR1]), bundle(10));
    expect(result).toMatchObject({ event: { incident: null, eliminations: [] } });
    const after = roundTrip(ok(result));
    expect(after.ruleState.fairPlay.lopsidedTrades).toHaveLength(1);
    expect(after.ruleState.fairPlay.incidents).toEqual([]);
    expect(asset(after, FR1).ownerUserId).toBe(bob);
  });

  it("warns on the pair's second lopsided trade and removes both on the next", () => {
    let state = setup({ owners: { [FR1]: alice, [JP3]: bob } });
    state = ok(trade2(state, alice, bob, bundle(0, [FR1]), bundle(10)));
    const other = ok(trade2(state, alice, carol, bundle(350), bundle(0)));
    expect(other.ruleState.fairPlay.incidents).toEqual([]);

    const warned = trade2(other, bob, alice, bundle(100, [JP3]), bundle(0));
    expect(warned).toMatchObject({
      event: { incident: { kind: "PATTERN", consequence: "WARNING", giverUserId: bob, receiverUserId: alice } },
    });
    const afterWarning = roundTrip(ok(warned));
    expect(afterWarning.players.every((candidate) => candidate.status === "ACTIVE")).toBe(true);

    const removal = trade2(afterWarning, alice, bob, bundle(400), bundle(0));
    expect(removal).toMatchObject({
      event: {
        incident: { consequence: "REMOVAL" },
        eliminations: [
          { userId: alice, reason: "REMOVED", resolutionId: null, creditor: { type: "BANK" }, obligationAmount: 0 },
          { userId: bob, reason: "REMOVED" },
        ],
      },
    });
    const ended = roundTrip(ok(removal));
    expect(ended.phase).toBe("GAME_OVER");
    expect(ended.ruleState.outcome).toMatchObject({ winnerUserIds: [carol], placements: [carol, bob, alice] });
    expect(asset(ended, JP3)).toMatchObject({ ownerUserId: null });
    expect(asset(ended, FR1)).toMatchObject({ ownerUserId: null });
  });

  it("never evaluates trades in TEAMS matches", () => {
    let state = setup({ owners: { [FR1]: alice, [JP3]: bob } }, undefined, started("TEAMS"));
    state = ok(trade2(state, alice, bob, bundle(0, [FR1]), bundle(0)));
    state = ok(trade2(state, bob, alice, bundle(0, [JP3]), bundle(0)));
    state = ok(trade2(state, alice, bob, bundle(500), bundle(0)));
    expect(state.ruleState.fairPlay).toEqual({ lopsidedTrades: [], incidents: [] });
    expect(state.players.every((candidate) => candidate.status === "ACTIVE")).toBe(true);
  });

  it("records nothing again when the same accepted action is replayed", () => {
    const state = ok(propose(setup({ owners: { [FR1]: alice } }), alice, bob, bundle(0, [FR1]), bundle(0)));
    const tradeId = openTradeId(state);
    const first = ok(run(state, "ACCEPT_TRADE", bob, { tradeId }, { actionId: "accept-gift" }));
    const replay = applyGameplayCommand(
      first,
      { type: "ACCEPT_TRADE", gameId: first.gameId, actionId: "accept-gift", payload: { tradeId } },
      {
        actorUserId: bob, board, rng: () => 0,
        appliedActions: [{ gameId: first.gameId, actionId: "accept-gift", resultingGameVersion: first.gameVersion }],
      },
    );
    expect(replay).toMatchObject({ kind: "DUPLICATE_ACTION" });
    expect(replay.state.ruleState.fairPlay.lopsidedTrades).toHaveLength(1);
  });
});

describe("INT-002 pre-bankruptcy dumps", () => {
  /** Alice owes $100 Customs tax with $50, owning FR-1 ($350). */
  function aliceInDebt(input: Parameters<typeof setup>[0] = {}) {
    const state = setup({
      ...input,
      positions: { [alice]: 11 },
      cash: { [alice]: 50, ...input.cash },
      owners: { [FR1]: alice, ...input.owners },
    });
    return ok(run(state, "ROLL_DICE", alice, {}, { dice: [1, 2] }));
  }

  it("flags a debtor who gifts assets during the debt and then declares bankruptcy", () => {
    const owing = aliceInDebt();
    const gifted = ok(trade2(owing, alice, bob, bundle(0, [FR1]), bundle(0)));
    const resolutionId = owing.pendingResolution?.resolutionId;
    expect(gifted.ruleState.fairPlay.lopsidedTrades[0]).toMatchObject({ liquidationFor: resolutionId });
    const declared = run(gifted, "DECLARE_BANKRUPTCY", alice, { resolutionId });
    expect(declared).toMatchObject({
      event: {
        type: "PLAYER_BANKRUPT",
        incidents: [{ kind: "DUMP", giverUserId: alice, receiverUserId: bob, consequence: "WARNING" }],
        removals: [],
      },
    });
    const after = roundTrip(ok(declared));
    expect(player(after, bob).status).toBe("ACTIVE");
    expect(asset(after, FR1).ownerUserId).toBe(bob);
  });

  it("counts each trade once and removes a dump receiver the pair was already warned about", () => {
    const owing = aliceInDebt({ owners: { [FR2]: alice } });
    const resolutionId = owing.pendingResolution?.resolutionId;
    const first = ok(trade2(owing, alice, bob, bundle(0, [FR1]), bundle(0)));
    const second = trade2(first, alice, bob, bundle(0, [FR2]), bundle(0));
    expect(second).toMatchObject({ event: { incident: { kind: "PATTERN", consequence: "WARNING" } } });
    const declared = run(ok(second), "DECLARE_BANKRUPTCY", alice, { resolutionId });
    expect(declared).toMatchObject({
      event: {
        incidents: [{ kind: "DUMP", consequence: "REMOVAL", tradeId: first.ruleState.fairPlay.lopsidedTrades[0]?.tradeId }],
        removals: [{ userId: bob, reason: "REMOVED" }],
        outcome: { winnerUserIds: [carol] },
      },
    });
    const ended = roundTrip(ok(declared));
    expect(ended.ruleState.fairPlay.incidents.map((incident) => incident.kind)).toEqual(["PATTERN", "DUMP"]);
    expect(asset(ended, FR2).ownerUserId).toBeNull();
  });

  it("does not treat a one-off rescue gift to the debtor as a dump", () => {
    const owing = aliceInDebt();
    const rescued = trade2(owing, bob, alice, bundle(400), bundle(0));
    expect(rescued).toMatchObject({ event: { debtSettled: true, incident: null } });
    const after = ok(rescued);
    expect(after.pendingResolution).toBeNull();
    expect(after.ruleState.fairPlay.lopsidedTrades).toHaveLength(1);
  });
});

describe("INT-002 removal repairs interactions with the removed players", () => {
  it("turns a debt owed to a removed player into a bank debt and keeps the turn", () => {
    const initial = createInitialGameState({ gameId: "d2-game", board, playerIds: [alice, bob, carol, dave] });
    let state = setup({ owners: { [FR1]: carol, [JP3]: dave, [MA1]: bob } }, undefined, ok(run(initial, "START_GAME", alice)));
    state = ok(trade2(state, carol, dave, bundle(0, [FR1]), bundle(0)));
    state = ok(trade2(state, dave, carol, bundle(100, [JP3]), bundle(0)));
    const owing = ok(run(setup({ positions: { [alice]: 3 }, cash: { [alice]: 1 }, owners: { [MA1]: carol } }, undefined, state),
      "ROLL_DICE", alice, {}, { dice: [1, 2] }));
    expect(owing.pendingResolution?.obligation?.creditor).toEqual({ type: "PLAYER", userId: carol });
    const removal = ok(trade2(owing, carol, dave, bundle(400), bundle(0)));
    expect(removal.players.filter((candidate) => candidate.status === "BANKRUPT").map((candidate) => candidate.userId))
      .toEqual([carol, dave]);
    expect(removal.phase).toBe("ACTIVE_TURN");
    expect(removal.turn?.activePlayerId).toBe(alice);
    expect(removal.pendingResolution?.obligation?.creditor).toEqual({ type: "BANK" });
    roundTrip(removal);
  });
});
