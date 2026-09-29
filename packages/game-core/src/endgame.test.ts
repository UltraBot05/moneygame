import { describe, expect, it } from "vitest";
import { applyGameplayCommand } from "./gameplay";
import { parseGameState, type GameState } from "./state";
import {
  alice,
  asset,
  board,
  bob,
  bundle,
  carol,
  catalog,
  drawFrom,
  EG1,
  FR2,
  MA1,
  MA2,
  MA3,
  ok,
  oneCard,
  player,
  PLUS_FIVE,
  propose,
  refused,
  roundTrip,
  run,
  setup,
  started,
  type Setup,
} from "./rules.testkit";

const SA1 = "property:SA-1";
const holdable = catalog([
  { cardId: "pass", effectId: "plus-one", held: true },
  { cardId: "s1", effectId: "plus-one" },
]);

function declare(state: GameState, actor = alice, options = {}) {
  return run(state, "DECLARE_BANKRUPTCY", actor, { resolutionId: state.pendingResolution?.resolutionId }, options);
}

/** The current turn owner rolls 1+2 onto `tile` from wherever `input` puts them. */
function rollOnto(state: GameState, actor: string, tile: number, input: Setup = {}, cards = holdable) {
  const positioned = setup({ ...input, positions: { ...input.positions, [actor]: tile - 3 } }, cards, state);
  return ok(run(positioned, "ROLL_DICE", actor, {}, { cards, dice: [1, 2] }));
}

/** Alice owes $100 Customs tax (bank creditor) with only $50. */
function aliceTaxDebt(input: Setup = {}, base: GameState = started()) {
  return rollOnto(base, alice, 14, { ...input, cash: { [alice]: 50, ...input.cash } });
}

describe("RULE-016 bankruptcy to a player", () => {
  it("transfers cash, sold-back developments, and mortgaged assets once, then passes the turn", () => {
    const withTrades = ok(propose(
      setup({ owners: { [MA1]: alice, [MA2]: alice, [MA3]: alice, [FR2]: alice, [SA1]: bob, [EG1]: carol } }, holdable),
      alice, carol, bundle(0, [FR2]), bundle(10),
    ));
    const sideTrade = ok(propose(withTrades, bob, carol, bundle(5), bundle(0, [EG1])));
    const owing = rollOnto(sideTrade, alice, 11, {
      cash: { [alice]: 5 },
      mortgaged: [FR2],
      development: { [MA1]: 1, [MA2]: 1, [MA3]: 1 },
      ruleState: {
        decks: [
          { deckId: "surprise", drawPile: ["s1"], discardPile: [] },
          { deckId: "treasure", drawPile: [PLUS_FIVE.cardId], discardPile: [] },
        ],
        heldCards: [{ cardId: "pass", deckId: "surprise", ownerUserId: alice, capability: "DETENTION_RELEASE" }],
      },
    });
    expect(owing.pendingResolution?.obligation).toMatchObject({ creditor: { type: "PLAYER", userId: bob }, amount: 14 });

    refused(declare(owing, bob, { cards: holdable }), "NOT_YOUR_TURN", owing);
    refused(run(owing, "DECLARE_BANKRUPTCY", alice, { resolutionId: "stale" }, { cards: holdable }), "DEBT_NOT_ACTIVE", owing);

    const result = declare(owing, alice, { cards: holdable });
    expect(result).toMatchObject({
      event: {
        type: "PLAYER_BANKRUPT",
        activePlayerId: bob,
        outcome: null,
        fact: {
          userId: alice, reason: "DECLARED", creditor: { type: "PLAYER", userId: bob },
          obligationAmount: 14, cashTransferred: 5 + 30 + 35 + 40,
        },
      },
    });
    const after = roundTrip(ok(result), holdable);
    expect(player(after, alice)).toMatchObject({ status: "BANKRUPT", cash: 0, inHolding: false });
    expect(player(after, bob).cash).toBe(player(owing, bob).cash + 110);
    for (const assetId of [MA1, MA2, MA3]) {
      expect(asset(after, assetId)).toMatchObject({ ownerUserId: bob, developmentLevel: 0, mortgaged: false });
    }
    expect(asset(after, FR2)).toMatchObject({ ownerUserId: bob, mortgaged: true });
    expect(after.ruleState.heldCards).toEqual([]);
    expect(after.ruleState.decks[0]?.discardPile).toEqual(["pass"]);
    expect(after.ruleState.trades.map((trade) => trade.proposerUserId)).toEqual([bob]);
    expect(after.ruleState.tradeFacts.at(-1)).toMatchObject({ type: "VOIDED", actorUserId: alice });
    expect(after.pendingResolution).toBeNull();
    expect(after.ruleState.debt).toBeNull();
    expect(after.turn).toMatchObject({ activePlayerId: bob, turnNumber: owing.turn!.turnNumber + 1, hasRolled: false });
    const cashBefore = owing.players.reduce((total, candidate) => total + candidate.cash, 0);
    expect(after.players.reduce((total, candidate) => total + candidate.cash, 0)).toBe(cashBefore + 105);
  });

  it("drops a suspended card effect when its debtor goes bankrupt", () => {
    const cards = oneCard("charge", [
      { effectId: "charge", type: "ADJUST_CASH", target: "CURRENT_PLAYER", amount: -900 },
    ]);
    const landed = ok(run(setup({ cash: { [alice]: 100 } }, cards), "ROLL_DICE", alice, {}, { cards, dice: [1, 2] }));
    const suspended = ok(drawFrom(landed, cards));
    expect(suspended.ruleState.effectContinuation).not.toBeNull();
    const after = ok(declare(suspended, alice, { cards }));
    expect(after.ruleState.effectContinuation).toBeNull();
    expect(after.pendingResolution).toBeNull();
    expect(after.ruleState.eliminations[0]?.creditor).toEqual({ type: "BANK" });
  });
});

