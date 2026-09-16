import { describe, expect, it } from "vitest";
import standardFixture from "../../../boards/world-tour/standard.json";
import { parseBoardDefinition } from "./board";
import { CommandValidationError } from "./command";
import { applyGameplayCommand, type GameplayCommandContext } from "./gameplay";
import { createSeededRandom } from "./random";
import { createInitialGameState, GameStateValidationError, parseGameState } from "./state";

const board = parseBoardDefinition(standardFixture);
const playerIds = ["google:carol", "google:alice", "google:bob"];

function command(type: string, actionId: string, expectedGameVersion?: number) {
  return {
    type,
    gameId: "game-1",
    actionId,
    ...(expectedGameVersion === undefined ? {} : { expectedGameVersion }),
    payload: {},
  };
}

function context(
  actorUserId: string,
  rng: GameplayCommandContext["rng"] = createSeededRandom(4),
): GameplayCommandContext {
  return { actorUserId, board, rng };
}

function accepted(result: ReturnType<typeof applyGameplayCommand>) {
  expect(result.kind).toBe("ACCEPTED");
  if (result.kind !== "ACCEPTED") throw new Error("expected accepted result");
  return result;
}

function startedGame() {
  const initial = createInitialGameState({ gameId: "game-1", board, playerIds });
  return accepted(
    applyGameplayCommand(initial, command("START_GAME", "start", 0), context(playerIds[0]!)),
  ).state;
}

function rollCurrentTurn(
  state: ReturnType<typeof startedGame>,
  actionId: string,
) {
  const activePlayerId = state.turn?.activePlayerId;
  expect(activePlayerId).toBeDefined();
  const values = [0, 0.2];
  let calls = 0;
  const rolled = accepted(
    applyGameplayCommand(
      state,
      command("ROLL_DICE", actionId, state.gameVersion),
      context(activePlayerId!, () => values[calls++] as number),
    ),
  ).state;
  return parseGameState({ ...rolled, pendingResolution: null }, board);
}

describe("CORE-006 turn lifecycle", () => {
  it("starts with exactly one deterministic owner in explicit seat order", () => {
    const first = startedGame();
    const replay = startedGame();

    expect(first.phase).toBe("ACTIVE_TURN");
    expect(first.turn).toEqual({
      turnId: "turn-1",
      activePlayerId: "google:carol",
      turnNumber: 1,
      hasRolled: false,
      rollAgain: false,
      consecutiveDoubles: 0,
    });
    expect(replay.turn).toEqual(first.turn);
  });

  it("advances once and wraps to the first eligible seat", () => {
    let state = startedGame();
    for (let index = 1; index <= 3; index += 1) {
      state = rollCurrentTurn(state, "roll-" + index);
      const current = state.turn?.activePlayerId;
      expect(current).toBeDefined();
      state = accepted(
        applyGameplayCommand(
          state,
          command("END_TURN", "end-" + index, state.gameVersion),
          context(current!),
        ),
      ).state;
    }

    expect(state.turn).toMatchObject({
      activePlayerId: "google:carol",
      turnNumber: 4,
    });
    expect(state.gameVersion).toBe(7);
  });

  it("rejects pre-roll END_TURN without changing owner or version, then advances post-roll", () => {
    const active = startedGame();
    const rejected = applyGameplayCommand(
      active,
      command("END_TURN", "pre-roll-end", active.gameVersion),
      context("google:carol"),
    );

    expect(rejected).toMatchObject({
      kind: "REJECTED",
      reason: "ROLL_REQUIRED",
      state: {
        gameVersion: active.gameVersion,
        turn: {
          activePlayerId: "google:carol",
          turnNumber: 1,
          hasRolled: false,
        },
      },
    });

    const rolled = rollCurrentTurn(active, "required-roll");
    const advanced = accepted(
      applyGameplayCommand(
        rolled,
        command("END_TURN", "post-roll-end", rolled.gameVersion),
        context("google:carol"),
      ),
    ).state;
    expect(advanced.turn).toMatchObject({
      activePlayerId: "google:alice",
      turnNumber: 2,
      hasRolled: false,
    });
  });

  it("skips bankrupt players and ends when only one active player remains", () => {
    const started = startedGame();
    const withMiddlePlayerBankrupt = parseGameState(
      {
        ...started,
        players: started.players.map((player) => ({
          ...player,
          status: player.userId === "google:alice" ? "BANKRUPT" : player.status,
        })),
      },
      board,
    );
    const rolledBeforeSkip = rollCurrentTurn(withMiddlePlayerBankrupt, "roll-before-skip");
    const skipped = accepted(
      applyGameplayCommand(
        rolledBeforeSkip,
        command("END_TURN", "skip", rolledBeforeSkip.gameVersion),
        context("google:carol"),
      ),
    ).state;
    expect(skipped.turn?.activePlayerId).toBe("google:bob");

    const withOneActive = parseGameState(
      {
        ...skipped,
        players: skipped.players.map((player) => ({
          ...player,
          status: player.userId === "google:bob" ? "ACTIVE" : "BANKRUPT",
        })),
      },
      board,
    );
    const rolledBeforeFinish = rollCurrentTurn(withOneActive, "roll-before-finish");
    const ended = accepted(
      applyGameplayCommand(
        rolledBeforeFinish,
        command("END_TURN", "finish", rolledBeforeFinish.gameVersion),
        context("google:bob"),
      ),
    );
    expect(ended.state).toMatchObject({ phase: "GAME_OVER", turn: null });
    expect(ended.event).toMatchObject({ type: "GAME_ENDED", winnerUserId: "google:bob" });
  });

  it("cannot advance before start, after end, or for a non-owner", () => {
    const initial = createInitialGameState({ gameId: "game-1", board, playerIds });
    expect(
      applyGameplayCommand(initial, command("END_TURN", "early"), context("google:carol")),
    ).toMatchObject({ kind: "REJECTED", reason: "GAME_NOT_STARTED" });

    const active = startedGame();
    expect(
      applyGameplayCommand(active, command("END_TURN", "wrong"), context("google:alice")),
    ).toMatchObject({ kind: "REJECTED", reason: "NOT_YOUR_TURN" });

    const ended = parseGameState({ ...active, phase: "GAME_OVER", turn: null }, board);
    expect(
      applyGameplayCommand(ended, command("END_TURN", "late"), context("google:carol")),
    ).toMatchObject({ kind: "REJECTED", reason: "GAME_ALREADY_ENDED" });
  });

  it("rejects malformed and duplicate canonical player identities", () => {
    const initial = createInitialGameState({ gameId: "game-1", board, playerIds });
    const duplicate = {
      ...initial,
      players: initial.players.map((player, index) => ({
        ...player,
        userId: index === 1 ? initial.players[0]!.userId : player.userId,
      })),
    };
    expect(() =>
      applyGameplayCommand(duplicate, command("START_GAME", "bad"), context("google:carol")),
    ).toThrow(GameStateValidationError);
  });

  it("rechecks the approved three-player minimum when starting", () => {
    const initial = createInitialGameState({ gameId: "game-1", board, playerIds });
    const twoPlayerState = parseGameState(
      { ...initial, players: initial.players.slice(0, 2) },
      board,
    );
    expect(
      applyGameplayCommand(
        twoPlayerState,
        command("START_GAME", "too-few"),
        context("google:carol"),
      ),
    ).toMatchObject({ kind: "REJECTED", reason: "GAME_NOT_STARTABLE" });
  });
});

