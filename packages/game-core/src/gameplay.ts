import {
  freezeTrade,
  initializeDecks,
  MAX_RESOLUTION_STEPS,
  returnHeldCard,
  runEffectFrames,
  type AdvancedRuleState,
  type EffectDiagnostic,
  type EffectFrame,
  type EliminationFact,
  type GameOutcome,
  type TradeBundle,
  type TradeFact,
  type TradeState,
} from "./advanced-rules";
import { parseBoardDefinition, type BoardDefinition } from "./board";
import type { CardCatalogDefinition, LandingRent } from "./cards";
import {
  classifyGameCommand,
  CommandValidationError,
  parseGameCommand,
  type AppliedActionRecord,
  type GameCommand,
} from "./command";
import { rollDice, type DiceRoll } from "./dice";
import { CANDIDATE_RULES } from "./economy";
import { lopsidedTrade, recordDumps, recordLopsidedTrade, type FairPlayIncident } from "./integrity";
import { evaluateLobbyStart } from "./lobby";
import { calculateMovement, type MovementResult } from "./movement";
import type { RandomSource } from "./random";
import {
  mortgageValue,
  propertyForAsset,
  propertySetAssets,
  purchasePrice,
  rentForAsset,
  unmortgageCost,
} from "./rules";
import {
  holdingTileIndex,
  parseGameState,
  parseTeams,
  teamOf,
  type AuctionFact,
  type AuctionState,
  type AssetState,
  type GameState,
  type MatchSettings,
  type MonetaryObligation,
  type PlayerState,
  type PendingResolution,
  type ResolutionContinuation,
  type TurnIdentity,
} from "./state";
import { dispatchLandedTile, type TileResolution } from "./tile-dispatch";

const COMMAND_TYPES = [
  "CONFIGURE_MATCH", "START_GAME", "ROLL_DICE", "END_TURN",
  "BUY_PROPERTY", "DECLINE_PROPERTY", "PLACE_BID", "PASS_AUCTION", "AUCTION_TIMEOUT",
  "BUILD", "SELL_DEVELOPMENT", "MORTGAGE", "UNMORTGAGE",
  "DRAW_CARD", "PAY_HOLDING_FEE", "USE_RELEASE_CARD",
  "PROPOSE_TRADE", "COUNTER_TRADE", "ACCEPT_TRADE", "REJECT_TRADE", "CANCEL_TRADE",
  "DEBT_TIMEOUT", "DECLARE_BANKRUPTCY", "TURN_TIMEOUT", "RESUME_CLOCKS",
] as const;

/** Commands only the room runtime may issue (from persisted deadlines), never a client. */
export const SYSTEM_COMMAND_TYPES: ReadonlySet<string> = new Set([
  "AUCTION_TIMEOUT", "DEBT_TIMEOUT", "TURN_TIMEOUT", "RESUME_CLOCKS",
]);

export type GameplayCommandType = (typeof COMMAND_TYPES)[number];

const EMPTY_PAYLOAD_COMMANDS: ReadonlySet<string> = new Set([
  "START_GAME", "ROLL_DICE", "END_TURN", "PAY_HOLDING_FEE",
]);

export interface GameplayCommandContext {
  readonly actorUserId: string;
  readonly board: BoardDefinition;
  readonly rng: RandomSource;
  readonly appliedActions?: readonly AppliedActionRecord[];
  readonly currentTime?: number;
  readonly auctionDecisionDeadlineAt?: number;
  /** Absolute deadline assigned to any obligation this command creates (runtime-supplied). */
  readonly debtDeadlineAt?: number;
  /** Required once a game has card state; absent means cards cannot be drawn. */
  readonly cardCatalog?: CardCatalogDefinition;
}

export type HoldingOutcome = "ENTERED" | "RELEASED" | "ATTEMPT_FAILED" | "FEE_DUE";

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
      readonly movement: MovementResult | null;
      readonly resolution: TileResolution | null;
      readonly holding: HoldingOutcome | null;
    }
  | {
      readonly type: "TURN_ENDED";
      readonly endedPlayerId: string;
      readonly activePlayerId: string;
    }
  | {
      readonly type: "MATCH_CONFIGURED";
      readonly settings: MatchSettings;
    }
  | {
      readonly type: "PROPERTY_BOUGHT";
      readonly playerId: string;
      readonly assetId: string;
      readonly price: number;
    }
  | {
      readonly type: "PROPERTY_DECLINED";
      readonly playerId: string;
      readonly assetId: string;
      readonly auction: AuctionState;
      readonly facts: readonly AuctionFact[];
    }
  | {
      readonly type: "AUCTION_UPDATED";
      readonly action: "BID" | "PASS" | "AUTO_PASS";
      readonly auctionId: string;
      readonly assetId: string;
      readonly auction: AuctionState | null;
      readonly facts: readonly AuctionFact[];
    }
  | {
      readonly type: "DEVELOPMENT_BOUGHT";
      readonly playerId: string;
      readonly assetId: string;
      readonly level: number;
      readonly price: number;
    }
  | {
      readonly type: "DEVELOPMENT_SOLD";
      readonly playerId: string;
      readonly assetId: string;
      readonly level: number;
      readonly amount: number;
      readonly debtSettled: boolean;
    }
  | {
      readonly type: "ASSET_MORTGAGED" | "ASSET_UNMORTGAGED";
      readonly playerId: string;
      readonly assetId: string;
      readonly amount: number;
      readonly debtSettled: boolean;
    }
  | {
      readonly type: "CARD_RESOLVED";
      readonly playerId: string;
      readonly drawnCardIds: readonly string[];
      readonly outcome: "COMPLETED" | "SUSPENDED";
    }
  | {
      readonly type: "HOLDING_RELEASED";
      readonly playerId: string;
      readonly method: "FEE" | "CARD";
      readonly cardId: string | null;
    }
  | {
      readonly type: "TRADE_UPDATED";
      readonly fact: TradeFact;
      readonly debtSettled: boolean;
      /** INT-001 incident this acceptance produced, and any removals it caused. */
      readonly incident: FairPlayIncident | null;
      readonly eliminations: readonly EliminationFact[];
    }
  | { readonly type: "CLOCKS_RESUMED"; readonly pausedMs: number }
  | {
      /** A turn deadline expired: the owner's default moves, in order, as one committed step. */
      readonly type: "TURN_AUTO_PLAYED";
      readonly playerId: string;
      readonly steps: readonly GameplayEvent[];
    }
  | {
      readonly type: "PLAYER_BANKRUPT";
      readonly fact: EliminationFact;
      /** INT-001 dump incidents and the removals they caused in the same transition. */
      readonly incidents: readonly FairPlayIncident[];
      readonly removals: readonly EliminationFact[];
      /** Next turn owner, or null when this elimination ended the game. */
      readonly activePlayerId: string | null;
      readonly outcome: GameOutcome | null;
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
  | "ROLL_ALREADY_COMPLETED"
  | "PENDING_RESOLUTION"
  | "SETTINGS_LOCKED"
  | "RESOLUTION_NOT_PENDING"
  | "ASSET_ALREADY_OWNED"
  | "ASSET_NOT_OWNED"
  | "INSUFFICIENT_FUNDS"
  | "ASSET_NOT_DEVELOPABLE"
  | "INCOMPLETE_SET"
  | "SET_MORTGAGED"
  | "UNEVEN_BUILD"
  | "UNEVEN_SALE"
  | "DEVELOPMENT_LIMIT_REACHED"
  | "PLAYER_IN_HOLDING"
  | "NOT_IN_HOLDING"
  | "HELD_CARD_NOT_OWNED"
  | "ALREADY_MORTGAGED"
  | "NOT_MORTGAGED"
  | "SET_HAS_DEVELOPMENT"
  | "AUCTION_NOT_ACTIVE"
  | "NOT_AUCTION_ACTOR"
  | "BID_TOO_LOW"
  | "BID_EXCEEDS_CASH"
  | "AUCTION_DEADLINE_NOT_EXPIRED"
  | "STALE_AUCTION_TIMEOUT"
  | "AUCTION_SETTLEMENT_UNAFFORDABLE"
  | "CARD_CATALOG_UNAVAILABLE"
  | "EFFECT_CHAIN_FAILED"
  | "TRADE_NOT_OPEN"
  | "NOT_TRADE_PARTICIPANT"
  | "INVALID_TRADE_PARTNER"
  | "EMPTY_TRADE"
  | "TRADE_BLOCKED_DURING_AUCTION"
  | "ASSET_IN_PENDING_RESOLUTION"
  | "DEBT_BLOCKED"
  | "DEBT_NOT_ACTIVE"
  | "DEBT_DEADLINE_NOT_EXPIRED"
  | "STALE_DEBT_TIMEOUT"
  | "STALE_TURN_TIMEOUT"
  | "NOTHING_TO_AUTO_PLAY"
  | "NO_CLOCKS_TO_RESUME";

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
      readonly diagnostic?: EffectDiagnostic;
    };

/** Authoritative inputs shared by every handler of one command. */
interface RuleEnv {
  readonly board: BoardDefinition;
  readonly catalog: CardCatalogDefinition | undefined;
  readonly context: GameplayCommandContext;
  readonly command: GameCommand;
  readonly actorUserId: string;
  readonly nextGameVersion: number;
}

/** Mutable-by-copy working set for multi-step transitions inside one command. */
interface Draft {
  readonly players: readonly PlayerState[];
  readonly assets: readonly AssetState[];
  readonly turn: TurnIdentity;
  readonly pendingResolution: PendingResolution | null;
  readonly ruleState: AdvancedRuleState;
}

type Changes = Readonly<{
  phase?: GameState["phase"];
  turn?: TurnIdentity | null;
  players?: readonly PlayerState[];
  assets?: readonly AssetState[];
  settings?: MatchSettings;
  pendingResolution?: PendingResolution | null;
  auction?: AuctionState | null;
  ruleState?: AdvancedRuleState;
}>;

function identifier(value: string, field: string): string {
  if (value.trim().length === 0) {
    throw new CommandValidationError(field, "expected a non-empty string");
  }
  return value;
}

function gameplayCommand(command: GameCommand): GameplayCommandType {
  const type = COMMAND_TYPES.find((candidate) => candidate === command.type);
  if (type === undefined) {
    throw new CommandValidationError("type", "unknown gameplay command " + command.type);
  }
  if (EMPTY_PAYLOAD_COMMANDS.has(type)) payloadObject(command, []);
  return type;
}

