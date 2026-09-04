import { describe, expect, it } from "vitest";
import { DEMO_SCENES, demoBoard } from "./fixtures";

describe("SPIKE-006 renderer fixtures", () => {
  it("keeps the demo-state switcher bounded and deterministic", () => {
    expect(DEMO_SCENES).toEqual([
      "turn",
      "property",
      "auction",
      "event",
      "trade",
      "debt",
      "results",
    ]);
    expect(demoBoard(52, { stress: true })).toEqual(demoBoard(52, { stress: true }));
  });

  it("uses eight set identities on Standard and all twelve on Grand", () => {
    for (const [tileCount, expectedSets] of [
      [40, 8],
      [52, 12],
    ] as const) {
      const used = new Set(
        demoBoard(tileCount).tiles
          .filter((tile) => tile.type === "property")
          .map((tile) => tile.setIndex),
      );
      expect(used.size).toBe(expectedSets);
    }
  });

  it("contains the destructive 10-player stress cases", () => {
    const board = demoBoard(52, { stress: true });
    expect(board.players).toHaveLength(10);
    expect(Math.max(...board.players.map((player) => player.balance))).toBeGreaterThan(1_000_000);
    expect(board.tiles.some((tile) => tile.name.length > 50)).toBe(true);
    expect(board.tiles.some((tile) => tile.tokens.length === 10)).toBe(true);
    expect(board.tiles.some((tile) => tile.mortgaged === true)).toBe(true);
    expect(board.tiles.some((tile) => (tile.buildings ?? 0) > 0)).toBe(true);
  });
});
