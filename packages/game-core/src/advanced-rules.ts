import type { BoardDefinition } from "./board";
import type { CardCatalogDefinition, CardDefinition, HeldCardCapability } from "./cards";
import type { DiceRoll } from "./dice";
import type { CardDeck } from "./economy";
import { calculateMovement } from "./movement";
import { shuffle, type RandomSource } from "./random";
import type { AssetState, PlayerState } from "./state";

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
  | { readonly type: "DRAW_CARD"; readonly deckId: CardDeck };

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

export type TradeFactType = "PROPOSED" | "COUNTERED" | "ACCEPTED" | "REJECTED" | "CANCELLED";

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

/** Deadline + handoff metadata for the CORE-011 obligation, which remains the debt truth. */
export interface DebtRuleState {
  readonly resolutionId: string;
  readonly deadlineAt: number;
  readonly bankruptcyRequired: boolean;
}

export interface AdvancedRuleState {
  readonly decks: readonly DeckState[];
  readonly heldCards: readonly HeldCardState[];
  readonly effectContinuation: EffectContinuationState | null;
  readonly trades: readonly TradeState[];
  readonly tradeFacts: readonly TradeFact[];
  readonly debt: DebtRuleState | null;
}

export const EMPTY_ADVANCED_RULE_STATE: AdvancedRuleState = Object.freeze({
  decks: Object.freeze([]),
  heldCards: Object.freeze([]),
  effectContinuation: null,
  trades: Object.freeze([]),
  tradeFacts: Object.freeze([]),
  debt: null,
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
    && type !== "REJECTED" && type !== "CANCELLED") {
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

function parseFrame(value: unknown, path: string): EffectFrame {
  const item = record(value, path);
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
      parseFrame(frame, path + ".frames[" + index + "]"),
    ),
    roll: context.parseRoll(item.roll, path + ".roll"),
  };
}

function parseDebt(value: unknown): DebtRuleState | null {
  if (value === null) return null;
  const path = "$.ruleState.debt";
  const item = record(value, path);
  keys(item, ["resolutionId", "deadlineAt", "bankruptcyRequired"], path);
  if (item.bankruptcyRequired !== true && item.bankruptcyRequired !== false) {
    invalid(path + ".bankruptcyRequired", "expected a boolean");
  }
  return {
    resolutionId: id(item.resolutionId, path + ".resolutionId"),
    deadlineAt: integer(item.deadlineAt, path + ".deadlineAt"),
    bankruptcyRequired: item.bankruptcyRequired,
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
  keys(root, ["decks", "heldCards", "effectContinuation", "trades", "tradeFacts", "debt"], "$.ruleState");
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
      if (frame.type === "EFFECT" && !effectIds.has(frame.effectId)) {
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
  | { readonly type: "LAND"; readonly tileIndex: number }
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
    }
  | {
      readonly kind: "SUSPENDED";
      readonly players: readonly PlayerState[];
      readonly ruleState: AdvancedRuleState;
      readonly effectId: string;
      readonly amount: number;
      readonly frames: readonly EffectFrame[];
      readonly remainingSteps: number;
      readonly drawnCardIds: readonly string[];
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
    Object.freeze({ kind: "COMPLETED", players, ruleState, terminal, drawnCardIds: Object.freeze(drawnCardIds) });
  const suspend = (effectId: string, amount: number): EffectRunResult => Object.freeze({
    kind: "SUSPENDED",
    players,
    ruleState,
    effectId,
    amount,
    frames: Object.freeze(frames.slice()),
    remainingSteps,
    drawnCardIds: Object.freeze(drawnCardIds),
  });
  const draw = (deck: CardDeck): void => {
    const drawn = drawCard(ruleState, input.catalog, deck, input.actorUserId, input.rng);
    ruleState = drawn.state;
    drawnCardIds.push(drawn.card.cardId);
    if (drawn.card.heldCapability === null) frames.push({ type: "EFFECT", effectId: drawn.card.effectId });
  };
  const land = (frame: EffectFrame, to: number, startAward: number): EffectRunResult | null => {
    updateActor({ position: to, cash: checkedCash(actor().cash + startAward) });
    const tile = input.board.economyProfile.tiles[to];
    if (tile?.type === "card") {
      frames.push({ type: "DRAW_CARD", deckId: tile.deck });
      return null;
    }
    if (frames.length > 0) return failed("NON_TERMINAL_MOVEMENT", frame);
    return completed({ type: "LAND", tileIndex: to });
  };

  while (frames.length > 0) {
    const frame = frames.pop() as EffectFrame;
    if (remainingSteps === 0) return failed("EFFECT_STEP_LIMIT", frame);
    remainingSteps -= 1;

    if (frame.type === "DRAW_CARD") {
      draw(frame.deckId);
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
      case "REPAIR_OWNED_ASSETS": {
        const amount = input.assets.reduce((total, asset) =>
          asset.kind === "PROPERTY" && asset.ownerUserId === input.actorUserId
            ? total + effect.perProperty + asset.developmentLevel * effect.perDevelopmentLevel
            : total, 0);
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
      case "ENTER_DETENTION":
        if (frames.length > 0) return failed("NON_TERMINAL_MOVEMENT", frame);
        return completed({ type: "ENTER_HOLDING" });
    }
  }
  return completed(null);
}
