/**
 * Pure, framework-free game core. Must not import React, DOM/browser APIs,
 * Cloudflare, D1, WebSockets, Google auth or UI libraries (ARCHITECTURE.md §5).
 *
 * Generic board types live here; product-specific board data is authored under
 * `boards/`. Game logic (state, rules, RNG) and the board validator (CORE-001)
 * arrive in later tasks.
 */

/** Inclusive recommended player range for a board (a lobby guideline). */
export interface RecommendedPlayers {
  readonly min: number;
  readonly max: number;
}

/**
 * Immutable identity of a board. Not the full board: tiles, sets, decks, prices
 * and rules are authored/validated later (CORE-001). `ref` is the stable
 * `<boardId>@<boardVersion>` identity recorded with every match.
 */
export interface BoardDefinition {
  readonly ref: string;
  readonly boardId: string;
  readonly boardVersion: number;
  readonly tileCount: number;
  readonly recommendedPlayers: RecommendedPlayers;
}
