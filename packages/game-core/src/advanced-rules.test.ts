import { describe, expect, it } from "vitest";
import {
  drawCard,
  EMPTY_ADVANCED_RULE_STATE,
  initializeDecks,
  returnHeldCard,
} from "./advanced-rules";
import { type CardCatalogDefinition } from "./cards";
import { CommandValidationError } from "./command";
import { applyGameplayCommand } from "./gameplay";
import { createSeededRandom } from "./random";
import { parseGameState, type GameState } from "./state";
import {
  board,
  alice,
  bob,
  carol,
  EG1,
  EG2,
  MA1,
  MA2,
  MA3,
  FR2,
  POWER_GRID,
  PLUS_FIVE,
  catalog,
  oneCard,
  run,
  ok,
  refused,
  roundTrip,
  started,
  type Setup,
  setup,
  player,
  asset,
  landOn,
  drawFrom,
  bundle,
  propose,
  openTradeId,
} from "./rules.testkit";

describe("RULE-009 deterministic deck and held-card engine", () => {
  const cards = catalog([
    { cardId: "s1", effectId: "plus-one" },
    { cardId: "s2", effectId: "plus-one" },
    { cardId: "s3", effectId: "plus-one" },
    { cardId: "s4", effectId: "plus-one" },
    { cardId: "held", effectId: "plus-one", held: true },
  ]);

  it("shuffles identically for the same seed and replays mid-deck after reconstruction", () => {
    const first = initializeDecks(EMPTY_ADVANCED_RULE_STATE, cards, createSeededRandom(5));
    expect(initializeDecks(EMPTY_ADVANCED_RULE_STATE, cards, createSeededRandom(5))).toEqual(first);
    expect(first.decks[0]?.drawPile).toHaveLength(5);

    const drawSequence = (ruleState: typeof first, seed: number) => {
      const rng = createSeededRandom(seed);
      let current = ruleState;
      const drawn: string[] = [];
      for (let index = 0; index < 9; index += 1) {
        const result = drawCard(current, cards, "surprise", alice, rng);
        drawn.push(result.card.cardId);
        current = result.state;
      }
      return { drawn, current };
    };
    const midDeck = drawCard(first, cards, "surprise", alice, createSeededRandom(1)).state;
    const game = roundTrip(setup({ ruleState: midDeck }, cards), cards);
    expect(drawSequence(game.ruleState, 9)).toEqual(drawSequence(midDeck, 9));
  });

  it("keeps held cards out of circulation and returns them exactly once", () => {
    const ruleState = setup({
      ruleState: {
        decks: [
          { deckId: "surprise", drawPile: ["held", "s1", "s2", "s3", "s4"], discardPile: [] },
          { deckId: "treasure", drawPile: [PLUS_FIVE.cardId], discardPile: [] },
        ],
      },
    }, cards).ruleState;
    let current = drawCard(ruleState, cards, "surprise", alice, createSeededRandom(2)).state;
    expect(current.heldCards).toEqual([
      { cardId: "held", deckId: "surprise", ownerUserId: alice, capability: "DETENTION_RELEASE" },
    ]);
    const later: string[] = [];
    for (let index = 0; index < 12; index += 1) {
      const result = drawCard(current, cards, "surprise", bob, createSeededRandom(index));
      later.push(result.card.cardId);
      current = result.state;
    }
    expect(later).not.toContain("held");
    const returned = returnHeldCard(current, cards, "held", alice);
    expect(returned.heldCards).toEqual([]);
    expect(returned.decks[0]?.discardPile).toContain("held");
    expect(() => returnHeldCard(returned, cards, "held", alice)).toThrow(/not owned/);
  });

  it("reshuffles only the discard pile once the draw pile is empty", () => {
    const ruleState = setup({
      ruleState: {
        decks: [
          { deckId: "surprise", drawPile: ["s1"], discardPile: ["s2", "s3", "s4"] },
          { deckId: "treasure", drawPile: [PLUS_FIVE.cardId], discardPile: [] },
        ],
        heldCards: [{ cardId: "held", deckId: "surprise", ownerUserId: bob, capability: "DETENTION_RELEASE" }],
      },
    }, cards).ruleState;
    const last = drawCard(ruleState, cards, "surprise", alice, createSeededRandom(3));
    expect(last.state.decks[0]).toEqual({ deckId: "surprise", drawPile: [], discardPile: ["s2", "s3", "s4", "s1"] });
    const reshuffled = drawCard(last.state, cards, "surprise", alice, createSeededRandom(3));
    const surprise = reshuffled.state.decks[0]!;
    expect([...surprise.drawPile, ...surprise.discardPile].sort()).toEqual(["s1", "s2", "s3", "s4"]);
    expect(surprise.discardPile).toEqual([reshuffled.card.cardId]);
    expect(reshuffled.state.heldCards).toEqual(ruleState.heldCards);
  });

  it("rejects duplicated, foreign, missing, or catalog-less card state on reconstruction", () => {
    const base = setup({}, cards);
    const decks = (surprise: unknown, treasurePile: readonly string[] = [PLUS_FIVE.cardId]) => ({
      ...base,
      ruleState: {
        ...base.ruleState,
        decks: [surprise, { deckId: "treasure", drawPile: treasurePile, discardPile: [] }],
      },
    });
    const valid = decks({ deckId: "surprise", drawPile: ["s1", "s2", "s3", "s4", "held"], discardPile: [] });
    expect(() => parseGameState(valid, board)).toThrow(/card catalog is required/);
    expect(() => parseGameState(decks({
      deckId: "surprise", drawPile: ["s1", "s2", "s3", "s4", "held"], discardPile: ["s1"],
    }), board, cards)).toThrow(/more than one zone/);
    expect(() => parseGameState({
      ...valid,
      ruleState: {
        ...valid.ruleState,
        heldCards: [{ cardId: "s1", deckId: "surprise", ownerUserId: alice, capability: "DETENTION_RELEASE" }],
      },
    }, board, cards)).toThrow(/more than one zone/);
    expect(() => parseGameState(decks({
      deckId: "surprise", drawPile: ["s1", "s2", "s3", "s4"], discardPile: [],
    }), board, cards)).toThrow(/conservation/);
    expect(() => parseGameState(decks({
      deckId: "surprise", drawPile: ["s1", "s2", "s3", "s4", "held", PLUS_FIVE.cardId], discardPile: [],
    }, []), board, cards)).toThrow(/another deck/);
  });

  it("initializes decks lazily from injected RNG and routes held draws to their owner", () => {
    const withHeld = catalog([
      { cardId: "keep", effectId: "plus-one", held: true },
      { cardId: "s1", effectId: "plus-one" },
    ]);
    const lazy = ok(drawFrom(landOn(3, {}, withHeld), withHeld));
    expect(lazy.ruleState.decks.map((deck) => deck.deckId)).toEqual(["surprise", "treasure"]);
    roundTrip(lazy, withHeld);

    const landed = landOn(3, {
      ruleState: {
        decks: [
          { deckId: "surprise", drawPile: ["keep", "s1"], discardPile: [] },
          { deckId: "treasure", drawPile: [PLUS_FIVE.cardId], discardPile: [] },
        ],
      },
    }, withHeld);
    const result = drawFrom(landed, withHeld);
    const next = ok(result);
    expect(result).toMatchObject({
      event: { type: "CARD_RESOLVED", drawnCardIds: ["keep"], outcome: "COMPLETED" },
    });
    expect(player(next, alice).cash).toBe(player(landed, alice).cash);
    expect(next.ruleState.heldCards.map((card) => card.ownerUserId)).toEqual([alice]);
    expect(next.pendingResolution).toBeNull();
    roundTrip(next, withHeld);
  });

  it("requires every deck to keep a drawable card even when all others are held", () => {
    expect(() => catalog([{ cardId: "keep", effectId: "plus-one", held: true }]))
      .toThrow(/cannot be held/);
  });
});

