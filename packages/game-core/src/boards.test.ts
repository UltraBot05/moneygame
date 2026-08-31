import { describe, expect, it } from "vitest";
import grand from "../../../boards/world-tour/grand.json";
import standard from "../../../boards/world-tour/standard.json";
import type { BoardDefinition } from "./index";

// Verify the canonical authored files directly (no duplicated constants).
const standardBoard: BoardDefinition = standard;
const grandBoard: BoardDefinition = grand;

describe("canonical launch board definitions", () => {
  it("have distinct stable refs and ids", () => {
    expect(standardBoard.ref).toBe("world-tour-standard@1");
    expect(grandBoard.ref).toBe("world-tour-grand@1");
    expect(standardBoard.ref).not.toBe(grandBoard.ref);
    expect(standardBoard.boardId).not.toBe(grandBoard.boardId);
  });

  it("declare fixed tile counts (40 Standard, 52 Grand)", () => {
    expect(standardBoard.tileCount).toBe(40);
    expect(grandBoard.tileCount).toBe(52);
  });

  it("declare recommended player ranges (3-6 Standard, 6-10 Grand)", () => {
    expect(standardBoard.recommendedPlayers).toEqual({ min: 3, max: 6 });
    expect(grandBoard.recommendedPlayers).toEqual({ min: 6, max: 10 });
  });

  it("are two separate definitions, not one resized into the other", () => {
    expect(grandBoard).not.toBe(standardBoard);
    expect(grandBoard).not.toEqual(standardBoard);
    expect(grandBoard.tileCount).not.toBe(standardBoard.tileCount);
  });
});
