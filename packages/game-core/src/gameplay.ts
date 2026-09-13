import { parseBoardDefinition, type BoardDefinition } from "./board";
import {
  classifyGameCommand,
  CommandValidationError,
  parseGameCommand,
  type AppliedActionRecord,
  type GameCommand,
} from "./command";
import { rollDice, type DiceRoll } from "./dice";
import { evaluateLobbyStart } from "./lobby";
import { calculateMovement, type MovementResult } from "./movement";
import type { RandomSource } from "./random";
import {
  parseGameState,
  type GameState,
  type PlayerState,
  type TurnIdentity,
} from "./state";
import { dispatchLandedTile, type TileResolution } from "./tile-dispatch";

export type GameplayCommandType = "START_GAME" | "ROLL_DICE" | "END_TURN";

export interface GameplayCommandContext {
  readonly actorUserId: string;
  readonly board: BoardDefinition;
  readonly rng: RandomSource;
  readonly appliedActions?: readonly AppliedActionRecord[];
}

export type GameplayEvent =
  | {
      readonly type: "GAME_STARTED";
      readonly turnOrder: readonly string[];
      readonly activePlayerId: string;
    }
  | {
      readonly type: "DICE_ROLLED";
      readonly playerId: string;
      readonly roll: DiceRoll;
      readonly movement: MovementResult;
      readonly resolution: TileResolution;
    }
  | {
      readonly type: "TURN_ENDED";
      readonly endedPlayerId: string;
      readonly activePlayerId: string;
    }
  | {
      readonly type: "GAME_ENDED";
      readonly endedPlayerId: string;
      readonly winnerUserId: string | null;
    };

export type GameplayRejectionReason =
  | "STALE_GAME"
  | "STALE_GAME_VERSION"
  | "ACTOR_NOT_IN_GAME"
  | "GAME_NOT_STARTABLE"
  | "GAME_NOT_STARTED"
  | "GAME_ALREADY_STARTED"
  | "GAME_ALREADY_ENDED"
  | "NOT_YOUR_TURN"
  | "PLAYER_NOT_ELIGIBLE"
  | "ROLL_REQUIRED"
  | "ROLL_ALREADY_COMPLETED";

export type GameplayCommandResult =
  | {
      readonly kind: "ACCEPTED";
      readonly state: GameState;
      readonly event: GameplayEvent;
    }
  | {
      readonly kind: "DUPLICATE_ACTION";
      readonly state: GameState;
      readonly committedGameVersion: number;
    }
  | {
      readonly kind: "REJECTED";
      readonly state: GameState;
      readonly reason: GameplayRejectionReason;
      readonly currentGameId?: string;
      readonly currentGameVersion?: number;
    };

function identifier(value: string, field: string): string {
  if (value.trim().length === 0) {
    throw new CommandValidationError(field, "expected a non-empty string");
  }
  return value;
}

function gameplayCommand(command: GameCommand): GameplayCommandType {
  if (
    command.type !== "START_GAME"
    && command.type !== "ROLL_DICE"
    && command.type !== "END_TURN"
  ) {
    throw new CommandValidationError("type", "unknown gameplay command " + command.type);
  }
  if (
    typeof command.payload !== "object"
    || command.payload === null
    || Array.isArray(command.payload)
    || Object.keys(command.payload).length !== 0
  ) {
    throw new CommandValidationError("payload", "expected an empty object");
  }
  return command.type;
}

function rejected(
  state: GameState,
  reason: GameplayRejectionReason,
  details: Readonly<{ currentGameId?: string; currentGameVersion?: number }> = {},
): GameplayCommandResult {
  return Object.freeze({ kind: "REJECTED", state, reason, ...details });
}

function nextTurn(turnNumber: number, activePlayerId: string): TurnIdentity {
  return {
    turnId: "turn-" + turnNumber,
    activePlayerId,
    turnNumber,
    hasRolled: false,
  };
}

function acceptedState(
  state: GameState,
  board: BoardDefinition,
  nextGameVersion: number,
  changes: Readonly<{
    phase?: GameState["phase"];
    turn?: TurnIdentity | null;
    players?: readonly PlayerState[];
  }>,
): GameState {
  return parseGameState(
    {
      ...state,
      ...changes,
      gameVersion: nextGameVersion,
    },
    board,
  );
}

function startGame(
  state: GameState,
  board: BoardDefinition,
  actorUserId: string,
  nextGameVersion: number,
): GameplayCommandResult {
  if (state.phase === "GAME_OVER") return rejected(state, "GAME_ALREADY_ENDED");
  if (state.phase !== "STARTING") return rejected(state, "GAME_ALREADY_STARTED");
  if (!state.players.some((player) => player.userId === actorUserId)) {
    return rejected(state, "ACTOR_NOT_IN_GAME");
  }

  const eligibility = evaluateLobbyStart(state.players.length);
  if (!eligibility.ok || state.players.some((player) => player.status !== "ACTIVE")) {
    return rejected(state, "GAME_NOT_STARTABLE");
  }

  const turnOrder = state.players.map((player) => player.userId);
  const activePlayerId = turnOrder[0];
  if (activePlayerId === undefined) return rejected(state, "GAME_NOT_STARTABLE");

  const nextState = acceptedState(state, board, nextGameVersion, {
    phase: "ACTIVE_TURN",
    turn: nextTurn(1, activePlayerId),
  });
  return Object.freeze({
    kind: "ACCEPTED",
    state: nextState,
    event: Object.freeze({
      type: "GAME_STARTED",
      turnOrder: Object.freeze(turnOrder),
      activePlayerId,
    }),
  });
}

