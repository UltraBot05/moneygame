import { CommandValidationError, type AppliedActionRecord } from "../command";
import { applyGameplayCommand, type GameplayCommandResult } from "../gameplay";
import { createSeededRandom, type RandomSource } from "../random";
import { createInitialGameState, type GameState } from "../state";
import { BASELINE_POLICY } from "../spike-008/economy-simulator";
import { botDecision, economyOf, type BotCommand } from "./production-simulator";

/**
 * QA-011/QA-005: seeded fuzzing of the production transition function. Most steps are legal bot
 * moves so matches progress to an end; the rest are random, stale, duplicate or malformed
 * commands from random actors. After every step the fuzzer checks invariants the state parser
 * does not own (card conservation, fixed asset set, refusals change nothing, duplicates replay).
 * Any failure names its seed and step, and replaying the seed reproduces it exactly.
 */

export interface FuzzConfig {
  readonly boardRef: string;
  readonly players: number;
  readonly seed: number;
  readonly maxCommands?: number;
  /** Share of steps that are chaos commands instead of bot moves. */
  readonly chaos?: number;
}

export interface FuzzResult {
  readonly seed: number;
  readonly commands: number;
  readonly accepted: number;
  readonly refused: number;
  readonly malformed: number;
  readonly duplicates: number;
  readonly finished: boolean;
  readonly gameVersion: number;
  /** FNV-1a of the final state JSON, for replay comparison. */
  readonly fingerprint: string;
}

export class FuzzInvariantError extends Error {
  constructor(readonly seed: number, readonly step: number, detail: string) {
    super("fuzz seed " + seed + " step " + step + ": " + detail);
    this.name = "FuzzInvariantError";
  }
}

const COMMAND_TYPES = [
  "ROLL_DICE", "END_TURN", "BUY_PROPERTY", "DECLINE_PROPERTY", "PLACE_BID", "PASS_AUCTION", "BUILD",
  "SELL_DEVELOPMENT", "MORTGAGE", "UNMORTGAGE", "DRAW_CARD", "PAY_HOLDING_FEE", "USE_RELEASE_CARD",
  "PROPOSE_TRADE", "COUNTER_TRADE", "ACCEPT_TRADE", "REJECT_TRADE", "CANCEL_TRADE", "DECLARE_BANKRUPTCY",
  "AUCTION_TIMEOUT", "DEBT_TIMEOUT", "TURN_TIMEOUT",
] as const;

