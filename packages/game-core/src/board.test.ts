import { describe, expect, it } from "vitest";
import grand from "../../../boards/world-tour/grand.json";
import standard from "../../../boards/world-tour/standard.json";
import {
  BoardValidationError,
  parseBoardDefinition,
  validateBoardDefinition,
} from "./board";

function cloneFixture<T>(value: T): T {
  const parsed: unknown = JSON.parse(JSON.stringify(value));
  return parsed as T;
}

describe("CORE-001 board schema and validator", () => {
  it("accepts and freezes both canonical launch boards", () => {
    const parsedStandard = parseBoardDefinition(standard);
    const parsedGrand = parseBoardDefinition(grand);

    expect(parsedStandard.economyProfile.tiles).toHaveLength(40);
    expect(parsedGrand.economyProfile.tiles).toHaveLength(52);
    expect(Object.isFrozen(parsedStandard)).toBe(true);
    expect(Object.isFrozen(parsedStandard.economyProfile.tiles)).toBe(true);
  });

  it("rejects broken and duplicate property tile references", () => {
    const brokenReference = cloneFixture(standard);
    brokenReference.economyProfile.tiles[1]!.propertyId = "MISSING";
    expect(() => parseBoardDefinition(brokenReference)).toThrow(BoardValidationError);

    const duplicateReference = cloneFixture(standard);
    duplicateReference.economyProfile.tiles[2]!.propertyId = "EG-1";
    expect(() => parseBoardDefinition(duplicateReference)).toThrow(
      /duplicate property tile reference/,
    );
  });

  it("rejects invalid or duplicate property-set membership", () => {
    const badMembership = cloneFixture(standard);
    badMembership.economyProfile.sets[0]!.properties[0]!.setId = "MA";
    expect(() => parseBoardDefinition(badMembership)).toThrow(/containing set id/);

    const duplicateProperty = cloneFixture(standard);
    duplicateProperty.economyProfile.sets[0]!.properties[1]!.id =
      duplicateProperty.economyProfile.sets[0]!.properties[0]!.id;
    expect(() => parseBoardDefinition(duplicateProperty)).toThrow(/duplicate property id/);

    const duplicateSet = cloneFixture(standard);
    duplicateSet.economyProfile.sets[1]!.id = duplicateSet.economyProfile.sets[0]!.id;
    for (const property of duplicateSet.economyProfile.sets[1]!.properties) {
      property.setId = duplicateSet.economyProfile.sets[0]!.id;
    }
    expect(() => parseBoardDefinition(duplicateSet)).toThrow(/duplicate set id/);
  });

  it("rejects bad tile positions, deck refs, and type-incompatible fields", () => {
    const badPosition = cloneFixture(standard);
    badPosition.economyProfile.tiles[2]!.index = 1;
    expect(() => parseBoardDefinition(badPosition)).toThrow(/ordered position/);

    const badDeck = cloneFixture(standard);
    const card = badDeck.economyProfile.tiles.find((tile) => tile.type === "card");
    expect(card).toBeDefined();
    if (card !== undefined) card.deck = "mystery";
    expect(() => parseBoardDefinition(badDeck)).toThrow(/unknown deck reference/);

    const badDistribution = cloneFixture(standard);
    const surprise = badDistribution.economyProfile.tiles.find(
      (tile) => tile.type === "card" && tile.deck === "surprise",
    );
    if (surprise !== undefined) surprise.deck = "treasure";
    expect(() => parseBoardDefinition(badDistribution)).toThrow(/deck counts/);

    const incompatible = cloneFixture(standard);
    Object.assign(incompatible.economyProfile.tiles[0]!, { amount: 100 });
    expect(() => parseBoardDefinition(incompatible)).toThrow(/unexpected field/);
  });

  it("rejects frozen identity and count mismatches", () => {
    const badRef = cloneFixture(standard);
    badRef.ref = "world-tour-standard@2";
    expect(() => parseBoardDefinition(badRef)).toThrow(/identity\/version/);

    const badCount = cloneFixture(grand);
    badCount.tileCount = 40;
    expect(() => parseBoardDefinition(badCount)).toThrow(/tileCount/);
  });

  it("offers a non-throwing validation result at unknown-data boundaries", () => {
    const result = validateBoardDefinition({ boardId: "unknown" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBeInstanceOf(BoardValidationError);
  });
});
