import type { BoardDefinition } from "../board";
import type { CardCatalogDefinition } from "../cards";
import { canonicalBoard } from "../catalog";
import { CANDIDATE_RULES, type PropertyEconomy } from "../economy";
import { applyGameplayCommand, type GameplayEvent } from "../gameplay";
import { createSeededRandom, type RandomSource } from "../random";
import { createInitialGameState, type AssetState, type GameState, type PlayerState } from "../state";
import {
  BASELINE_POLICY,
  configurationSeed,
  summarizeSimulations,
  type CashCheckpoint,
  type GameSimulationResult,
  type PlayerCheckpoint,
  type SimulationPolicy,
  type SimulationSummary,
} from "../spike-008/economy-simulator";

/**
 * GRAND-003/004, QA-011: whole games played by deterministic bots through the production rule
 * path (`applyGameplayCommand`, the same pipeline the room runs), summarized with the unchanged
 * SPIKE-008 metrics and health bands. The bot follows the SPIKE-008 policy (reserves, 75% auction
 * cap, 125% set-completion trades once per round) but must obey every production rule: English
 * auctions, full Holding flow, even building and selling, two builds per turn, real card decks,
 * CORE-011 debt with liquidation, and classic bankruptcy. A refused bot command is a bug.
 */

export interface ProductionSimulationConfig {
  readonly boardRef: string;
  readonly players: number;
  readonly seed: number;
  readonly startingCash?: number;
  readonly maxRounds?: number;
  readonly policy?: SimulationPolicy;
}

export class SimulationRefusedError extends Error {
  constructor(readonly command: string, readonly reason: string) {
    super("bot command " + command + " refused: " + reason);
    this.name = "SimulationRefusedError";
  }
}

const CHECKPOINT_ROUNDS = new Set([5, 10, 20, 40]);
const MAX_COMMANDS = 200_000;

function roundToTen(value: number): number {
  return Math.ceil(value / 10) * 10;
}

function gini(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const minimum = Math.min(...values);
  const sorted = values.map((value) => value - Math.min(0, minimum)).sort((a, b) => a - b);
  const total = sorted.reduce((sum, value) => sum + value, 0);
  if (total === 0) return 0;
  const weighted = sorted.reduce((sum, value, index) => sum + (index + 1) * value, 0);
  return (2 * weighted) / (sorted.length * total) - (sorted.length + 1) / sorted.length;
}

export interface Economy {
  readonly board: BoardDefinition;
  readonly cards: CardCatalogDefinition;
  readonly property: ReadonlyMap<number, PropertyEconomy>;
  readonly setOf: ReadonlyMap<number, readonly number[]>;
  /** Tile indexes of each property set, in board order. */
  readonly sets: readonly (readonly number[])[];
}

export function economyOf(boardRef: string): Economy {
  const { board, cards } = canonicalBoard(boardRef);
  const profile = board.economyProfile;
  const property = new Map<number, PropertyEconomy>();
  const setOf = new Map<number, readonly number[]>();
  const sets: (readonly number[])[] = [];
  for (const set of profile.sets) {
    const ids = new Set(set.properties.map((candidate) => candidate.id));
    const indexes = profile.tiles.filter((tile) => tile.type === "property" && ids.has(tile.propertyId)).map((tile) => tile.index);
    sets.push(indexes);
    for (const tile of profile.tiles) {
      if (tile.type !== "property" || !ids.has(tile.propertyId)) continue;
      const economy = set.properties.find((candidate) => candidate.id === tile.propertyId);
      if (economy !== undefined) property.set(tile.index, economy);
      setOf.set(tile.index, indexes);
    }
  }
  return { board, cards, property, setOf, sets };
}

function price(economy: Economy, asset: AssetState): number {
  const profile = economy.board.economyProfile;
  if (asset.kind === "TRANSIT") return profile.transit.price;
  if (asset.kind === "UTILITY") return profile.utility.price;
  return economy.property.get(asset.tileIndex)?.price ?? 0;
}

