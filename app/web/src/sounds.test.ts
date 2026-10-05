import { describe, expect, it } from "vitest";
import { applyGameplayCommand, canonicalBoard, createInitialGameState, projectGameState, type GameState } from "@moneygame/game-core";
import { boardModel } from "./view-model";
import { soundsFor } from "./sounds";

const REF = "world-tour-standard@1";
const { board, cards } = canonicalBoard(REF);
const IDS = ["u-a", "u-b", "u-c"];

function dice(...faces: number[]): () => number {
  const queue = faces.map((face) => (face - 1) / 6 + 0.001);
  return () => queue.shift() ?? 0.5;
}

function run(state: GameState, actor: string, type: string, payload: unknown, rng = dice()) {
  const result = applyGameplayCommand(state, { type, gameId: state.gameId, actionId: type + state.gameVersion, expectedGameVersion: state.gameVersion, payload },
    { actorUserId: actor, board, rng, cardCatalog: cards, currentTime: 1000 });
  if (result.kind !== "ACCEPTED") throw new Error("refused: " + JSON.stringify(result));
  return result;
}

describe("game sounds", () => {
  const begun = run(createInitialGameState({ gameId: "g1", board, playerIds: IDS, startingCash: 2000 }), "u-a", "START_GAME", {});
  const active = begun.state.turn?.activePlayerId as string;
  const other = IDS.find((id) => id !== active) as string;
  // The first property a first roll of 1 + (target - 1) reaches without a double.
  const target = boardModel(REF).tiles.find((tile) => tile.kind === "property" && tile.index >= 3 && tile.index <= 7)?.index as number;

  it("tells only the player whose turn it is", () => {
    expect(soundsFor(begun.event, projectGameState(begun.state, null), active)).toEqual(["turn"]);
    expect(soundsFor(begun.event, projectGameState(begun.state, null), other)).toEqual([]);
  });

  it("rattles the dice, and adds a coin when the pawn lands on someone else's deed", () => {
    const rolled = run(begun.state, active, "ROLL_DICE", {}, dice(1, target - 1));
    const game = projectGameState(rolled.state, null);
    expect(soundsFor(rolled.event, game, other)).toEqual(["dice"]);
    const owned = { ...game, assets: game.assets.map((asset) => (asset.tileIndex === target ? { ...asset, ownerUserId: other } : asset)) };
    expect(soundsFor(rolled.event, owned, other)).toEqual(["dice", "coin"]);

    const bought = run(rolled.state, active, "BUY_PROPERTY", { resolutionId: rolled.state.pendingResolution?.resolutionId });
    expect(soundsFor(bought.event, projectGameState(bought.state, null), other)).toEqual(["coin"]);

    const ended = run(bought.state, active, "END_TURN", {});
    const next = ended.state.turn?.activePlayerId as string;
    expect(soundsFor(ended.event, projectGameState(ended.state, null), next)).toEqual(["turn"]);
    expect(soundsFor(ended.event, projectGameState(ended.state, null), active)).toEqual([]);
  });
});
