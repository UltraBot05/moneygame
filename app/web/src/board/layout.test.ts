import { describe, expect, it } from "vitest";
import { computeLayout, isPerimeterBoard, type TilePos } from "./layout";

/**
 * SPIKE-006 — the perimeter layout must derive corners/sides from tileCount for
 * BOTH canonical boards, with no hard-coded 40-tile assumption. Pure math test.
 */

function at(tiles: TilePos[], index: number): TilePos {
  const t = tiles.find((x) => x.index === index);
  if (t === undefined) throw new Error(`no tile ${index}`);
  return t;
}

describe("SPIKE-006 perimeter layout", () => {
  it("accepts canonical boards and rejects non-perimeter counts", () => {
    expect(isPerimeterBoard(40)).toBe(true);
    expect(isPerimeterBoard(52)).toBe(true);
    expect(isPerimeterBoard(41)).toBe(false);
    expect(isPerimeterBoard(6)).toBe(false);
    expect(() => computeLayout(41)).toThrow();
  });

  for (const [tileCount, perSide, gridSize] of [
    [40, 9, 11],
    [52, 12, 14],
  ] as const) {
    describe(`${tileCount}-tile board`, () => {
      const layout = computeLayout(tileCount);

      it("derives perSide and gridSize from tileCount", () => {
        expect(layout.perSide).toBe(perSide);
        expect(layout.gridSize).toBe(gridSize);
        expect(layout.center).toEqual({ row: 2, column: 2, span: perSide });
      });

      it("emits exactly tileCount tiles with unique indices 0..N-1", () => {
        expect(layout.tiles).toHaveLength(tileCount);
        expect(new Set(layout.tiles.map((t) => t.index)).size).toBe(tileCount);
      });

      it("has exactly 4 corners at the four grid corners", () => {
        const corners = layout.tiles.filter((t) => t.edge === "corner");
        expect(corners).toHaveLength(4);
        const coords = corners.map((c) => `${c.gridRow},${c.gridColumn}`).sort();
        expect(coords).toEqual(
          [`${gridSize},${gridSize}`, `${gridSize},1`, `1,1`, `1,${gridSize}`].sort(),
        );
      });

      it("has perSide tiles on each of the four edges", () => {
        for (const edge of ["bottom", "left", "top", "right"] as const) {
          expect(layout.tiles.filter((t) => t.edge === edge)).toHaveLength(perSide);
        }
      });

      it("places every non-corner tile on the outer ring (never interior)", () => {
        for (const t of layout.tiles) {
          const onRing =
            t.gridRow === 1 || t.gridRow === gridSize || t.gridColumn === 1 || t.gridColumn === gridSize;
          expect(onRing).toBe(true);
        }
      });

      it("no two tiles share a grid cell", () => {
        const cells = layout.tiles.map((t) => `${t.gridRow},${t.gridColumn}`);
        expect(new Set(cells).size).toBe(tileCount);
      });

      it("walks clockwise: index 0 bottom-right, then leftward along the bottom", () => {
        expect(at(layout.tiles, 0)).toMatchObject({ corner: "br" });
        expect(at(layout.tiles, 1)).toMatchObject({ edge: "bottom", gridRow: gridSize, gridColumn: gridSize - 1 });
        expect(at(layout.tiles, perSide + 1)).toMatchObject({ corner: "bl" });
      });
    });
  }
});