function payloadObject(command: GameCommand, keys: readonly string[]): Record<string, unknown> {
  if (
    typeof command.payload !== "object"
    || command.payload === null
    || Array.isArray(command.payload)
  ) {
    throw new CommandValidationError("payload", "expected an object");
  }
  const payload = command.payload as Record<string, unknown>;
  const keySet = new Set(keys);
  for (const key of Object.keys(payload)) {
    if (!keySet.has(key)) throw new CommandValidationError("payload." + key, "unexpected field");
  }
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(payload, key)) {
      throw new CommandValidationError("payload." + key, "missing field");
    }
  }
  return payload;
}

function payloadIdentifier(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new CommandValidationError(field, "expected a non-empty string");
  }
  return value;
}

function payloadBundle(value: unknown, field: string): TradeBundle {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new CommandValidationError(field, "expected an object");
  }
  const bundle = value as Record<string, unknown>;
  const keys = Object.keys(bundle);
  if (keys.length !== 2 || !keys.includes("cash") || !keys.includes("assetIds")) {
    throw new CommandValidationError(field, "expected exactly cash and assetIds");
  }
  if (!Number.isSafeInteger(bundle.cash) || (bundle.cash as number) < 0) {
    throw new CommandValidationError(field + ".cash", "expected a non-negative safe integer");
  }
  if (!Array.isArray(bundle.assetIds)) {
    throw new CommandValidationError(field + ".assetIds", "expected an array");
  }
  const assetIds = bundle.assetIds.map((assetId, index) =>
    payloadIdentifier(assetId, field + ".assetIds[" + index + "]"),
  );
  if (new Set(assetIds).size !== assetIds.length) {
    throw new CommandValidationError(field + ".assetIds", "contains a duplicate");
  }
  return { cash: bundle.cash as number, assetIds };
}

function authoritativeInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new CommandValidationError(field, "expected a non-negative safe integer");
  }
  return value as number;
}

function rejected(
  state: GameState,
  reason: GameplayRejectionReason,
  details: Readonly<{
    currentGameId?: string;
    currentGameVersion?: number;
    diagnostic?: EffectDiagnostic;
  }> = {},
): GameplayCommandResult {
  return Object.freeze({ kind: "REJECTED", state, reason, ...details });
}

function accepted(state: GameState, event: GameplayEvent): GameplayCommandResult {
  return Object.freeze({ kind: "ACCEPTED", state, event: Object.freeze(event) });
}

function nextTurn(turnNumber: number, activePlayerId: string): TurnIdentity {
  return {
    turnId: "turn-" + turnNumber,
    activePlayerId,
    turnNumber,
    hasRolled: false,
    rollAgain: false,
    consecutiveDoubles: 0,
    developmentActionsUsed: 0,
    rollFromHolding: false,
  };
}

/**
 * Builds and fully revalidates the next canonical state. Debt metadata is derived here, once:
 * a new obligation receives the runtime deadline; a cleared obligation drops it.
 */
function acceptedState(state: GameState, env: RuleEnv, changes: Changes): GameState {
  const pendingResolution = "pendingResolution" in changes
    ? changes.pendingResolution ?? null
    : state.pendingResolution;
  const ruleState = changes.ruleState ?? state.ruleState;
  let debt = null;
  if (pendingResolution?.obligation != null) {
    debt = ruleState.debt?.resolutionId === pendingResolution.resolutionId
      ? ruleState.debt
      : {
          resolutionId: pendingResolution.resolutionId,
          deadlineAt: authoritativeInteger(env.context.debtDeadlineAt, "context.debtDeadlineAt"),
        };
  }
  return parseGameState(
    {
      ...state,
      ...changes,
      ruleState: { ...ruleState, debt },
      gameVersion: env.nextGameVersion,
    },
    env.board,
    env.catalog,
  );
}

function draftOf(state: GameState, turn: TurnIdentity): Draft {
  return {
    players: state.players,
    assets: state.assets,
    turn,
    pendingResolution: state.pendingResolution,
    ruleState: state.ruleState,
  };
}

function continuationFor(turn: TurnIdentity): ResolutionContinuation {
  return turn.rollAgain ? { type: "ROLL_AGAIN" } : { type: "END_TURN" };
}

function updatePlayer(
  players: readonly PlayerState[],
  userId: string,
  update: (player: PlayerState) => PlayerState,
): readonly PlayerState[] {
  return players.map((player) => player.userId === userId ? update(player) : player);
}

function checkedCash(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError("cash exceeds canonical range");
  return value;
}

function enterHolding(draft: Draft, env: RuleEnv, userId: string): Draft {
  const position = holdingTileIndex(env.board);
  return {
    ...draft,
    players: updatePlayer(draft.players, userId, (player) => ({
      ...player, position, inHolding: true, holdingAttempts: 0,
    })),
    turn: { ...draft.turn, rollAgain: false, consecutiveDoubles: 0 },
    pendingResolution: null,
  };
}

function moveActor(
  draft: Draft,
  env: RuleEnv,
  userId: string,
  distance: number,
): Readonly<{ draft: Draft; movement: MovementResult }> {
  const player = draft.players.find((candidate) => candidate.userId === userId);
  if (player === undefined) throw new RangeError("moving player is not in the game");
  const movement = calculateMovement(env.board, player.position, distance);
  return {
    movement,
    draft: {
      ...draft,
      players: updatePlayer(draft.players, userId, (candidate) => ({
        ...candidate,
        position: movement.to,
        cash: checkedCash(candidate.cash + movement.startAward),
      })),
    },
  };
}

/** Charges now, or records the full amount as the single outstanding obligation. */
function charge(
  draft: Draft,
  env: RuleEnv,
  debtorUserId: string,
  amount: number,
  creditorUserId: string | null,
  roll: DiceRoll,
  tileIndex: number,
): Draft {
  if (!Number.isSafeInteger(amount) || amount < 0) throw new RangeError("charge must be non-negative");
  if (amount === 0) return draft;
  const debtor = draft.players.find((player) => player.userId === debtorUserId);
  if (debtor === undefined) throw new RangeError("charge debtor is not a game player");
  const continuation = continuationFor(draft.turn);
  if (debtor.cash < amount) {
    return {
      ...draft,
      pendingResolution: {
        resolutionId: draft.turn.turnId + ":debt:" + env.nextGameVersion,
        kind: "DEBT",
        actorUserId: debtorUserId,
        decisionOwnerUserId: debtorUserId,
        source: { type: "TILE", tileIndex },
        continuation,
        roll,
        obligation: {
          debtorUserId,
          creditor: creditorUserId === null
            ? { type: "BANK" }
            : { type: "PLAYER", userId: creditorUserId },
          amount,
          continuation,
        },
      },
    };
  }
  return {
    ...draft,
    players: draft.players.map((player) => {
      if (player.userId === debtorUserId) return { ...player, cash: player.cash - amount };
      if (player.userId === creditorUserId) return { ...player, cash: checkedCash(player.cash + amount) };
      return player;
    }),
  };
}

function isGoToHolding(board: BoardDefinition, tileIndex: number): boolean {
  const tile = board.economyProfile.tiles[tileIndex];
  return tile?.type === "corner" && tile.name === "GO TO HOLDING";
}

/** Resolves the actor's current tile exactly as a dice landing, whatever moved them there. */
function resolveLanding(
  state: GameState,
  env: RuleEnv,
  draft: Draft,
  userId: string,
  roll: DiceRoll,
  landingRent: LandingRent = "STANDARD",
): Readonly<{ draft: Draft; resolution: TileResolution; enteredHolding: boolean }> {
  const player = draft.players.find((candidate) => candidate.userId === userId);
  if (player === undefined) throw new RangeError("landing player is not in the game");
  const tileIndex = player.position;
  const resolution = dispatchLandedTile(env.board, tileIndex);
  const decision = (kind: PendingResolution["kind"]): Draft => ({
    ...draft,
    pendingResolution: {
      resolutionId: draft.turn.turnId + ":landing:" + env.nextGameVersion,
      kind,
      actorUserId: userId,
      decisionOwnerUserId: userId,
      source: { type: "TILE", tileIndex },
      continuation: continuationFor(draft.turn),
      roll,
      obligation: null,
    },
  });
  const result = (next: Draft, enteredHolding = false) => ({ draft: next, resolution, enteredHolding });
  switch (resolution.kind) {
    case "PROPERTY":
    case "TRANSIT":
    case "UTILITY": {
      const asset = draft.assets.find((candidate) => candidate.tileIndex === tileIndex);
      if (asset === undefined) throw new RangeError("landed ownable has no canonical asset");
      if (asset.ownerUserId === null) return result(decision("BUY_DECISION"));
      if (asset.ownerUserId === userId || asset.mortgaged) return result(draft);
      const standard = () => rentForAsset({ ...state, assets: draft.assets }, env.board, asset, roll.total);
      const rent = landingRent === "STANDARD" ? standard()
        : landingRent === "DOUBLE" ? standard() * 2
          : rollDice(env.context.rng).total * 10;
      return result(charge(draft, env, userId, rent, asset.ownerUserId, roll, tileIndex));
    }
    case "TAX":
      return result(charge(draft, env, userId, resolution.amount, null, roll, tileIndex));
    case "SURPRISE":
    case "TREASURE":
      return result(decision("CARD"));
    case "STRUCTURAL_CORNER":
      return isGoToHolding(env.board, tileIndex)
        ? result(enterHolding(draft, env, userId), true)
        : result(draft);
    case "GRAND_SPECIAL":
      return result(draft);
  }
}

type EffectApplication =
  | {
      readonly kind: "APPLIED";
      readonly draft: Draft;
      readonly outcome: "COMPLETED" | "SUSPENDED";
      readonly drawnCardIds: readonly string[];
    }
  | { readonly kind: "FAILED"; readonly diagnostic: EffectDiagnostic };

