import type { BoardDefinition } from "./board";
import type { CardCatalogDefinition, CardDefinition, HeldCardCapability, LandingRent } from "./cards";
import type { DiceRoll } from "./dice";
import type { CardDeck } from "./economy";
import { EMPTY_FAIR_PLAY, type FairPlayIncident, type FairPlayState, type LopsidedTrade } from "./integrity";
import { calculateMovement } from "./movement";
import { shuffle, type RandomSource } from "./random";
import type { AssetState, ObligationCreditor, PlayerState } from "./state";

export const MAX_RESOLUTION_STEPS = 16;

export interface DeckState {
  readonly deckId: CardDeck;
  readonly drawPile: readonly string[];
  readonly discardPile: readonly string[];
}

export interface HeldCardState {
  readonly cardId: string;
  readonly deckId: CardDeck;
  readonly ownerUserId: string;
  readonly capability: HeldCardCapability;
}

export type EffectFrame =
  | { readonly type: "EFFECT"; readonly effectId: string }
  | { readonly type: "DRAW_CARD"; readonly deckId: CardDeck }
  /** One creditor per frame, so a shortfall suspends against exactly one player. */
  | { readonly type: "PAY_PLAYER"; readonly effectId: string; readonly userId: string; readonly amount: number };

/** Everything needed to resume a suspended effect chain after reconstruction. */
export interface EffectContinuationState {
  readonly resolutionId: string;
  readonly actorUserId: string;
  readonly originTileIndex: number;
  readonly remainingSteps: number;
  readonly frames: readonly EffectFrame[];
  /** The roll that landed on the originating card tile; later landings reuse it. */
  readonly roll: DiceRoll;
}

export interface TradeBundle {
  readonly cash: number;
  readonly assetIds: readonly string[];
}

export interface TradeState {
  readonly tradeId: string;
  readonly parentTradeId: string | null;
  readonly proposerUserId: string;
  readonly recipientUserId: string;
  /** What the proposer gives. */
  readonly offered: TradeBundle;
  /** What the recipient gives. */
  readonly requested: TradeBundle;
  readonly createdGameVersion: number;
  /** Debt resolution this liquidation trade was created under, or null for an ordinary trade. */
  readonly liquidationFor: string | null;
}

/** VOIDED: closed by the rules because a participant was eliminated. */
export type TradeFactType = "PROPOSED" | "COUNTERED" | "ACCEPTED" | "REJECTED" | "CANCELLED" | "VOIDED";

/** Neutral authoritative trade history for later integrity analysis. Never a judgement. */
export interface TradeFact {
  readonly type: TradeFactType;
  readonly tradeId: string;
  readonly parentTradeId: string | null;
  readonly actorUserId: string;
  readonly proposerUserId: string;
  readonly recipientUserId: string;
  readonly offered: TradeBundle;
  readonly requested: TradeBundle;
  readonly liquidationFor: string | null;
  readonly gameVersion: number;
  readonly actionId: string;
}

/** Deadline metadata for the CORE-011 obligation, which remains the debt truth. */
export interface DebtRuleState {
  readonly resolutionId: string;
  readonly deadlineAt: number;
}

/**
 * Neutral elimination record: who went out, why, to whom, and exactly what moved.
 * REMOVED (INT-001 fair-play removal) settles to the bank with no debt behind it.
 */
export interface EliminationFact {
  readonly userId: string;
  /** RESIGNED: the player left voluntarily with no debt; like a removal, it settles to the bank. */
  readonly reason: "DECLARED" | "DEADLINE" | "REMOVED" | "RESIGNED";
  /** The debt resolution that ended in bankruptcy; null for a removal. */
  readonly resolutionId: string | null;
  readonly creditor: ObligationCreditor;
  readonly obligationAmount: number;
  /** Debtor cash plus development sell-back proceeds, paid to the creditor (or the bank). */
  readonly cashTransferred: number;
  readonly assetIds: readonly string[];
  readonly gameVersion: number;
  readonly actionId: string;
}

export interface GameOutcome {
  readonly reason: "LAST_STANDING";
  readonly winnerUserIds: readonly string[];
  readonly winningTeamId: string | null;
  /** Every player, best first: survivors in seat order, then eliminations newest first. */
  readonly placements: readonly string[];
  readonly endedGameVersion: number;
}

export interface AdvancedRuleState {
  readonly decks: readonly DeckState[];
  readonly heldCards: readonly HeldCardState[];
  readonly effectContinuation: EffectContinuationState | null;
  readonly trades: readonly TradeState[];
  readonly tradeFacts: readonly TradeFact[];
  readonly debt: DebtRuleState | null;
  readonly eliminations: readonly EliminationFact[];
  readonly outcome: GameOutcome | null;
  readonly fairPlay: FairPlayState;
}

export const EMPTY_ADVANCED_RULE_STATE: AdvancedRuleState = Object.freeze({
  decks: Object.freeze([]),
  heldCards: Object.freeze([]),
  effectContinuation: null,
  trades: Object.freeze([]),
  tradeFacts: Object.freeze([]),
  debt: null,
  eliminations: Object.freeze([]),
  outcome: null,
  fairPlay: EMPTY_FAIR_PLAY,
});