describe("RULE-010 closed effect execution with a shared 16-step budget", () => {
  const chain = catalog([{ cardId: "s-chain", effectId: "chain" }], [
    { effectId: "draw-treasure", type: "DRAW_CARD", deckId: "treasure" },
    { effectId: "chain", type: "SEQUENCE", effectIds: ["plus-ten", "draw-treasure"] },
  ]);

  it("executes nested sequences and draws deterministically in one committed transition", () => {
    const landed = landOn(3, {}, chain);
    const first = drawFrom(landed, chain);
    expect(first).toMatchObject({
      kind: "ACCEPTED",
      event: { drawnCardIds: ["s-chain", PLUS_FIVE.cardId], outcome: "COMPLETED" },
    });
    const next = ok(first);
    expect(player(next, alice).cash).toBe(player(landed, alice).cash + 15);
    expect(next.gameVersion).toBe(landed.gameVersion + 1);
    expect(ok(drawFrom(landed, chain))).toEqual(next);
  });

  const sequenceOf = (steps: number) => catalog([{ cardId: "s-long", effectId: "long" }], [
    { effectId: "long", type: "SEQUENCE", effectIds: Array.from({ length: steps }, () => "plus-one") },
  ]);

  it("accepts exactly 16 steps and rejects the 17th atomically with a diagnostic", () => {
    // DRAW frame + SEQUENCE + 14 children = 16 steps.
    const exact = sequenceOf(14);
    const landedExact = landOn(3, {}, exact);
    expect(player(ok(drawFrom(landedExact, exact)), alice).cash).toBe(player(landedExact, alice).cash + 14);

    const over = sequenceOf(15);
    const landed = landOn(3, {}, over);
    const result = drawFrom(landed, over);
    refused(result, "EFFECT_CHAIN_FAILED", landed);
    expect(result).toMatchObject({
      diagnostic: {
        code: "EFFECT_STEP_LIMIT",
        executedSteps: 16,
        maximumSteps: 16,
        failedFrame: { type: "EFFECT", effectId: "plus-one" },
      },
    });
    expect(landed.ruleState.decks).toEqual([]);
  });

  it("breaks a dynamic draw cycle that static validation cannot see", () => {
    const cycle = catalog([
      { cardId: "loop-a", effectId: "draw-a" },
      { cardId: "loop-b", effectId: "draw-b" },
    ], [
      { effectId: "draw-a", type: "DRAW_CARD", deckId: "surprise" },
      { effectId: "draw-b", type: "DRAW_CARD", deckId: "surprise" },
    ]);
    const landed = landOn(3, {}, cycle);
    const result = drawFrom(landed, cycle);
    refused(result, "EFFECT_CHAIN_FAILED", landed);
    expect(result).toMatchObject({ diagnostic: { code: "EFFECT_STEP_LIMIT", executedSteps: 16 } });
  });

  const chargeThen = (followUps: number) => catalog([{ cardId: "s-charge", effectId: "charge-then" }], [
    { effectId: "charge-500", type: "ADJUST_CASH", target: "CURRENT_PLAYER", amount: -500 },
    {
      effectId: "charge-then",
      type: "SEQUENCE",
      effectIds: ["charge-500", ...Array.from({ length: followUps }, () => "plus-one")],
    },
  ]);

  it("suspends on a shortfall with a persisted continuation and resumes after exact settlement", () => {
    const cards = chargeThen(1);
    const landed = landOn(3, { cash: { [alice]: 450 }, owners: { [FR2]: alice } }, cards);
    const suspended = ok(drawFrom(landed, cards));
    expect(suspended.pendingResolution).toMatchObject({
      kind: "DEBT",
      source: { type: "EFFECT", effectId: "charge-500", originTileIndex: 3 },
      continuation: { type: "RESUME_EFFECT", effectId: "charge-500" },
      obligation: { debtorUserId: alice, creditor: { type: "BANK" }, amount: 500 },
    });
    expect(suspended.ruleState.effectContinuation).toMatchObject({
      remainingSteps: 13,
      frames: [{ type: "EFFECT", effectId: "plus-one" }],
      roll: landed.pendingResolution?.roll,
    });
    expect(suspended.ruleState.debt).toEqual({
      resolutionId: suspended.pendingResolution?.resolutionId, deadlineAt: 3000,
    });
    expect(player(suspended, alice).cash).toBe(450);
    const restored = roundTrip(suspended, cards);

    for (const type of ["ROLL_DICE", "END_TURN"]) {
      refused(run(restored, type, alice, {}, { cards }), "PENDING_RESOLUTION", restored);
    }
    const settled = run(restored, "MORTGAGE", alice, { assetId: FR2 }, { cards });
    expect(settled).toMatchObject({ event: { type: "ASSET_MORTGAGED", debtSettled: true } });
    const next = ok(settled);
    expect(player(next, alice).cash).toBe(450 + 200 - 500 + 1);
    expect(next.pendingResolution).toBeNull();
    expect(next.ruleState.effectContinuation).toBeNull();
    expect(next.ruleState.debt).toBeNull();
  });

  it("rejects tampered persisted continuations and wrong or repeated draws", () => {
    const cards = chargeThen(1);
    const suspended = ok(drawFrom(landOn(3, { cash: { [alice]: 450 } }, cards), cards));
    const continuation = suspended.ruleState.effectContinuation!;
    const tampered = (changes: Record<string, unknown>) => ({
      ...suspended,
      ruleState: { ...suspended.ruleState, effectContinuation: { ...continuation, ...changes } },
    });
    expect(() => parseGameState(tampered({ remainingSteps: 17 }), board, cards)).toThrow(/shared budget/);
    expect(() => parseGameState(tampered({ frames: [{ type: "EFFECT", effectId: "rm -rf" }] }), board, cards))
      .toThrow(/unknown effect/);
    expect(() => parseGameState(tampered({ frames: [{ type: "CODE", source: "x" }] }), board, cards))
      .toThrow(/unknown effect frame/);
    expect(() => parseGameState(tampered({ resolutionId: "other" }), board, cards)).toThrow(/pending effect/);
    expect(() => parseGameState(tampered({
      roll: { ...continuation.roll, consecutiveDoubles: 2 },
    }), board, cards)).toThrow(/roll/);

    const cardsOnce = catalog([{ cardId: "s1", effectId: "plus-one" }]);
    const landed = landOn(3, {}, cardsOnce);
    const payload = { resolutionId: landed.pendingResolution?.resolutionId };
    refused(run(landed, "DRAW_CARD", bob, payload, { cards: cardsOnce }), "RESOLUTION_NOT_PENDING", landed);
    const drawn = ok(run(landed, "DRAW_CARD", alice, payload, { cards: cardsOnce }));
    refused(run(drawn, "DRAW_CARD", alice, payload, { cards: cardsOnce }), "RESOLUTION_NOT_PENDING", drawn);
  });

  it("carries the remaining budget across suspension so resuming cannot reset it", () => {
    // DRAW + SEQUENCE + charge = 3 steps before suspending; 13 remain.
    const fits = chargeThen(13);
    const setupFor = (cards: CardCatalogDefinition) =>
      ok(drawFrom(landOn(3, { cash: { [alice]: 450 }, owners: { [FR2]: alice } }, cards), cards));
    const fitting = setupFor(fits);
    expect(player(ok(run(fitting, "MORTGAGE", alice, { assetId: FR2 }, { cards: fits })), alice).cash)
      .toBe(450 + 200 - 500 + 13);

    const tooLong = chargeThen(14);
    const suspended = setupFor(tooLong);
    const result = run(suspended, "MORTGAGE", alice, { assetId: FR2 }, { cards: tooLong });
    refused(result, "EFFECT_CHAIN_FAILED", suspended);
    expect(result).toMatchObject({ diagnostic: { code: "EFFECT_STEP_LIMIT", executedSteps: 16 } });
  });

  const mover = (effect: Record<string, unknown>) => oneCard("move", [{ effectId: "move", ...effect }]);

  it("resolves card movement exactly like a dice landing", () => {
    const toCairo = mover({ type: "MOVE_TO_TILE", tileIndex: 1, collectStart: true });
    const landed = landOn(3, {}, toCairo);
    const buying = ok(drawFrom(landed, toCairo));
    expect(player(buying, alice)).toMatchObject({ position: 1, cash: player(landed, alice).cash + 200 });
    expect(buying.pendingResolution).toMatchObject({
      kind: "BUY_DECISION", source: { type: "TILE", tileIndex: 1 }, roll: landed.pendingResolution?.roll,
    });
    const bought = ok(run(buying, "BUY_PROPERTY", alice, {
      resolutionId: buying.pendingResolution?.resolutionId,
    }, { cards: toCairo }));
    expect(asset(bought, EG1).ownerUserId).toBe(alice);

    const rentLanded = landOn(3, { owners: { [EG1]: bob } }, toCairo);
    const rented = ok(drawFrom(rentLanded, toCairo));
    expect(player(rented, bob).cash).toBe(player(rentLanded, bob).cash + 6);
    expect(player(rented, alice).cash).toBe(player(rentLanded, alice).cash + 200 - 6);

    const toGrid = mover({ type: "MOVE_TO_TILE", tileIndex: 4, collectStart: false });
    const gridLanded = landOn(3, { owners: { [POWER_GRID]: bob } }, toGrid);
    expect(player(ok(drawFrom(gridLanded, toGrid)), bob).cash).toBe(player(gridLanded, bob).cash + 3 * 4);

    const back = mover({ type: "MOVE_BY", offset: -3 });
    const backLanded = landOn(3, {}, back);
    const atStart = ok(drawFrom(backLanded, back));
    expect(player(atStart, alice)).toMatchObject({ position: 0, cash: player(backLanded, alice).cash });
    expect(atStart.pendingResolution).toBeNull();
  });

  it("draws in-chain when card movement lands on another card tile", () => {
    const toTreasure = mover({ type: "MOVE_BY", offset: 6 });
    const landed = landOn(3, {}, toTreasure);
    const result = drawFrom(landed, toTreasure);
    expect(result).toMatchObject({ event: { drawnCardIds: ["surprise:only", PLUS_FIVE.cardId] } });
    expect(player(ok(result), alice)).toMatchObject({ position: 9, cash: player(landed, alice).cash + 5 });
  });

  it("sends card movement onto GO TO HOLDING, or ENTER_DETENTION, into Holding without salary", () => {
    for (const cards of [
      mover({ type: "MOVE_TO_TILE", tileIndex: 30, collectStart: false }),
      oneCard("detain", [{ effectId: "detain", type: "ENTER_DETENTION" }]),
    ]) {
      // Arrive on the Surprise tile with a double so the turn would otherwise continue.
      const landed = ok(run(setup({ positions: { [alice]: 1 } }, cards), "ROLL_DICE", alice, {}, {
        cards, dice: [1, 1],
      }));
      expect(landed.turn?.rollAgain).toBe(true);
      const held = ok(drawFrom(landed, cards));
      expect(player(held, alice)).toMatchObject({
        position: 10, inHolding: true, holdingAttempts: 0, cash: player(landed, alice).cash,
      });
      expect(held.turn).toMatchObject({ rollAgain: false, consecutiveDoubles: 0 });
      ok(run(held, "END_TURN", alice, {}, { cards }));
    }
  });

  it("rejects catalogs whose effects could not settle or resolve deterministically", () => {
    expect(() => oneCard("fine", [
      { effectId: "fine", type: "ADJUST_CASH", target: "EACH_OTHER_PLAYER", amount: -50 },
    ])).toThrow(/only the current player/);
    for (const first of ["walk", "draw"]) {
      expect(() => oneCard("seq", [
        { effectId: "walk", type: "MOVE_BY", offset: 2 },
        { effectId: "draw", type: "DRAW_CARD", deckId: "treasure" },
        { effectId: "seq", type: "SEQUENCE", effectIds: [first, "plus-one"] },
      ])).toThrow(/must end their sequence/);
    }
    expect(() => oneCard("outer", [
      { effectId: "walk", type: "MOVE_BY", offset: 2 },
      { effectId: "inner", type: "SEQUENCE", effectIds: ["plus-one", "walk"] },
      { effectId: "outer", type: "SEQUENCE", effectIds: ["inner", "plus-one"] },
    ])).toThrow(/must end their sequence/);
  });

  it("pays each other player from the bank and never charges them", () => {
    const gift = oneCard("gift", [
      { effectId: "gift", type: "ADJUST_CASH", target: "EACH_OTHER_PLAYER", amount: 25 },
    ]);
    const landed = landOn(3, {}, gift);
    const next = ok(drawFrom(landed, gift));
    expect([alice, bob, carol].map((userId) => player(next, userId).cash - player(landed, userId).cash))
      .toEqual([0, 25, 25]);
  });

  it("refuses to draw without an authoritative catalog", () => {
    const landed = landOn(3);
    refused(drawFrom(landed), "CARD_CATALOG_UNAVAILABLE", landed);
  });
});