function runEffects(
  state: GameState,
  env: RuleEnv,
  catalog: CardCatalogDefinition,
  draft: Draft,
  frames: readonly EffectFrame[],
  remainingSteps: number,
  originTileIndex: number,
  roll: DiceRoll,
): EffectApplication {
  const actorUserId = draft.turn.activePlayerId;
  const run = runEffectFrames({
    board: env.board,
    catalog,
    players: draft.players,
    assets: draft.assets,
    ruleState: draft.ruleState,
    actorUserId,
    frames,
    remainingSteps,
    rng: env.context.rng,
  });
  if (run.kind === "FAILED") return run;
  if (run.kind === "SUSPENDED") {
    const resolutionId = draft.turn.turnId + ":effect:" + env.nextGameVersion;
    const continuation: ResolutionContinuation = { type: "RESUME_EFFECT", effectId: run.effectId };
    return {
      kind: "APPLIED",
      outcome: "SUSPENDED",
      drawnCardIds: run.drawnCardIds,
      draft: {
        ...draft,
        players: run.players,
        ruleState: {
          ...run.ruleState,
          effectContinuation: {
            resolutionId,
            actorUserId,
            originTileIndex,
            remainingSteps: run.remainingSteps,
            frames: run.frames,
            roll,
          },
        },
        pendingResolution: {
          resolutionId,
          kind: "DEBT",
          actorUserId,
          decisionOwnerUserId: actorUserId,
          source: { type: "EFFECT", effectId: run.effectId, originTileIndex },
          continuation,
          roll: null,
          obligation: {
            debtorUserId: actorUserId,
            creditor: run.creditor,
            amount: run.amount,
            continuation,
          },
        },
      },
    };
  }
  let next: Draft = {
    ...draft,
    players: run.players,
    ruleState: { ...run.ruleState, effectContinuation: null },
    pendingResolution: null,
  };
  if (run.terminal?.type === "ENTER_HOLDING") next = enterHolding(next, env, actorUserId);
  else if (run.terminal?.type === "LAND") {
    next = resolveLanding(state, env, next, actorUserId, roll, run.terminal.rent).draft;
  }
  return { kind: "APPLIED", outcome: "COMPLETED", drawnCardIds: run.drawnCardIds, draft: next };
}

type Settlement =
  | { readonly kind: "APPLIED"; readonly draft: Draft; readonly settled: boolean }
  | { readonly kind: "FAILED"; readonly diagnostic: EffectDiagnostic };

/**
 * Pays the outstanding obligation as soon as the debtor can cover it, then continues exactly
 * where the obligation interrupted play. Never forgives, never partially pays.
 */
function settleObligation(state: GameState, env: RuleEnv, draft: Draft): Settlement {
  const pending = draft.pendingResolution;
  const obligation = pending?.obligation ?? null;
  const unchanged: Settlement = { kind: "APPLIED", draft, settled: false };
  if (pending === null || obligation === null) return unchanged;
  const debtor = draft.players.find((player) => player.userId === obligation.debtorUserId);
  if (debtor === undefined || debtor.cash < obligation.amount) return unchanged;
  const creditorUserId = obligation.creditor.type === "PLAYER" ? obligation.creditor.userId : null;
  let next: Draft = {
    ...draft,
    pendingResolution: null,
    players: draft.players.map((player) => {
      if (player.userId === obligation.debtorUserId) return { ...player, cash: player.cash - obligation.amount };
      if (player.userId === creditorUserId) return { ...player, cash: checkedCash(player.cash + obligation.amount) };
      return player;
    }),
  };
  if (pending.continuation.type === "RESUME_EFFECT") {
    const suspended = draft.ruleState.effectContinuation;
    if (suspended === null || env.catalog === undefined) {
      throw new RangeError("suspended effect lacks its persisted continuation or catalog");
    }
    next = { ...next, ruleState: { ...next.ruleState, effectContinuation: null } };
    const resumed = runEffects(
      state, env, env.catalog, next, suspended.frames, suspended.remainingSteps,
      suspended.originTileIndex, suspended.roll,
    );
    return resumed.kind === "FAILED" ? resumed : { kind: "APPLIED", draft: resumed.draft, settled: true };
  }
  if (pending.kind === "DETENTION_FEE" && pending.roll !== null) {
    next = { ...next, players: releaseFromHolding(next.players, obligation.debtorUserId) };
    const moved = moveActor(next, env, obligation.debtorUserId, pending.roll.total);
    next = resolveLanding(state, env, moved.draft, obligation.debtorUserId, pending.roll).draft;
  }
  return { kind: "APPLIED", draft: next, settled: true };
}

function releaseFromHolding(players: readonly PlayerState[], userId: string): readonly PlayerState[] {
  return updatePlayer(players, userId, (player) => ({ ...player, inHolding: false, holdingAttempts: 0 }));
}

function configureMatch(state: GameState, env: RuleEnv): GameplayCommandResult {
  if (state.phase !== "STARTING") return rejected(state, "SETTINGS_LOCKED");
  if (!state.players.some((player) => player.userId === env.actorUserId)) {
    return rejected(state, "ACTOR_NOT_IN_GAME");
  }
  const payload = payloadObject(env.command, ["matchMode", "winMode", "startingCash", "teams"]);
  const matchMode = payload.matchMode === "FFA" || payload.matchMode === "TEAMS"
    ? payload.matchMode
    : (() => { throw new CommandValidationError("payload.matchMode", "expected FFA or TEAMS"); })();
  const settings: MatchSettings = {
    matchMode,
    winMode: payload.winMode === "LAST_STANDING"
      ? payload.winMode
      : (() => { throw new CommandValidationError("payload.winMode", "expected LAST_STANDING"); })(),
    startingCash: typeof payload.startingCash === "number" ? payload.startingCash : Number.NaN,
    pacing: "CORE",
    teams: parseTeams(payload.teams, matchMode, new Set(state.players.map((player) => player.userId))),
  };
  const nextState = acceptedState(state, env, {
    settings,
    players: state.players.map((player) => ({ ...player, cash: settings.startingCash })),
  });
  return accepted(nextState, { type: "MATCH_CONFIGURED", settings: nextState.settings });
}

function startGame(state: GameState, env: RuleEnv): GameplayCommandResult {
  if (state.phase === "GAME_OVER") return rejected(state, "GAME_ALREADY_ENDED");
  if (state.phase !== "STARTING") return rejected(state, "GAME_ALREADY_STARTED");
  if (!state.players.some((player) => player.userId === env.actorUserId)) {
    return rejected(state, "ACTOR_NOT_IN_GAME");
  }

  const eligibility = evaluateLobbyStart(state.players.length);
  if (!eligibility.ok || state.players.some((player) => player.status !== "ACTIVE")) {
    return rejected(state, "GAME_NOT_STARTABLE");
  }

  const turnOrder = state.players.map((player) => player.userId);
  const activePlayerId = turnOrder[0];
  if (activePlayerId === undefined) return rejected(state, "GAME_NOT_STARTABLE");

  const nextState = acceptedState(state, env, {
    phase: "ACTIVE_TURN",
    turn: nextTurn(1, activePlayerId),
  });
  return accepted(nextState, {
    type: "GAME_STARTED",
    turnOrder: Object.freeze(turnOrder),
    activePlayerId,
  });
}

/** Common guard for actions only the active turn owner may take outside any pending resolution. */
function turnOwnerRejection(state: GameState, actorUserId: string): GameplayRejectionReason | null {
  if (state.phase === "STARTING") return "GAME_NOT_STARTED";
  if (state.phase === "GAME_OVER") return "GAME_ALREADY_ENDED";
  if (state.turn === null) return "GAME_NOT_STARTED";
  if (state.turn.activePlayerId !== actorUserId) return "NOT_YOUR_TURN";
  if (state.pendingResolution !== null) return "PENDING_RESOLUTION";
  return null;
}

function rollCurrentPlayer(state: GameState, env: RuleEnv): GameplayCommandResult {
  const guard = turnOwnerRejection(state, env.actorUserId);
  if (guard !== null) return rejected(state, guard);
  const turn = state.turn as TurnIdentity;
  if (turn.hasRolled && !turn.rollAgain) return rejected(state, "ROLL_ALREADY_COMPLETED");
  const player = state.players.find((candidate) => candidate.userId === env.actorUserId);
  if (player === undefined) return rejected(state, "ACTOR_NOT_IN_GAME");
  if (player.status !== "ACTIVE") return rejected(state, "PLAYER_NOT_ELIGIBLE");
  if (player.inHolding) return holdingAttempt(state, env, turn, player);

  const roll = rollDice(env.context.rng, turn.consecutiveDoubles);
  const rolledTurn: TurnIdentity = {
    ...turn,
    hasRolled: true,
    rollAgain: roll.doubles,
    consecutiveDoubles: roll.consecutiveDoubles,
  };
  if (roll.isThirdConsecutiveDouble) {
    const held = enterHolding(draftOf(state, rolledTurn), env, env.actorUserId);
    return accepted(acceptedState(state, env, held), {
      type: "DICE_ROLLED",
      playerId: env.actorUserId,
      roll,
      movement: null,
      resolution: null,
      holding: "ENTERED",
    });
  }
  const moved = moveActor(draftOf(state, rolledTurn), env, env.actorUserId, roll.total);
  const landing = resolveLanding(state, env, moved.draft, env.actorUserId, roll);
  return accepted(acceptedState(state, env, landing.draft), {
    type: "DICE_ROLLED",
    playerId: env.actorUserId,
    roll,
    movement: moved.movement,
    resolution: landing.resolution,
    holding: landing.enteredHolding ? "ENTERED" : null,
  });
}

/** A Holding turn's roll: doubles release; the third failure forces the fee, then movement. */
function holdingAttempt(
  state: GameState,
  env: RuleEnv,
  turn: TurnIdentity,
  player: PlayerState,
): GameplayCommandResult {
  const roll = rollDice(env.context.rng, 0);
  const holdingTurn: TurnIdentity = {
    ...turn, hasRolled: true, rollAgain: false, consecutiveDoubles: 0, rollFromHolding: true,
  };
  let draft = draftOf(state, holdingTurn);
  const fee = CANDIDATE_RULES.holdingReleaseFee;
  const event = (
    holding: HoldingOutcome,
    movement: MovementResult | null = null,
    resolution: TileResolution | null = null,
  ): GameplayEvent => ({ type: "DICE_ROLLED", playerId: player.userId, roll, movement, resolution, holding });

  if (!roll.doubles && player.holdingAttempts < 2) {
    draft = {
      ...draft,
      players: updatePlayer(draft.players, player.userId, (candidate) => ({
        ...candidate, holdingAttempts: candidate.holdingAttempts + 1,
      })),
    };
    return accepted(acceptedState(state, env, draft), event("ATTEMPT_FAILED"));
  }
  if (!roll.doubles && player.cash < fee) {
    const continuation: ResolutionContinuation = { type: "END_TURN" };
    draft = {
      ...draft,
      pendingResolution: {
        resolutionId: turn.turnId + ":holding-fee:" + env.nextGameVersion,
        kind: "DETENTION_FEE",
        actorUserId: player.userId,
        decisionOwnerUserId: player.userId,
        source: { type: "TILE", tileIndex: player.position },
        continuation,
        roll,
        obligation: { debtorUserId: player.userId, creditor: { type: "BANK" }, amount: fee, continuation },
      },
    };
    return accepted(acceptedState(state, env, draft), event("FEE_DUE"));
  }
  const cashAfterFee = roll.doubles ? player.cash : player.cash - fee;
  draft = {
    ...draft,
    players: updatePlayer(releaseFromHolding(draft.players, player.userId), player.userId, (candidate) => ({
      ...candidate, cash: cashAfterFee,
    })),
  };
  const moved = moveActor(draft, env, player.userId, roll.total);
  const landing = resolveLanding(state, env, moved.draft, player.userId, roll);
  return accepted(
    acceptedState(state, env, landing.draft),
    event(landing.enteredHolding ? "ENTERED" : "RELEASED", moved.movement, landing.resolution),
  );
}