export class AdvancedRuleValidationError extends Error {
  constructor(readonly path: string, message: string) {
    super(path + ": " + message);
    this.name = "AdvancedRuleValidationError";
  }
}

function invalid(path: string, message: string): never {
  throw new AdvancedRuleValidationError(path, message);
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    invalid(path, "expected an object");
  }
  return value as Record<string, unknown>;
}

function array(value: unknown, path: string): readonly unknown[] {
  if (!Array.isArray(value)) invalid(path, "expected an array");
  return value;
}

function keys(value: Record<string, unknown>, expected: readonly string[], path: string): void {
  const allowed = new Set(expected);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) invalid(path + "." + key, "unexpected field");
  }
  for (const key of expected) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) invalid(path + "." + key, "missing field");
  }
}

function id(value: unknown, path: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    invalid(path, "expected a non-empty string");
  }
  return value;
}

function nullableId(value: unknown, path: string): string | null {
  return value === null ? null : id(value, path);
}

function integer(value: unknown, path: string, minimum = 0): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) {
    invalid(path, "expected a safe integer >= " + minimum);
  }
  return value as number;
}

function deckId(value: unknown, path: string): CardDeck {
  if (value !== "surprise" && value !== "treasure") invalid(path, "unknown deck");
  return value;
}

function stringList(value: unknown, path: string): readonly string[] {
  const result = array(value, path).map((item, index) => id(item, path + "[" + index + "]"));
  if (new Set(result).size !== result.length) invalid(path, "contains a duplicate");
  return result;
}

function player(value: unknown, path: string, playerIds: ReadonlySet<string>): string {
  const userId = id(value, path);
  if (!playerIds.has(userId)) invalid(path, "must identify a game player");
  return userId;
}

export interface AdvancedRuleParseContext {
  readonly playerIds: ReadonlySet<string>;
  readonly activePlayerIds: ReadonlySet<string>;
  readonly assetIds: ReadonlySet<string>;
  readonly tileCount: number;
  readonly parseRoll: (value: unknown, path: string) => DiceRoll;
}

function parseBundle(
  value: unknown,
  path: string,
  assetIds: ReadonlySet<string>,
): TradeBundle {
  const item = record(value, path);
  keys(item, ["cash", "assetIds"], path);
  const bundle = {
    cash: integer(item.cash, path + ".cash"),
    assetIds: stringList(item.assetIds, path + ".assetIds"),
  };
  for (const assetId of bundle.assetIds) {
    if (!assetIds.has(assetId)) invalid(path + ".assetIds", "unknown asset " + assetId);
  }
  return bundle;
}

function parseTradeSides(
  item: Record<string, unknown>,
  path: string,
  context: AdvancedRuleParseContext,
): Pick<TradeState, "proposerUserId" | "recipientUserId" | "offered" | "requested"> {
  const proposerUserId = player(item.proposerUserId, path + ".proposerUserId", context.playerIds);
  const recipientUserId = player(item.recipientUserId, path + ".recipientUserId", context.playerIds);
  if (proposerUserId === recipientUserId) invalid(path, "trade participants must differ");
  const offered = parseBundle(item.offered, path + ".offered", context.assetIds);
  const requested = parseBundle(item.requested, path + ".requested", context.assetIds);
  const assets = [...offered.assetIds, ...requested.assetIds];
  if (new Set(assets).size !== assets.length) invalid(path, "an asset cannot appear on both sides");
  if (offered.cash === 0 && requested.cash === 0 && assets.length === 0) {
    invalid(path, "a trade must exchange something");
  }
  return { proposerUserId, recipientUserId, offered, requested };
}

function parseTrade(value: unknown, index: number, context: AdvancedRuleParseContext): TradeState {
  const path = "$.ruleState.trades[" + index + "]";
  const item = record(value, path);
  keys(item, [
    "tradeId", "parentTradeId", "proposerUserId", "recipientUserId", "offered", "requested",
    "createdGameVersion", "liquidationFor",
  ], path);
  const sides = parseTradeSides(item, path, context);
  if (!context.activePlayerIds.has(sides.proposerUserId)
    || !context.activePlayerIds.has(sides.recipientUserId)) {
    invalid(path, "open trade participants must be eligible players");
  }
  return {
    tradeId: id(item.tradeId, path + ".tradeId"),
    parentTradeId: nullableId(item.parentTradeId, path + ".parentTradeId"),
    ...sides,
    createdGameVersion: integer(item.createdGameVersion, path + ".createdGameVersion"),
    liquidationFor: nullableId(item.liquidationFor, path + ".liquidationFor"),
  };
}