describe("RULE-013 Holding", () => {
  it("enters from GO TO HOLDING, clears doubles, and treats the Holding tile as visiting", () => {
    const state = setup({ positions: { [alice]: 28 } });
    const result = run(state, "ROLL_DICE", alice, {}, { dice: [1, 1] });
    expect(result).toMatchObject({ event: { holding: "ENTERED", resolution: { tileIndex: 30 } } });
    const held = ok(result);
    expect(player(held, alice)).toMatchObject({ position: 10, inHolding: true, cash: player(state, alice).cash });
    expect(held.turn).toMatchObject({ rollAgain: false, consecutiveDoubles: 0 });
    ok(run(held, "END_TURN", alice));
    roundTrip(held);

    const visiting = landOn(10);
    expect(player(visiting, alice)).toMatchObject({ position: 10, inHolding: false });
  });

  it("releases for the canonical $50 before rolling, then rolls and moves normally", () => {
    const held = setup({ holding: 0 });
    for (const [state, actor, reason] of [
      [setup(), alice, "NOT_IN_HOLDING"],
      [setup({ holding: 0, cash: { [alice]: 49 } }), alice, "INSUFFICIENT_FUNDS"],
      [held, bob, "NOT_YOUR_TURN"],
    ] as const) {
      refused(run(state, "PAY_HOLDING_FEE", actor), reason, state);
    }
    const paid = run(held, "PAY_HOLDING_FEE", alice);
    expect(paid).toMatchObject({ event: { type: "HOLDING_RELEASED", method: "FEE", cardId: null } });
    const released = ok(paid);
    expect(player(released, alice)).toMatchObject({
      inHolding: false, holdingAttempts: 0, cash: player(held, alice).cash - 50,
    });
    const rolled = ok(run(released, "ROLL_DICE", alice, {}, { dice: [2, 2] }));
    expect(player(rolled, alice).position).toBe(14);
    expect(rolled.turn).toMatchObject({ rollAgain: true, rollFromHolding: false });

    const afterAttempt = ok(run(held, "ROLL_DICE", alice, {}, { dice: [1, 2] }));
    refused(run(afterAttempt, "PAY_HOLDING_FEE", alice), "ROLL_ALREADY_COMPLETED", afterAttempt);
  });

  it("counts failed attempts and releases on doubles without an extra roll", () => {
    const held = setup({ holding: 0 });
    const failed = run(held, "ROLL_DICE", alice, {}, { dice: [1, 2] });
    expect(failed).toMatchObject({ event: { holding: "ATTEMPT_FAILED", movement: null } });
    const waiting = ok(failed);
    expect(player(waiting, alice)).toMatchObject({ position: 10, inHolding: true, holdingAttempts: 1 });
    expect(waiting.turn).toMatchObject({ hasRolled: true, rollAgain: false, rollFromHolding: true });
    refused(run(waiting, "ROLL_DICE", alice, {}, { dice: [3, 3] }), "ROLL_ALREADY_COMPLETED", waiting);
    ok(run(waiting, "END_TURN", alice));

    const doubles = run(setup({ holding: 1 }), "ROLL_DICE", alice, {}, { dice: [3, 3] });
    expect(doubles).toMatchObject({ event: { holding: "RELEASED", roll: { doubles: true } } });
    const free = roundTrip(ok(doubles));
    expect(player(free, alice)).toMatchObject({ position: 16, inHolding: false, holdingAttempts: 0 });
    expect(free.turn).toMatchObject({ rollAgain: false, consecutiveDoubles: 0, rollFromHolding: true });
    expect(free.pendingResolution).toMatchObject({ kind: "BUY_DECISION", continuation: { type: "END_TURN" } });
    const bought = ok(run(free, "BUY_PROPERTY", alice, { resolutionId: free.pendingResolution?.resolutionId }));
    refused(run(bought, "ROLL_DICE", alice), "ROLL_ALREADY_COMPLETED", bought);
    ok(run(bought, "END_TURN", alice));
  });

  it("forces the fee on the third failed attempt and moves by that roll", () => {
    const held = setup({ holding: 2, cash: { [alice]: 500 } });
    const result = run(held, "ROLL_DICE", alice, {}, { dice: [1, 2] });
    expect(result).toMatchObject({ event: { holding: "RELEASED", movement: { from: 10, to: 13 } } });
    expect(player(ok(result), alice)).toMatchObject({ position: 13, inHolding: false, cash: 450 });
  });

  it("turns an unaffordable forced fee into a bank obligation that releases on settlement", () => {
    const held = setup({ holding: 2, cash: { [alice]: 20 }, owners: { [FR2]: alice } });
    const due = run(held, "ROLL_DICE", alice, {}, { dice: [1, 2] });
    expect(due).toMatchObject({ event: { holding: "FEE_DUE", movement: null } });
    const owing = roundTrip(ok(due));
    expect(owing.pendingResolution).toMatchObject({
      kind: "DETENTION_FEE",
      source: { type: "TILE", tileIndex: 10 },
      roll: { total: 3 },
      obligation: { creditor: { type: "BANK" }, amount: 50 },
    });
    expect(player(owing, alice)).toMatchObject({ position: 10, inHolding: true, cash: 20 });
    refused(run(owing, "ROLL_DICE", alice), "PENDING_RESOLUTION", owing);
    refused(run(owing, "PAY_HOLDING_FEE", alice), "PENDING_RESOLUTION", owing);

    const settled = ok(run(owing, "MORTGAGE", alice, { assetId: FR2 }));
    expect(player(settled, alice)).toMatchObject({ position: 13, inHolding: false, cash: 20 + 200 - 50 });
    expect(settled.pendingResolution).toMatchObject({ kind: "BUY_DECISION", source: { tileIndex: 13 } });
    expect(settled.ruleState.debt).toBeNull();
  });

  it("consumes a held release card exactly once, returning it to its deck", () => {
    const cards = catalog([
      { cardId: "pass", effectId: "plus-one", held: true },
      { cardId: "s1", effectId: "plus-one" },
    ]);
    const held = setup({
      holding: 1,
      ruleState: {
        decks: [
          { deckId: "surprise", drawPile: ["s1"], discardPile: [] },
          { deckId: "treasure", drawPile: [PLUS_FIVE.cardId], discardPile: [] },
        ],
        heldCards: [{ cardId: "pass", deckId: "surprise", ownerUserId: alice, capability: "DETENTION_RELEASE" }],
      },
    }, cards);
    refused(run(held, "USE_RELEASE_CARD", alice, { cardId: "s1" }, { cards }), "HELD_CARD_NOT_OWNED", held);
    const used = run(held, "USE_RELEASE_CARD", alice, { cardId: "pass" }, { cards });
    expect(used).toMatchObject({ event: { type: "HOLDING_RELEASED", method: "CARD", cardId: "pass" } });
    const released = roundTrip(ok(used), cards);
    expect(player(released, alice)).toMatchObject({ inHolding: false, cash: player(held, alice).cash });
    expect(released.ruleState.heldCards).toEqual([]);
    expect(released.ruleState.decks[0]?.discardPile).toEqual(["pass"]);
    refused(run(released, "USE_RELEASE_CARD", alice, { cardId: "pass" }, { cards }), "NOT_IN_HOLDING", released);
  });

  it("still collects rent while held", () => {
    const state = setup({
      holding: 0,
      owners: { [EG1]: alice },
      positions: { [bob]: 38 },
      turn: { activePlayerId: bob },
    });
    const rented = ok(run(state, "ROLL_DICE", bob, {}, { dice: [1, 2] }));
    expect(player(rented, alice).cash).toBe(player(state, alice).cash + 6);
  });
});

