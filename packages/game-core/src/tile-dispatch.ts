import { parseBoardDefinition, type BoardDefinition } from "./board";
import type { EconomyTile } from "./economy";

export type GrandSpecialKind = "AUCTION_HUB" | "GIFT_CHOICE" | "TRANSIT_PASS";

export type TileResolution =
  | { readonly kind: "PROPERTY"; readonly tileIndex: number; readonly propertyId: string }
  | { readonly kind: "TRANSIT"; readonly tileIndex: number }
  | { readonly kind: "UTILITY"; readonly tileIndex: number }
  | { readonly kind: "TAX"; readonly tileIndex: number; readonly amount: number }
  | { readonly kind: "SURPRISE"; readonly tileIndex: number }
  | { readonly kind: "TREASURE"; readonly tileIndex: number }
  | { readonly kind: "STRUCTURAL_CORNER"; readonly tileIndex: number }
  | {
      readonly kind: "GRAND_SPECIAL";
      readonly tileIndex: number;
      readonly special: GrandSpecialKind;
    };

export class TileDispatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TileDispatchError";
  }
}

function grandSpecialKind(
  name: Extract<EconomyTile, { readonly type: "grand-special" }>["name"],
): GrandSpecialKind {
  switch (name) {
    case "Auction Hub":
      return "AUCTION_HUB";
    case "Gift/Choice":
      return "GIFT_CHOICE";
    case "Transit Pass":
      return "TRANSIT_PASS";
  }
}

function impossibleTile(tile: never): never {
  throw new TileDispatchError("unknown canonical tile type " + String(tile));
}

export function dispatchLandedTile(
  boardInput: BoardDefinition,
  tileIndex: number,
): TileResolution {
  const board = parseBoardDefinition(boardInput);
  if (!Number.isSafeInteger(tileIndex) || tileIndex < 0 || tileIndex >= board.tileCount) {
    throw new TileDispatchError("tileIndex must identify a tile on the supplied board");
  }

  const tile = board.economyProfile.tiles[tileIndex];
  if (tile === undefined) {
    throw new TileDispatchError("canonical board is missing the landed tile");
  }

  switch (tile.type) {
    case "property":
      return Object.freeze({
        kind: "PROPERTY",
        tileIndex: tile.index,
        propertyId: tile.propertyId,
      });
    case "transit":
      return Object.freeze({ kind: "TRANSIT", tileIndex: tile.index });
    case "utility":
      return Object.freeze({ kind: "UTILITY", tileIndex: tile.index });
    case "tax":
      return Object.freeze({ kind: "TAX", tileIndex: tile.index, amount: tile.amount });
    case "card":
      return Object.freeze({
        kind: tile.deck === "surprise" ? "SURPRISE" : "TREASURE",
        tileIndex: tile.index,
      });
    case "corner":
      return Object.freeze({ kind: "STRUCTURAL_CORNER", tileIndex: tile.index });
    case "grand-special":
      return Object.freeze({
        kind: "GRAND_SPECIAL",
        tileIndex: tile.index,
        special: grandSpecialKind(tile.name),
      });
    default:
      return impossibleTile(tile);
  }
}
