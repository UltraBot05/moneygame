import { parseBoardDefinition, type BoardDefinition } from "./board";
import { validStartingCash } from "./economy";
import { assertLobbyCanStart } from "./lobby";

export type PlayerStatus = "ACTIVE" | "BANKRUPT";
export type GamePhase = "STARTING" | "ACTIVE_TURN" | "GAME_OVER";

export interface GameBoardIdentity {
  readonly ref: string;
  readonly boardId: string;
  readonly boardVersion: number;
  readonly tileCount: number;
}

export interface PlayerState {
  readonly userId: string;
  readonly seatIndex: number;
  readonly cash: number;
  readonly position: number;
  readonly status: PlayerStatus;
}

export interface PropertyState {
  readonly propertyId: string;
  readonly tileIndex: number;
  readonly ownerUserId: string | null;
  readonly developmentLevel: number;
  readonly mortgaged: boolean;
}

export interface TurnIdentity {
  readonly turnId: string;
  readonly activePlayerId: string;
  readonly turnNumber: number;
  readonly hasRolled: boolean;
}

export interface GameState {
  readonly gameId: string;
  readonly gameVersion: number;
  readonly board: GameBoardIdentity;
  readonly phase: GamePhase;
  readonly turn: TurnIdentity | null;
  readonly players: readonly PlayerState[];
  readonly properties: readonly PropertyState[];
}

export interface CreateInitialGameStateInput {
  readonly gameId: string;
  readonly board: BoardDefinition;
  readonly playerIds: readonly string[];
  readonly startingCash?: number;
}

export class GameStateValidationError extends Error {
  constructor(readonly path: string, message: string) {
    super(path + ": " + message);
    this.name = "GameStateValidationError";
  }
}

function fail(path: string, message: string): never {
  throw new GameStateValidationError(path, message);
}

function objectAt(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail(path, "expected an object");
  }
  return value as Record<string, unknown>;
}

function arrayAt(value: unknown, path: string): readonly unknown[] {
  if (!Array.isArray(value)) fail(path, "expected an array");
  return value;
}

function exactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  path: string,
): void {
  const expectedSet = new Set(expected);
  for (const key of Object.keys(value)) {
    if (!expectedSet.has(key)) fail(path + "." + key, "unexpected field");
  }
  for (const key of expected) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) fail(path + "." + key, "missing field");
  }
}

function identifierAt(value: unknown, path: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    fail(path, "expected a non-empty string");
  }
  return value;
}

function integerAt(value: unknown, path: string, minimum = 0, maximum?: number): number {
  if (
    !Number.isSafeInteger(value)
    || (value as number) < minimum
    || (maximum !== undefined && (value as number) > maximum)
  ) {
    fail(
      path,
      "expected a safe integer from " + minimum + (maximum === undefined ? "" : " to " + maximum),
    );
  }
  return value as number;
}

function parseBoardIdentity(value: unknown, board: BoardDefinition): GameBoardIdentity {
  const object = objectAt(value, "$.board");
  exactKeys(object, ["ref", "boardId", "boardVersion", "tileCount"], "$.board");
  const identity: GameBoardIdentity = {
    ref: identifierAt(object.ref, "$.board.ref"),
    boardId: identifierAt(object.boardId, "$.board.boardId"),
    boardVersion: integerAt(object.boardVersion, "$.board.boardVersion", 1),
    tileCount: integerAt(object.tileCount, "$.board.tileCount", 1),
  };
  if (
    identity.ref !== board.ref
    || identity.boardId !== board.boardId
    || identity.boardVersion !== board.boardVersion
    || identity.tileCount !== board.tileCount
  ) {
    fail("$.board", "identity does not match the supplied board");
  }
  return identity;
}

function parsePlayer(value: unknown, index: number, tileCount: number): PlayerState {
  const path = "$.players[" + index + "]";
  const object = objectAt(value, path);
  exactKeys(object, ["userId", "seatIndex", "cash", "position", "status"], path);
  const seatIndex = integerAt(object.seatIndex, path + ".seatIndex");
  if (seatIndex !== index) fail(path + ".seatIndex", "must match ordered seat position");
  const status =
    object.status === "ACTIVE" || object.status === "BANKRUPT"
      ? object.status
      : fail(path + ".status", "expected ACTIVE or BANKRUPT");
  return {
    userId: identifierAt(object.userId, path + ".userId"),
    seatIndex,
    cash: integerAt(object.cash, path + ".cash"),
    position: integerAt(object.position, path + ".position", 0, tileCount - 1),
    status,
  };
}

function parseProperty(value: unknown, index: number, board: BoardDefinition): PropertyState {
  const path = "$.properties[" + index + "]";
  const object = objectAt(value, path);
  exactKeys(
    object,
    ["propertyId", "tileIndex", "ownerUserId", "developmentLevel", "mortgaged"],
    path,
  );
  const ownerUserId =
    object.ownerUserId === null
      ? null
      : identifierAt(object.ownerUserId, path + ".ownerUserId");
  const developmentLevel = integerAt(object.developmentLevel, path + ".developmentLevel", 0, 4);
  if (ownerUserId === null && (developmentLevel !== 0 || object.mortgaged !== false)) {
    fail(path, "an unowned property cannot be developed or mortgaged");
  }
  if (object.mortgaged !== true && object.mortgaged !== false) {
    fail(path + ".mortgaged", "expected a boolean");
  }
  if (object.mortgaged && developmentLevel !== 0) {
    fail(path, "a mortgaged property cannot have development");
  }

  const tileIndex = integerAt(object.tileIndex, path + ".tileIndex", 0, board.tileCount - 1);
  const tile = board.economyProfile.tiles[tileIndex];
  const propertyId = identifierAt(object.propertyId, path + ".propertyId");
  if (tile?.type !== "property" || tile.propertyId !== propertyId) {
    fail(path, "property identity does not match its board tile");
  }

  return {
    propertyId,
    tileIndex,
    ownerUserId,
    developmentLevel,
    mortgaged: object.mortgaged,
  };
}

