import { describe, expect, it } from "vitest";
import { assertLobbyCanStart, evaluateLobbyStart, LobbyStartError } from "./lobby";

describe("CORE-005 lobby start eligibility", () => {
  it.each([1, 2])("rejects a new game with %i players", (playerCount) => {
    expect(evaluateLobbyStart(playerCount)).toMatchObject({
      ok: false,
      reason: "TOO_FEW_PLAYERS",
    });
    expect(() => assertLobbyCanStart(playerCount)).toThrow(LobbyStartError);
  });

  it.each([3, 10])("accepts the start boundary at %i players", (playerCount) => {
    expect(evaluateLobbyStart(playerCount)).toEqual({ ok: true, playerCount });
    expect(() => assertLobbyCanStart(playerCount)).not.toThrow();
  });

  it("rejects eleven players and malformed counts", () => {
    expect(evaluateLobbyStart(11)).toMatchObject({
      ok: false,
      reason: "TOO_MANY_PLAYERS",
    });
    expect(evaluateLobbyStart(3.5)).toMatchObject({
      ok: false,
      reason: "INVALID_COUNT",
    });
  });
});
