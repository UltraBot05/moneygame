import { describe, expect, it } from "vitest";
import { CANONICAL_BOARDS, canonicalBoard } from "./catalog";
import { applyGameplayCommand, type GameplayCommandResult } from "./gameplay";
import { createSeededRandom } from "./random";
import { createInitialGameState, parseGameState, type GameState } from "./state";

const alice = "google:alice";
const bob = "google:bob";
const carol = "google:carol";
const STANDARD = "world-tour-standard@1";
const GRAND = "world-tour-grand@1";

function tileOfDeck(ref: string, deck: "surprise" | "treasure"): number {
  const tile = canonicalBoard(ref).board.economyProfile.tiles.find((candidate) =>
    candidate.type === "card" && candidate.deck === deck
  );
  if (tile === undefined) throw new Error("board has no " + deck + " tile");
  return tile.index;
}

let actionCounter = 0;

function run(
  state: GameState,
  ref: string,
  type: string,
  actorUserId: string,
  payload: unknown = {},
  dice: readonly number[] = [],
): GameplayCommandResult {
  const { board, cards } = canonicalBoard(ref);
  const faces = dice.map((face) => (face - 1) / 6 + 0.001);
  const seeded = createSeededRandom(11);
  actionCounter += 1;
  return applyGameplayCommand(
    state,
    { type, gameId: state.gameId, actionId: "canon-" + actionCounter, expectedGameVersion: state.gameVersion, payload },
    {
      actorUserId,
      board,
      rng: () => faces.length > 0 ? faces.shift() as number : seeded(),
      currentTime: 1000,
      auctionDecisionDeadlineAt: 2000,
      debtDeadlineAt: 3000,
      cardCatalog: cards,
    },
  );
}

function ok(result: GameplayCommandResult): GameState {
  if (result.kind !== "ACCEPTED") throw new Error("expected ACCEPTED, got " + JSON.stringify(result));
  return result.state;
}

interface Arrangement {
  readonly cash?: number;
  readonly owners?: Readonly<Record<string, string>>;
  readonly development?: Readonly<Record<string, number>>;
}

/**
 * Alice stands on `tile` with `cardId` on top of its deck and a pending CARD draw, reached
 * the canonical way: a real 1+2 roll from three tiles back.
 */
function facingCard(ref: string, cardId: string, tile: number, input: Arrangement = {}): GameState {
  const { board, cards } = canonicalBoard(ref);
  const initial = createInitialGameState({ gameId: "canon-game", board, playerIds: [alice, bob, carol] });
  const began = ok(run(initial, ref, "START_GAME", alice));
  const card = cards.cards.find((candidate) => candidate.cardId === cardId);
  if (card === undefined) throw new Error("unknown card " + cardId);
  const positioned = parseGameState({
    ...began,
    players: began.players.map((player) => player.userId === alice
      ? { ...player, position: (tile - 3 + board.tileCount) % board.tileCount, cash: input.cash ?? player.cash }
      : player),
    assets: began.assets.map((asset) => ({
      ...asset,
      ownerUserId: input.owners?.[asset.assetId] ?? asset.ownerUserId,
      ...(asset.kind === "PROPERTY"
        ? { developmentLevel: input.development?.[asset.assetId] ?? asset.developmentLevel }
        : {}),
    })),
    ruleState: {
      ...began.ruleState,
      decks: cards.decks.map((deck) => ({
        deckId: deck.deckId,
        drawPile: deck.deckId === card.deckId
          ? [cardId, ...deck.cardIds.filter((candidate) => candidate !== cardId)]
          : [...deck.cardIds],
        discardPile: [],
      })),
    },
  }, board, cards);
  const landed = ok(run(positioned, ref, "ROLL_DICE", alice, {}, [1, 2]));
  expect(landed.pendingResolution?.kind).toBe("CARD");
  return landed;
}

function draw(state: GameState, ref: string, dice: readonly number[] = []): GameplayCommandResult {
  return run(state, ref, "DRAW_CARD", alice, { resolutionId: state.pendingResolution?.resolutionId }, dice);
}

function cashOf(state: GameState, userId: string): number {
  return state.players.find((player) => player.userId === userId)?.cash ?? Number.NaN;
}