function holdingReleaseRejection(state: GameState, actorUserId: string): GameplayRejectionReason | null {
  const guard = turnOwnerRejection(state, actorUserId);
  if (guard !== null) return guard;
  if (state.turn?.hasRolled) return "ROLL_ALREADY_COMPLETED";
  const player = state.players.find((candidate) => candidate.userId === actorUserId);
  return player?.inHolding ? null : "NOT_IN_HOLDING";
}

function payHoldingFee(state: GameState, env: RuleEnv): GameplayCommandResult {
  const guard = holdingReleaseRejection(state, env.actorUserId);
  if (guard !== null) return rejected(state, guard);
  const fee = CANDIDATE_RULES.holdingReleaseFee;
  const player = state.players.find((candidate) => candidate.userId === env.actorUserId) as PlayerState;
  if (player.cash < fee) return rejected(state, "INSUFFICIENT_FUNDS");
  const players = updatePlayer(releaseFromHolding(state.players, player.userId), player.userId, (candidate) => ({
    ...candidate, cash: candidate.cash - fee,
  }));
  return accepted(acceptedState(state, env, { players }), {
    type: "HOLDING_RELEASED", playerId: player.userId, method: "FEE", cardId: null,
  });
}

function useReleaseCard(state: GameState, env: RuleEnv): GameplayCommandResult {
  const payload = payloadObject(env.command, ["cardId"]);
  const cardId = payloadIdentifier(payload.cardId, "payload.cardId");
  const guard = holdingReleaseRejection(state, env.actorUserId);
  if (guard !== null) return rejected(state, guard);
  const held = state.ruleState.heldCards.find((card) =>
    card.cardId === cardId && card.ownerUserId === env.actorUserId && card.capability === "DETENTION_RELEASE"
  );
  if (held === undefined || env.catalog === undefined) return rejected(state, "HELD_CARD_NOT_OWNED");
  return accepted(
    acceptedState(state, env, {
      players: releaseFromHolding(state.players, env.actorUserId),
      ruleState: returnHeldCard(state.ruleState, env.catalog, cardId, env.actorUserId),
    }),
    { type: "HOLDING_RELEASED", playerId: env.actorUserId, method: "CARD", cardId },
  );
}

function drawPendingCard(state: GameState, env: RuleEnv): GameplayCommandResult {
  const payload = payloadObject(env.command, ["resolutionId"]);
  const resolutionId = payloadIdentifier(payload.resolutionId, "payload.resolutionId");
  const pending = pendingDecision(state, env.actorUserId, resolutionId);
  if (pending?.kind !== "CARD" || pending.source.type !== "TILE" || pending.roll === null) {
    return rejected(state, "RESOLUTION_NOT_PENDING");
  }
  const tile = env.board.economyProfile.tiles[pending.source.tileIndex];
  if (tile?.type !== "card") return rejected(state, "RESOLUTION_NOT_PENDING");
  if (env.catalog === undefined) return rejected(state, "CARD_CATALOG_UNAVAILABLE");
  const turn = state.turn as TurnIdentity;
  const ruleState = state.ruleState.decks.length === 0
    ? initializeDecks(state.ruleState, env.catalog, env.context.rng)
    : state.ruleState;
  const applied = runEffects(
    state,
    env,
    env.catalog,
    { ...draftOf(state, turn), ruleState, pendingResolution: null },
    [{ type: "DRAW_CARD", deckId: tile.deck }],
    MAX_RESOLUTION_STEPS,
    pending.source.tileIndex,
    pending.roll,
  );
  if (applied.kind === "FAILED") {
    return rejected(state, "EFFECT_CHAIN_FAILED", { diagnostic: applied.diagnostic });
  }
  return accepted(acceptedState(state, env, applied.draft), {
    type: "CARD_RESOLVED",
    playerId: env.actorUserId,
    drawnCardIds: applied.drawnCardIds,
    outcome: applied.outcome,
  });
}

function pendingDecision(
  state: GameState,
  actorUserId: string,
  resolutionId: string,
): PendingResolution | null {
  const pending = state.pendingResolution;
  if (pending === null || pending.resolutionId !== resolutionId) return null;
  if (pending.decisionOwnerUserId !== actorUserId) return null;
  return pending;
}

function buyProperty(state: GameState, env: RuleEnv): GameplayCommandResult {
  const payload = payloadObject(env.command, ["resolutionId"]);
  const resolutionId = payloadIdentifier(payload.resolutionId, "payload.resolutionId");
  const pending = pendingDecision(state, env.actorUserId, resolutionId);
  if (pending?.kind !== "BUY_DECISION" || pending.source.type !== "TILE") {
    return rejected(state, "RESOLUTION_NOT_PENDING");
  }
  const tileIndex = pending.source.tileIndex;
  const assetIndex = state.assets.findIndex((asset) => asset.tileIndex === tileIndex);
  const asset = state.assets[assetIndex];
  if (asset === undefined) return rejected(state, "RESOLUTION_NOT_PENDING");
  if (asset.ownerUserId !== null) return rejected(state, "ASSET_ALREADY_OWNED");
  const playerIndex = state.players.findIndex((player) => player.userId === env.actorUserId);
  const player = state.players[playerIndex];
  if (player === undefined) return rejected(state, "ACTOR_NOT_IN_GAME");
  const price = purchasePrice(env.board, asset);
  if (player.cash < price) return rejected(state, "INSUFFICIENT_FUNDS");
  const nextState = acceptedState(state, env, {
    players: state.players.map((candidate, index) => index === playerIndex
      ? { ...candidate, cash: candidate.cash - price }
      : candidate),
    assets: state.assets.map((candidate, index) => index === assetIndex
      ? { ...candidate, ownerUserId: env.actorUserId }
      : candidate),
    pendingResolution: null,
  });
  return accepted(nextState, {
    type: "PROPERTY_BOUGHT", playerId: env.actorUserId, assetId: asset.assetId, price,
  });
}

function declineProperty(state: GameState, env: RuleEnv): GameplayCommandResult {
  const payload = payloadObject(env.command, ["resolutionId"]);
  const resolutionId = payloadIdentifier(payload.resolutionId, "payload.resolutionId");
  const pending = pendingDecision(state, env.actorUserId, resolutionId);
  if (pending?.kind !== "BUY_DECISION" || pending.source.type !== "TILE") {
    return rejected(state, "RESOLUTION_NOT_PENDING");
  }
  const tileIndex = pending.source.tileIndex;
  const asset = state.assets.find((candidate) => candidate.tileIndex === tileIndex);
  if (asset === undefined || asset.ownerUserId !== null) {
    return rejected(state, asset === undefined ? "RESOLUTION_NOT_PENDING" : "ASSET_ALREADY_OWNED");
  }
  const deadline = authoritativeInteger(
    env.context.auctionDecisionDeadlineAt, "context.auctionDecisionDeadlineAt",
  );
  const eligiblePlayers = state.players.filter((player) => player.status === "ACTIVE");
  const decliningIndex = eligiblePlayers.findIndex((player) => player.userId === env.actorUserId);
  const participantOrder = Array.from(
    { length: eligiblePlayers.length },
    (_, offset) => eligiblePlayers[(decliningIndex + offset + 1) % eligiblePlayers.length]!.userId,
  );
  const currentActorUserId = participantOrder[0]!;
  const fact = auctionFact(
    "STARTED", pending.resolutionId, asset.assetId, env.actorUserId, null,
    env.nextGameVersion, env.command.actionId,
  );
  const auction: AuctionState = {
    auctionId: pending.resolutionId,
    assetId: asset.assetId,
    originatingPlayerId: env.actorUserId,
    continuation: pending.continuation,
    participantOrder,
    passedPlayerIds: [],
    currentActorUserId,
    highBid: null,
    highBidderUserId: null,
    hasBid: false,
    decisionDeadlineAt: deadline,
    history: [fact],
  };
  const nextState = acceptedState(state, env, {
    pendingResolution: {
      ...pending,
      kind: "AUCTION",
      decisionOwnerUserId: currentActorUserId,
    },
    auction,
  });
  return accepted(nextState, {
    type: "PROPERTY_DECLINED",
    playerId: env.actorUserId,
    assetId: asset.assetId,
    auction: nextState.auction!,
    facts: nextState.auction!.history,
  });
}

function auctionFact(
  type: AuctionFact["type"],
  auctionId: string,
  assetId: string,
  actorUserId: string | null,
  amount: number | null,
  gameVersion: number,
  actionId: string,
): AuctionFact {
  return Object.freeze({ type, auctionId, assetId, actorUserId, amount, gameVersion, actionId });
}

function currentAuction(
  state: GameState,
  auctionId: string,
): Readonly<{ auction: AuctionState; pending: PendingResolution }> | null {
  if (
    state.auction === null
    || state.auction.auctionId !== auctionId
    || state.pendingResolution?.kind !== "AUCTION"
  ) {
    return null;
  }
  return { auction: state.auction, pending: state.pendingResolution };
}

function nextAuctionActor(
  auction: AuctionState,
  passedPlayerIds: readonly string[],
  highBidderUserId: string | null,
): string {
  const currentIndex = auction.participantOrder.indexOf(auction.currentActorUserId);
  for (let offset = 1; offset <= auction.participantOrder.length; offset += 1) {
    const candidate = auction.participantOrder[
      (currentIndex + offset) % auction.participantOrder.length
    ]!;
    if (!passedPlayerIds.includes(candidate) && candidate !== highBidderUserId) return candidate;
  }
  throw new RangeError("continuing auction has no next actor");
}