describe("RULE-014 trade lifecycle", () => {
  const tradeReady = () => setup({ owners: { [EG1]: alice, [MA1]: bob }, mortgaged: [EG1] });

  it("settles an accepted trade atomically and records neutral facts", () => {
    const state = tradeReady();
    const proposed = ok(propose(state, alice, bob, bundle(50, [EG1]), bundle(0, [MA1])));
    const tradeId = openTradeId(proposed);
    expect(tradeId).toBe("trade-" + proposed.gameVersion);
    roundTrip(proposed);

    const acceptance = run(proposed, "ACCEPT_TRADE", bob, { tradeId }, { actionId: "accept-once" });
    const settled = ok(acceptance);
    expect(player(settled, alice).cash).toBe(player(state, alice).cash - 50);
    expect(player(settled, bob).cash).toBe(player(state, bob).cash + 50);
    expect(asset(settled, EG1)).toMatchObject({ ownerUserId: bob, mortgaged: true });
    expect(asset(settled, MA1).ownerUserId).toBe(alice);
    expect(settled.ruleState.trades).toEqual([]);
    expect(settled.ruleState.tradeFacts.map((fact) => fact.type)).toEqual(["PROPOSED", "ACCEPTED"]);
    expect(Object.keys(settled.ruleState.tradeFacts[1]!).sort()).toEqual([
      "actionId", "actorUserId", "gameVersion", "liquidationFor", "offered", "parentTradeId",
      "proposerUserId", "recipientUserId", "requested", "tradeId", "type",
    ]);

    refused(run(settled, "ACCEPT_TRADE", bob, { tradeId }), "TRADE_NOT_OPEN", settled);
    const replay = applyGameplayCommand(
      settled,
      { type: "ACCEPT_TRADE", gameId: settled.gameId, actionId: "accept-once", payload: { tradeId } },
      {
        actorUserId: bob,
        board,
        rng: () => 0,
        appliedActions: [{ gameId: settled.gameId, actionId: "accept-once", resultingGameVersion: settled.gameVersion }],
      },
    );
    expect(replay).toMatchObject({ kind: "DUPLICATE_ACTION", committedGameVersion: settled.gameVersion });
  });

  it("revalidates at acceptance against current state, never proposal-time state", () => {
    const proposed = ok(propose(tradeReady(), alice, bob, bundle(50, [EG1]), bundle(0, [MA1])));
    const tradeId = openTradeId(proposed);
    const stale = (input: Setup, reason: string) => {
      const changed = setup(input, undefined, proposed);
      refused(run(changed, "ACCEPT_TRADE", bob, { tradeId }), reason, changed);
    };
    stale({ cash: { [alice]: 49 } }, "INSUFFICIENT_FUNDS");
    stale({ owners: { [EG1]: carol } }, "ASSET_NOT_OWNED");
    stale({ owners: { [MA1]: carol } }, "ASSET_NOT_OWNED");
    stale({ owners: { [MA2]: bob, [MA3]: bob }, development: { [MA1]: 1 } }, "SET_HAS_DEVELOPMENT");
    refused(run(proposed, "ACCEPT_TRADE", alice, { tradeId }), "NOT_TRADE_PARTICIPANT", proposed);
    refused(run(proposed, "ACCEPT_TRADE", carol, { tradeId }), "NOT_TRADE_PARTICIPANT", proposed);

    const onProperty = setup({ positions: { [alice]: 8 } }, undefined, proposed);
    const decline = ok(run(onProperty, "ROLL_DICE", alice, {}, { dice: [1, 2] }));
    const auction = ok(run(decline, "DECLINE_PROPERTY", alice, {
      resolutionId: decline.pendingResolution?.resolutionId,
    }));
    refused(run(auction, "ACCEPT_TRADE", bob, { tradeId }), "TRADE_BLOCKED_DURING_AUCTION", auction);
    refused(
      propose(auction, bob, carol, bundle(1), bundle(0)), "TRADE_BLOCKED_DURING_AUCTION", auction,
    );
  });

  it("rejects malformed, empty, and illegal proposals without mutation", () => {
    const state = tradeReady();
    for (const offered of [
      { cash: -1, assetIds: [] },
      { cash: 1.5, assetIds: [] },
      { cash: 0, assetIds: [EG1, EG1] },
      { cash: 0, assetIds: [], cardIds: [] },
    ]) {
      expect(() => propose(state, alice, bob, offered, bundle(0))).toThrow(CommandValidationError);
    }
    expect(() => propose(state, alice, bob, bundle(0, [EG1]), bundle(0, [EG1])))
      .toThrow(CommandValidationError);
    refused(propose(state, alice, bob, bundle(0), bundle(0)), "EMPTY_TRADE", state);
    refused(propose(state, alice, alice, bundle(1), bundle(0)), "INVALID_TRADE_PARTNER", state);
    refused(propose(state, alice, "google:stranger", bundle(1), bundle(0)), "INVALID_TRADE_PARTNER", state);
    refused(propose(state, alice, bob, bundle(0, [MA1]), bundle(0)), "ASSET_NOT_OWNED", state);
    refused(propose(state, alice, bob, bundle(5000), bundle(0)), "INSUFFICIENT_FUNDS", state);
    const developed = setup({ owners: { [EG1]: alice, [EG2]: alice }, development: { [EG2]: 1 } });
    refused(propose(developed, alice, bob, bundle(0, [EG1]), bundle(10)), "SET_HAS_DEVELOPMENT", developed);

    const rentDebt = landOn(6, { cash: { [alice]: 1 }, owners: { [MA1]: bob } });
    expect(rentDebt.pendingResolution?.kind).toBe("DEBT");
    refused(
      propose(rentDebt, bob, carol, bundle(0, [MA1]), bundle(10)), "ASSET_IN_PENDING_RESOLUTION", rentDebt,
    );
  });

  it("supports counter, reject, and cancel with the correct actor only", () => {
    const state = tradeReady();
    const proposed = ok(propose(state, alice, bob, bundle(10), bundle(0, [MA1])));
    const originalId = openTradeId(proposed);
    const counterPayload = { tradeId: originalId, offered: bundle(0, [MA1]), requested: bundle(40) };
    refused(run(proposed, "COUNTER_TRADE", alice, counterPayload), "NOT_TRADE_PARTICIPANT", proposed);
    const countered = ok(run(proposed, "COUNTER_TRADE", bob, counterPayload));
    expect(countered.ruleState.trades).toEqual([expect.objectContaining({
      parentTradeId: originalId, proposerUserId: bob, recipientUserId: alice,
      offered: bundle(0, [MA1]), requested: bundle(40),
    })]);
    const counterId = openTradeId(countered);
    refused(run(countered, "ACCEPT_TRADE", bob, { tradeId: originalId }), "TRADE_NOT_OPEN", countered);
    refused(run(countered, "REJECT_TRADE", bob, { tradeId: counterId }), "NOT_TRADE_PARTICIPANT", countered);
    const rejectedTrade = ok(run(countered, "REJECT_TRADE", alice, { tradeId: counterId }));

    const again = ok(propose(rejectedTrade, alice, carol, bundle(5), bundle(0)));
    const againId = openTradeId(again);
    refused(run(again, "CANCEL_TRADE", carol, { tradeId: againId }), "NOT_TRADE_PARTICIPANT", again);
    const cancelled = ok(run(again, "CANCEL_TRADE", alice, { tradeId: againId }));
    expect(cancelled.ruleState.trades).toEqual([]);
    expect(cancelled.ruleState.tradeFacts.map((fact) => fact.type))
      .toEqual(["PROPOSED", "COUNTERED", "REJECTED", "PROPOSED", "CANCELLED"]);
    expect(player(cancelled, alice).cash).toBe(player(state, alice).cash);
    roundTrip(cancelled);
  });

  it("applies the ordinary trade rules unchanged in TEAMS mode", () => {
    const teams = setup({ owners: { [EG1]: alice, [MA1]: bob } }, undefined, started("TEAMS"));
    refused(propose(teams, alice, bob, bundle(0, [MA1]), bundle(0)), "ASSET_NOT_OWNED", teams);
    const proposed = ok(propose(teams, alice, bob, bundle(0, [EG1]), bundle(0, [MA1])));
    const settled = ok(run(proposed, "ACCEPT_TRADE", bob, { tradeId: openTradeId(proposed) }));
    expect(asset(settled, EG1).ownerUserId).toBe(bob);
  });
});