describe("CORE-007..009 composed authoritative roll", () => {
  it("uses injected dice, moves, pays Start, and dispatches the landed tile", () => {
    const active = startedGame();
    const nearStart = parseGameState(
      {
        ...active,
        players: active.players.map((player, index) => ({
          ...player,
          position: index === 0 ? 39 : player.position,
        })),
      },
      board,
    );
    const values = [0, 0];
    let calls = 0;
    const result = accepted(
      applyGameplayCommand(
        nearStart,
        command("ROLL_DICE", "roll", nearStart.gameVersion),
        context("google:carol", () => values[calls++] as number),
      ),
    );

    expect(calls).toBe(2);
    expect(result.event).toMatchObject({
      type: "DICE_ROLLED",
      roll: { dice: [1, 1], total: 2, doubles: true, consecutiveDoubles: 1 },
      movement: { from: 39, to: 1, startCrossings: 1, startAward: 200 },
      resolution: { kind: "PROPERTY", tileIndex: 1, propertyId: "EG-1" },
    });
    expect(result.state.players[0]).toMatchObject({ position: 1, cash: 2200 });
    expect(result.state.turn?.hasRolled).toBe(true);
    expect(result.state.turn).toMatchObject({ rollAgain: true, consecutiveDoubles: 1 });
  });

  it("never accepts client-supplied dice or a second roll in the same turn", () => {
    const active = startedGame();
    const forged = {
      ...command("ROLL_DICE", "forged", active.gameVersion),
      payload: { dice: [6, 6], total: 12 },
    };
    expect(() =>
      applyGameplayCommand(active, forged, context("google:carol", () => 0)),
    ).toThrow(CommandValidationError);

    const rolled = accepted(
      applyGameplayCommand(
        active,
        command("ROLL_DICE", "first", active.gameVersion),
        context("google:carol", (() => {
          const values = [0, 0.2];
          let index = 0;
          return () => values[index++] as number;
        })()),
      ),
    ).state;
    expect(
      applyGameplayCommand(
        parseGameState({ ...rolled, pendingResolution: null }, board),
        command("ROLL_DICE", "second", rolled.gameVersion),
        context("google:carol", () => 0),
      ),
    ).toMatchObject({ kind: "REJECTED", reason: "ROLL_ALREADY_COMPLETED" });
  });

  it("preserves optional expectedGameVersion and duplicate action semantics", () => {
    const active = startedGame();
    expect(
      applyGameplayCommand(
        active,
        command("END_TURN", "stale", active.gameVersion - 1),
        context("google:carol"),
      ),
    ).toMatchObject({
      kind: "REJECTED",
      reason: "STALE_GAME_VERSION",
      currentGameVersion: active.gameVersion,
    });

    const rolled = rollCurrentTurn(active, "roll-for-optional-version");
    const withoutVersion = accepted(
      applyGameplayCommand(rolled, command("END_TURN", "optional"), context("google:carol")),
    );
    expect(withoutVersion.state.gameVersion).toBe(rolled.gameVersion + 1);

    const duplicateContext = {
      ...context("google:carol"),
      appliedActions: [{
        gameId: "game-1",
        actionId: "repeat",
        resultingGameVersion: active.gameVersion,
      }],
    };
    expect(
      applyGameplayCommand(
        active,
        command("END_TURN", "repeat", active.gameVersion - 1),
        duplicateContext,
      ),
    ).toMatchObject({
      kind: "DUPLICATE_ACTION",
      committedGameVersion: active.gameVersion,
    });
  });
});