describe("RULE-017 bankruptcy to the bank", () => {
  it("resets every asset to unowned, unmortgaged, and undeveloped without auctions", () => {
    const owing = aliceTaxDebt({
      owners: { [MA1]: alice, [MA2]: alice, [MA3]: alice, [FR2]: alice },
      mortgaged: [FR2],
      development: { [MA1]: 2, [MA2]: 2, [MA3]: 1 },
    });
    const after = roundTrip(ok(declare(owing)));
    for (const assetId of [MA1, MA2, MA3, FR2]) {
      expect(asset(after, assetId)).toMatchObject({ ownerUserId: null, mortgaged: false });
    }
    for (const assetId of [MA1, MA2, MA3]) expect(asset(after, assetId)).toMatchObject({ developmentLevel: 0 });
    expect(after.auction).toBeNull();
    expect(after.ruleState.eliminations[0]).toMatchObject({ cashTransferred: 50, assetIds: [MA1, MA2, MA3, FR2] });
    expect(player(after, bob).cash).toBe(player(owing, bob).cash);
    expect(player(after, carol).cash).toBe(player(owing, carol).cash);

    const buying = rollOnto(after, bob, 6);
    const auctionAfter = ok(run(buying, "DECLINE_PROPERTY", bob, {
      resolutionId: buying.pendingResolution?.resolutionId,
    }));
    expect(auctionAfter.auction?.participantOrder).toEqual([carol, bob]);
  });
});