function auctionTransition(
  state: GameState,
  env: RuleEnv,
  pending: PendingResolution,
  changedAuction: AuctionState,
  action: "BID" | "PASS" | "AUTO_PASS",
): GameplayCommandResult {
  const remaining = changedAuction.participantOrder.filter(
    (playerId) => !changedAuction.passedPlayerIds.includes(playerId),
  );
  const assetIndex = state.assets.findIndex(
    (candidate) => candidate.assetId === changedAuction.assetId,
  );
  const asset = state.assets[assetIndex];
  if (asset === undefined || asset.ownerUserId !== null) return rejected(state, "AUCTION_NOT_ACTIVE");
  const updated = (nextState: GameState, facts: readonly AuctionFact[]) => accepted(nextState, {
    type: "AUCTION_UPDATED",
    action,
    auctionId: changedAuction.auctionId,
    assetId: changedAuction.assetId,
    auction: nextState.auction,
    facts: Object.freeze(facts),
  });

  if (changedAuction.hasBid && remaining.length === 1) {
    const winnerUserId = changedAuction.highBidderUserId;
    const finalPrice = changedAuction.highBid;
    if (winnerUserId === null || finalPrice === null || remaining[0] !== winnerUserId) {
      throw new RangeError("terminal auction winner is inconsistent");
    }
    const winnerIndex = state.players.findIndex((player) => player.userId === winnerUserId);
    const winner = state.players[winnerIndex];
    if (winner === undefined || winner.cash < finalPrice) {
      return rejected(state, "AUCTION_SETTLEMENT_UNAFFORDABLE");
    }
    const finalFact = auctionFact(
      "WINNER", changedAuction.auctionId, changedAuction.assetId, winnerUserId,
      finalPrice, env.nextGameVersion, env.command.actionId,
    );
    const nextState = acceptedState(state, env, {
      players: state.players.map((player, index) => index === winnerIndex
        ? { ...player, cash: player.cash - finalPrice }
        : player),
      assets: state.assets.map((candidate, index) => index === assetIndex
        ? { ...candidate, ownerUserId: winnerUserId }
        : candidate),
      pendingResolution: null,
      auction: null,
    });
    return updated(nextState, [changedAuction.history.at(-1)!, finalFact]);
  }

  if (!changedAuction.hasBid && remaining.length === 0) {
    const finalFact = auctionFact(
      "NO_BID", changedAuction.auctionId, changedAuction.assetId, null, null,
      env.nextGameVersion, env.command.actionId,
    );
    const nextState = acceptedState(state, env, { pendingResolution: null, auction: null });
    return updated(nextState, [changedAuction.history.at(-1)!, finalFact]);
  }

  const currentActorUserId = nextAuctionActor(
    changedAuction,
    changedAuction.passedPlayerIds,
    changedAuction.highBidderUserId,
  );
  const nextState = acceptedState(state, env, {
    pendingResolution: { ...pending, decisionOwnerUserId: currentActorUserId },
    auction: {
      ...changedAuction,
      currentActorUserId,
      decisionDeadlineAt: authoritativeInteger(
        env.context.auctionDecisionDeadlineAt, "context.auctionDecisionDeadlineAt",
      ),
    },
  });
  return updated(nextState, [nextState.auction!.history.at(-1)!]);
}

function placeBid(state: GameState, env: RuleEnv): GameplayCommandResult {
  const payload = payloadObject(env.command, ["auctionId", "amount"]);
  const auctionId = payloadIdentifier(payload.auctionId, "payload.auctionId");
  if (!Number.isSafeInteger(payload.amount)) {
    throw new CommandValidationError("payload.amount", "expected a safe integer");
  }
  const amount = payload.amount as number;
  const active = currentAuction(state, auctionId);
  if (active === null) return rejected(state, "AUCTION_NOT_ACTIVE");
  const { auction, pending } = active;
  if (auction.currentActorUserId !== env.actorUserId) return rejected(state, "NOT_AUCTION_ACTOR");
  const minimum = auction.highBid === null ? 2 : auction.highBid + 2;
  if (!Number.isSafeInteger(minimum)) throw new RangeError("auction minimum exceeds safe integer range");
  if (amount < minimum) return rejected(state, "BID_TOO_LOW");
  const bidder = state.players.find((player) => player.userId === env.actorUserId);
  if (bidder === undefined || bidder.status !== "ACTIVE") return rejected(state, "PLAYER_NOT_ELIGIBLE");
  if (amount > bidder.cash) return rejected(state, "BID_EXCEEDS_CASH");
  const fact = auctionFact(
    "BID", auction.auctionId, auction.assetId, env.actorUserId, amount,
    env.nextGameVersion, env.command.actionId,
  );
  return auctionTransition(state, env, pending, {
    ...auction,
    hasBid: true,
    highBid: amount,
    highBidderUserId: env.actorUserId,
    history: [...auction.history, fact],
  }, "BID");
}

function passAuction(state: GameState, env: RuleEnv, autoPass: boolean): GameplayCommandResult {
  const keys = autoPass
    ? ["auctionId", "actorUserId", "decisionDeadlineAt"]
    : ["auctionId"];
  const payload = payloadObject(env.command, keys);
  const auctionId = payloadIdentifier(payload.auctionId, "payload.auctionId");
  const active = currentAuction(state, auctionId);
  if (active === null) return rejected(state, "AUCTION_NOT_ACTIVE");
  const { auction, pending } = active;
  if (autoPass) {
    const expectedActorUserId = payloadIdentifier(
      payload.actorUserId, "payload.actorUserId",
    );
    const expectedDeadline = authoritativeInteger(
      payload.decisionDeadlineAt, "payload.decisionDeadlineAt",
    );
    if (
      expectedActorUserId !== auction.currentActorUserId
      || expectedDeadline !== auction.decisionDeadlineAt
    ) {
      return rejected(state, "STALE_AUCTION_TIMEOUT");
    }
  } else if (auction.currentActorUserId !== env.actorUserId) {
    return rejected(state, "NOT_AUCTION_ACTOR");
  }
  const passingPlayerId = auction.currentActorUserId;
  const fact = auctionFact(
    autoPass ? "AUTO_PASS" : "PASS",
    auction.auctionId,
    auction.assetId,
    passingPlayerId,
    null,
    env.nextGameVersion,
    env.command.actionId,
  );
  return auctionTransition(state, env, pending, {
    ...auction,
    passedPlayerIds: [...auction.passedPlayerIds, passingPlayerId],
    history: [...auction.history, fact],
  }, autoPass ? "AUTO_PASS" : "PASS");
}

function timeoutAuction(state: GameState, env: RuleEnv): GameplayCommandResult {
  const now = authoritativeInteger(env.context.currentTime, "context.currentTime");
  const payload = payloadObject(env.command, ["auctionId", "actorUserId", "decisionDeadlineAt"]);
  const auctionId = payloadIdentifier(payload.auctionId, "payload.auctionId");
  const active = currentAuction(state, auctionId);
  if (active === null) return rejected(state, "AUCTION_NOT_ACTIVE");
  const expectedActorUserId = payloadIdentifier(payload.actorUserId, "payload.actorUserId");
  const expectedDeadline = authoritativeInteger(
    payload.decisionDeadlineAt, "payload.decisionDeadlineAt",
  );
  if (
    expectedActorUserId !== active.auction.currentActorUserId
    || expectedDeadline !== active.auction.decisionDeadlineAt
  ) {
    return rejected(state, "STALE_AUCTION_TIMEOUT");
  }
  if (now < active.auction.decisionDeadlineAt) {
    return rejected(state, "AUCTION_DEADLINE_NOT_EXPIRED");
  }
  return passAuction(state, env, true);
}

/**
 * Owned-asset management by the turn owner. Liquidation actions are also legal while the
 * actor's own obligation is outstanding; everything else waits for the pending resolution.
 */
function ownedAssetAction(
  state: GameState,
  env: RuleEnv,
  liquidation: boolean,
): Readonly<{ asset: AssetState; assetIndex: number }> | GameplayCommandResult {
  const payload = payloadObject(env.command, ["assetId"]);
  const assetId = payloadIdentifier(payload.assetId, "payload.assetId");
  const turn = state.turn;
  if (turn === null || turn.activePlayerId !== env.actorUserId) return rejected(state, "NOT_YOUR_TURN");
  const pending = state.pendingResolution;
  if (pending !== null) {
    const ownDebt = pending.obligation?.debtorUserId === env.actorUserId;
    if (!liquidation || !ownDebt) return rejected(state, "PENDING_RESOLUTION");
  }
  const assetIndex = state.assets.findIndex((candidate) => candidate.assetId === assetId);
  const asset = state.assets[assetIndex];
  if (asset === undefined || asset.ownerUserId !== env.actorUserId) return rejected(state, "ASSET_NOT_OWNED");
  return { asset, assetIndex };
}

/** Applies a liquidation-capable change, then settles the actor's obligation if now covered. */
function liquidationResult(
  state: GameState,
  env: RuleEnv,
  players: readonly PlayerState[],
  assets: readonly AssetState[],
  event: (debtSettled: boolean) => GameplayEvent,
): GameplayCommandResult {
  const settlement = settleObligation(state, env, {
    ...draftOf(state, state.turn as TurnIdentity),
    players,
    assets,
  });
  if (settlement.kind === "FAILED") {
    return rejected(state, "EFFECT_CHAIN_FAILED", { diagnostic: settlement.diagnostic });
  }
  return accepted(acceptedState(state, env, settlement.draft), event(settlement.settled));
}

