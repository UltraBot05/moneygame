import { describe, expect, it } from "vitest";
import grand from "../../../boards/world-tour/grand.json";
import standard from "../../../boards/world-tour/standard.json";
import type { BoardDefinition } from "./index";
import { createGame, type GameState } from "./game";

/**
 * SPIKE-005 — rematch / board-contamination isolation, proven on the pure
 * fresh-state factory. These tests do MORE than compare initial JSON: they
 * aggressively mutate one game and prove a later game shares no nested
 * structure, catching shallow-copy contamination.
 */

const standardBoard: BoardDefinition = standard;
const grandBoard: BoardDefinition = grand;
const PLAYERS = ["google:alice", "google:bob", "google:carol"];

/** Aggressively dirties every mutable field of a game, in place. */
function dirty(state: GameState): void {
  state.gameVersion += 137;
  state.ownership[0] = "google:alice";
  state.ownership[state.tileCount - 1] = "google:bob";
  state.buildings[0] = 4;
  state.mortgaged[1] = true;
  state.players[0]!.balance = 999999;
  state.players[0]!.position = 27;
  state.players[1]!.status = "BANKRUPT";
  state.decks.surprise!.push("INJECTED");
  state.decks.surprise![0] = "TAMPERED";
  state.deckPointers.surprise = 5;
  state.decks.chest!.pop();
  state.trades.push({ tradeId: "t1", from: "google:alice", to: "google:bob" });
  state.auction = { tileIndex: 3, highBid: 500, highBidder: "google:carol" };
  state.debts.push({ debtor: "google:bob", creditor: "google:alice", amount: 250 });
  state.turn = { turnId: "turn-7", activePlayerIndex: 1 };
}

/** A pristine fresh game for the given board (all mutable subsystems empty). */
function expectPristine(state: GameState, board: BoardDefinition): void {
  expect(state.boardId).toBe(board.boardId);
  expect(state.boardVersion).toBe(board.boardVersion);
  expect(state.tileCount).toBe(board.tileCount);
  expect(state.gameVersion).toBe(0);
  expect(state.ownership).toHaveLength(board.tileCount);
  expect(state.ownership.every((o) => o === null)).toBe(true);
  expect(state.buildings.every((b) => b === 0)).toBe(true);
  expect(state.mortgaged.every((m) => m === false)).toBe(true);
  expect(state.players.every((p) => p.status === "ACTIVE" && p.position === 0)).toBe(true);
  expect(state.deckPointers).toEqual({ surprise: 0, chest: 0 });
  expect(state.decks.surprise).toHaveLength(12);
  expect(state.decks.surprise).not.toContain("INJECTED");
  expect(state.decks.surprise).not.toContain("TAMPERED");
  expect(state.trades).toHaveLength(0);
  expect(state.auction).toBeNull();
  expect(state.debts).toHaveLength(0);
  expect(state.turn).toBeNull();
}

describe("SPIKE-005 createGame identity + fresh state", () => {
  it("stamps correct immutable board identity and tile count", () => {
    const std = createGame({ gameId: "g1", board: standardBoard, playerIds: PLAYERS, seed: 1 });
    const grd = createGame({ gameId: "g2", board: grandBoard, playerIds: PLAYERS, seed: 1 });
    expect(std.tileCount).toBe(40);
    expect(grd.tileCount).toBe(52);
    expect(std.boardId).toBe("world-tour-standard");
    expect(grd.boardId).toBe("world-tour-grand");
    expectPristine(std, standardBoard);
    expectPristine(grd, grandBoard);
  });

  it("is deterministic for a fixed seed and varies with the seed", () => {
    const a = createGame({ gameId: "g", board: standardBoard, playerIds: PLAYERS, seed: 42 });
    const b = createGame({ gameId: "g", board: standardBoard, playerIds: PLAYERS, seed: 42 });
    const c = createGame({ gameId: "g", board: standardBoard, playerIds: PLAYERS, seed: 43 });
    expect(a.decks.surprise).toEqual(b.decks.surprise);
    expect(a.decks.surprise).not.toEqual(c.decks.surprise);
  });
});