function rollCurrentPlayer(
  state: GameState,
  board: BoardDefinition,
  actorUserId: string,
  rng: RandomSource,
  nextGameVersion: number,
): GameplayCommandResult {
  if (state.phase === "STARTING") return rejected(state, "GAME_NOT_STARTED");
  if (state.phase === "GAME_OVER") return rejected(state, "GAME_ALREADY_ENDED");
  const turn = state.turn;
  if (turn === null) return rejected(state, "GAME_NOT_STARTED");
  if (turn.activePlayerId !== actorUserId) return rejected(state, "NOT_YOUR_TURN");
  if (turn.hasRolled) return rejected(state, "ROLL_ALREADY_COMPLETED");

  const playerIndex = state.players.findIndex((player) => player.userId === actorUserId);
  const player = state.players[playerIndex];
  if (player === undefined) return rejected(state, "ACTOR_NOT_IN_GAME");
  if (player.status !== "ACTIVE") return rejected(state, "PLAYER_NOT_ELIGIBLE");

  const roll = rollDice(rng);
  const movement = calculateMovement(board, player.position, roll.total);
  const resolution = dispatchLandedTile(board, movement.to);
  const nextCash = player.cash + movement.startAward;
  if (!Number.isSafeInteger(nextCash)) {
    throw new RangeError("Start award would move player cash outside the safe integer range");
  }

  const players = state.players.map((candidate, index) =>
    index === playerIndex
      ? { ...candidate, position: movement.to, cash: nextCash }
      : candidate,
  );
  const nextState = acceptedState(state, board, nextGameVersion, {
    players,
    turn: { ...turn, hasRolled: true },
  });

  return Object.freeze({
    kind: "ACCEPTED",
    state: nextState,
    event: Object.freeze({
      type: "DICE_ROLLED",
      playerId: actorUserId,
      roll,
      movement,
      resolution,
    }),
  });
}

function endCurrentTurn(
  state: GameState,
  board: BoardDefinition,
  actorUserId: string,
  nextGameVersion: number,
): GameplayCommandResult {
  if (state.phase === "STARTING") return rejected(state, "GAME_NOT_STARTED");
  if (state.phase === "GAME_OVER") return rejected(state, "GAME_ALREADY_ENDED");
  const turn = state.turn;
  if (turn === null) return rejected(state, "GAME_NOT_STARTED");
  if (turn.activePlayerId !== actorUserId) return rejected(state, "NOT_YOUR_TURN");
  if (!turn.hasRolled) return rejected(state, "ROLL_REQUIRED");

  const eligiblePlayers = state.players.filter((player) => player.status === "ACTIVE");
  if (eligiblePlayers.length <= 1) {
    const winnerUserId = eligiblePlayers[0]?.userId ?? null;
    const nextState = acceptedState(state, board, nextGameVersion, {
      phase: "GAME_OVER",
      turn: null,
    });
    return Object.freeze({
      kind: "ACCEPTED",
      state: nextState,
      event: Object.freeze({
        type: "GAME_ENDED",
        endedPlayerId: actorUserId,
        winnerUserId,
      }),
    });
  }

  const currentIndex = state.players.findIndex((player) => player.userId === actorUserId);
  for (let offset = 1; offset <= state.players.length; offset += 1) {
    const candidate = state.players[(currentIndex + offset) % state.players.length];
    if (candidate?.status !== "ACTIVE") continue;

    const nextState = acceptedState(state, board, nextGameVersion, {
      turn: nextTurn(turn.turnNumber + 1, candidate.userId),
    });
    return Object.freeze({
      kind: "ACCEPTED",
      state: nextState,
      event: Object.freeze({
        type: "TURN_ENDED",
        endedPlayerId: actorUserId,
        activePlayerId: candidate.userId,
      }),
    });
  }

  return rejected(state, "PLAYER_NOT_ELIGIBLE");
}

export function applyGameplayCommand(
  stateInput: unknown,
  commandInput: unknown,
  context: GameplayCommandContext,
): GameplayCommandResult {
  const board = parseBoardDefinition(context.board);
  const state = parseGameState(stateInput, board);
  const command = parseGameCommand(commandInput);
  const type = gameplayCommand(command);
  const actorUserId = identifier(context.actorUserId, "context.actorUserId");
  const decision = classifyGameCommand(state, command, context.appliedActions ?? []);

  switch (decision.kind) {
    case "DUPLICATE_ACTION":
      return Object.freeze({
        kind: "DUPLICATE_ACTION",
        state,
        committedGameVersion: decision.committedGameVersion,
      });
    case "STALE_GAME":
      return rejected(state, "STALE_GAME", { currentGameId: decision.currentGameId });
    case "STALE_GAME_VERSION":
      return rejected(state, "STALE_GAME_VERSION", {
        currentGameVersion: decision.currentGameVersion,
      });
    case "NEW_ACTION":
      switch (type) {
        case "START_GAME":
          return startGame(state, board, actorUserId, decision.nextGameVersion);
        case "ROLL_DICE":
          return rollCurrentPlayer(
            state,
            board,
            actorUserId,
            context.rng,
            decision.nextGameVersion,
          );
        case "END_TURN":
          return endCurrentTurn(state, board, actorUserId, decision.nextGameVersion);
      }
  }
}