describe("RULE-015 debt and liquidation", () => {
  const taxDebt = (input: Setup = {}) => landOn(14, { cash: { [alice]: 50 }, ...input });

  it("records player and bank creditors with the runtime deadline and blocks unrelated actions", () => {
    const rentDebt = roundTrip(landOn(6, { cash: { [alice]: 1 }, owners: { [MA1]: bob } }));
    expect(rentDebt.pendingResolution?.obligation).toMatchObject({
      debtorUserId: alice, creditor: { type: "PLAYER", userId: bob }, amount: 10,
    });
    expect(rentDebt.ruleState.debt).toMatchObject({ deadlineAt: 3000 });

    const owing = taxDebt({ owners: { [EG1]: alice }, mortgaged: [EG1] });
    expect(owing.pendingResolution?.obligation).toMatchObject({ creditor: { type: "BANK" }, amount: 100 });
    for (const [type, payload] of [
      ["ROLL_DICE", {}], ["END_TURN", {}], ["BUILD", { assetId: EG1 }], ["UNMORTGAGE", { assetId: EG1 }],
    ] as const) {
      refused(run(owing, type, alice, payload), "PENDING_RESOLUTION", owing);
    }
    refused(run(owing, "MORTGAGE", bob, { assetId: EG1 }), "NOT_YOUR_TURN", owing);

    const noDeadline = setup({ positions: { [alice]: 11 }, cash: { [alice]: 50 } });
    const faces = [0.001, 1 / 6 + 0.001];
    expect(() => applyGameplayCommand(
      noDeadline,
      { type: "ROLL_DICE", gameId: noDeadline.gameId, actionId: "no-deadline", payload: {} },
      { actorUserId: alice, board, rng: () => faces.shift() ?? 0 },
    )).toThrow(/debtDeadlineAt/);
  });

  it("allows only legal liquidation and settles exactly once funds suffice", () => {
    const owing = taxDebt({
      owners: { [EG1]: alice, [MA1]: alice, [MA2]: alice, [MA3]: alice },
      development: { [MA1]: 1, [MA2]: 2, [MA3]: 1 },
    });
    refused(run(owing, "MORTGAGE", alice, { assetId: MA1 }), "SET_HAS_DEVELOPMENT", owing);
    refused(run(owing, "SELL_DEVELOPMENT", alice, { assetId: MA1 }), "UNEVEN_SALE", owing);
    refused(run(owing, "SELL_DEVELOPMENT", alice, { assetId: EG1 }), "ASSET_NOT_DEVELOPABLE", owing);

    const partial = run(owing, "MORTGAGE", alice, { assetId: EG1 });
    expect(partial).toMatchObject({ event: { debtSettled: false } });
    const stillOwing = ok(partial);
    expect(player(stillOwing, alice).cash).toBe(80);
    expect(stillOwing.ruleState.debt).toEqual(owing.ruleState.debt);

    const sale = run(stillOwing, "SELL_DEVELOPMENT", alice, { assetId: MA2 });
    expect(sale).toMatchObject({ event: { type: "DEVELOPMENT_SOLD", level: 1, amount: 35, debtSettled: true } });
    const settled = ok(sale);
    expect(player(settled, alice).cash).toBe(80 + 35 - 100);
    expect(asset(settled, MA2)).toMatchObject({ developmentLevel: 1 });
    expect(settled.pendingResolution).toBeNull();
    expect(settled.ruleState.debt).toBeNull();
    ok(run(settled, "END_TURN", alice));

    const rentDebt = landOn(6, { cash: { [alice]: 1 }, owners: { [MA1]: bob, [FR2]: alice } });
    const paid = ok(run(rentDebt, "MORTGAGE", alice, { assetId: FR2 }));
    expect(player(paid, bob).cash).toBe(player(rentDebt, bob).cash + 10);
    expect(player(paid, alice).cash).toBe(1 + 200 - 10);
  });

  it("allows the debtor only explicit liquidation trades created during the debt", () => {
    const base = setup({ owners: { [EG1]: alice, [MA1]: carol } });
    const early = ok(propose(base, alice, bob, bundle(0, [EG1]), bundle(200)));
    const earlyId = openTradeId(early);
    const owing = ok(run(
      setup({ positions: { [alice]: 11 }, cash: { [alice]: 50 } }, undefined, early),
      "ROLL_DICE", alice, {}, { dice: [1, 2] },
    ));
    const resolutionId = owing.pendingResolution?.resolutionId;
    refused(run(owing, "ACCEPT_TRADE", bob, { tradeId: earlyId }), "DEBT_BLOCKED", owing);

    const sideTrade = ok(propose(owing, carol, bob, bundle(0, [MA1]), bundle(1)));
    ok(run(sideTrade, "ACCEPT_TRADE", bob, { tradeId: openTradeId(sideTrade) }));

    const liquidation = ok(propose(owing, alice, bob, bundle(0, [EG1]), bundle(200)));
    const trade = liquidation.ruleState.trades.at(-1);
    expect(trade?.liquidationFor).toBe(resolutionId);
    const accepted = run(liquidation, "ACCEPT_TRADE", bob, { tradeId: trade!.tradeId });
    expect(accepted).toMatchObject({ event: { type: "TRADE_UPDATED", debtSettled: true } });
    const settled = ok(accepted);
    expect(player(settled, alice).cash).toBe(50 + 200 - 100);
    expect(asset(settled, EG1).ownerUserId).toBe(bob);
    expect(settled.ruleState.tradeFacts.at(-1)).toMatchObject({ type: "ACCEPTED", liquidationFor: resolutionId });
    expect(settled.pendingResolution).toBeNull();
  });

  it("expires only at the persisted deadline, which forces bankruptcy", () => {
    const owing = taxDebt({ owners: { [EG1]: alice } });
    const resolutionId = owing.pendingResolution!.resolutionId;
    const timeout = (state: GameState, payload: Record<string, unknown>, currentTime: number) =>
      run(state, "DEBT_TIMEOUT", bob, payload, { extra: { currentTime } });
    refused(timeout(owing, { resolutionId, deadlineAt: 3000 }, 2999), "DEBT_DEADLINE_NOT_EXPIRED", owing);
    refused(timeout(owing, { resolutionId, deadlineAt: 2500 }, 3000), "STALE_DEBT_TIMEOUT", owing);
    refused(timeout(owing, { resolutionId: "stale", deadlineAt: 3000 }, 3000), "DEBT_NOT_ACTIVE", owing);

    const forced = timeout(owing, { resolutionId, deadlineAt: 3000 }, 3000);
    expect(forced).toMatchObject({
      event: { type: "PLAYER_BANKRUPT", fact: { userId: alice, reason: "DEADLINE", creditor: { type: "BANK" } } },
    });
    const after = roundTrip(ok(forced));
    expect(player(after, alice)).toMatchObject({ status: "BANKRUPT", cash: 0 });
    refused(timeout(after, { resolutionId, deadlineAt: 3000 }, 4000), "DEBT_NOT_ACTIVE", after);
  });
});
