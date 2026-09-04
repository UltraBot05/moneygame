/**
 * SPIKE-006 — size-agnostic perimeter board layout.
 *
 * One function drives BOTH canonical boards: Standard (40 tiles) and Grand (52).
 * A perimeter board is 4 corners + 4 equal sides, so `perSide = (tileCount-4)/4`
 * (9 for Standard, 12 for Grand) and the CSS grid is `perSide + 2` cells square.
 * There is no hard-coded 40-tile assumption — any `4 + 4·k` board lays out.
 *
 * Index 0 is the bottom-right corner; indices increase clockwise (left along the
 * bottom, up the left, right along the top, down the right) — the walking order a
 * token follows. Pure: no React, no DOM.
 */

export type Edge = "bottom" | "left" | "top" | "right";
export type Corner = "br" | "bl" | "tl" | "tr";

export interface TilePos {
  index: number;
  /** 1-based CSS grid coordinates. */
  gridRow: number;
  gridColumn: number;
  edge: Edge | "corner";
  corner?: Corner;
}

export interface BoardLayout {
  tileCount: number;
  /** Tiles per side, excluding corners. */
  perSide: number;
  /** Grid is gridSize × gridSize cells. */
  gridSize: number;
  tiles: TilePos[];
  /** Central face grid area (1-based start, cell span). */
  center: { row: number; column: number; span: number };
}

export function isPerimeterBoard(tileCount: number): boolean {
  return tileCount >= 8 && (tileCount - 4) % 4 === 0;
}

export function computeLayout(tileCount: number): BoardLayout {
  if (!isPerimeterBoard(tileCount)) {
    throw new Error(`unsupported tileCount ${tileCount}: must be 4 + 4·perSide`);
  }
  const perSide = (tileCount - 4) / 4;
  const gridSize = perSide + 2; // corner + perSide + corner
  const tiles: TilePos[] = [];
  const add = (
    index: number,
    gridRow: number,
    gridColumn: number,
    edge: Edge | "corner",
    corner?: Corner,
  ): void => {
    tiles.push(corner === undefined ? { index, gridRow, gridColumn, edge } : { index, gridRow, gridColumn, edge, corner });
  };

  const G = gridSize;
  add(0, G, G, "corner", "br"); // bottom-right
  let idx = 1;
  for (let k = 0; k < perSide; k++) add(idx++, G, G - 1 - k, "bottom"); // bottom, leftward
  add(idx++, G, 1, "corner", "bl"); // bottom-left
  for (let k = 0; k < perSide; k++) add(idx++, G - 1 - k, 1, "left"); // left, upward
  add(idx++, 1, 1, "corner", "tl"); // top-left
  for (let k = 0; k < perSide; k++) add(idx++, 1, 2 + k, "top"); // top, rightward
  add(idx++, 1, G, "corner", "tr"); // top-right
  for (let k = 0; k < perSide; k++) add(idx++, 2 + k, G, "right"); // right, downward

  return {
    tileCount,
    perSide,
    gridSize: G,
    tiles,
    center: { row: 2, column: 2, span: perSide },
  };
}