function mortgageValue(economy: Economy, asset: AssetState): number {
  const profile = economy.board.economyProfile;
  if (asset.kind === "TRANSIT") return profile.transit.mortgageValue;
  if (asset.kind === "UTILITY") return profile.utility.mortgageValue;
  return economy.property.get(asset.tileIndex)?.mortgageValue ?? 0;
}

function unmortgageCost(economy: Economy, asset: AssetState): number {
  const profile = economy.board.economyProfile;
  if (asset.kind === "TRANSIT") return profile.transit.unmortgageCost;
  if (asset.kind === "UTILITY") return profile.utility.unmortgageCost;
  return economy.property.get(asset.tileIndex)?.unmortgageCost ?? 0;
}

function level(asset: AssetState): number {
  return asset.kind === "PROPERTY" ? asset.developmentLevel : 0;
}

function setAssets(state: GameState, economy: Economy, asset: AssetState): readonly AssetState[] {
  const indexes = economy.setOf.get(asset.tileIndex);
  return indexes === undefined ? [] : state.assets.filter((candidate) => indexes.includes(candidate.tileIndex));
}

function netWorth(state: GameState, economy: Economy, player: PlayerState): number {
  return state.assets.filter((asset) => asset.ownerUserId === player.userId).reduce((total, asset) =>
    total + (asset.mortgaged ? mortgageValue(economy, asset) : price(economy, asset))
      + level(asset) * (economy.property.get(asset.tileIndex)?.buildingCost ?? 0),
  player.cash);
}

export interface BotCommand {
  readonly actor: string;
  readonly type: string;
  readonly payload: Readonly<Record<string, unknown>>;
}

/**
 * The SPIKE-008-policy bot's next legal command for a running game: auctions, then debt
 * liquidation, buy/decline, card draws, Holding, rolls, one mortgage restore per turn (skipped
 * when `restoredThisTurn`), up to two even builds, then END_TURN.
 */