function parseTradeFact(value: unknown, index: number, context: AdvancedRuleParseContext): TradeFact {
  const path = "$.ruleState.tradeFacts[" + index + "]";
  const item = record(value, path);
  keys(item, [
    "type", "tradeId", "parentTradeId", "actorUserId", "proposerUserId", "recipientUserId",
    "offered", "requested", "liquidationFor", "gameVersion", "actionId",
  ], path);
  const type = item.type;
  if (type !== "PROPOSED" && type !== "COUNTERED" && type !== "ACCEPTED"
    && type !== "REJECTED" && type !== "CANCELLED" && type !== "VOIDED") {
    invalid(path + ".type", "unknown trade fact");
  }
  return {
    type,
    tradeId: id(item.tradeId, path + ".tradeId"),
    parentTradeId: nullableId(item.parentTradeId, path + ".parentTradeId"),
    actorUserId: player(item.actorUserId, path + ".actorUserId", context.playerIds),
    ...parseTradeSides(item, path, context),
    liquidationFor: nullableId(item.liquidationFor, path + ".liquidationFor"),
    gameVersion: integer(item.gameVersion, path + ".gameVersion", 1),
    actionId: id(item.actionId, path + ".actionId"),
  };
}

function parseFrame(value: unknown, path: string, playerIds: ReadonlySet<string>): EffectFrame {
  const item = record(value, path);
  if (item.type === "PAY_PLAYER") {
    keys(item, ["type", "effectId", "userId", "amount"], path);
    return {
      type: "PAY_PLAYER",
      effectId: id(item.effectId, path + ".effectId"),
      userId: player(item.userId, path + ".userId", playerIds),
      amount: integer(item.amount, path + ".amount", 1),
    };
  }
  if (item.type === "EFFECT") {
    keys(item, ["type", "effectId"], path);
    return { type: "EFFECT", effectId: id(item.effectId, path + ".effectId") };
  }
  if (item.type === "DRAW_CARD") {
    keys(item, ["type", "deckId"], path);
    return { type: "DRAW_CARD", deckId: deckId(item.deckId, path + ".deckId") };
  }
  return invalid(path + ".type", "unknown effect frame");
}

function parseEffectContinuation(
  value: unknown,
  context: AdvancedRuleParseContext,
): EffectContinuationState | null {
  if (value === null) return null;
  const path = "$.ruleState.effectContinuation";
  const item = record(value, path);
  keys(item, ["resolutionId", "actorUserId", "originTileIndex", "remainingSteps", "frames", "roll"], path);
  const originTileIndex = integer(item.originTileIndex, path + ".originTileIndex");
  if (originTileIndex >= context.tileCount) invalid(path + ".originTileIndex", "unknown tile");
  const remainingSteps = integer(item.remainingSteps, path + ".remainingSteps");
  if (remainingSteps > MAX_RESOLUTION_STEPS) invalid(path + ".remainingSteps", "exceeds the shared budget");
  return {
    resolutionId: id(item.resolutionId, path + ".resolutionId"),
    actorUserId: player(item.actorUserId, path + ".actorUserId", context.playerIds),
    originTileIndex,
    remainingSteps,
    frames: array(item.frames, path + ".frames").map((frame, index) =>
      parseFrame(frame, path + ".frames[" + index + "]", context.playerIds),
    ),
    roll: context.parseRoll(item.roll, path + ".roll"),
  };
}

function parseDebt(value: unknown): DebtRuleState | null {
  if (value === null) return null;
  const path = "$.ruleState.debt";
  const item = record(value, path);
  keys(item, ["resolutionId", "deadlineAt"], path);
  return {
    resolutionId: id(item.resolutionId, path + ".resolutionId"),
    deadlineAt: integer(item.deadlineAt, path + ".deadlineAt"),
  };
}

function parseCreditor(value: unknown, path: string, playerIds: ReadonlySet<string>): ObligationCreditor {
  const item = record(value, path);
  if (item.type === "BANK") {
    keys(item, ["type"], path);
    return { type: "BANK" };
  }
  if (item.type === "PLAYER") {
    keys(item, ["type", "userId"], path);
    return { type: "PLAYER", userId: player(item.userId, path + ".userId", playerIds) };
  }
  return invalid(path + ".type", "unknown creditor");
}

function parseElimination(value: unknown, index: number, context: AdvancedRuleParseContext): EliminationFact {
  const path = "$.ruleState.eliminations[" + index + "]";
  const item = record(value, path);
  keys(item, [
    "userId", "reason", "resolutionId", "creditor", "obligationAmount", "cashTransferred", "assetIds",
    "gameVersion", "actionId",
  ], path);
  if (item.reason !== "DECLARED" && item.reason !== "DEADLINE" && item.reason !== "REMOVED" && item.reason !== "RESIGNED") {
    invalid(path + ".reason", "unknown reason");
  }
  const debtless = item.reason === "REMOVED" || item.reason === "RESIGNED";
  const resolutionId = nullableId(item.resolutionId, path + ".resolutionId");
  const obligationAmount = integer(item.obligationAmount, path + ".obligationAmount");
  if (debtless !== (resolutionId === null) || (resolutionId !== null) !== (obligationAmount > 0)) {
    invalid(path, "a bankruptcy ends a debt; a removal or resignation has none");
  }
  const creditor = parseCreditor(item.creditor, path + ".creditor", context.playerIds);
  if (debtless && creditor.type !== "BANK") invalid(path + ".creditor", "a removal or resignation settles to the bank");
  const assetIds = stringList(item.assetIds, path + ".assetIds");
  for (const assetId of assetIds) {
    if (!context.assetIds.has(assetId)) invalid(path + ".assetIds", "unknown asset " + assetId);
  }
  return {
    userId: player(item.userId, path + ".userId", context.playerIds),
    reason: item.reason,
    resolutionId,
    creditor,
    obligationAmount,
    cashTransferred: integer(item.cashTransferred, path + ".cashTransferred"),
    assetIds,
    gameVersion: integer(item.gameVersion, path + ".gameVersion", 1),
    actionId: id(item.actionId, path + ".actionId"),
  };
}

