/**
 * SPIKE-005 fresh-game / rematch isolation core (pure, framework-free).
 *
 * `createGame` builds a brand-new mutable `GameState` for a rematch. Its job in
 * this spike is to PROVE isolation, not to implement gameplay: every mutable
 * structure (ownership, buildings, mortgages, players, decks, trades, auction,
 * debt, turn) is freshly allocated and shares NO reference with any previous
 * game, the caller's inputs, or the immutable board definition. The rich rules
 * that fill these fields arrive in later CORE-/RULE- tasks.
 *
 * No real country/card/economy content is authored here — GOV-003 owns that.
 * Deck fixtures are opaque synthetic ids (`s0`, `c1`, …) whose only purpose is
 * to demonstrate that deck progress cannot leak across games. Starting cash is a
 * clearly-labelled spike fixture, not the authored economy table (ADR-004).
 */

import type { BoardDefinition } from "./board";
import { createSeededRandom, shuffle, type RandomSource } from "./random";

/** Spike fixture only — NOT the authored ADR-004 economy. Isolation proofs do
 *  not depend on the value; it merely gives players a mutable balance field. */
const SPIKE_FIXTURE_STARTING_CASH = 2000;

export type PlayerStatus = "ACTIVE" | "BANKRUPT";

export interface PlayerState {
  userId: string;
  balance: number;
  position: number;
  status: PlayerStatus;
}

export interface TradeState {
  tradeId: string;
  from: string;
  to: string;
}

export interface AuctionState {
  tileIndex: number;
  highBid: number;
  highBidder: string | null;
}

export interface DebtState {
  debtor: string;
  creditor: string;
  amount: number;
}

export interface TurnState {
  turnId: string;
  activePlayerIndex: number;
}

/**
 * Minimal mutable match state. Board identity is copied in as primitives so the
 * immutable {@link BoardDefinition} is never aliased into mutable state.
 */
export interface GameState {
  gameId: string;
  boardId: string;
  boardVersion: number;
  tileCount: number;
  gameVersion: number;
  /** Per-tile owner userId, or null. Length === tileCount. */
  ownership: (string | null)[];
  /** Per-tile building count. Length === tileCount. */
  buildings: number[];
  /** Per-tile mortgage flag. Length === tileCount. */
  mortgaged: boolean[];
  players: PlayerState[];
  /** Synthetic opaque deck fixtures: deck name -> ordered card ids. */
  decks: Record<string, string[]>;
  /** Draw pointer per deck (deck progress). */
  deckPointers: Record<string, number>;
  trades: TradeState[];
  auction: AuctionState | null;
  debts: DebtState[];
  turn: TurnState | null;
}

/** Builds a synthetic opaque deck (`<prefix>0`…) — no authored card content. */
function syntheticDeck(prefix: string, size: number, rng: RandomSource): string[] {
  const ids: string[] = [];
  for (let i = 0; i < size; i++) ids.push(`${prefix}${i}`);
  return shuffle(ids, rng);
}

export interface CreateGameInput {
  gameId: string;
  board: BoardDefinition;
  /** Authenticated seat userIds joining the fresh game. */
  playerIds: readonly string[];
  /** Deterministic seed for deck order. */
  seed: number;
  /** Spike fixture; defaults to {@link SPIKE_FIXTURE_STARTING_CASH}. */
  startingCash?: number;
}

/**
 * Creates a fresh, fully-isolated `GameState`. Every array/record/object is
 * newly allocated here; nothing is shared with `input`, the board, or any prior
 * game. `gameVersion` starts at 0; all mutable subsystems start empty.
 */
export function createGame(input: CreateGameInput): GameState {
  const { gameId, board, playerIds, seed } = input;
  const cash = input.startingCash ?? SPIKE_FIXTURE_STARTING_CASH;
  const rng = createSeededRandom(seed);

  const players: PlayerState[] = playerIds.map((userId) => ({
    userId,
    balance: cash,
    position: 0,
    status: "ACTIVE",
  }));

  return {
    gameId,
    boardId: board.boardId,
    boardVersion: board.boardVersion,
    tileCount: board.tileCount,
    gameVersion: 0,
    ownership: new Array<string | null>(board.tileCount).fill(null),
    buildings: new Array<number>(board.tileCount).fill(0),
    mortgaged: new Array<boolean>(board.tileCount).fill(false),
    players,
    // Sizes are spike fixtures, deliberately independent of any authored deck.
    decks: {
      surprise: syntheticDeck("s", 12, rng),
      chest: syntheticDeck("c", 12, rng),
    },
    deckPointers: { surprise: 0, chest: 0 },
    trades: [],
    auction: null,
    debts: [],
    turn: null,
  };
}