function fingerprint(text: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

function pick<T>(random: RandomSource, items: readonly T[]): T | undefined {
  return items.length === 0 ? undefined : items[Math.floor(random() * items.length)];
}

function chaosCommand(state: GameState, random: RandomSource): BotCommand {
  const actor = pick(random, state.players.map((player) => player.userId)) ?? "p0";
  const type = pick(random, COMMAND_TYPES) ?? "ROLL_DICE";
  const asset = pick(random, state.assets);
  const trade = pick(random, state.ruleState.trades);
  const resolutionId = random() < 0.8 ? state.pendingResolution?.resolutionId ?? "none" : "bogus";
  const auctionId = state.auction?.auctionId ?? "none";
  const bundle = () => ({
    cash: Math.floor(random() * 400),
    assetIds: state.assets.filter(() => random() < 0.06).map((candidate) => candidate.assetId),
  });
  const payloads: Record<string, Record<string, unknown>> = {
    ROLL_DICE: {}, END_TURN: {}, PAY_HOLDING_FEE: {},
    BUY_PROPERTY: { resolutionId }, DECLINE_PROPERTY: { resolutionId }, DRAW_CARD: { resolutionId }, DECLARE_BANKRUPTCY: { resolutionId },
    PLACE_BID: { auctionId, amount: Math.floor(random() * 600) },
    PASS_AUCTION: { auctionId },
    BUILD: { assetId: asset?.assetId ?? "none" }, SELL_DEVELOPMENT: { assetId: asset?.assetId ?? "none" },
    MORTGAGE: { assetId: asset?.assetId ?? "none" }, UNMORTGAGE: { assetId: asset?.assetId ?? "none" },
    USE_RELEASE_CARD: { cardId: pick(random, state.ruleState.heldCards)?.cardId ?? "none" },
    PROPOSE_TRADE: { recipientUserId: pick(random, state.players)?.userId ?? "p1", offered: bundle(), requested: bundle() },
    COUNTER_TRADE: { tradeId: trade?.tradeId ?? "none", offered: bundle(), requested: bundle() },
    ACCEPT_TRADE: { tradeId: trade?.tradeId ?? "none" }, REJECT_TRADE: { tradeId: trade?.tradeId ?? "none" },
    CANCEL_TRADE: { tradeId: trade?.tradeId ?? "none" },
    AUCTION_TIMEOUT: { auctionId, actorUserId: actor, decisionDeadlineAt: 0 },
    DEBT_TIMEOUT: { resolutionId, deadlineAt: 0 },
    TURN_TIMEOUT: { turnId: state.turn?.turnId ?? "none" },
  };
  // A little malformed input: an unexpected field.
  const payload = random() < 0.05 ? { ...payloads[type], extra: true } : payloads[type] ?? {};
  return { actor, type, payload };
}

function cardCount(state: GameState): number {
  return state.ruleState.decks.reduce((sum, deck) => sum + deck.drawPile.length + deck.discardPile.length, 0) + state.ruleState.heldCards.length;
}

export function fuzzProductionGame(config: FuzzConfig): FuzzResult {
  const economy = economyOf(config.boardRef);
  const maxCommands = config.maxCommands ?? 4000;
  const chaos = config.chaos ?? 0.3;
  const ids = Array.from({ length: config.players }, (_unused, index) => "p" + index);
  const gameRng = createSeededRandom(config.seed);
  const chaosRng = createSeededRandom((config.seed * 7919 + 17) % 2_147_483_647);
  const totalCards = economy.cards.cards.length;
  const assetIds = new Set<string>();
  const applied: AppliedActionRecord[] = [];
  let state = createInitialGameState({ gameId: "fuzz-" + config.seed, board: economy.board, playerIds: ids });
  let clock = 1_000_000;
  let accepted = 0;
  let refused = 0;
  let malformed = 0;
  let duplicates = 0;
  let restoredThisTurn = false;
  let step = 0;
  const fail = (detail: string): never => {
    throw new FuzzInvariantError(config.seed, step, detail);
  };

  const apply = (command: BotCommand, options: Readonly<{ actionId?: string; version?: number; gameId?: string }> = {}): GameplayCommandResult | null => {
    clock += 1000;
    const before = state;
    const beforeJson = JSON.stringify(before);
    let result: GameplayCommandResult;
    try {
      result = applyGameplayCommand(
        state,
        {
          type: command.type, gameId: options.gameId ?? state.gameId, actionId: options.actionId ?? "fuzz-" + step,
          expectedGameVersion: options.version ?? state.gameVersion, payload: command.payload,
        },
        {
          actorUserId: command.actor, board: economy.board, rng: gameRng, cardCatalog: economy.cards, currentTime: clock,
          auctionDecisionDeadlineAt: clock + 20_000, debtDeadlineAt: clock + 120_000, appliedActions: applied,
        },
      );
    } catch (error) {
      if (!(error instanceof CommandValidationError)) throw error;
      malformed += 1;
      if (JSON.stringify(state) !== beforeJson) fail("malformed command changed state");
      return null;
    }
    if (result.kind !== "ACCEPTED") {
      if (result.kind === "DUPLICATE_ACTION") duplicates += 1;
      else refused += 1;
      if (JSON.stringify(result.state) !== beforeJson) fail(result.kind + " changed state");
      return result;
    }
    accepted += 1;
    state = result.state;
    applied.push({ gameId: state.gameId, actionId: options.actionId ?? "fuzz-" + step, resultingGameVersion: state.gameVersion });
    if (applied.length > 500) applied.shift();
    if (state.gameVersion !== before.gameVersion + 1) fail("gameVersion did not advance by one");
    if (state.assets.length !== assetIds.size || state.assets.some((asset) => !assetIds.has(asset.assetId))) fail("asset set changed");
    if (state.ruleState.decks.length > 0 && cardCount(state) !== totalCards) fail("cards not conserved: " + cardCount(state) + " of " + totalCards);
    if (state.players.some((player) => player.cash < 0)) fail("negative cash");
    if (state.turn !== null && before.turn !== null && state.turn.turnNumber < before.turn.turnNumber) fail("turn number went backwards");
    if (before.turn?.turnId !== state.turn?.turnId) restoredThisTurn = false;
    return result;
  };

  for (const asset of state.assets) assetIds.add(asset.assetId);
  apply({ actor: "p0", type: "START_GAME", payload: {} });
  while (state.phase !== "GAME_OVER" && step < maxCommands) {
    step += 1;
    const roll = chaosRng();
    if (roll < chaos * 0.85) {
      apply(chaosCommand(state, chaosRng));
    } else if (roll < chaos * 0.9 && applied.length > 1) {
      // Replay an old committed actionId: must be a no-op duplicate.
      const old = applied[Math.floor(chaosRng() * (applied.length - 1))] as AppliedActionRecord;
      const result = apply({ actor: "p0", type: "ROLL_DICE", payload: {} }, { actionId: old.actionId, version: old.resultingGameVersion - 1 });
      if (result?.kind !== "DUPLICATE_ACTION") fail("replayed actionId " + old.actionId + " was not a duplicate");
    } else if (roll < chaos) {
      // Stale version or wrong game: must be refused.
      const stale = chaosRng() < 0.5 && state.gameVersion > 4;
      const result = apply(botDecision(state, economy, BASELINE_POLICY, restoredThisTurn),
        stale ? { version: state.gameVersion - 1 - Math.floor(chaosRng() * 3) } : { gameId: "other-game" });
      if (result?.kind !== "REJECTED") fail("stale or foreign command was not rejected");
    } else {
      const decision = botDecision(state, economy, BASELINE_POLICY, restoredThisTurn);
      if (decision.type === "UNMORTGAGE") restoredThisTurn = true;
      const result = apply(decision);
      if (result?.kind !== "ACCEPTED") fail("bot command " + decision.type + " refused: " + (result === null ? "malformed" : result.kind === "REJECTED" ? result.reason : result.kind));
    }
  }
  return {
    seed: config.seed, commands: step, accepted, refused, malformed, duplicates,
    finished: state.phase === "GAME_OVER", gameVersion: state.gameVersion, fingerprint: fingerprint(JSON.stringify(state)),
  };
}