function parseTurn(value: unknown, playerIds: ReadonlySet<string>): TurnIdentity | null {
  if (value === null) return null;
  const object = objectAt(value, "$.turn");
  exactKeys(object, ["turnId", "activePlayerId", "turnNumber", "hasRolled"], "$.turn");
  if (object.hasRolled !== true && object.hasRolled !== false) {
    fail("$.turn.hasRolled", "expected a boolean");
  }
  const turn = {
    turnId: identifierAt(object.turnId, "$.turn.turnId"),
    activePlayerId: identifierAt(object.activePlayerId, "$.turn.activePlayerId"),
    turnNumber: integerAt(object.turnNumber, "$.turn.turnNumber", 1),
    hasRolled: object.hasRolled,
  };
  if (!playerIds.has(turn.activePlayerId)) {
    fail("$.turn.activePlayerId", "must identify a player in this game");
  }
  return turn;
}

function freezeGameState(state: GameState): GameState {
  state.players.forEach(Object.freeze);
  state.properties.forEach(Object.freeze);
  Object.freeze(state.players);
  Object.freeze(state.properties);
  Object.freeze(state.board);
  if (state.turn !== null) Object.freeze(state.turn);
  return Object.freeze(state);
}

export function parseGameState(input: unknown, boardInput: BoardDefinition): GameState {
  const board = parseBoardDefinition(boardInput);
  const root = objectAt(input, "$");
  exactKeys(root, ["gameId", "gameVersion", "board", "phase", "turn", "players", "properties"], "$");

  const players = arrayAt(root.players, "$.players").map((player, index) =>
    parsePlayer(player, index, board.tileCount),
  );
  if (players.length === 0 || players.length > 10) {
    fail("$.players", "expected between one and ten current players");
  }
  const playerIds = new Set<string>();
  for (const player of players) {
    if (playerIds.has(player.userId)) fail("$.players", "duplicate userId " + player.userId);
    playerIds.add(player.userId);
  }

  const properties = arrayAt(root.properties, "$.properties").map((property, index) =>
    parseProperty(property, index, board),
  );
  const expectedProperties = board.economyProfile.tiles.filter(
    (tile): tile is Extract<(typeof board.economyProfile.tiles)[number], { readonly type: "property" }> =>
      tile.type === "property",
  );
  if (properties.length !== expectedProperties.length) {
    fail("$.properties", "must contain every board property exactly once");
  }
  const seenPropertyIds = new Set<string>();
  for (const property of properties) {
    if (seenPropertyIds.has(property.propertyId)) {
      fail("$.properties", "duplicate property state " + property.propertyId);
    }
    seenPropertyIds.add(property.propertyId);
    if (property.ownerUserId !== null && !playerIds.has(property.ownerUserId)) {
      fail("$.properties", "owner must identify a player in this game");
    }
  }
  for (const expected of expectedProperties) {
    if (!seenPropertyIds.has(expected.propertyId)) {
      fail("$.properties", "missing property state " + expected.propertyId);
    }
  }

  const phase =
    root.phase === "STARTING" || root.phase === "ACTIVE_TURN" || root.phase === "GAME_OVER"
      ? root.phase
      : fail("$.phase", "unknown phase");
  const turn = parseTurn(root.turn, playerIds);
  if ((phase === "ACTIVE_TURN") !== (turn !== null)) {
    fail("$.turn", "turn identity is required only during ACTIVE_TURN");
  }

  return freezeGameState({
    gameId: identifierAt(root.gameId, "$.gameId"),
    gameVersion: integerAt(root.gameVersion, "$.gameVersion"),
    board: parseBoardIdentity(root.board, board),
    phase,
    turn,
    players,
    properties,
  });
}

export function createInitialGameState(input: CreateInitialGameStateInput): GameState {
  const board = parseBoardDefinition(input.board);
  assertLobbyCanStart(input.playerIds.length);

  const gameId = identifierAt(input.gameId, "$.gameId");
  const playerIds = input.playerIds.map((playerId, index) =>
    identifierAt(playerId, "$.playerIds[" + index + "]"),
  );
  if (new Set(playerIds).size !== playerIds.length) {
    fail("$.playerIds", "player ids must be unique");
  }

  const startingCash = input.startingCash ?? board.economyProfile.startingCash;
  if (!validStartingCash(startingCash)) {
    fail("$.startingCash", "must be an integer from 1500 through 2500");
  }

  const properties: PropertyState[] = [];
  for (const tile of board.economyProfile.tiles) {
    if (tile.type === "property") {
      properties.push({
        propertyId: tile.propertyId,
        tileIndex: tile.index,
        ownerUserId: null,
        developmentLevel: 0,
        mortgaged: false,
      });
    }
  }

  return parseGameState(
    {
      gameId,
      gameVersion: 0,
      board: {
        ref: board.ref,
        boardId: board.boardId,
        boardVersion: board.boardVersion,
        tileCount: board.tileCount,
      },
      phase: "STARTING",
      turn: null,
      players: playerIds.map((userId, seatIndex) => ({
        userId,
        seatIndex,
        cash: startingCash,
        position: 0,
        status: "ACTIVE",
      })),
      properties,
    },
    board,
  );
}
