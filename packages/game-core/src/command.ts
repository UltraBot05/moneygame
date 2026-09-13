export interface GameCommand<TType extends string = string, TPayload = unknown> {
  readonly type: TType;
  readonly gameId: string;
  readonly actionId: string;
  readonly expectedGameVersion?: number;
  readonly payload: TPayload;
}

export interface CurrentGameIdentity {
  readonly gameId: string;
  readonly gameVersion: number;
}

export interface AppliedActionRecord {
  readonly gameId: string;
  readonly actionId: string;
  readonly resultingGameVersion: number;
}

export type CommandDecision =
  | {
      readonly kind: "NEW_ACTION";
      readonly nextGameVersion: number;
    }
  | {
      readonly kind: "DUPLICATE_ACTION";
      readonly committedGameVersion: number;
    }
  | {
      readonly kind: "STALE_GAME";
      readonly currentGameId: string;
    }
  | {
      readonly kind: "STALE_GAME_VERSION";
      readonly currentGameVersion: number;
    };

export class CommandValidationError extends Error {
  constructor(readonly field: string, message: string) {
    super(field + ": " + message);
    this.name = "CommandValidationError";
  }
}

function commandObject(input: unknown): Record<string, unknown> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new CommandValidationError("$", "expected an object");
  }
  return input as Record<string, unknown>;
}

function requiredIdentifier(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new CommandValidationError(field, "expected a non-empty string");
  }
  return value;
}

function requiredVersion(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new CommandValidationError("expectedGameVersion", "expected a non-negative safe integer");
  }
  return value as number;
}

export function parseGameCommand(input: unknown): GameCommand {
  const object = commandObject(input);
  const expectedKeys = ["type", "gameId", "actionId", "expectedGameVersion", "payload"];
  const expectedKeySet = new Set(expectedKeys);
  for (const key of Object.keys(object)) {
    if (!expectedKeySet.has(key)) {
      throw new CommandValidationError(key, "unexpected field");
    }
  }
  for (const key of ["type", "gameId", "actionId", "payload"]) {
    if (!Object.prototype.hasOwnProperty.call(object, key)) {
      throw new CommandValidationError(key, "missing field");
    }
  }

  const command = {
    type: requiredIdentifier(object.type, "type"),
    gameId: requiredIdentifier(object.gameId, "gameId"),
    actionId: requiredIdentifier(object.actionId, "actionId"),
    payload: object.payload,
  };

  if (Object.prototype.hasOwnProperty.call(object, "expectedGameVersion")) {
    return Object.freeze({
      ...command,
      expectedGameVersion: requiredVersion(object.expectedGameVersion),
    });
  }
  return Object.freeze(command);
}

function matchingAppliedAction(
  appliedActions: readonly AppliedActionRecord[],
  command: GameCommand,
): AppliedActionRecord | undefined {
  return appliedActions.find(
    (record) => record.gameId === command.gameId && record.actionId === command.actionId,
  );
}

export function classifyGameCommand(
  current: CurrentGameIdentity,
  command: GameCommand,
  appliedActions: readonly AppliedActionRecord[],
): CommandDecision {
  if (command.gameId !== current.gameId) {
    return { kind: "STALE_GAME", currentGameId: current.gameId };
  }

  const duplicate = matchingAppliedAction(appliedActions, command);
  if (duplicate !== undefined) {
    return {
      kind: "DUPLICATE_ACTION",
      committedGameVersion: duplicate.resultingGameVersion,
    };
  }

  if (
    command.expectedGameVersion !== undefined
    && command.expectedGameVersion !== current.gameVersion
  ) {
    return {
      kind: "STALE_GAME_VERSION",
      currentGameVersion: current.gameVersion,
    };
  }

  if (!Number.isSafeInteger(current.gameVersion) || current.gameVersion < 0) {
    throw new RangeError("current gameVersion must be a non-negative safe integer");
  }
  if (current.gameVersion === Number.MAX_SAFE_INTEGER) {
    throw new RangeError("gameVersion cannot advance beyond Number.MAX_SAFE_INTEGER");
  }

  return { kind: "NEW_ACTION", nextGameVersion: current.gameVersion + 1 };
}