function parseLopsided(value: unknown, path: string, context: AdvancedRuleParseContext): LopsidedTrade {
  const item = record(value, path);
  keys(item, [
    "tradeId", "giverUserId", "receiverUserId", "givenValue", "returnedValue", "liquidationFor", "gameVersion",
  ], path);
  return {
    tradeId: id(item.tradeId, path + ".tradeId"),
    giverUserId: player(item.giverUserId, path + ".giverUserId", context.playerIds),
    receiverUserId: player(item.receiverUserId, path + ".receiverUserId", context.playerIds),
    givenValue: integer(item.givenValue, path + ".givenValue", 1),
    returnedValue: integer(item.returnedValue, path + ".returnedValue"),
    liquidationFor: nullableId(item.liquidationFor, path + ".liquidationFor"),
    gameVersion: integer(item.gameVersion, path + ".gameVersion", 1),
  };
}

function parseIncident(value: unknown, path: string, context: AdvancedRuleParseContext): FairPlayIncident {
  const item = record(value, path);
  keys(item, [
    "kind", "tradeId", "giverUserId", "receiverUserId", "givenValue", "returnedValue", "consequence",
    "gameVersion", "actionId",
  ], path);
  if (item.kind !== "PATTERN" && item.kind !== "DUMP") invalid(path + ".kind", "unknown incident");
  if (item.consequence !== "WARNING" && item.consequence !== "REMOVAL") {
    invalid(path + ".consequence", "unknown consequence");
  }
  return {
    kind: item.kind,
    tradeId: id(item.tradeId, path + ".tradeId"),
    giverUserId: player(item.giverUserId, path + ".giverUserId", context.playerIds),
    receiverUserId: player(item.receiverUserId, path + ".receiverUserId", context.playerIds),
    givenValue: integer(item.givenValue, path + ".givenValue", 1),
    returnedValue: integer(item.returnedValue, path + ".returnedValue"),
    consequence: item.consequence,
    gameVersion: integer(item.gameVersion, path + ".gameVersion", 1),
    actionId: id(item.actionId, path + ".actionId"),
  };
}

function parseFairPlay(value: unknown, context: AdvancedRuleParseContext): FairPlayState {
  const path = "$.ruleState.fairPlay";
  const item = record(value, path);
  keys(item, ["lopsidedTrades", "incidents"], path);
  const lopsidedTrades = array(item.lopsidedTrades, path + ".lopsidedTrades").map((entry, index) =>
    parseLopsided(entry, path + ".lopsidedTrades[" + index + "]", context),
  );
  if (new Set(lopsidedTrades.map((trade) => trade.tradeId)).size !== lopsidedTrades.length) {
    invalid(path + ".lopsidedTrades", "a trade is recorded once");
  }
  const incidents = array(item.incidents, path + ".incidents").map((entry, index) =>
    parseIncident(entry, path + ".incidents[" + index + "]", context),
  );
  for (const incident of incidents) {
    const source = lopsidedTrades.find((trade) => trade.tradeId === incident.tradeId);
    if (source === undefined || source.giverUserId !== incident.giverUserId
      || source.receiverUserId !== incident.receiverUserId) {
      invalid(path + ".incidents", "an incident must cite its recorded lopsided trade");
    }
  }
  return { lopsidedTrades, incidents };
}

function parseOutcome(value: unknown, context: AdvancedRuleParseContext): GameOutcome | null {
  if (value === null) return null;
  const path = "$.ruleState.outcome";
  const item = record(value, path);
  keys(item, ["reason", "winnerUserIds", "winningTeamId", "placements", "endedGameVersion"], path);
  if (item.reason !== "LAST_STANDING") invalid(path + ".reason", "unknown outcome");
  const winnerUserIds = stringList(item.winnerUserIds, path + ".winnerUserIds");
  const placements = stringList(item.placements, path + ".placements");
  if (winnerUserIds.length === 0) invalid(path + ".winnerUserIds", "an outcome needs a winner");
  for (const userId of winnerUserIds) player(userId, path + ".winnerUserIds", context.playerIds);
  if (placements.length !== context.playerIds.size || placements.some((userId) => !context.playerIds.has(userId))) {
    invalid(path + ".placements", "must rank every player exactly once");
  }
  return {
    reason: item.reason,
    winnerUserIds,
    winningTeamId: nullableId(item.winningTeamId, path + ".winningTeamId"),
    placements,
    endedGameVersion: integer(item.endedGameVersion, path + ".endedGameVersion", 1),
  };
}