function build(state: GameState, env: RuleEnv): GameplayCommandResult {
  const selected = ownedAssetAction(state, env, false);
  if ("kind" in selected) return selected;
  const { asset, assetIndex } = selected;
  if (asset.kind !== "PROPERTY") return rejected(state, "ASSET_NOT_DEVELOPABLE");
  const turn = state.turn;
  if (turn === null) return rejected(state, "NOT_YOUR_TURN");
  const playerIndex = state.players.findIndex((player) => player.userId === env.actorUserId);
  const player = state.players[playerIndex];
  if (player === undefined) return rejected(state, "ACTOR_NOT_IN_GAME");
  if (player.inHolding) return rejected(state, "PLAYER_IN_HOLDING");
  if (turn.developmentActionsUsed >= 2) return rejected(state, "DEVELOPMENT_LIMIT_REACHED");
  const setAssets = propertySetAssets(state, env.board, asset);
  if (!setAssets.every((candidate) => candidate.ownerUserId === env.actorUserId)) {
    return rejected(state, "INCOMPLETE_SET");
  }
  if (setAssets.some((candidate) => candidate.mortgaged)) return rejected(state, "SET_MORTGAGED");
  if (asset.developmentLevel >= 4) return rejected(state, "ASSET_NOT_DEVELOPABLE");
  const minimumLevel = Math.min(...setAssets.map((candidate) => candidate.developmentLevel));
  if (asset.developmentLevel !== minimumLevel) return rejected(state, "UNEVEN_BUILD");
  const property = propertyForAsset(env.board, asset);
  if (property === null) return rejected(state, "ASSET_NOT_DEVELOPABLE");
  if (player.cash < property.buildingCost) return rejected(state, "INSUFFICIENT_FUNDS");
  const nextLevel = asset.developmentLevel + 1;
  const nextState = acceptedState(state, env, {
    players: state.players.map((candidate, index) => index === playerIndex
      ? { ...candidate, cash: candidate.cash - property.buildingCost }
      : candidate),
    assets: state.assets.map((candidate, index) => index === assetIndex
      ? { ...asset, developmentLevel: nextLevel }
      : candidate),
    turn: { ...turn, developmentActionsUsed: turn.developmentActionsUsed + 1 },
  });
  return accepted(nextState, {
    type: "DEVELOPMENT_BOUGHT",
    playerId: env.actorUserId,
    assetId: asset.assetId,
    level: nextLevel,
    price: property.buildingCost,
  });
}

/** Sells one level back at the canonical 50%, highest level in the set first (even-sell). */
function sellDevelopment(state: GameState, env: RuleEnv): GameplayCommandResult {
  const selected = ownedAssetAction(state, env, true);
  if ("kind" in selected) return selected;
  const { asset, assetIndex } = selected;
  if (asset.kind !== "PROPERTY" || asset.developmentLevel === 0) {
    return rejected(state, "ASSET_NOT_DEVELOPABLE");
  }
  const setAssets = propertySetAssets(state, env.board, asset);
  if (asset.developmentLevel !== Math.max(...setAssets.map((candidate) => candidate.developmentLevel))) {
    return rejected(state, "UNEVEN_SALE");
  }
  const property = propertyForAsset(env.board, asset);
  if (property === null) return rejected(state, "ASSET_NOT_DEVELOPABLE");
  const amount = property.buildingSellBack;
  const level = asset.developmentLevel - 1;
  return liquidationResult(
    state,
    env,
    updatePlayer(state.players, env.actorUserId, (player) => ({
      ...player, cash: checkedCash(player.cash + amount),
    })),
    state.assets.map((candidate, index) => index === assetIndex
      ? { ...asset, developmentLevel: level }
      : candidate),
    (debtSettled) => ({
      type: "DEVELOPMENT_SOLD", playerId: env.actorUserId, assetId: asset.assetId, level, amount, debtSettled,
    }),
  );
}

function changeMortgage(state: GameState, env: RuleEnv, mortgage: boolean): GameplayCommandResult {
  const selected = ownedAssetAction(state, env, mortgage);
  if ("kind" in selected) return selected;
  const { asset, assetIndex } = selected;
  if (mortgage && asset.mortgaged) return rejected(state, "ALREADY_MORTGAGED");
  if (!mortgage && !asset.mortgaged) return rejected(state, "NOT_MORTGAGED");
  if (mortgage && asset.kind === "PROPERTY") {
    const setAssets = propertySetAssets(state, env.board, asset);
    if (setAssets.some((candidate) => candidate.developmentLevel > 0)) {
      return rejected(state, "SET_HAS_DEVELOPMENT");
    }
  }
  const player = state.players.find((candidate) => candidate.userId === env.actorUserId);
  if (player === undefined) return rejected(state, "ACTOR_NOT_IN_GAME");
  const amount = mortgage ? mortgageValue(env.board, asset) : unmortgageCost(env.board, asset);
  if (!mortgage && player.cash < amount) return rejected(state, "INSUFFICIENT_FUNDS");
  const nextCash = checkedCash(mortgage ? player.cash + amount : player.cash - amount);
  return liquidationResult(
    state,
    env,
    updatePlayer(state.players, env.actorUserId, (candidate) => ({ ...candidate, cash: nextCash })),
    state.assets.map((candidate, index) => index === assetIndex
      ? { ...candidate, mortgaged: mortgage }
      : candidate),
    (debtSettled) => ({
      type: mortgage ? "ASSET_MORTGAGED" : "ASSET_UNMORTGAGED",
      playerId: env.actorUserId,
      assetId: asset.assetId,
      amount,
      debtSettled,
    }),
  );
}

function tradeFact(
  type: TradeFact["type"],
  trade: TradeState,
  env: RuleEnv,
  actorUserId = env.actorUserId,
): TradeFact {
  return freezeTrade({
    type,
    tradeId: trade.tradeId,
    parentTradeId: trade.parentTradeId,
    actorUserId,
    proposerUserId: trade.proposerUserId,
    recipientUserId: trade.recipientUserId,
    offered: trade.offered,
    requested: trade.requested,
    liquidationFor: trade.liquidationFor,
    gameVersion: env.nextGameVersion,
    actionId: env.command.actionId,
  });
}

/**
 * Current-state legality for creating or settling a trade. Acceptance always calls this again,
 * so nothing validated at proposal time is trusted later.
 */
function tradeRejection(state: GameState, env: RuleEnv, trade: TradeState): GameplayRejectionReason | null {
  if (state.phase === "STARTING") return "GAME_NOT_STARTED";
  if (state.phase === "GAME_OVER") return "GAME_ALREADY_ENDED";
  if (state.auction !== null) return "TRADE_BLOCKED_DURING_AUCTION";
  const parties = [trade.proposerUserId, trade.recipientUserId];
  if (parties.some((userId) => state.players.find((player) => player.userId === userId)?.status !== "ACTIVE")) {
    return "PLAYER_NOT_ELIGIBLE";
  }
  const pending = state.pendingResolution;
  const debtorUserId = pending?.obligation?.debtorUserId ?? null;
  if (debtorUserId !== null && parties.includes(debtorUserId)) {
    // Only an explicit liquidation trade created under this debt may involve the debtor.
    if (trade.liquidationFor !== pending?.resolutionId) return "DEBT_BLOCKED";
  }
  // RULE-018 owns team-specific trade legality; FFA and TEAMS currently share these rules.
  const sides: readonly [string, TradeBundle][] = [
    [trade.proposerUserId, trade.offered],
    [trade.recipientUserId, trade.requested],
  ];
  for (const [giverUserId, bundle] of sides) {
    const giver = state.players.find((player) => player.userId === giverUserId) as PlayerState;
    if (giver.cash < bundle.cash) return "INSUFFICIENT_FUNDS";
    for (const assetId of bundle.assetIds) {
      const asset = state.assets.find((candidate) => candidate.assetId === assetId);
      if (asset?.ownerUserId !== giverUserId) return "ASSET_NOT_OWNED";
      if (pending?.source.type === "TILE" && pending.source.tileIndex === asset.tileIndex) {
        return "ASSET_IN_PENDING_RESOLUTION";
      }
      if (asset.kind === "PROPERTY"
        && propertySetAssets(state, env.board, asset).some((candidate) => candidate.developmentLevel > 0)) {
        return "SET_HAS_DEVELOPMENT";
      }
    }
  }
  return null;
}

function withTrades(
  state: GameState,
  trades: readonly TradeState[],
  fact: TradeFact,
): AdvancedRuleState {
  return { ...state.ruleState, trades, tradeFacts: [...state.ruleState.tradeFacts, fact] };
}

function openTrade(state: GameState, env: RuleEnv, parent: TradeState | null): GameplayCommandResult {
  const payload = payloadObject(
    env.command,
    parent === null ? ["recipientUserId", "offered", "requested"] : ["tradeId", "offered", "requested"],
  );
  const offered = payloadBundle(payload.offered, "payload.offered");
  const requested = payloadBundle(payload.requested, "payload.requested");
  const recipientUserId = parent === null
    ? payloadIdentifier(payload.recipientUserId, "payload.recipientUserId")
    : parent.proposerUserId;
  if (recipientUserId === env.actorUserId
    || !state.players.some((player) => player.userId === recipientUserId)) {
    return rejected(state, "INVALID_TRADE_PARTNER");
  }
  const assetIds = [...offered.assetIds, ...requested.assetIds];
  if (new Set(assetIds).size !== assetIds.length) {
    throw new CommandValidationError("payload", "an asset cannot appear on both sides");
  }
  if (offered.cash === 0 && requested.cash === 0 && assetIds.length === 0) {
    return rejected(state, "EMPTY_TRADE");
  }
  const pending = state.pendingResolution;
  const debtorUserId = pending?.obligation?.debtorUserId ?? null;
  const trade: TradeState = freezeTrade({
    tradeId: "trade-" + env.nextGameVersion,
    parentTradeId: parent?.tradeId ?? null,
    proposerUserId: env.actorUserId,
    recipientUserId,
    offered,
    requested,
    createdGameVersion: env.nextGameVersion,
    liquidationFor: debtorUserId !== null && [env.actorUserId, recipientUserId].includes(debtorUserId)
      ? pending?.resolutionId ?? null
      : null,
  });
  const reason = tradeRejection(state, env, trade);
  if (reason !== null) return rejected(state, reason);
  const remaining = state.ruleState.trades.filter((candidate) => candidate.tradeId !== parent?.tradeId);
  const fact = tradeFact(parent === null ? "PROPOSED" : "COUNTERED", trade, env);
  return accepted(
    acceptedState(state, env, { ruleState: withTrades(state, [...remaining, trade], fact) }),
    { type: "TRADE_UPDATED", fact, debtSettled: false, incident: null, eliminations: [] },
  );
}

function openTradeFor(state: GameState, env: RuleEnv): TradeState | null {
  const payload = payloadObject(env.command, env.command.type === "COUNTER_TRADE"
    ? ["tradeId", "offered", "requested"]
    : ["tradeId"]);
  const tradeId = payloadIdentifier(payload.tradeId, "payload.tradeId");
  return state.ruleState.trades.find((trade) => trade.tradeId === tradeId) ?? null;
}

