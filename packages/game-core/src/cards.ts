import { parseBoardDefinition, type BoardDefinition } from "./board";
import type { CardDeck } from "./economy";

export type HeldCardCapability = "DETENTION_RELEASE";
export type EffectTarget = "CURRENT_PLAYER" | "EACH_OTHER_PLAYER" | "EACH_PLAYER";

interface EffectIdentity {
  readonly effectId: string;
}

export type EffectDefinition =
  | (EffectIdentity & {
      readonly type: "ADJUST_CASH";
      readonly target: EffectTarget;
      readonly amount: number;
    })
  | (EffectIdentity & {
      readonly type: "MOVE_TO_TILE";
      readonly tileIndex: number;
      readonly collectStart: boolean;
    })
  | (EffectIdentity & { readonly type: "MOVE_BY"; readonly offset: number })
  | (EffectIdentity & { readonly type: "DRAW_CARD"; readonly deckId: CardDeck })
  | (EffectIdentity & { readonly type: "SEQUENCE"; readonly effectIds: readonly string[] })
  | (EffectIdentity & { readonly type: "ENTER_DETENTION" })
  | (EffectIdentity & {
      readonly type: "REPAIR_OWNED_ASSETS";
      readonly perProperty: number;
      readonly perDevelopmentLevel: number;
    });

export interface CardDefinition {
  readonly cardId: string;
  readonly deckId: CardDeck;
  readonly effectId: string;
  readonly heldCapability: HeldCardCapability | null;
}

export interface DeckDefinition {
  readonly deckId: CardDeck;
  readonly cardIds: readonly string[];
}

export interface CardCatalogDefinition {
  readonly decks: readonly DeckDefinition[];
  readonly cards: readonly CardDefinition[];
  readonly effects: readonly EffectDefinition[];
}

export class CardSchemaValidationError extends Error {
  constructor(readonly path: string, message: string) {
    super(path + ": " + message);
    this.name = "CardSchemaValidationError";
  }
}

function fail(path: string, message: string): never {
  throw new CardSchemaValidationError(path, message);
}

function objectAt(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail(path, "expected an object");
  }
  return value as Record<string, unknown>;
}

function arrayAt(value: unknown, path: string): readonly unknown[] {
  if (!Array.isArray(value)) fail(path, "expected an array");
  return value;
}

function exactKeys(
  object: Record<string, unknown>,
  expected: readonly string[],
  path: string,
): void {
  const keys = new Set(expected);
  for (const key of Object.keys(object)) {
    if (!keys.has(key)) fail(path + "." + key, "unexpected field");
  }
  for (const key of expected) {
    if (!Object.prototype.hasOwnProperty.call(object, key)) fail(path + "." + key, "missing field");
  }
}

function identifierAt(value: unknown, path: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    fail(path, "expected a non-empty string");
  }
  return value;
}

function integerAt(value: unknown, path: string, minimum?: number): number {
  if (!Number.isSafeInteger(value) || (minimum !== undefined && (value as number) < minimum)) {
    fail(path, "expected a safe integer" + (minimum === undefined ? "" : " >= " + minimum));
  }
  return value as number;
}

function booleanAt(value: unknown, path: string): boolean {
  if (value !== true && value !== false) fail(path, "expected a boolean");
  return value;
}

function deckIdAt(value: unknown, path: string): CardDeck {
  if (value !== "surprise" && value !== "treasure") fail(path, "unknown deck reference");
  return value;
}

function parseDeck(value: unknown, index: number): DeckDefinition {
  const path = "$.decks[" + index + "]";
  const object = objectAt(value, path);
  exactKeys(object, ["deckId", "cardIds"], path);
  const cardIds = arrayAt(object.cardIds, path + ".cardIds").map((cardId, cardIndex) =>
    identifierAt(cardId, path + ".cardIds[" + cardIndex + "]"),
  );
  if (cardIds.length === 0) fail(path + ".cardIds", "deck must contain at least one card");
  if (new Set(cardIds).size !== cardIds.length) fail(path + ".cardIds", "duplicate card reference");
  return { deckId: deckIdAt(object.deckId, path + ".deckId"), cardIds };
}