describe("RULE-011/012 canonical Surprise and Treasure decks", () => {
  it.each([STANDARD, GRAND])("loads 16+16 data-defined cards with copy for %s", (ref) => {
    const { cards, cardCopy } = canonicalBoard(ref);
    expect(cards.decks.map((deck) => [deck.deckId, deck.cardIds.length])).toEqual([
      ["surprise", 16], ["treasure", 16],
    ]);
    for (const deck of cards.decks) {
      expect(cards.cards.filter((card) => card.deckId === deck.deckId && card.heldCapability !== null))
        .toHaveLength(1);
    }
    expect(Object.keys(cardCopy).sort()).toEqual(cards.cards.map((card) => card.cardId).sort());
    for (const copy of Object.values(cardCopy)) expect(copy.title + copy.text).not.toMatch(/—/);
    expect(Object.isFrozen(CANONICAL_BOARDS[ref])).toBe(true);
  });

  it("shares card content across boards and differs only in named destinations", () => {
    const destinations = (ref: string) => canonicalBoard(ref).cards.effects
      .filter((effect) => effect.type === "MOVE_TO_TILE")
      .map((effect) => effect.type === "MOVE_TO_TILE" ? [effect.effectId, effect.tileIndex] : []);
    expect(destinations(STANDARD)).toEqual([
      ["advance-start", 0], ["advance-paris", 36], ["advance-rome", 31], ["advance-heathrow", 5],
    ]);
    expect(destinations(GRAND)).toEqual([
      ["advance-start", 0], ["advance-paris", 33], ["advance-rome", 27], ["advance-heathrow", 6],
    ]);
    const content = (ref: string) => canonicalBoard(ref).cards.cards;
    expect(content(GRAND)).toEqual(content(STANDARD));
    expect(canonicalBoard(GRAND).cardCopy).toEqual(canonicalBoard(STANDARD).cardCopy);
    expect(() => canonicalBoard("world-tour-mega@1")).toThrow(/unknown canonical board/);
  });

  it.each([STANDARD, GRAND])("resolves every canonical card through the engine on %s", (ref) => {
    const { cards } = canonicalBoard(ref);
    for (const card of cards.cards) {
      const facing = facingCard(ref, card.cardId, tileOfDeck(ref, card.deckId), { cash: 5000 });
      const result = draw(facing, ref);
      const next = ok(result);
      expect(result).toMatchObject({ event: { type: "CARD_RESOLVED" } });
      expect(parseGameState(JSON.parse(JSON.stringify(next)), canonicalBoard(ref).board, cards)).toEqual(next);
      if (card.heldCapability !== null) {
        expect(next.ruleState.heldCards).toEqual([
          { cardId: card.cardId, deckId: card.deckId, ownerUserId: alice, capability: "DETENTION_RELEASE" },
        ]);
      }
    }
  });

  it("charges double rent at the nearest transit hub and ten times a fresh roll at the nearest utility", () => {
    const flight = facingCard(STANDARD, "surprise:next-flight", 3, { owners: { "transit:5": bob } });
    const flown = ok(draw(flight, STANDARD));
    expect(flown.players.find((player) => player.userId === alice)?.position).toBe(5);
    expect(cashOf(flown, bob) - cashOf(flight, bob)).toBe(20 * 2);

    const landing = facingCard(STANDARD, "surprise:emergency-landing", 3, { owners: { "utility:4": bob } });
    const landed = ok(draw(landing, STANDARD, [6, 5]));
    expect(landed.players.find((player) => player.userId === alice)?.position).toBe(4);
    expect(cashOf(landed, bob) - cashOf(landing, bob)).toBe(110);

    const unowned = ok(draw(facingCard(STANDARD, "surprise:next-flight", 3), STANDARD));
    expect(unowned.pendingResolution).toMatchObject({ kind: "BUY_DECISION", source: { tileIndex: 5 } });

    // From the last Surprise tile the nearest utility wraps past START and pays the salary.
    const wrap = facingCard(STANDARD, "surprise:emergency-landing", 34);
    const wrapped = ok(draw(wrap, STANDARD));
    expect(wrapped.players.find((player) => player.userId === alice)).toMatchObject({ position: 4 });
    expect(cashOf(wrapped, alice) - cashOf(wrap, alice)).toBe(200);
  });

  it("pays each other player in seat order and suspends against one creditor at a time", () => {
    const festival = facingCard(STANDARD, "surprise:sponsor-festival", 3, {
      cash: 70, owners: { "property:FR-2": alice },
    });
    const owing = ok(draw(festival, STANDARD));
    expect(cashOf(owing, bob) - cashOf(festival, bob)).toBe(50);
    expect(owing.pendingResolution?.obligation).toMatchObject({
      creditor: { type: "PLAYER", userId: carol }, amount: 50,
    });
    expect(owing.ruleState.effectContinuation?.frames).toEqual([]);
    const paid = ok(run(owing, STANDARD, "MORTGAGE", alice, { assetId: "property:FR-2" }));
    expect(cashOf(paid, carol) - cashOf(festival, carol)).toBe(50);
    expect(cashOf(paid, alice)).toBe(70 - 50 + 200 - 50);
    expect(paid.pendingResolution).toBeNull();
  });

  it("applies per-city, per-level, and per-landmark amounts from owned assets", () => {
    const owned = {
      owners: { "property:MA-1": alice, "property:MA-2": alice, "property:MA-3": alice, "property:EG-1": alice },
      development: { "property:MA-1": 4, "property:MA-2": 3, "property:MA-3": 3 },
    };
    const repairs = facingCard(STANDARD, "surprise:street-repairs", 3, { cash: 5000, ...owned });
    expect(cashOf(ok(draw(repairs, STANDARD)), alice) - cashOf(repairs, alice)).toBe(-(115 + 3 * 40 + 3 * 40));
    const slide = facingCard(STANDARD, "surprise:currency-slide", 3, { cash: 5000, ...owned });
    expect(cashOf(ok(draw(slide, STANDARD)), alice) - cashOf(slide, alice)).toBe(-4 * 40);
    const dividend = facingCard(STANDARD, "treasure:annual-dividend", 9, owned);
    expect(cashOf(ok(draw(dividend, STANDARD)), alice) - cashOf(dividend, alice)).toBe(4 * 30);
    const boom = facingCard(STANDARD, "treasure:tourism-boom", 9);
    const boomed = ok(draw(boom, STANDARD));
    expect([alice, bob, carol].map((userId) => cashOf(boomed, userId) - cashOf(boom, userId))).toEqual([25, 25, 25]);
  });
});