function freezeBundle(bundle: TradeBundle): TradeBundle {
  Object.freeze(bundle.assetIds);
  return Object.freeze(bundle);
}

export function freezeTrade<T extends TradeState | TradeFact>(trade: T): T {
  freezeBundle(trade.offered);
  freezeBundle(trade.requested);
  return Object.freeze(trade);
}

function freezeRuleState(state: AdvancedRuleState): AdvancedRuleState {
  state.decks.forEach((deck) => {
    Object.freeze(deck.drawPile);
    Object.freeze(deck.discardPile);
    Object.freeze(deck);
  });
  state.heldCards.forEach(Object.freeze);
  if (state.effectContinuation !== null) {
    state.effectContinuation.frames.forEach(Object.freeze);
    Object.freeze(state.effectContinuation.frames);
    Object.freeze(state.effectContinuation);
  }
  state.trades.forEach(freezeTrade);
  state.tradeFacts.forEach(freezeTrade);
  state.eliminations.forEach((fact) => {
    Object.freeze(fact.creditor);
    Object.freeze(fact.assetIds);
    Object.freeze(fact);
  });
  Object.freeze(state.eliminations);
  if (state.outcome !== null) {
    Object.freeze(state.outcome.winnerUserIds);
    Object.freeze(state.outcome.placements);
    Object.freeze(state.outcome);
  }
  state.fairPlay.lopsidedTrades.forEach(Object.freeze);
  state.fairPlay.incidents.forEach(Object.freeze);
  Object.freeze(state.fairPlay.lopsidedTrades);
  Object.freeze(state.fairPlay.incidents);
  Object.freeze(state.fairPlay);
  Object.freeze(state.decks);
  Object.freeze(state.heldCards);
  Object.freeze(state.trades);
  Object.freeze(state.tradeFacts);
  if (state.debt !== null) Object.freeze(state.debt);
  return Object.freeze(state);
}

export function parseAdvancedRuleState(
  value: unknown,
  context: AdvancedRuleParseContext,
): AdvancedRuleState {
  const root = record(value, "$.ruleState");
  keys(root, [
    "decks", "heldCards", "effectContinuation", "trades", "tradeFacts", "debt", "eliminations", "outcome",
    "fairPlay",
  ], "$.ruleState");
  const decks = array(root.decks, "$.ruleState.decks").map((value, index): DeckState => {
    const path = "$.ruleState.decks[" + index + "]";
    const item = record(value, path);
    keys(item, ["deckId", "drawPile", "discardPile"], path);
    return {
      deckId: deckId(item.deckId, path + ".deckId"),
      drawPile: stringList(item.drawPile, path + ".drawPile"),
      discardPile: stringList(item.discardPile, path + ".discardPile"),
    };
  });
  if (new Set(decks.map((deck) => deck.deckId)).size !== decks.length) {
    invalid("$.ruleState.decks", "duplicate deck identity");
  }
  const heldCards = array(root.heldCards, "$.ruleState.heldCards").map((value, index): HeldCardState => {
    const path = "$.ruleState.heldCards[" + index + "]";
    const item = record(value, path);
    keys(item, ["cardId", "deckId", "ownerUserId", "capability"], path);
    if (item.capability !== "DETENTION_RELEASE") invalid(path + ".capability", "unknown capability");
    return {
      cardId: id(item.cardId, path + ".cardId"),
      deckId: deckId(item.deckId, path + ".deckId"),
      ownerUserId: player(item.ownerUserId, path + ".ownerUserId", context.playerIds),
      capability: item.capability,
    };
  });
  const zonedCards = [
    ...decks.flatMap((deck) => [...deck.drawPile, ...deck.discardPile]),
    ...heldCards.map((card) => card.cardId),
  ];
  if (new Set(zonedCards).size !== zonedCards.length) {
    invalid("$.ruleState", "a physical card appears in more than one zone");
  }
  const trades = array(root.trades, "$.ruleState.trades").map((trade, index) =>
    parseTrade(trade, index, context),
  );
  if (new Set(trades.map((trade) => trade.tradeId)).size !== trades.length) {
    invalid("$.ruleState.trades", "duplicate trade identity");
  }
  return freezeRuleState({
    decks,
    heldCards,
    effectContinuation: parseEffectContinuation(root.effectContinuation, context),
    trades,
    tradeFacts: array(root.tradeFacts, "$.ruleState.tradeFacts").map((fact, index) =>
      parseTradeFact(fact, index, context),
    ),
    debt: parseDebt(root.debt),
    eliminations: array(root.eliminations, "$.ruleState.eliminations").map((fact, index) =>
      parseElimination(fact, index, context),
    ),
    outcome: parseOutcome(root.outcome, context),
    fairPlay: parseFairPlay(root.fairPlay, context),
  });
}

