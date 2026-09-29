import { describe, expect, it } from "vitest";
import { SYSTEM_COMMAND_TYPES } from "./gameplay";
import { projectGameState } from "./projection";
import type { GameState } from "./state";
import {
  alice,
  bob,
  bundle,
  carol,
  catalog,
  FR2,
  MA1,
  ok,
  oneCard,
  openTradeId,
  player,
  PLUS_FIVE,
  refused,
  run,
  setup,
} from "./rules.testkit";

const FR1 = "property:FR-1";

function timeout(state: GameState, turnId = state.turn?.turnId, options = {}) {
  return run(state, "TURN_TIMEOUT", "runtime", { turnId }, options);
}

describe("RUNTIME-E1 turn timeout auto-play", () => {
  it("rejects a stale turn and never runs for an outstanding debt", () => {
    const state = setup();
    refused(timeout(state, "turn-99"), "STALE_TURN_TIMEOUT", state);
    const owing = ok(run(setup({ positions: { [alice]: 11 }, cash: { [alice]: 50 } }), "ROLL_DICE", alice, {}, {
      dice: [1, 2],
    }));
    refused(timeout(owing), "NOTHING_TO_AUTO_PLAY", owing);
    expect(SYSTEM_COMMAND_TYPES).toEqual(new Set(["AUCTION_TIMEOUT", "DEBT_TIMEOUT", "TURN_TIMEOUT"]));
  });

  it("rolls, declines an unowned purchase, and stops at the auction others must decide", () => {
    const state = setup({ positions: { [alice]: 3 } });
    const result = timeout(state, state.turn?.turnId, { dice: [1, 2] });
    expect(result).toMatchObject({
      event: { type: "TURN_AUTO_PLAYED", playerId: alice, steps: [{ type: "DICE_ROLLED" }, { type: "PROPERTY_DECLINED" }] },
    });
    const after = ok(result);
    expect(after.gameVersion).toBe(state.gameVersion + 1);
    expect(after.auction?.assetId).toBe(MA1);
    expect(after.turn?.activePlayerId).toBe(alice);
  });

  it("finishes a plain turn and passes it to the next seat", () => {
    const state = setup({ positions: { [alice]: 7 } });
    const result = timeout(state, state.turn?.turnId, { dice: [1, 2] });
    expect(result).toMatchObject({ event: { steps: [{ type: "DICE_ROLLED" }, { type: "TURN_ENDED" }] } });
    expect(ok(result).turn?.activePlayerId).toBe(bob);
  });

  it("draws a pending card, attempts Holding, and ends only when nothing is left", () => {
    const cards = oneCard("plus-ten");
    const card = setup({ positions: { [alice]: 0 } }, cards);
    const drawn = timeout(card, card.turn?.turnId, { cards, dice: [1, 2] });
    expect(drawn).toMatchObject({
      event: { steps: [{ type: "DICE_ROLLED" }, { type: "CARD_RESOLVED" }, { type: "TURN_ENDED" }] },
    });
    expect(player(ok(drawn), alice).cash).toBe(player(card, alice).cash + 10);

    const held = setup({ holding: 0 });
    const attempt = timeout(held, held.turn?.turnId, { dice: [1, 2] });
    expect(attempt).toMatchObject({
      event: { steps: [{ type: "DICE_ROLLED", holding: "ATTEMPT_FAILED" }, { type: "TURN_ENDED" }] },
    });
  });
});

describe("RUNTIME-E1 state projection", () => {
  it("hides draw order and the guard ledger, and shows warnings only to the pair", () => {
    const cards = catalog([{ cardId: "s1", effectId: "plus-one" }, { cardId: "s2", effectId: "plus-one" }]);
    let state = setup({
      owners: { [FR1]: alice, [FR2]: alice },
      ruleState: {
        decks: [
          { deckId: "surprise", drawPile: ["s2"], discardPile: ["s1"] },
          { deckId: "treasure", drawPile: [PLUS_FIVE.cardId], discardPile: [] },
        ],
      },
    }, cards);
    for (const assetId of [FR1, FR2]) {
      const proposed = ok(run(state, "PROPOSE_TRADE", alice, {
        recipientUserId: bob, offered: bundle(0, [assetId]), requested: bundle(0),
      }, { cards }));
      state = ok(run(proposed, "ACCEPT_TRADE", bob, { tradeId: openTradeId(proposed) }, { cards }));
    }
    expect(state.ruleState.fairPlay.incidents).toHaveLength(1);

    const forCarol = projectGameState(state, carol);
    expect(forCarol.ruleState.decks).toEqual([
      { deckId: "surprise", drawCount: 1, discardPile: ["s1"] },
      { deckId: "treasure", drawCount: 1, discardPile: [] },
    ]);
    expect(JSON.stringify(forCarol)).not.toContain("s2");
    expect(JSON.stringify(forCarol)).not.toContain("lopsidedTrades");
    expect(forCarol.ruleState.fairPlay.incidents).toEqual([]);
    expect(projectGameState(state, null).ruleState.fairPlay.incidents).toEqual([]);
    expect(projectGameState(state, alice).ruleState.fairPlay.incidents).toHaveLength(1);
    expect(projectGameState(state, bob).ruleState.fairPlay.incidents).toHaveLength(1);
    expect(state.ruleState.decks[0]?.drawPile).toEqual(["s2"]);
  });
});
