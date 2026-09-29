import { describe, expect, it } from "vitest";
import {
  applyGameplayCommand,
  canonicalBoard,
  createInitialGameState,
  projectGameState,
  type GameState,
} from "@moneygame/game-core";
import { DEFAULT_ROOM_SETTINGS, type RoomView } from "@moneygame/shared";
import { boardModel, deedModel, describeEvent, fitName, money, playerModels, turnModel } from "./view-model";

const REF = "world-tour-standard@1";
const { board, cards } = canonicalBoard(REF);
const IDS = ["u-a", "u-b", "u-c"];
const room: RoomView = {
  roomCode: "ROOM42", hostUserId: "u-a", phase: "IN_GAME", paused: false, settings: DEFAULT_ROOM_SETTINGS, turnDeadlineAt: null,
  members: IDS.map((userId, seatIndex) => ({ userId, displayName: "Player " + userId.slice(2).toUpperCase(), seatIndex, ready: true, connected: true, away: false })),
};

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

function started(): GameState {
  const initial = createInitialGameState({ gameId: "g1", board, playerIds: IDS, startingCash: 2000 });
  return run(initial, "u-a", "START_GAME", {}).state;
}

describe("board model", () => {
  it("gives every set a distinct colour and pattern on both boards", () => {
    for (const [ref, tiles, sets] of [[REF, 40, 8], ["world-tour-grand@1", 52, 12]] as const) {
      const model = boardModel(ref);
      expect(model.tiles).toHaveLength(tiles);
      expect(model.sets).toHaveLength(sets);
      expect(new Set(model.sets.map((set) => set.color + set.pattern)).size).toBe(sets);
      expect(model.sets.flatMap((set) => set.tileIndexes)).toHaveLength(model.tiles.filter((tile) => tile.kind === "property").length);
    }
    expect(boardModel(REF).sets.find((set) => set.setId === "SA")?.code).toBe("SA");
    expect(boardModel(REF).sets.find((set) => set.setId === "EG")?.code).toBe("EGYPT");
    expect(boardModel(REF).tiles[10]?.corner).toBe("HOLDING");
  });

  it("fits long tile names at real syllables instead of mid-letter", () => {
    expect(fitName("Heathrow", 6.5)).toEqual({ text: "Heath\u00ADrow", fit: 1 });
    expect(fitName("Cape Town", 6.5)).toEqual({ text: "Cape Town", fit: 1 });
    expect(fitName("Surprise", 6.5).fit).toBeCloseTo(6.5 / 8);
    expect(fitName("Johannesburg", 8.5).text).toBe("Johannes\u00ADburg");
    for (const tile of [...boardModel(REF).tiles, ...boardModel("world-tour-grand@1").tiles]) {
      expect(fitName(tile.name, 6.5).fit, tile.name).toBeGreaterThanOrEqual(0.7);
    }
  });

  it("formats money with separators and sign", () => {
    expect(money(1250)).toBe("$1,250");
    expect(money(-50)).toBe("-$50");
  });
});

describe("turn model", () => {
  it("offers the roll only to the active player", () => {
    const state = started();
    const game = projectGameState(state, null);
    const model = boardModel(REF);
    const active = state.turn?.activePlayerId as string;
    const other = IDS.find((id) => id !== active) as string;
    expect(turnModel(game, room, model, active).primary?.intent.type).toBe("ROLL_DICE");
    expect(turnModel(game, room, model, other)).toMatchObject({ primary: null, isMine: false });
  });

  it("turns an unowned landing into buy or decline, then end turn", () => {
    const start = started();
    const active = start.turn?.activePlayerId as string;
    const rolled = run(start, active, "ROLL_DICE", {}, dice(2, 4));
    const model = boardModel(REF);
    const game = projectGameState(rolled.state, active);
    const turn = turnModel(game, room, model, active);
    expect(turn.primary?.intent).toEqual({ type: "BUY_PROPERTY", payload: { resolutionId: rolled.state.pendingResolution?.resolutionId } });
    expect(turn.secondary.map((action) => action.intent.type)).toEqual(["DECLINE_PROPERTY"]);
    expect(describeEvent(rolled.event, game, model, (id) => id).join(" ")).toContain("moved to " + model.tiles[6]?.name);

    const bought = run(rolled.state, active, "BUY_PROPERTY", { resolutionId: rolled.state.pendingResolution?.resolutionId });
    const after = projectGameState(bought.state, active);
    expect(turnModel(after, room, model, active).primary?.intent.type).toBe("END_TURN");
    const deed = deedModel(after, model, 6, active);
    expect(deed?.ownerUserId).toBe(active);
    expect(deed?.actions.find((action) => action.intent.type === "BUILD")?.disabledReason).toBe("Own the full set first");
    expect(deed?.actions.find((action) => action.intent.type === "MORTGAGE")?.disabledReason).toBeUndefined();
    expect(deedModel(after, model, 6, IDS.find((id) => id !== active) ?? null)?.actions).toEqual([]);
    expect(playerModels(after, room, model).find((player) => player.userId === active)?.deeds).toBe(1);
  });
});
