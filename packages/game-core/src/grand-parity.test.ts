import { describe, expect, it } from "vitest";
import { canonicalBoard } from "./catalog";
import { applyGameplayCommand } from "./gameplay";
import { createInitialGameState, holdingTileIndex, parseGameState, type GameState } from "./state";

/** GRAND-001: the frozen 52/12/30 Grand definition runs on the shared production rule path. */
const { board, cards } = canonicalBoard("world-tour-grand@1");
const IDS = ["g0", "g1", "g2", "g3", "g4", "g5"];

function dice(...faces: number[]): () => number {
  const queue = faces.map((face) => (face - 1) / 6 + 0.001);
  return () => queue.shift() ?? 0.5;
}

function run(state: GameState, type: string, payload: unknown, rng = dice()) {
  const actor = state.turn?.activePlayerId ?? "g0";
  const result = applyGameplayCommand(state, { type, gameId: state.gameId, actionId: type + ":" + state.gameVersion, expectedGameVersion: state.gameVersion, payload },
    { actorUserId: actor, board, rng, cardCatalog: cards, currentTime: 1_000, auctionDecisionDeadlineAt: 21_000, debtDeadlineAt: 121_000 });
  if (result.kind !== "ACCEPTED") throw new Error(type + " refused: " + JSON.stringify(result));
  return result;
}

function startedAt(position: number): GameState {
  const started = run(createInitialGameState({ gameId: "grand", board, playerIds: IDS }), "START_GAME", {}).state;
  const active = started.turn?.activePlayerId;
  return parseGameState({ ...started, players: started.players.map((player) => player.userId === active ? { ...player, position } : player) }, board, cards);
}

describe("GRAND-001 production parity", () => {
  it("keeps the frozen Grand structure", () => {
    const tiles = board.economyProfile.tiles;
    expect(tiles).toHaveLength(52);
    expect(board.economyProfile.sets).toHaveLength(12);
    expect(tiles.filter((tile) => tile.type === "property")).toHaveLength(30);
    expect(holdingTileIndex(board)).toBe(13);
    expect(tiles.filter((tile) => tile.type === "grand-special").map((tile) => tile.index)).toEqual([11, 24, 25]);
    expect(tiles[31]).toMatchObject({ type: "card", deck: "surprise" });
  });

  it("treats every reserved Grand special as a neutral landing", () => {
    for (const [from, a, b, special] of [[0, 5, 6, 11], [18, 2, 4, 24], [20, 1, 4, 25]] as const) {
      const state = startedAt(from);
      const rolled = run(state, "ROLL_DICE", {}, dice(a, b));
      const mover = rolled.state.players.find((player) => player.userId === state.turn?.activePlayerId);
      expect(rolled.event).toMatchObject({ type: "DICE_ROLLED", resolution: { kind: "GRAND_SPECIAL", tileIndex: special } });
      expect(rolled.state.pendingResolution).toBeNull();
      expect(mover?.cash).toBe(state.players.find((player) => player.userId === mover?.userId)?.cash);
    }
  });

  it("sends Go To Holding (39) to Holding (13) with no Start salary", () => {
    const state = startedAt(33);
    const rolled = run(state, "ROLL_DICE", {}, dice(2, 4));
    const mover = rolled.state.players.find((player) => player.userId === state.turn?.activePlayerId);
    expect(mover).toMatchObject({ position: 13, inHolding: true, cash: 2000 });
  });

  it("draws from the Grand Surprise deck on tile 31", () => {
    const state = startedAt(25);
    const rolled = run(state, "ROLL_DICE", {}, dice(2, 4));
    expect(rolled.state.pendingResolution).toMatchObject({ kind: "CARD", source: { tileIndex: 31 } });
    const drawn = run(rolled.state, "DRAW_CARD", { resolutionId: rolled.state.pendingResolution?.resolutionId });
    expect(drawn.event).toMatchObject({ type: "CARD_RESOLVED" });
    expect(drawn.state.ruleState.decks.map((deck) => deck.deckId).sort()).toEqual(["surprise", "treasure"]);
  });
});