export function botDecision(state: GameState, economy: Economy, policy: SimulationPolicy, restoredThisTurn: boolean): BotCommand {
  const player = (userId: string) => state.players.find((candidate) => candidate.userId === userId) as PlayerState;
  const owned = (userId: string) => state.assets.filter((asset) => asset.ownerUserId === userId);
  const auction = state.auction;
  if (auction !== null) {
    // Open auction: the first participant who is still in and not leading answers (bids its cap or drops out).
    const bidderId = auction.participantOrder.find((userId) => !auction.passedPlayerIds.includes(userId) && userId !== auction.highBidderUserId) as string;
    const bidder = player(bidderId);
    const asset = state.assets.find((candidate) => candidate.assetId === auction.assetId) as AssetState;
    const cap = roundToTen(price(economy, asset) * policy.auctionPriceFraction);
    const minimum = auction.highBid === null ? 2 : auction.highBid + 2;
    const bid = Math.min(cap, bidder.cash - policy.purchaseReserve);
    return bid >= minimum
      ? { actor: bidder.userId, type: "PLACE_BID", payload: { auctionId: auction.auctionId, amount: bid } }
      : { actor: bidder.userId, type: "PASS_AUCTION", payload: { auctionId: auction.auctionId } };
  }
  const pending = state.pendingResolution;
  if (pending !== null && pending.obligation !== null) {
    const debtor = pending.obligation.debtorUserId;
    const mine = owned(debtor);
    const developed = mine.filter((asset) => level(asset) > 0).sort((a, b) => level(b) - level(a) || a.tileIndex - b.tileIndex)[0];
    if (developed !== undefined) return { actor: debtor, type: "SELL_DEVELOPMENT", payload: { assetId: developed.assetId } };
    const mortgageable = mine
      .filter((asset) => !asset.mortgaged && setAssets(state, economy, asset).every((member) => level(member) === 0))
      .sort((a, b) => mortgageValue(economy, b) - mortgageValue(economy, a) || price(economy, b) - price(economy, a) || a.tileIndex - b.tileIndex)[0];
    if (mortgageable !== undefined) return { actor: debtor, type: "MORTGAGE", payload: { assetId: mortgageable.assetId } };
    return { actor: debtor, type: "DECLARE_BANKRUPTCY", payload: { resolutionId: pending.resolutionId } };
  }
  if (pending?.kind === "BUY_DECISION" && pending.source.type === "TILE") {
    const tileIndex = pending.source.tileIndex;
    const asset = state.assets.find((candidate) => candidate.tileIndex === tileIndex) as AssetState;
    const decider = player(pending.decisionOwnerUserId);
    return {
      actor: decider.userId,
      type: decider.cash - price(economy, asset) >= policy.purchaseReserve ? "BUY_PROPERTY" : "DECLINE_PROPERTY",
      payload: { resolutionId: pending.resolutionId },
    };
  }
  if (pending?.kind === "CARD") return { actor: pending.decisionOwnerUserId, type: "DRAW_CARD", payload: { resolutionId: pending.resolutionId } };
  if (pending !== null) throw new Error("bot has no policy for pending " + pending.kind);
  const turn = state.turn;
  if (turn === null) throw new Error("active game without a turn");
  const active = player(turn.activePlayerId);
  if (active.inHolding && !turn.hasRolled) {
    const card = state.ruleState.heldCards.find((held) => held.ownerUserId === active.userId);
    if (card !== undefined) return { actor: active.userId, type: "USE_RELEASE_CARD", payload: { cardId: card.cardId } };
    return active.cash - CANDIDATE_RULES.holdingReleaseFee >= policy.purchaseReserve
      ? { actor: active.userId, type: "PAY_HOLDING_FEE", payload: {} }
      : { actor: active.userId, type: "ROLL_DICE", payload: {} };
  }
  if (!turn.hasRolled || turn.rollAgain) return { actor: active.userId, type: "ROLL_DICE", payload: {} };
  if (!active.inHolding) {
    if (!restoredThisTurn) {
      const restore = owned(active.userId).filter((asset) => asset.mortgaged && active.cash - unmortgageCost(economy, asset) >= policy.purchaseReserve)
        .sort((a, b) => unmortgageCost(economy, a) - unmortgageCost(economy, b) || a.tileIndex - b.tileIndex)[0];
      if (restore !== undefined) return { actor: active.userId, type: "UNMORTGAGE", payload: { assetId: restore.assetId } };
    }
    if (turn.developmentActionsUsed < CANDIDATE_RULES.developmentActions) {
      for (const set of economy.sets) {
        const members = state.assets.filter((asset) => set.includes(asset.tileIndex));
        if (!members.every((asset) => asset.ownerUserId === active.userId) || members.some((asset) => asset.mortgaged)) continue;
        const minimum = Math.min(...members.map(level));
        if (minimum >= 4) continue;
        const target = members.filter((asset) => level(asset) === minimum).sort((a, b) => a.tileIndex - b.tileIndex)[0];
        const cost = target === undefined ? undefined : economy.property.get(target.tileIndex)?.buildingCost;
        if (target === undefined || cost === undefined || active.cash - cost < policy.developmentReserve) continue;
        return { actor: active.userId, type: "BUILD", payload: { assetId: target.assetId } };
      }
    }
  }
  return { actor: active.userId, type: "END_TURN", payload: {} };
}

