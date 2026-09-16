import { describe, expect, it } from "vitest";
import standardFixture from "../../../boards/world-tour/standard.json";
import { parseBoardDefinition } from "./board";
import {
  CardSchemaValidationError,
  parseCardCatalog,
  validateCardCatalog,
} from "./cards";
import * as publicApi from "./index";

const board = parseBoardDefinition(standardFixture);

function catalog() {
  return {
    decks: [
      { deckId: "surprise", cardIds: ["surprise:advance"] },
      { deckId: "treasure", cardIds: ["treasure:release"] },
    ],
    cards: [
      {
        cardId: "surprise:advance",
        deckId: "surprise",
        effectId: "effect:advance",
        heldCapability: null,
      },
      {
        cardId: "treasure:release",
        deckId: "treasure",
        effectId: "effect:release",
        heldCapability: "DETENTION_RELEASE",
      },
    ],
    effects: [
      {
        effectId: "effect:advance",
        type: "SEQUENCE",
        effectIds: ["effect:move", "effect:cash"],
      },
      { effectId: "effect:move", type: "MOVE_TO_TILE", tileIndex: 0, collectStart: true },
      {
        effectId: "effect:cash",
        type: "ADJUST_CASH",
        target: "CURRENT_PLAYER",
        amount: 100,
      },
      { effectId: "effect:release", type: "ENTER_DETENTION" },
    ],
  };
}

describe("CORE-013 declarative card/effect schema", () => {
  it("parses typed stable identities, references, and explicit held capability", () => {
    const parsed = parseCardCatalog(catalog(), board);
    expect(parsed.decks.map((deck) => deck.deckId)).toEqual(["surprise", "treasure"]);
    expect(parsed.cards[1]).toMatchObject({
      cardId: "treasure:release",
      heldCapability: "DETENTION_RELEASE",
    });
    expect(parsed.effects[0]).toMatchObject({
      effectId: "effect:advance",
      type: "SEQUENCE",
      effectIds: ["effect:move", "effect:cash"],
    });
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed.decks[0]?.cardIds)).toBe(true);
    expect(publicApi.parseCardCatalog).toBe(parseCardCatalog);
  });

  it("rejects unknown or executable effect content", () => {
    expect(() => parseCardCatalog({
      ...catalog(),
      effects: [{ effectId: "effect:advance", type: "RUN_JAVASCRIPT", source: "cash += 1" }],
    }, board)).toThrow(/unknown effect type/);
    expect(() => parseCardCatalog({
      ...catalog(),
      effects: [() => 1],
    }, board)).toThrow(/expected an object/);
    expect(() => parseCardCatalog({
      ...catalog(),
      effects: [{
        effectId: "effect:advance",
        type: "MOVE_BY",
        offset: 1,
        execute: () => 1,
      }],
    }, board)).toThrow(/unexpected field/);
  });

  it("rejects invalid tile, deck, card, and effect references", () => {
    const invalidTile = catalog();
    invalidTile.effects[1] = {
      effectId: "effect:move",
      type: "MOVE_TO_TILE",
      tileIndex: board.tileCount,
      collectStart: true,
    };
    expect(() => parseCardCatalog(invalidTile, board)).toThrow(/unknown tile reference/);

    const invalidDeck = catalog();
    invalidDeck.decks[0] = { deckId: "unknown", cardIds: ["surprise:advance"] };
    expect(() => parseCardCatalog(invalidDeck, board)).toThrow(/unknown deck reference/);

    const invalidCard = catalog();
    invalidCard.decks[0] = { deckId: "surprise", cardIds: ["missing"] };
    expect(() => parseCardCatalog(invalidCard, board)).toThrow(/unknown card reference/);

    const invalidEffect = catalog();
    invalidEffect.cards[0] = { ...invalidEffect.cards[0]!, effectId: "missing" };
    expect(() => parseCardCatalog(invalidEffect, board)).toThrow(/unknown effect reference/);
  });

  it("rejects duplicate stable identities and obvious static cycles", () => {
    const duplicateCard = catalog();
    duplicateCard.cards[1] = {
      ...duplicateCard.cards[1]!,
      cardId: duplicateCard.cards[0]!.cardId,
    };
    expect(() => parseCardCatalog(duplicateCard, board)).toThrow(/duplicate card identity/);

    const duplicateEffect = catalog();
    duplicateEffect.effects[1] = {
      effectId: "effect:advance",
      type: "MOVE_TO_TILE",
      tileIndex: 1,
      collectStart: false,
    };
    expect(() => parseCardCatalog(duplicateEffect, board)).toThrow(/duplicate effect identity/);

    const cyclic = catalog();
    cyclic.effects = [
      { effectId: "effect:advance", type: "SEQUENCE", effectIds: ["effect:cycle"] },
      { effectId: "effect:cycle", type: "SEQUENCE", effectIds: ["effect:advance"] },
      { effectId: "effect:release", type: "ENTER_DETENTION" },
    ];
    expect(() => parseCardCatalog(cyclic, board)).toThrow(/static effect reference cycle/);
  });

  it("returns a typed validation failure without accepting malformed input", () => {
    const result = validateCardCatalog({ ...catalog(), cards: [] }, board);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected invalid catalog");
    expect(result.error).toBeInstanceOf(CardSchemaValidationError);
  });
});