function cardById(catalog: CardCatalogDefinition, cardId: string): CardDefinition | undefined {
  return catalog.cards.find((candidate) => candidate.cardId === cardId);
}

/** Every catalog card sits in exactly one zone of its own deck (draw, discard, or held). */
export function validateAdvancedRuleStateCatalog(
  state: AdvancedRuleState,
  catalog: CardCatalogDefinition,
): void {
  if (state.decks.length === 0 && state.heldCards.length === 0) {
    if (state.effectContinuation !== null) invalid("$.ruleState", "effects require initialized decks");
    return;
  }
  const expected = new Map(catalog.decks.map((deck) => [deck.deckId, new Set(deck.cardIds)]));
  if (state.decks.length !== expected.size) invalid("$.ruleState.decks", "must contain every catalog deck");
  const seen = new Set<string>();
  for (const deck of state.decks) {
    const cards = expected.get(deck.deckId);
    if (cards === undefined) invalid("$.ruleState.decks", "deck is absent from catalog");
    for (const cardId of [...deck.drawPile, ...deck.discardPile]) {
      if (!cards.has(cardId)) invalid("$.ruleState.decks", "card belongs to another deck");
      seen.add(cardId);
    }
  }
  for (const held of state.heldCards) {
    const card = cardById(catalog, held.cardId);
    if (card?.deckId !== held.deckId || card.heldCapability !== held.capability) {
      invalid("$.ruleState.heldCards", "held card does not match catalog");
    }
    seen.add(held.cardId);
  }
  if (seen.size !== catalog.cards.length) invalid("$.ruleState", "deck conservation failed");
  if (state.effectContinuation !== null) {
    const effectIds = new Set(catalog.effects.map((effect) => effect.effectId));
    for (const frame of state.effectContinuation.frames) {
      if (frame.type !== "DRAW_CARD" && !effectIds.has(frame.effectId)) {
        invalid("$.ruleState.effectContinuation.frames", "unknown effect");
      }
    }
  }
}

export function initializeDecks(
  state: AdvancedRuleState,
  catalog: CardCatalogDefinition,
  rng: RandomSource,
): AdvancedRuleState {
  if (state.decks.length !== 0 || state.heldCards.length !== 0) {
    throw new RangeError("decks are already initialized");
  }
  const next = freezeRuleState({
    ...state,
    decks: catalog.decks.map((deck) => ({
      deckId: deck.deckId,
      drawPile: shuffle(deck.cardIds, rng),
      discardPile: [],
    })),
  });
  validateAdvancedRuleStateCatalog(next, catalog);
  return next;
}

export interface DrawCardResult {
  readonly card: CardDefinition;
  readonly state: AdvancedRuleState;
}

/** Draws the top card; an empty draw pile first reshuffles only the discard pile. */
export function drawCard(
  state: AdvancedRuleState,
  catalog: CardCatalogDefinition,
  requestedDeckId: CardDeck,
  ownerUserId: string,
  rng: RandomSource,
): DrawCardResult {
  const current = state.decks.find((deck) => deck.deckId === requestedDeckId);
  if (current === undefined) throw new RangeError("deck is not initialized");
  const reshuffled = current.drawPile.length === 0;
  const drawPile = reshuffled ? shuffle(current.discardPile, rng) : current.drawPile.slice();
  const cardId = drawPile.shift();
  if (cardId === undefined) throw new RangeError("deck has no drawable cards");
  const card = cardById(catalog, cardId);
  if (card === undefined) throw new RangeError("drawn card is absent from catalog");
  const discardPile = reshuffled ? [] : current.discardPile.slice();
  const heldCards = state.heldCards.slice();
  if (card.heldCapability === null) discardPile.push(cardId);
  else heldCards.push({ cardId, deckId: requestedDeckId, ownerUserId, capability: card.heldCapability });
  const next = freezeRuleState({
    ...state,
    decks: state.decks.map((deck) => deck === current ? { deckId: deck.deckId, drawPile, discardPile } : deck),
    heldCards,
  });
  validateAdvancedRuleStateCatalog(next, catalog);
  return Object.freeze({ card, state: next });
}

/** Consumes a held card once by returning it to its own deck's discard pile. */
export function returnHeldCard(
  state: AdvancedRuleState,
  catalog: CardCatalogDefinition,
  cardId: string,
  ownerUserId: string,
): AdvancedRuleState {
  const held = state.heldCards.find((card) => card.cardId === cardId && card.ownerUserId === ownerUserId);
  if (held === undefined) throw new RangeError("held card is not owned by the actor");
  const next = freezeRuleState({
    ...state,
    decks: state.decks.map((deck) => deck.deckId === held.deckId
      ? { ...deck, discardPile: [...deck.discardPile, held.cardId] }
      : deck),
    heldCards: state.heldCards.filter((card) => card !== held),
  });
  validateAdvancedRuleStateCatalog(next, catalog);
  return next;
}