export function simulateProductionGame(config: ProductionSimulationConfig): GameSimulationResult {
  const economy = economyOf(config.boardRef);
  const policy = config.policy ?? BASELINE_POLICY;
  const kind = economy.board.economyProfile.kind;
  const maxRounds = config.maxRounds ?? (kind === "standard" ? 90 : 80);
  const count = config.players;
  const ids = Array.from({ length: count }, (_unused, index) => "p" + index);
  const seatOf = (userId: string) => ids.indexOf(userId);
  const rng: RandomSource = createSeededRandom(config.seed);
  const propertyCount = economy.property.size;

  let state = createInitialGameState({
    gameId: "sim-" + config.seed, board: economy.board, playerIds: ids,
    ...(config.startingCash === undefined ? {} : { startingCash: config.startingCash }),
  });
  let clock = 1_000_000;
  let commands = 0;

  // Metrics, in SPIKE-008 terms.
  let seatSteps = 0;
  let laps = 0;
  let startIncome = 0;
  let listedProperties = 0;
  let auctionedProperties = 0;
  let auctionSales = 0;
  let purchases = 0;
  let trades = 0;
  let firstSetTurn: number | null = null;
  let firstBuildTurn: number | null = null;
  let firstBankruptcyTurn: number | null = null;
  const eliminationTurns: number[] = [];
  const acquisitionTurns: { quarter: number | null; half: number | null; threeQuarter: number | null } = { quarter: null, half: null, threeQuarter: null };
  let rentPaid = 0;
  const rentCollected = new Map<string, number>(ids.map((id) => [id, 0]));
  let mortgageEvents = 0;
  let unmortgageEvents = 0;
  let taxPaid = 0;
  let cardBankNet = 0;
  const debts = new Set<string>();
  const checkpoints: CashCheckpoint[] = [];

  // SPIKE-008 counts turns begun and seat steps (a bankrupt seat still costs a step).
  let turns = 0;
  let restoredThisTurn = false;
  const roundsDue: number[] = [];

  const run = (actor: string, type: string, payload: unknown): GameplayEvent => {
    commands += 1;
    if (commands > MAX_COMMANDS) throw new Error("simulation exceeded " + MAX_COMMANDS + " commands");
    clock += 1000;
    const before = state;
    const result = applyGameplayCommand(
      state,
      { type, gameId: state.gameId, actionId: "sim-" + commands, expectedGameVersion: state.gameVersion, payload },
      {
        actorUserId: actor, board: economy.board, rng, cardCatalog: economy.cards, currentTime: clock,
        auctionDecisionDeadlineAt: clock + 20_000, debtDeadlineAt: clock + 120_000,
      },
    );
    if (result.kind !== "ACCEPTED") throw new SimulationRefusedError(type, "reason" in result ? String(result.reason) : result.kind);
    state = result.state;
    const from = before.turn;
    const to = state.turn;
    if (to !== null && (from === null || to.turnNumber > from.turnNumber)) {
      turns += 1;
      restoredThisTurn = false;
      if (from !== null) {
        const previousRound = Math.floor(seatSteps / count);
        seatSteps += (seatOf(to.activePlayerId) - seatOf(from.activePlayerId) + count) % count || count;
        for (let round = previousRound + 1; round <= Math.floor(seatSteps / count); round += 1) roundsDue.push(round);
      }
    }
    observe(before, actor, type, result.event);
    return result.event;
  };

  const observe = (before: GameState, actor: string, type: string, event: GameplayEvent): void => {
    const turn = turns;
    // Rent: one other player's income in a non-trade, non-auction step. Several recipients at
    // once is a card paying everyone, which SPIKE-008 does not count as rent.
    if (type !== "ACCEPT_TRADE" && type !== "PLACE_BID" && type !== "PASS_AUCTION") {
      const gains = state.players.flatMap((player) => {
        if (player.userId === actor) return [];
        const gained = player.cash - (before.players.find((candidate) => candidate.userId === player.userId)?.cash ?? 0);
        return gained > 0 ? [[player.userId, gained] as const] : [];
      });
      const only = gains.length === 1 ? gains[0] : undefined;
      if (only !== undefined) {
        rentPaid += only[1];
        rentCollected.set(only[0], (rentCollected.get(only[0]) ?? 0) + only[1]);
      }
    }
    if (type === "DRAW_CARD") {
      const total = (players: readonly PlayerState[]) => players.reduce((sum, player) => sum + player.cash, 0);
      cardBankNet += total(state.players) - total(before.players);
    }
    const pending = state.pendingResolution;
    if (pending?.obligation !== null && pending !== null) debts.add(pending.resolutionId);
    const steps = event.type === "TURN_AUTO_PLAYED" ? event.steps : [event];
    for (const step of steps) {
      switch (step.type) {
        case "DICE_ROLLED":
          if (step.movement !== null) {
            laps += step.movement.startCrossings;
            startIncome += step.movement.startAward;
          }
          if (step.resolution?.kind === "TAX") taxPaid += step.resolution.amount;
          break;
        case "CARD_RESOLVED":
          startIncome += step.startAward;
          if (step.startAward > 0) laps += 1;
          break;
        case "PROPERTY_BOUGHT":
          purchases += 1;
          break;
        case "PROPERTY_DECLINED":
          auctionedProperties += 1;
          break;
        case "AUCTION_UPDATED":
          for (const fact of step.facts) {
            if (fact.type === "WINNER") {
              auctionSales += 1;
              purchases += 1;
            }
          }
          break;
        case "DEVELOPMENT_BOUGHT":
          firstBuildTurn ??= turn;
          break;
        case "ASSET_MORTGAGED":
          mortgageEvents += 1;
          break;
        case "ASSET_UNMORTGAGED":
          unmortgageEvents += 1;
          break;
        case "TRADE_UPDATED":
          if (step.fact.type === "ACCEPTED") trades += 1;
          break;
        case "PLAYER_BANKRUPT":
          for (let index = 0; index <= step.removals.length; index += 1) eliminationTurns.push(turn);
          firstBankruptcyTurn ??= turn;
          break;
        default:
          break;
      }
    }
    if (firstSetTurn === null && state.assets.some((asset) => asset.kind === "PROPERTY" && asset.ownerUserId !== null
      && setAssets(state, economy, asset).every((candidate) => candidate.ownerUserId === asset.ownerUserId))) {
      firstSetTurn = turn;
    }
    const owned = state.assets.filter((asset) => asset.kind === "PROPERTY" && asset.ownerUserId !== null).length / propertyCount;
    if (owned >= 0.25) acquisitionTurns.quarter ??= turn;
    if (owned >= 0.5) acquisitionTurns.half ??= turn;
    if (owned >= 0.75) acquisitionTurns.threeQuarter ??= turn;
  };

  const player = (userId: string) => state.players.find((candidate) => candidate.userId === userId) as PlayerState;
  const owned = (userId: string) => state.assets.filter((asset) => asset.ownerUserId === userId);

  const checkpoint = (round: number): void => {
    const rows = state.players.map((candidate): PlayerCheckpoint => ({
      playerId: seatOf(candidate.userId),
      cash: candidate.cash,
      netWorth: netWorth(state, economy, candidate),
      properties: owned(candidate.userId).filter((asset) => asset.kind === "PROPERTY").length,
      completeSets: new Set(owned(candidate.userId).filter((asset) => asset.kind === "PROPERTY"
        && setAssets(state, economy, asset).every((member) => member.ownerUserId === candidate.userId))
        .map((asset) => economy.property.get(asset.tileIndex)?.setId)).size,
      rentCollected: rentCollected.get(candidate.userId) ?? 0,
    }));
    checkpoints.push({ round, cash: rows.map((row) => row.cash), gini: gini(rows.map((row) => row.netWorth)), players: rows });
  };

  /** One set-completion purchase per round, at 125% of list price (SPIKE-008 policy). */
  const closeOneSetTrade = (): void => {
    if (state.phase !== "ACTIVE_TURN" || state.auction !== null) return;
    const debtor = state.pendingResolution?.obligation?.debtorUserId ?? null;
    for (const buyer of state.players) {
      if (buyer.status !== "ACTIVE" || buyer.userId === debtor) continue;
      for (const indexes of economy.sets) {
        const members = state.assets.filter((asset) => indexes.includes(asset.tileIndex));
        const missing = members.filter((asset) => asset.ownerUserId !== buyer.userId);
        const target = missing[0];
        if (missing.length !== 1 || target === undefined || target.ownerUserId === null || target.ownerUserId === debtor) continue;
        if (target.mortgaged || members.some((asset) => level(asset) > 0)) continue;
        if (player(target.ownerUserId).status !== "ACTIVE") continue;
        const offer = roundToTen(price(economy, target) * policy.tradeMarkup);
        if (buyer.cash - offer < policy.purchaseReserve) continue;
        const seller = target.ownerUserId;
        run(buyer.userId, "PROPOSE_TRADE", { recipientUserId: seller, offered: { cash: offer, assetIds: [] }, requested: { cash: 0, assetIds: [target.assetId] } });
        const trade = state.ruleState.trades.at(-1);
        if (trade === undefined) return;
        run(seller, "ACCEPT_TRADE", { tradeId: trade.tradeId });
        return;
      }
    }
  };

  run("p0", "START_GAME", {});

  while (state.phase !== "GAME_OVER" && seatSteps < maxRounds * count) {
    const due = roundsDue.shift();
    if (due !== undefined) {
      closeOneSetTrade();
      if (CHECKPOINT_ROUNDS.has(due)) checkpoint(due);
      continue;
    }
    const decision = botDecision(state, economy, policy, restoredThisTurn);
    if (decision.type === "BUY_PROPERTY" || decision.type === "DECLINE_PROPERTY") listedProperties += 1;
    if (decision.type === "UNMORTGAGE") restoredThisTurn = true;
    run(decision.actor, decision.type, decision.payload);
  }

  const survivors = state.players.filter((candidate) => candidate.status === "ACTIVE");
  const naturalWinner = state.phase === "GAME_OVER";
  const winner = naturalWinner
    ? survivors[0]
    : [...state.players].sort((a, b) => netWorth(state, economy, b) - netWorth(state, economy, a) || seatOf(a.userId) - seatOf(b.userId))[0];
  if (winner === undefined) throw new Error("simulation has no winner");
  const collected = [...rentCollected.values()];
  const totalCollected = collected.reduce((sum, value) => sum + value, 0);
  return {
    board: kind,
    players: count,
    seed: config.seed,
    turns,
    rounds: (naturalWinner ? seatSteps + 1 : seatSteps) / count,
    naturalWinner,
    winnerId: seatOf(winner.userId),
    laps,
    startIncome,
    listedProperties,
    auctionedProperties,
    auctionSales,
    purchases,
    trades,
    firstSetTurn,
    firstBuildTurn,
    holdingDevelopmentActions: 0,
    firstBankruptcyTurn,
    eliminationTurns,
    acquisitionTurns,
    ownershipSaturation: state.assets.filter((asset) => asset.kind === "PROPERTY" && asset.ownerUserId !== null).length / propertyCount,
    rentPaid,
    topRentShare: totalCollected === 0 ? 0 : Math.max(...collected) / totalCollected,
    mortgageEvents,
    unmortgageEvents,
    liquidityEvents: debts.size,
    taxPaid,
    cardBankNet,
    bankruptcies: eliminationTurns.length,
    checkpoints,
  };
}