describe("CORE-012 doubles continuation integration", () => {
  function withoutPending(state: ReturnType<typeof startedGame>) {
    return parseGameState({ ...state, pendingResolution: null }, board);
  }

  it("permits consecutive doubles, persists their count, and blocks through resolution", () => {
    let state = startedGame();
    const first = accepted(applyGameplayCommand(
      state,
      command("ROLL_DICE", "double-1", state.gameVersion),
      context("google:carol", () => 0),
    ));
    expect(first.state.turn).toMatchObject({
      hasRolled: true,
      rollAgain: true,
      consecutiveDoubles: 1,
    });
    expect(first.state.pendingResolution?.continuation).toEqual({ type: "ROLL_AGAIN" });

    let rngCalls = 0;
    expect(applyGameplayCommand(
      first.state,
      command("ROLL_DICE", "blocked-double", first.state.gameVersion),
      context("google:carol", () => { rngCalls += 1; return 0; }),
    )).toMatchObject({ kind: "REJECTED", reason: "PENDING_RESOLUTION" });
    expect(rngCalls).toBe(0);

    state = withoutPending(first.state);
    const second = accepted(applyGameplayCommand(
      state,
      command("ROLL_DICE", "double-2", state.gameVersion),
      context("google:carol", () => 0),
    ));
    expect(second.event).toMatchObject({
      type: "DICE_ROLLED",
      roll: { consecutiveDoubles: 2, isThirdConsecutiveDouble: false },
    });

    state = withoutPending(second.state);
    const third = accepted(applyGameplayCommand(
      state,
      command("ROLL_DICE", "double-3", state.gameVersion),
      context("google:carol", () => 0),
    ));
    expect(third.event).toMatchObject({
      type: "DICE_ROLLED",
      roll: { consecutiveDoubles: 3, isThirdConsecutiveDouble: true },
    });
    expect(third.state.turn).toMatchObject({ rollAgain: true, consecutiveDoubles: 3 });
  });

  it("replays the same continuation sequence from the same state and seed", () => {
    const initial = startedGame();
    const replay = () => {
      let state = initial;
      const rng = createSeededRandom(11);
      const rolls = [];
      for (let index = 0; index < 4; index += 1) {
        const result = accepted(applyGameplayCommand(
          state,
          command("ROLL_DICE", "seeded-" + index, state.gameVersion),
          context("google:carol", rng),
        ));
        if (result.event.type !== "DICE_ROLLED") throw new Error("expected dice event");
        rolls.push(result.event.roll);
        state = withoutPending(result.state);
        if (!state.turn?.rollAgain) break;
      }
      return rolls;
    };
    const first = replay();
    expect(first.slice(0, 2)).toMatchObject([
      { doubles: true, consecutiveDoubles: 1 },
      { doubles: true, consecutiveDoubles: 2 },
    ]);
    expect(replay()).toEqual(first);
  });

  it("ends only after a non-double and resets continuation for the next owner", () => {
    const active = startedGame();
    const doubled = accepted(applyGameplayCommand(
      active,
      command("ROLL_DICE", "double", active.gameVersion),
      context("google:carol", () => 0),
    )).state;
    const continuation = withoutPending(doubled);
    expect(applyGameplayCommand(
      continuation,
      command("END_TURN", "premature-end", continuation.gameVersion),
      context("google:carol"),
    )).toMatchObject({ kind: "REJECTED", reason: "ROLL_REQUIRED" });

    const values = [0, 0.2];
    let calls = 0;
    const completed = accepted(applyGameplayCommand(
      continuation,
      command("ROLL_DICE", "non-double", continuation.gameVersion),
      context("google:carol", () => values[calls++] as number),
    )).state;
    expect(completed.turn).toMatchObject({ rollAgain: false, consecutiveDoubles: 0 });
    const advanced = accepted(applyGameplayCommand(
      withoutPending(completed),
      command("END_TURN", "advance", completed.gameVersion),
      context("google:carol"),
    )).state;
    expect(advanced.turn).toMatchObject({
      activePlayerId: "google:alice",
      hasRolled: false,
      rollAgain: false,
      consecutiveDoubles: 0,
    });
  });
});