export type EffectTerminal =
  | { readonly type: "LAND"; readonly tileIndex: number; readonly rent: LandingRent }
  | { readonly type: "ENTER_HOLDING" };

export interface EffectDiagnostic {
  readonly code: "EFFECT_STEP_LIMIT" | "UNKNOWN_EFFECT" | "NON_TERMINAL_MOVEMENT";
  readonly failedFrame: EffectFrame;
  readonly executedSteps: number;
  readonly maximumSteps: typeof MAX_RESOLUTION_STEPS;
}

export type EffectRunResult =
  | {
      readonly kind: "COMPLETED";
      readonly players: readonly PlayerState[];
      readonly ruleState: AdvancedRuleState;
      readonly terminal: EffectTerminal | null;
      readonly drawnCardIds: readonly string[];
      /** Start salary the actor collected from card movement during this run. */
      readonly startAward: number;
    }
  | {
      readonly kind: "SUSPENDED";
      readonly players: readonly PlayerState[];
      readonly ruleState: AdvancedRuleState;
      readonly effectId: string;
      readonly amount: number;
      readonly creditor: ObligationCreditor;
      readonly frames: readonly EffectFrame[];
      readonly remainingSteps: number;
      readonly drawnCardIds: readonly string[];
      readonly startAward: number;
    }
  | { readonly kind: "FAILED"; readonly diagnostic: EffectDiagnostic };

export interface EffectRunInput {
  readonly board: BoardDefinition;
  readonly catalog: CardCatalogDefinition;
  readonly players: readonly PlayerState[];
  readonly assets: readonly AssetState[];
  readonly ruleState: AdvancedRuleState;
  readonly actorUserId: string;
  readonly frames: readonly EffectFrame[];
  readonly remainingSteps: number;
  readonly rng: RandomSource;
}

function checkedCash(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError("cash exceeds canonical range");
  return value;
}

/**
 * Runs a closed set of declarative effect frames against ONE shared step budget.
 * Movement is terminal (enforced by the catalog); its landing is returned for the caller to resolve.
 * Rejected work returns FAILED without any partial state.
 */
