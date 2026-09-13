import { describe, expect, it } from "vitest";
import grandFixture from "../../../boards/world-tour/grand.json";
import standardFixture from "../../../boards/world-tour/standard.json";
import { parseBoardDefinition, type BoardDefinition } from "./board";
import type { EconomyTile } from "./economy";
import { dispatchLandedTile, TileDispatchError } from "./tile-dispatch";

const standard = parseBoardDefinition(standardFixture);
const grand = parseBoardDefinition(grandFixture);

function expectedKind(tile: EconomyTile): string {
  switch (tile.type) {
    case "property":
      return "PROPERTY";
    case "transit":
      return "TRANSIT";
    case "utility":
      return "UTILITY";
    case "tax":
      return "TAX";
    case "card":
      return tile.deck === "surprise" ? "SURPRISE" : "TREASURE";
    case "corner":
      return "STRUCTURAL_CORNER";
    case "grand-special":
      return "GRAND_SPECIAL";
  }
}

describe("CORE-009 typed canonical tile dispatch", () => {
  it.each([
    ["Standard", standard],
    ["Grand", grand],
  ] as const)("routes every %s tile to its discriminated resolution", (_name, board) => {
    for (const tile of board.economyProfile.tiles) {
      expect(dispatchLandedTile(board, tile.index).kind).toBe(expectedKind(tile));
    }
  });

  it("preserves property identity and tax amount without applying future rules", () => {
    expect(dispatchLandedTile(standard, 1)).toEqual({
      kind: "PROPERTY",
      tileIndex: 1,
      propertyId: "EG-1",
    });
    expect(dispatchLandedTile(standard, 14)).toEqual({
      kind: "TAX",
      tileIndex: 14,
      amount: 100,
    });
  });

  it("distinguishes every reserved Grand special from corners and cards", () => {
    const specials = grand.economyProfile.tiles
      .filter((tile) => tile.type === "grand-special")
      .map((tile) => dispatchLandedTile(grand, tile.index));

    expect(specials).toEqual([
      { kind: "GRAND_SPECIAL", tileIndex: 11, special: "AUCTION_HUB" },
      { kind: "GRAND_SPECIAL", tileIndex: 24, special: "GIFT_CHOICE" },
      { kind: "GRAND_SPECIAL", tileIndex: 25, special: "TRANSIT_PASS" },
    ]);
  });

  it("rejects impossible indices and unknown board tile types", () => {
    expect(() => dispatchLandedTile(standard, -1)).toThrow(TileDispatchError);
    expect(() => dispatchLandedTile(grand, 52)).toThrow(TileDispatchError);

    const malformed = JSON.parse(JSON.stringify(standardFixture)) as Record<string, unknown>;
    const economy = malformed.economyProfile as { tiles: Array<Record<string, unknown>> };
    economy.tiles[0] = { index: 0, type: "portal", name: "Unsafe fallback" };
    expect(() => dispatchLandedTile(malformed as unknown as BoardDefinition, 0)).toThrow(
      /unknown tile type portal/,
    );
  });
});