function parseCard(value: unknown, index: number): CardDefinition {
  const path = "$.cards[" + index + "]";
  const object = objectAt(value, path);
  exactKeys(object, ["cardId", "deckId", "effectId", "heldCapability"], path);
  const heldCapability = object.heldCapability === null
    ? null
    : object.heldCapability === "DETENTION_RELEASE"
      ? object.heldCapability
      : fail(path + ".heldCapability", "unknown held-card capability");
  return {
    cardId: identifierAt(object.cardId, path + ".cardId"),
    deckId: deckIdAt(object.deckId, path + ".deckId"),
    effectId: identifierAt(object.effectId, path + ".effectId"),
    heldCapability,
  };
}

function parseEffect(value: unknown, index: number, board: BoardDefinition): EffectDefinition {
  const path = "$.effects[" + index + "]";
  const object = objectAt(value, path);
  const effectId = identifierAt(object.effectId, path + ".effectId");
  switch (object.type) {
    case "ADJUST_CASH": {
      exactKeys(object, ["effectId", "type", "target", "amount"], path);
      const target = object.target;
      if (target !== "CURRENT_PLAYER" && target !== "EACH_OTHER_PLAYER" && target !== "EACH_PLAYER") {
        fail(path + ".target", "unknown effect target");
      }
      const amount = integerAt(object.amount, path + ".amount");
      if (amount === 0) fail(path + ".amount", "cash adjustment must be non-zero");
      return { effectId, type: object.type, target, amount };
    }
    case "MOVE_TO_TILE": {
      exactKeys(object, ["effectId", "type", "tileIndex", "collectStart"], path);
      const tileIndex = integerAt(object.tileIndex, path + ".tileIndex", 0);
      if (tileIndex >= board.tileCount) fail(path + ".tileIndex", "unknown tile reference");
      return {
        effectId,
        type: object.type,
        tileIndex,
        collectStart: booleanAt(object.collectStart, path + ".collectStart"),
      };
    }
    case "MOVE_BY": {
      exactKeys(object, ["effectId", "type", "offset"], path);
      const offset = integerAt(object.offset, path + ".offset");
      if (offset === 0) fail(path + ".offset", "movement offset must be non-zero");
      return { effectId, type: object.type, offset };
    }
    case "DRAW_CARD":
      exactKeys(object, ["effectId", "type", "deckId"], path);
      return { effectId, type: object.type, deckId: deckIdAt(object.deckId, path + ".deckId") };
    case "SEQUENCE": {
      exactKeys(object, ["effectId", "type", "effectIds"], path);
      const effectIds = arrayAt(object.effectIds, path + ".effectIds").map((child, childIndex) =>
        identifierAt(child, path + ".effectIds[" + childIndex + "]"),
      );
      if (effectIds.length === 0) fail(path + ".effectIds", "sequence must not be empty");
      return { effectId, type: object.type, effectIds };
    }
    case "ENTER_DETENTION":
      exactKeys(object, ["effectId", "type"], path);
      return { effectId, type: object.type };
    case "REPAIR_OWNED_ASSETS":
      exactKeys(object, ["effectId", "type", "perProperty", "perDevelopmentLevel"], path);
      return {
        effectId,
        type: object.type,
        perProperty: integerAt(object.perProperty, path + ".perProperty", 0),
        perDevelopmentLevel: integerAt(
          object.perDevelopmentLevel,
          path + ".perDevelopmentLevel",
          0,
        ),
      };
    default:
      return fail(path + ".type", "unknown effect type");
  }
}