export const PRODUCTION_MATRIX: readonly Readonly<{ boardRef: string; board: "standard" | "grand"; players: readonly number[] }>[] = [
  { boardRef: "world-tour-standard@1", board: "standard", players: [3, 4, 5, 6] },
  { boardRef: "world-tour-grand@1", board: "grand", players: [6, 7, 8, 9, 10] },
];

export function productionSeeds(boardRef: string, players: number, games: number, seedBase = 0x5eed_0008): readonly number[] {
  const kind = canonicalBoard(boardRef).board.economyProfile.kind;
  return Array.from({ length: games }, (_unused, caseIndex) => configurationSeed(kind, players, caseIndex, seedBase));
}

/** 250-seed style configuration run with the SPIKE-008 seed schedule and summary bands. */
export function runProductionConfiguration(
  boardRef: string,
  players: number,
  games: number,
  options: Readonly<{ seedBase?: number; startingCash?: number }> = {},
): SimulationSummary {
  const kind = canonicalBoard(boardRef).board.economyProfile.kind;
  const results = Array.from({ length: games }, (_unused, caseIndex) => simulateProductionGame({
    boardRef, players, seed: configurationSeed(kind, players, caseIndex, options.seedBase ?? 0x5eed_0008),
    ...(options.startingCash === undefined ? {} : { startingCash: options.startingCash }),
  }));
  return summarizeSimulations(results);
}
