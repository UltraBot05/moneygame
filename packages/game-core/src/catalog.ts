import grandBoard from "../../../boards/world-tour/grand.json";
import grandCards from "../../../boards/world-tour/grand.cards.json";
import standardBoard from "../../../boards/world-tour/standard.json";
import standardCards from "../../../boards/world-tour/standard.cards.json";
import { parseBoardDefinition, type BoardDefinition } from "./board";
import { CardSchemaValidationError, parseCardCatalog, type CardCatalogDefinition } from "./cards";

export interface CardCopy {
  readonly title: string;
  readonly text: string;
}

/** A launch board with its authoritative decks and the player-facing card text. */
export interface CanonicalBoard {
  readonly board: BoardDefinition;
  readonly cards: CardCatalogDefinition;
  readonly cardCopy: Readonly<Record<string, CardCopy>>;
}

function parseCopy(value: unknown, cards: CardCatalogDefinition): Readonly<Record<string, CardCopy>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new CardSchemaValidationError("$.copy", "expected an object");
  }
  const entries = value as Record<string, unknown>;
  const cardIds = new Set(cards.cards.map((card) => card.cardId));
  const keys = Object.keys(entries);
  if (keys.length !== cardIds.size || keys.some((cardId) => !cardIds.has(cardId))) {
    throw new CardSchemaValidationError("$.copy", "every card needs exactly one copy entry");
  }
  const copy: Record<string, CardCopy> = {};
  for (const cardId of keys) {
    const entry = entries[cardId] as Record<string, unknown> | null;
    const title = entry?.title;
    const text = entry?.text;
    if (typeof title !== "string" || title.trim() === "" || typeof text !== "string" || text.trim() === ""
      || Object.keys(entry ?? {}).length !== 2) {
      throw new CardSchemaValidationError("$.copy." + cardId, "expected a non-empty title and text");
    }
    copy[cardId] = Object.freeze({ title, text });
  }
  return Object.freeze(copy);
}

function load(boardData: unknown, cardData: { readonly copy: unknown }): CanonicalBoard {
  const board = parseBoardDefinition(boardData);
  const { copy, ...catalog } = cardData;
  const cards = parseCardCatalog(catalog, board);
  return Object.freeze({ board, cards, cardCopy: parseCopy(copy, cards) });
}

export const CANONICAL_BOARDS: Readonly<Record<string, CanonicalBoard>> = Object.freeze({
  [standardBoard.ref]: load(standardBoard, standardCards),
  [grandBoard.ref]: load(grandBoard, grandCards),
});

export function canonicalBoard(ref: string): CanonicalBoard {
  const found = CANONICAL_BOARDS[ref];
  if (found === undefined) throw new RangeError("unknown canonical board " + ref);
  return found;
}