describe("SPIKE-005 aliasing / shallow-copy contamination", () => {
  it("a heavily mutated game A does not contaminate a later game B", () => {
    const a = createGame({ gameId: "A", board: standardBoard, playerIds: PLAYERS, seed: 1 });
    dirty(a);
    const b = createGame({ gameId: "B", board: standardBoard, playerIds: PLAYERS, seed: 1 });
    expectPristine(b, standardBoard);

    // Mutating A AFTER B exists must not change B.
    a.ownership[5] = "google:carol";
    a.decks.chest!.push("LATE");
    expectPristine(b, standardBoard);

    // Mutating B must not change A.
    const aOwner0 = a.ownership[0];
    b.ownership[0] = "google:bob";
    expect(a.ownership[0]).toBe(aOwner0);
  });

  it("shares no nested references between two games", () => {
    const a = createGame({ gameId: "A", board: standardBoard, playerIds: PLAYERS, seed: 7 });
    const b = createGame({ gameId: "B", board: standardBoard, playerIds: PLAYERS, seed: 7 });
    expect(a.ownership).not.toBe(b.ownership);
    expect(a.buildings).not.toBe(b.buildings);
    expect(a.mortgaged).not.toBe(b.mortgaged);
    expect(a.players).not.toBe(b.players);
    expect(a.players[0]).not.toBe(b.players[0]);
    expect(a.decks).not.toBe(b.decks);
    expect(a.decks.surprise).not.toBe(b.decks.surprise);
    expect(a.deckPointers).not.toBe(b.deckPointers);
    expect(a.trades).not.toBe(b.trades);
    expect(a.debts).not.toBe(b.debts);
  });

  it("never mutates the immutable board definition", () => {
    const frozen = Object.freeze({ ...standardBoard });
    const g = createGame({ gameId: "A", board: frozen, playerIds: PLAYERS, seed: 1 });
    // Heavy mutation of game state must not touch the frozen board (no throw,
    // no aliasing of the board object into mutable game state).
    expect(() => dirty(g)).not.toThrow();
    expect(frozen.tileCount).toBe(40);
    expect(frozen.boardId).toBe("world-tour-standard");
  });

  it("does not alias the caller's playerIds input array", () => {
    const ids = ["google:alice", "google:bob", "google:carol"];
    const g = createGame({ gameId: "A", board: standardBoard, playerIds: ids, seed: 1 });
    ids.push("google:mallory");
    expect(g.players).toHaveLength(3);
  });
});

describe("SPIKE-005 hundreds+ deterministic rematch cycles", () => {
  const CYCLES = 300;
  const classes: Array<[string, BoardDefinition, BoardDefinition]> = [
    ["Standard->Standard", standardBoard, standardBoard],
    ["Standard->Grand", standardBoard, grandBoard],
    ["Grand->Standard", grandBoard, standardBoard],
  ];

  for (const [label, first, second] of classes) {
    it(`${label}: ${CYCLES} cycles, every game pristine and uniquely identified`, () => {
      const seenIds = new Set<string>();
      let prev = createGame({ gameId: `${label}-0`, board: first, playerIds: PLAYERS, seed: 0 });
      seenIds.add(prev.gameId);

      for (let i = 1; i <= CYCLES; i++) {
        dirty(prev); // aggressively dirty the outgoing game first
        const board = i % 2 === 1 ? second : first;
        const gameId = `${label}-${i}`;
        const next = createGame({ gameId, board, playerIds: PLAYERS, seed: i });

        expect(seenIds.has(gameId)).toBe(false); // new gameId every rematch
        seenIds.add(gameId);
        expect(next.gameId).not.toBe(prev.gameId);
        expectPristine(next, board);
        // The dirtied previous game must not have leaked into the fresh one.
        expect(next.ownership).not.toBe(prev.ownership);
        expect(next.decks.surprise).not.toBe(prev.decks.surprise);

        prev = next;
      }
      expect(seenIds.size).toBe(CYCLES + 1);
    });
  }
});