function assertNoStaticEffectCycles(
  effects: readonly EffectDefinition[],
  decks: readonly DeckDefinition[],
  cards: readonly CardDefinition[],
): void {
  const cardById = new Map(cards.map((card) => [card.cardId, card]));
  const edges = new Map<string, readonly string[]>();
  for (const effect of effects) {
    if (effect.type === "SEQUENCE") {
      edges.set(effect.effectId, effect.effectIds);
      continue;
    }
    if (effect.type === "DRAW_CARD") {
      const deck = decks.find((candidate) => candidate.deckId === effect.deckId);
      const deterministicTargets = new Set(
        deck?.cardIds.map((cardId) => cardById.get(cardId)?.effectId).filter(
          (effectId): effectId is string => effectId !== undefined,
        ),
      );
      edges.set(effect.effectId, deterministicTargets.size === 1 ? [...deterministicTargets] : []);
      continue;
    }
    edges.set(effect.effectId, []);
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (effectId: string): void => {
    if (visiting.has(effectId)) fail("$.effects", "static effect reference cycle at " + effectId);
    if (visited.has(effectId)) return;
    visiting.add(effectId);
    for (const childId of edges.get(effectId) ?? []) visit(childId);
    visiting.delete(effectId);
    visited.add(effectId);
  };
  for (const effect of effects) visit(effect.effectId);
}

function freezeCatalog(catalog: CardCatalogDefinition): CardCatalogDefinition {
  catalog.decks.forEach((deck) => {
    Object.freeze(deck.cardIds);
    Object.freeze(deck);
  });
  catalog.cards.forEach(Object.freeze);
  catalog.effects.forEach((effect) => {
    if (effect.type === "SEQUENCE") Object.freeze(effect.effectIds);
    Object.freeze(effect);
  });
  Object.freeze(catalog.decks);
  Object.freeze(catalog.cards);
  Object.freeze(catalog.effects);
  return Object.freeze(catalog);
}

export function parseCardCatalog(input: unknown, boardInput: BoardDefinition): CardCatalogDefinition {
  const board = parseBoardDefinition(boardInput);
  const root = objectAt(input, "$");
  exactKeys(root, ["decks", "cards", "effects"], "$");
  const decks = arrayAt(root.decks, "$.decks").map(parseDeck);
  const cards = arrayAt(root.cards, "$.cards").map(parseCard);
  const effects = arrayAt(root.effects, "$.effects").map((effect, index) =>
    parseEffect(effect, index, board),
  );

  const requiredDecks = new Set(
    board.economyProfile.tiles
      .filter((tile) => tile.type === "card")
      .map((tile) => tile.deck),
  );
  const deckIds = new Set<CardDeck>();
  for (const deck of decks) {
    if (deckIds.has(deck.deckId)) fail("$.decks", "duplicate deck identity " + deck.deckId);
    deckIds.add(deck.deckId);
  }
  for (const deckId of requiredDecks) {
    if (!deckIds.has(deckId)) fail("$.decks", "missing board deck " + deckId);
  }
  if (deckIds.size !== requiredDecks.size) fail("$.decks", "deck is not referenced by the board");

  const cardById = new Map<string, CardDefinition>();
  for (const card of cards) {
    if (cardById.has(card.cardId)) fail("$.cards", "duplicate card identity " + card.cardId);
    if (!deckIds.has(card.deckId)) fail("$.cards", "unknown deck reference " + card.deckId);
    cardById.set(card.cardId, card);
  }

  const listedCards = new Set<string>();
  for (const deck of decks) {
    for (const cardId of deck.cardIds) {
      const card = cardById.get(cardId);
      if (card === undefined) fail("$.decks", "unknown card reference " + cardId);
      if (card.deckId !== deck.deckId) fail("$.decks", "card reference belongs to another deck " + cardId);
      if (listedCards.has(cardId)) fail("$.decks", "card is listed in more than one deck " + cardId);
      listedCards.add(cardId);
    }
  }
  if (listedCards.size !== cards.length) fail("$.cards", "card is not listed by its deck");

  const effectIds = new Set<string>();
  for (const effect of effects) {
    if (effectIds.has(effect.effectId)) fail("$.effects", "duplicate effect identity " + effect.effectId);
    effectIds.add(effect.effectId);
  }
  for (const card of cards) {
    if (!effectIds.has(card.effectId)) fail("$.cards", "unknown effect reference " + card.effectId);
  }
  for (const effect of effects) {
    if (effect.type === "DRAW_CARD" && !deckIds.has(effect.deckId)) {
      fail("$.effects", "unknown deck reference " + effect.deckId);
    }
    if (effect.type === "SEQUENCE") {
      for (const childId of effect.effectIds) {
        if (!effectIds.has(childId)) fail("$.effects", "unknown effect reference " + childId);
      }
    }
  }
  assertNoStaticEffectCycles(effects, decks, cards);
  return freezeCatalog({ decks, cards, effects });
}

export type CardCatalogValidationResult =
  | { readonly ok: true; readonly catalog: CardCatalogDefinition }
  | { readonly ok: false; readonly error: CardSchemaValidationError };

export function validateCardCatalog(
  input: unknown,
  board: BoardDefinition,
): CardCatalogValidationResult {
  try {
    return { ok: true, catalog: parseCardCatalog(input, board) };
  } catch (error) {
    if (error instanceof CardSchemaValidationError) return { ok: false, error };
    throw error;
  }
}
