import { describe, expect, it } from "vitest";
import {
  classifyGameCommand,
  CommandValidationError,
  parseGameCommand,
  type AppliedActionRecord,
} from "./command";

const current = Object.freeze({ gameId: "game-b", gameVersion: 7 });

function command(overrides: Readonly<Record<string, unknown>> = {}) {
  return parseGameCommand({
    type: "ROLL",
    gameId: "game-b",
    actionId: "action-1",
    expectedGameVersion: 7,
    payload: {},
    ...overrides,
  });
}

function commandWithoutVersion(overrides: Readonly<Record<string, unknown>> = {}) {
  return parseGameCommand({
    type: "ROLL",
    gameId: "game-b",
    actionId: "action-1",
    payload: {},
    ...overrides,
  });
}

describe("CORE-004 command identity, idempotency, and version contract", () => {
  it("classifies a new valid command and computes its next version without mutation", () => {
    const action = command();
    const decision = classifyGameCommand(current, action, []);
    expect(decision).toEqual({ kind: "NEW_ACTION", nextGameVersion: 8 });
    expect(current).toEqual({ gameId: "game-b", gameVersion: 7 });
  });

  it("accepts a command with no expected gameVersion", () => {
    const action = commandWithoutVersion();
    expect(action).not.toHaveProperty("expectedGameVersion");
    expect(classifyGameCommand(current, action, [])).toEqual({
      kind: "NEW_ACTION",
      nextGameVersion: 8,
    });
  });

  it("recognizes a duplicate before stale-version rejection", () => {
    const applied: readonly AppliedActionRecord[] = [
      { gameId: "game-b", actionId: "action-1", resultingGameVersion: 7 },
    ];
    expect(
      classifyGameCommand(current, command({ expectedGameVersion: 6 }), applied),
    ).toEqual({ kind: "DUPLICATE_ACTION", committedGameVersion: 7 });
    expect(
      classifyGameCommand(current, commandWithoutVersion(), applied),
    ).toEqual({ kind: "DUPLICATE_ACTION", committedGameVersion: 7 });
  });

  it("scopes idempotency to gameId", () => {
    const applied: readonly AppliedActionRecord[] = [
      { gameId: "game-a", actionId: "action-1", resultingGameVersion: 99 },
    ];
    expect(classifyGameCommand(current, command(), applied)).toEqual({
      kind: "NEW_ACTION",
      nextGameVersion: 8,
    });
  });

  it("distinguishes stale game identity from stale gameVersion", () => {
    expect(
      classifyGameCommand(
        current,
        command({ gameId: "game-a", expectedGameVersion: 6 }),
        [],
      ),
    ).toEqual({ kind: "STALE_GAME", currentGameId: "game-b" });
    expect(
      classifyGameCommand(current, command({ expectedGameVersion: 6 }), []),
    ).toEqual({
      kind: "STALE_GAME_VERSION",
      currentGameVersion: 7,
    });
  });

  it.each(["gameId", "actionId"])(
    "rejects a missing mandatory %s field",
    (field) => {
      const input: Record<string, unknown> = {
        type: "ROLL",
        gameId: "game-b",
        actionId: "action-1",
        expectedGameVersion: 7,
        payload: {},
      };
      delete input[field];
      expect(() => parseGameCommand(input)).toThrow(CommandValidationError);
    },
  );

  it("rejects invalid supplied versions and undeclared envelope fields", () => {
    expect(() => command({ expectedGameVersion: 7.5 })).toThrow(CommandValidationError);
    expect(() => command({ expectedGameVersion: undefined })).toThrow(CommandValidationError);
    expect(() => command({ retry: true })).toThrow(/unexpected field/);
  });
});