function counterTrade(state: GameState, env: RuleEnv): GameplayCommandResult {
  const original = openTradeFor(state, env);
  if (original === null) return rejected(state, "TRADE_NOT_OPEN");
  if (original.recipientUserId !== env.actorUserId) return rejected(state, "NOT_TRADE_PARTICIPANT");
  return openTrade(state, env, original);
}

function closeTrade(state: GameState, env: RuleEnv, disposition: "REJECTED" | "CANCELLED"): GameplayCommandResult {
  if (state.phase !== "ACTIVE_TURN") {
    return rejected(state, state.phase === "GAME_OVER" ? "GAME_ALREADY_ENDED" : "GAME_NOT_STARTED");
  }
  const trade = openTradeFor(state, env);
  if (trade === null) return rejected(state, "TRADE_NOT_OPEN");
  const allowedUserId = disposition === "REJECTED" ? trade.recipientUserId : trade.proposerUserId;
  if (env.actorUserId !== allowedUserId) return rejected(state, "NOT_TRADE_PARTICIPANT");
  const fact = tradeFact(disposition, trade, env);
  return accepted(
    acceptedState(state, env, {
      ruleState: withTrades(state, state.ruleState.trades.filter((candidate) => candidate !== trade), fact),
    }),
    { type: "TRADE_UPDATED", fact, debtSettled: false, incident: null, eliminations: [] },
  );
}

/** Atomic settlement after revalidating the proposal against the current canonical state. */
function acceptTrade(state: GameState, env: RuleEnv): GameplayCommandResult {
  const trade = openTradeFor(state, env);
  if (trade === null) return rejected(state, "TRADE_NOT_OPEN");
  if (trade.recipientUserId !== env.actorUserId) return rejected(state, "NOT_TRADE_PARTICIPANT");
  const reason = tradeRejection(state, env, trade);
  if (reason !== null) return rejected(state, reason);
  const net = trade.requested.cash - trade.offered.cash;
  const players = state.players.map((player) => {
    if (player.userId === trade.proposerUserId) return { ...player, cash: checkedCash(player.cash + net) };
    if (player.userId === trade.recipientUserId) return { ...player, cash: checkedCash(player.cash - net) };
    return player;
  });
  const assets = state.assets.map((asset) => {
    if (trade.offered.assetIds.includes(asset.assetId)) return { ...asset, ownerUserId: trade.recipientUserId };
    if (trade.requested.assetIds.includes(asset.assetId)) return { ...asset, ownerUserId: trade.proposerUserId };
    return asset;
  });
  const fact = tradeFact("ACCEPTED", trade, env);
  const settlement = settleObligation(state, env, {
    ...draftOf(state, state.turn as TurnIdentity),
    players,
    assets,
    ruleState: withTrades(state, state.ruleState.trades.filter((candidate) => candidate !== trade), fact),
  });
  if (settlement.kind === "FAILED") {
    return rejected(state, "EFFECT_CHAIN_FAILED", { diagnostic: settlement.diagnostic });
  }
  // INT-001: FFA trades are valued as they stood at acceptance; TEAMS are never evaluated.
  const lopsided = state.settings.matchMode === "FFA"
    ? lopsidedTrade(env.board, state.assets, trade, env.nextGameVersion)
    : null;
  let draft = settlement.draft;
  let incident: FairPlayIncident | null = null;
  if (lopsided !== null) {
    const recorded = recordLopsidedTrade(draft.ruleState.fairPlay, lopsided, env.command.actionId);
    incident = recorded.incident;
    draft = { ...draft, ruleState: { ...draft.ruleState, fairPlay: recorded.fairPlay } };
  }
  const result = eliminate(state, env, draft, incident === null ? [] : removalsFor(draft, [incident]));
  return accepted(result.state, {
    type: "TRADE_UPDATED", fact, debtSettled: settlement.settled, incident, eliminations: result.facts,
  });
}

/** The surviving player (FFA) or team (TEAMS), once only one remains. */
function lastStanding(state: GameState, players: readonly PlayerState[]): Readonly<{
  winnerUserIds: readonly string[];
  winningTeamId: string | null;
}> | null {
  const survivors = players.filter((player) => player.status === "ACTIVE").map((player) => player.userId);
  if (state.settings.matchMode === "FFA") {
    return survivors.length === 1 ? { winnerUserIds: survivors, winningTeamId: null } : null;
  }
  const teamIds = new Set(survivors.map((userId) => teamOf(state.settings, userId)));
  if (teamIds.size !== 1) return null;
  const team = state.settings.teams.find((candidate) => teamIds.has(candidate.teamId));
  return team === undefined ? null : { winnerUserIds: team.memberUserIds, winningTeamId: team.teamId };
}

type EliminationRequest = Pick<
  EliminationFact, "userId" | "reason" | "resolutionId" | "creditor" | "obligationAmount"
>;

/** INT-001 section 5: a removal settles like a bankruptcy to the bank, for every active pair member. */
function removalsFor(draft: Draft, incidents: readonly FairPlayIncident[]): EliminationRequest[] {
  const userIds = new Set(incidents
    .filter((incident) => incident.consequence === "REMOVAL")
    .flatMap((incident) => [incident.giverUserId, incident.receiverUserId]));
  return draft.players
    .filter((player) => player.status === "ACTIVE" && userIds.has(player.userId))
    .map((player) => ({
      userId: player.userId, reason: "REMOVED", resolutionId: null, creditor: { type: "BANK" }, obligationAmount: 0,
    }));
}

/**
 * RULE-016/017 bankruptcy and INT-001 removal share one path. In order, each eliminated player
 * hands cash and assets to a still-active player creditor (developments sold back at 50%, mortgages
 * kept) or back to the bank (reset). Then every interaction that referenced them is repaired: held
 * cards return to their decks, their trades are voided, debts owed to them become bank debts, and
 * card payments queued to them are dropped. The game ends if one player or team remains; otherwise
 * the next eligible seat starts a new turn when the turn owner is gone.
 */
function eliminate(
  state: GameState,
  env: RuleEnv,
  initial: Draft,
  requests: readonly EliminationRequest[],
): Readonly<{
  state: GameState;
  facts: readonly EliminationFact[];
  outcome: GameOutcome | null;
  activePlayerId: string | null;
}> {
  const turn = initial.turn;
  if (requests.length === 0) {
    return { state: acceptedState(state, env, initial), facts: [], outcome: null, activePlayerId: turn.activePlayerId };
  }
  let players = initial.players;
  let assets = initial.assets;
  let ruleState = initial.ruleState;
  const facts: EliminationFact[] = [];
  for (const request of requests) {
    const creditor = request.creditor;
    const creditorUserId = creditor.type === "PLAYER"
      && players.find((player) => player.userId === creditor.userId)?.status === "ACTIVE"
      ? creditor.userId
      : null;
    let saleProceeds = 0;
    const assetIds: string[] = [];
    assets = assets.map((asset): AssetState => {
      if (asset.ownerUserId !== request.userId) return asset;
      assetIds.push(asset.assetId);
      if (creditorUserId === null) {
        return asset.kind === "PROPERTY"
          ? { ...asset, ownerUserId: null, mortgaged: false, developmentLevel: 0 }
          : { ...asset, ownerUserId: null, mortgaged: false };
      }
      if (asset.kind !== "PROPERTY") return { ...asset, ownerUserId: creditorUserId };
      saleProceeds += asset.developmentLevel * (propertyForAsset(env.board, asset)?.buildingSellBack ?? 0);
      return { ...asset, ownerUserId: creditorUserId, developmentLevel: 0 };
    });
    const eliminated = players.find((player) => player.userId === request.userId) as PlayerState;
    const cashTransferred = eliminated.cash + (creditorUserId === null ? 0 : saleProceeds);
    players = players.map((player) => {
      if (player.userId === request.userId) {
        return { ...player, cash: 0, status: "BANKRUPT" as const, inHolding: false, holdingAttempts: 0 };
      }
      if (player.userId === creditorUserId) return { ...player, cash: checkedCash(player.cash + cashTransferred) };
      return player;
    });
    for (const card of ruleState.heldCards.filter((held) => held.ownerUserId === request.userId)) {
      ruleState = returnHeldCard(ruleState, env.catalog as CardCatalogDefinition, card.cardId, request.userId);
    }
    facts.push({
      ...request,
      cashTransferred,
      assetIds,
      gameVersion: env.nextGameVersion,
      actionId: env.command.actionId,
    });
  }
  const out = new Set(requests.map((request) => request.userId));
  const winner = lastStanding(state, players);
  // A finished game keeps no open trades; otherwise only trades touching an eliminated player end.
  const voided = ruleState.trades.filter((trade) => winner !== null
    || out.has(trade.proposerUserId) || out.has(trade.recipientUserId));
  const voidingActor = (trade: TradeState): string => {
    if (out.has(trade.proposerUserId)) return trade.proposerUserId;
    return out.has(trade.recipientUserId) ? trade.recipientUserId : (requests[0] as EliminationRequest).userId;
  };
  let pendingResolution = initial.pendingResolution;
  let effectContinuation = ruleState.effectContinuation;
  if (out.has(turn.activePlayerId) || winner !== null) {
    pendingResolution = null;
    effectContinuation = null;
  } else {
    const obligation = pendingResolution?.obligation ?? null;
    if (pendingResolution !== null && obligation !== null
      && obligation.creditor.type === "PLAYER" && out.has(obligation.creditor.userId)) {
      pendingResolution = { ...pendingResolution, obligation: { ...obligation, creditor: { type: "BANK" } } };
    }
    if (effectContinuation !== null) {
      effectContinuation = {
        ...effectContinuation,
        frames: effectContinuation.frames.filter((frame) => frame.type !== "PAY_PLAYER" || !out.has(frame.userId)),
      };
    }
  }
  const eliminations = [...ruleState.eliminations, ...facts];
  let outcome: GameOutcome | null = null;
  let activePlayerId: string | null = turn.activePlayerId;
  let nextTurnState: TurnIdentity | null = turn;
  if (winner !== null) {
    const survivors = players.filter((player) => player.status === "ACTIVE").map((player) => player.userId);
    outcome = {
      reason: "LAST_STANDING",
      ...winner,
      placements: [...survivors, ...eliminations.map((elimination) => elimination.userId).reverse()],
      endedGameVersion: env.nextGameVersion,
    };
    activePlayerId = null;
    nextTurnState = null;
  } else if (out.has(turn.activePlayerId)) {
    const seat = players.findIndex((player) => player.userId === turn.activePlayerId);
    activePlayerId = [...players.slice(seat + 1), ...players.slice(0, seat)]
      .find((player) => player.status === "ACTIVE")?.userId ?? null;
    nextTurnState = activePlayerId === null ? null : nextTurn(turn.turnNumber + 1, activePlayerId);
  }
  const nextState = acceptedState(state, env, {
    players,
    assets,
    pendingResolution,
    phase: outcome === null ? "ACTIVE_TURN" : "GAME_OVER",
    turn: nextTurnState,
    ruleState: {
      ...ruleState,
      effectContinuation,
      trades: ruleState.trades.filter((trade) => !voided.includes(trade)),
      tradeFacts: [
        ...ruleState.tradeFacts,
        ...voided.map((trade) => tradeFact("VOIDED", trade, env, voidingActor(trade))),
      ],
      eliminations,
      outcome,
    },
  });
  return { state: nextState, facts, outcome, activePlayerId };
}