describe("RULE-019 last standing and the immutable result", () => {
  it("ends an FFA match the moment one player remains and refuses every later command", () => {
    const aliceOut = ok(declare(aliceTaxDebt()));
    const withTrade = ok(propose(aliceOut, carol, bob, bundle(5), bundle(0)));
    const bobOwing = rollOnto(withTrade, bob, 14, { cash: { [bob]: 50 } });
    const result = declare(bobOwing, bob);
    expect(result).toMatchObject({
      event: {
        type: "PLAYER_BANKRUPT",
        activePlayerId: null,
        outcome: {
          reason: "LAST_STANDING",
          winnerUserIds: [carol],
          winningTeamId: null,
          placements: [carol, bob, alice],
          endedGameVersion: bobOwing.gameVersion + 1,
        },
      },
    });
    const ended = roundTrip(ok(result));
    expect(ended).toMatchObject({ phase: "GAME_OVER", turn: null, pendingResolution: null });
    expect(ended.ruleState.trades).toEqual([]);

    for (const [type, actor, payload] of [
      ["ROLL_DICE", carol, {}],
      ["END_TURN", carol, {}],
      ["PROPOSE_TRADE", carol, { recipientUserId: bob, offered: bundle(1), requested: bundle(0) }],
      ["CONFIGURE_MATCH", carol, { matchMode: "FFA", winMode: "LAST_STANDING", startingCash: 2000, teams: [] }],
      ["DECLARE_BANKRUPTCY", carol, { resolutionId: "x" }],
    ] as const) {
      refused(run(ended, type, actor, payload), "GAME_ALREADY_ENDED", ended);
    }
    const replay = applyGameplayCommand(
      ended,
      { type: "END_TURN", gameId: ended.gameId, actionId: "already-done", payload: {} },
      {
        actorUserId: carol, board, rng: () => 0,
        appliedActions: [{ gameId: ended.gameId, actionId: "already-done", resultingGameVersion: 5 }],
      },
    );
    expect(replay).toMatchObject({ kind: "DUPLICATE_ACTION", committedGameVersion: 5 });
  });

  it("lets a team win with eliminated members once every other team is out, charging allies rent", () => {
    const teams = started("TEAMS");
    const allyRent = rollOnto(teams, alice, 6, { owners: { [MA1]: carol } });
    expect(player(allyRent, carol).cash).toBe(player(teams, carol).cash + 10);

    const aliceOut = ok(declare(aliceTaxDebt({}, teams)));
    expect(aliceOut.phase).toBe("ACTIVE_TURN");
    expect(aliceOut.turn?.activePlayerId).toBe(bob);
    const ended = roundTrip(ok(declare(rollOnto(aliceOut, bob, 14, { cash: { [bob]: 50 } }), bob)));
    expect(ended.ruleState.outcome).toEqual({
      reason: "LAST_STANDING",
      winnerUserIds: [alice, carol],
      winningTeamId: "red",
      placements: [carol, bob, alice],
      endedGameVersion: ended.gameVersion,
    });
  });

  it("rejects reconstructed states that break elimination or outcome invariants", () => {
    const aliceOut = ok(declare(aliceTaxDebt()));
    const tamper = (changes: Record<string, unknown>) => () => parseGameState({ ...aliceOut, ...changes }, board);
    expect(tamper({
      assets: aliceOut.assets.map((candidate) => candidate.assetId === EG1 ? { ...candidate, ownerUserId: alice } : candidate),
    })).toThrow(/only eligible players/);
    expect(tamper({ ruleState: { ...aliceOut.ruleState, eliminations: [] } })).toThrow(/eliminated exactly once/);
    expect(tamper({ players: aliceOut.players.map((candidate) => candidate.userId === alice ? { ...candidate, cash: 1 } : candidate) }))
      .toThrow(/eliminated exactly once/);
    expect(tamper({ phase: "GAME_OVER", turn: null })).toThrow(/outcome exists exactly/);
    expect(tamper({
      phase: "GAME_OVER",
      turn: null,
      ruleState: {
        ...aliceOut.ruleState,
        outcome: {
          reason: "LAST_STANDING", winnerUserIds: [bob], winningTeamId: null,
          placements: [bob, carol, alice], endedGameVersion: aliceOut.gameVersion,
        },
      },
    })).toThrow(/surviving player/);
  });
});