export function runEffectFrames(input: EffectRunInput): EffectRunResult {
  const effects = new Map(input.catalog.effects.map((effect) => [effect.effectId, effect]));
  const frames = input.frames.slice();
  let players = input.players.slice();
  let ruleState = input.ruleState;
  let remainingSteps = input.remainingSteps;
  const drawnCardIds: string[] = [];
  let startAwarded = 0;
  const actor = (): PlayerState => {
    const found = players.find((candidate) => candidate.userId === input.actorUserId);
    if (found === undefined) throw new RangeError("effect actor is not a game player");
    return found;
  };
  const updateActor = (changes: Partial<PlayerState>): void => {
    players = players.map((candidate) => candidate.userId === input.actorUserId
      ? { ...candidate, ...changes }
      : candidate);
  };
  const failed = (code: EffectDiagnostic["code"], failedFrame: EffectFrame): EffectRunResult =>
    Object.freeze({
      kind: "FAILED",
      diagnostic: Object.freeze({
        code,
        failedFrame,
        executedSteps: MAX_RESOLUTION_STEPS - remainingSteps,
        maximumSteps: MAX_RESOLUTION_STEPS,
      }),
    });
  const completed = (terminal: EffectTerminal | null): EffectRunResult =>
    Object.freeze({ kind: "COMPLETED", players, ruleState, terminal, drawnCardIds: Object.freeze(drawnCardIds), startAward: startAwarded });
  const suspend = (
    effectId: string,
    amount: number,
    creditor: ObligationCreditor = { type: "BANK" },
  ): EffectRunResult => Object.freeze({
    kind: "SUSPENDED",
    players,
    ruleState,
    effectId,
    amount,
    creditor,
    frames: Object.freeze(frames.slice()),
    remainingSteps,
    drawnCardIds: Object.freeze(drawnCardIds),
    startAward: startAwarded,
  });
  const draw = (deck: CardDeck): void => {
    const drawn = drawCard(ruleState, input.catalog, deck, input.actorUserId, input.rng);
    ruleState = drawn.state;
    drawnCardIds.push(drawn.card.cardId);
    if (drawn.card.heldCapability === null) frames.push({ type: "EFFECT", effectId: drawn.card.effectId });
  };
  const land = (
    frame: EffectFrame,
    to: number,
    startAward: number,
    rent: LandingRent = "STANDARD",
  ): EffectRunResult | null => {
    updateActor({ position: to, cash: checkedCash(actor().cash + startAward) });
    startAwarded += startAward;
    const tile = input.board.economyProfile.tiles[to];
    if (tile?.type === "card") {
      frames.push({ type: "DRAW_CARD", deckId: tile.deck });
      return null;
    }
    if (frames.length > 0) return failed("NON_TERMINAL_MOVEMENT", frame);
    return completed({ type: "LAND", tileIndex: to, rent });
  };

  while (frames.length > 0) {
    const frame = frames.pop() as EffectFrame;
    if (remainingSteps === 0) return failed("EFFECT_STEP_LIMIT", frame);
    remainingSteps -= 1;

    if (frame.type === "DRAW_CARD") {
      draw(frame.deckId);
      continue;
    }
    if (frame.type === "PAY_PLAYER") {
      if (actor().cash < frame.amount) {
        return suspend(frame.effectId, frame.amount, { type: "PLAYER", userId: frame.userId });
      }
      players = players.map((candidate) => {
        if (candidate.userId === input.actorUserId) return { ...candidate, cash: candidate.cash - frame.amount };
        if (candidate.userId === frame.userId) return { ...candidate, cash: checkedCash(candidate.cash + frame.amount) };
        return candidate;
      });
      continue;
    }
    const effect = effects.get(frame.effectId);
    if (effect === undefined) return failed("UNKNOWN_EFFECT", frame);
    switch (effect.type) {
      case "SEQUENCE":
        for (let index = effect.effectIds.length - 1; index >= 0; index -= 1) {
          frames.push({ type: "EFFECT", effectId: effect.effectIds[index] as string });
        }
        break;
      case "DRAW_CARD":
        draw(effect.deckId);
        break;
      case "ADJUST_CASH": {
        if (effect.amount < 0) {
          // The catalog only permits negative adjustments for the current player.
          if (actor().cash < -effect.amount) return suspend(effect.effectId, -effect.amount);
          updateActor({ cash: actor().cash + effect.amount });
          break;
        }
        players = players.map((candidate) => {
          const targeted = effect.target === "CURRENT_PLAYER"
            ? candidate.userId === input.actorUserId
            : candidate.status === "ACTIVE"
              && (effect.target === "EACH_PLAYER" || candidate.userId !== input.actorUserId);
          return targeted ? { ...candidate, cash: checkedCash(candidate.cash + effect.amount) } : candidate;
        });
        break;
      }
      case "PAY_EACH_OTHER_PLAYER": {
        // Seat order after the actor; pushed reversed so the nearest seat is paid first.
        const seat = players.findIndex((candidate) => candidate.userId === input.actorUserId);
        const recipients = [...players.slice(seat + 1), ...players.slice(0, seat)]
          .filter((candidate) => candidate.status === "ACTIVE");
        for (const recipient of recipients.reverse()) {
          frames.push({ type: "PAY_PLAYER", effectId: effect.effectId, userId: recipient.userId, amount: effect.amount });
        }
        break;
      }
      case "COLLECT_PER_OWNED_PROPERTY": {
        const owned = input.assets.filter((asset) =>
          asset.kind === "PROPERTY" && asset.ownerUserId === input.actorUserId
        ).length;
        updateActor({ cash: checkedCash(actor().cash + owned * effect.amount) });
        break;
      }
      case "REPAIR_OWNED_ASSETS": {
        const amount = input.assets.reduce((total, asset) => {
          if (asset.kind !== "PROPERTY" || asset.ownerUserId !== input.actorUserId) return total;
          const development = asset.developmentLevel === 4
            ? effect.perLandmark
            : asset.developmentLevel * effect.perDevelopmentLevel;
          return total + effect.perProperty + development;
        }, 0);
        if (!Number.isSafeInteger(amount)) throw new RangeError("repair charge exceeds safe integer range");
        if (actor().cash < amount) return suspend(effect.effectId, amount);
        updateActor({ cash: actor().cash - amount });
        break;
      }
      case "MOVE_TO_TILE": {
        const from = actor().position;
        const distance = (effect.tileIndex - from + input.board.tileCount) % input.board.tileCount;
        const award = effect.collectStart && distance > 0
          ? calculateMovement(input.board, from, distance).startAward
          : 0;
        const landed = land(frame, effect.tileIndex, award);
        if (landed !== null) return landed;
        break;
      }
      case "MOVE_BY": {
        const from = actor().position;
        const tileCount = input.board.tileCount;
        const to = (((from + effect.offset) % tileCount) + tileCount) % tileCount;
        const award = effect.offset > 0 ? calculateMovement(input.board, from, effect.offset).startAward : 0;
        const landed = land(frame, to, award);
        if (landed !== null) return landed;
        break;
      }
      case "MOVE_TO_NEAREST": {
        const from = actor().position;
        const tileType = effect.assetKind === "TRANSIT" ? "transit" : "utility";
        const tileCount = input.board.tileCount;
        let distance = 1;
        while (input.board.economyProfile.tiles[(from + distance) % tileCount]?.type !== tileType) distance += 1;
        const award = effect.collectStart ? calculateMovement(input.board, from, distance).startAward : 0;
        const landed = land(frame, (from + distance) % tileCount, award, effect.rent);
        if (landed !== null) return landed;
        break;
      }
      case "ENTER_DETENTION":
        if (frames.length > 0) return failed("NON_TERMINAL_MOVEMENT", frame);
        return completed({ type: "ENTER_HOLDING" });
    }
  }
  return completed(null);
}