/** Bankrupts the current debtor, then applies any INT-001 dump consequences (FFA only). */
function bankrupt(state: GameState, env: RuleEnv, reason: "DECLARED" | "DEADLINE"): GameplayCommandResult {
  const pending = state.pendingResolution as PendingResolution;
  const obligation = pending.obligation as MonetaryObligation;
  let draft: Draft = { ...draftOf(state, state.turn as TurnIdentity), pendingResolution: null };
  let incidents: readonly FairPlayIncident[] = [];
  if (state.settings.matchMode === "FFA") {
    const dumps = recordDumps(
      draft.ruleState.fairPlay, obligation.debtorUserId, pending.resolutionId, env.nextGameVersion,
      env.command.actionId,
    );
    incidents = dumps.incidents;
    draft = { ...draft, ruleState: { ...draft.ruleState, fairPlay: dumps.fairPlay } };
  }
  const bankruptcy: EliminationRequest = {
    userId: obligation.debtorUserId,
    reason,
    resolutionId: pending.resolutionId,
    creditor: obligation.creditor,
    obligationAmount: obligation.amount,
  };
  const removals = removalsFor(draft, incidents).filter((request) => request.userId !== obligation.debtorUserId);
  const result = eliminate(state, env, draft, [bankruptcy, ...removals]);
  return accepted(result.state, {
    type: "PLAYER_BANKRUPT",
    fact: result.facts[0] as EliminationFact,
    removals: result.facts.slice(1),
    incidents,
    activePlayerId: result.activePlayerId,
    outcome: result.outcome,
  });
}

function outstandingDebt(state: GameState, resolutionId: string) {
  const pending = state.pendingResolution;
  return pending?.resolutionId === resolutionId && pending.obligation !== null ? pending.obligation : null;
}

/**
 * The runtime's turn deadline expired (RUNTIME-E1 section 6). Plays the owner's default moves with
 * the ordinary handlers until the turn passes or someone else must decide (an auction) or a debt is
 * outstanding: roll (a Holding attempt if held), draw a pending card, decline a purchase, end the turn.
 */
function timeoutTurn(state: GameState, env: RuleEnv): GameplayCommandResult {
  const payload = payloadObject(env.command, ["turnId"]);
  const turnId = payloadIdentifier(payload.turnId, "payload.turnId");
  if (state.phase !== "ACTIVE_TURN" || state.turn?.turnId !== turnId) return rejected(state, "STALE_TURN_TIMEOUT");
  const owner = state.turn.activePlayerId;
  const as = (movePayload: unknown): RuleEnv => ({
    ...env, actorUserId: owner, command: { ...env.command, payload: movePayload },
  });
  const steps: GameplayEvent[] = [];
  let current = state;
  // A turn has at most three rolls, one card draw per landing, and an end; 12 bounds the loop.
  for (let step = 0; step < 12 && current.phase === "ACTIVE_TURN" && current.turn?.turnId === turnId; step += 1) {
    const pending = current.pendingResolution;
    const turn = current.turn;
    let move: GameplayCommandResult;
    if (pending === null) {
      move = !turn.hasRolled || turn.rollAgain
        ? rollCurrentPlayer(current, as({}))
        : endCurrentTurn(current, as({}));
    } else if (pending.kind === "CARD" && pending.obligation === null) {
      move = drawPendingCard(current, as({ resolutionId: pending.resolutionId }));
    } else if (pending.kind === "BUY_DECISION") {
      move = declineProperty(current, as({ resolutionId: pending.resolutionId }));
    } else {
      break;
    }
    if (move.kind !== "ACCEPTED") break;
    steps.push(move.event);
    current = move.state;
  }
  if (steps.length === 0) return rejected(state, "NOTHING_TO_AUTO_PLAY");
  return accepted(current, { type: "TURN_AUTO_PLAYED", playerId: owner, steps });
}

/**
 * RT-010 resume: moves every in-state deadline (auction decision, debt) later by the time the
 * room spent paused, so a pause never costs anyone their decision time.
 */
function resumeClocks(state: GameState, env: RuleEnv): GameplayCommandResult {
  const payload = payloadObject(env.command, ["pausedMs"]);
  const pausedMs = authoritativeInteger(payload.pausedMs, "payload.pausedMs");
  const auction = state.auction;
  const debt = state.ruleState.debt;
  if (pausedMs === 0 || (auction === null && debt === null)) return rejected(state, "NO_CLOCKS_TO_RESUME");
  return accepted(
    acceptedState(state, env, {
      auction: auction === null ? null : { ...auction, decisionDeadlineAt: auction.decisionDeadlineAt + pausedMs },
      ruleState: { ...state.ruleState, debt: debt === null ? null : { ...debt, deadlineAt: debt.deadlineAt + pausedMs } },
    }),
    { type: "CLOCKS_RESUMED", pausedMs },
  );
}

/** The debtor may give up at any time while in debt. */
function declareBankruptcy(state: GameState, env: RuleEnv): GameplayCommandResult {
  const payload = payloadObject(env.command, ["resolutionId"]);
  const obligation = outstandingDebt(state, payloadIdentifier(payload.resolutionId, "payload.resolutionId"));
  if (obligation === null) return rejected(state, "DEBT_NOT_ACTIVE");
  if (obligation.debtorUserId !== env.actorUserId) return rejected(state, "NOT_YOUR_TURN");
  return bankrupt(state, env, "DECLARED");
}

/** Expiry of the persisted absolute debt deadline forces bankruptcy. */
function timeoutDebt(state: GameState, env: RuleEnv): GameplayCommandResult {
  const now = authoritativeInteger(env.context.currentTime, "context.currentTime");
  const payload = payloadObject(env.command, ["resolutionId", "deadlineAt"]);
  const resolutionId = payloadIdentifier(payload.resolutionId, "payload.resolutionId");
  const deadlineAt = authoritativeInteger(payload.deadlineAt, "payload.deadlineAt");
  const debt = state.ruleState.debt;
  if (debt === null || outstandingDebt(state, resolutionId) === null) return rejected(state, "DEBT_NOT_ACTIVE");
  if (debt.deadlineAt !== deadlineAt) return rejected(state, "STALE_DEBT_TIMEOUT");
  if (now < debt.deadlineAt) return rejected(state, "DEBT_DEADLINE_NOT_EXPIRED");
  return bankrupt(state, env, "DEADLINE");
}

function endCurrentTurn(state: GameState, env: RuleEnv): GameplayCommandResult {
  const guard = turnOwnerRejection(state, env.actorUserId);
  if (guard !== null) return rejected(state, guard);
  const turn = state.turn as TurnIdentity;
  if (!turn.hasRolled || turn.rollAgain) return rejected(state, "ROLL_REQUIRED");

  const currentIndex = state.players.findIndex((player) => player.userId === env.actorUserId);
  for (let offset = 1; offset <= state.players.length; offset += 1) {
    const candidate = state.players[(currentIndex + offset) % state.players.length];
    if (candidate?.status !== "ACTIVE") continue;
    const nextState = acceptedState(state, env, {
      turn: nextTurn(turn.turnNumber + 1, candidate.userId),
    });
    return accepted(nextState, {
      type: "TURN_ENDED",
      endedPlayerId: env.actorUserId,
      activePlayerId: candidate.userId,
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
  const state = parseGameState(stateInput, board, context.cardCatalog);
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
      break;
  }
  // RULE-019: the final state is immutable; only rematch (a new game) follows.
  if (state.phase === "GAME_OVER") return rejected(state, "GAME_ALREADY_ENDED");
  const env: RuleEnv = {
    board,
    catalog: context.cardCatalog,
    context,
    command,
    actorUserId,
    nextGameVersion: decision.nextGameVersion,
  };
  switch (type) {
    case "CONFIGURE_MATCH": return configureMatch(state, env);
    case "START_GAME": return startGame(state, env);
    case "ROLL_DICE": return rollCurrentPlayer(state, env);
    case "END_TURN": return endCurrentTurn(state, env);
    case "BUY_PROPERTY": return buyProperty(state, env);
    case "DECLINE_PROPERTY": return declineProperty(state, env);
    case "PLACE_BID": return placeBid(state, env);
    case "PASS_AUCTION": return passAuction(state, env, false);
    case "AUCTION_TIMEOUT": return timeoutAuction(state, env);
    case "BUILD": return build(state, env);
    case "SELL_DEVELOPMENT": return sellDevelopment(state, env);
    case "MORTGAGE": return changeMortgage(state, env, true);
    case "UNMORTGAGE": return changeMortgage(state, env, false);
    case "DRAW_CARD": return drawPendingCard(state, env);
    case "PAY_HOLDING_FEE": return payHoldingFee(state, env);
    case "USE_RELEASE_CARD": return useReleaseCard(state, env);
    case "PROPOSE_TRADE": return openTrade(state, env, null);
    case "COUNTER_TRADE": return counterTrade(state, env);
    case "ACCEPT_TRADE": return acceptTrade(state, env);
    case "REJECT_TRADE": return closeTrade(state, env, "REJECTED");
    case "CANCEL_TRADE": return closeTrade(state, env, "CANCELLED");
    case "DEBT_TIMEOUT": return timeoutDebt(state, env);
    case "DECLARE_BANKRUPTCY": return declareBankruptcy(state, env);
    case "TURN_TIMEOUT": return timeoutTurn(state, env);
    case "RESUME_CLOCKS": return resumeClocks(state, env);
  }
}
