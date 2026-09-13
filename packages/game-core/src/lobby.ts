export const MINIMUM_START_PLAYERS = 3;
export const MAXIMUM_START_PLAYERS = 10;

export type LobbyStartEligibility =
  | { readonly ok: true; readonly playerCount: number }
  | {
      readonly ok: false;
      readonly playerCount: number;
      readonly reason: "INVALID_COUNT" | "TOO_FEW_PLAYERS" | "TOO_MANY_PLAYERS";
    };

export function evaluateLobbyStart(playerCount: number): LobbyStartEligibility {
  if (!Number.isSafeInteger(playerCount) || playerCount < 0) {
    return { ok: false, playerCount, reason: "INVALID_COUNT" };
  }
  if (playerCount < MINIMUM_START_PLAYERS) {
    return { ok: false, playerCount, reason: "TOO_FEW_PLAYERS" };
  }
  if (playerCount > MAXIMUM_START_PLAYERS) {
    return { ok: false, playerCount, reason: "TOO_MANY_PLAYERS" };
  }
  return { ok: true, playerCount };
}

export class LobbyStartError extends Error {
  constructor(readonly eligibility: Exclude<LobbyStartEligibility, { readonly ok: true }>) {
    super("cannot start lobby: " + eligibility.reason);
    this.name = "LobbyStartError";
  }
}

export function assertLobbyCanStart(playerCount: number): void {
  const eligibility = evaluateLobbyStart(playerCount);
  if (!eligibility.ok) throw new LobbyStartError(eligibility);
}
