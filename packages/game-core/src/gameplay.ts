import { parseBoardDefinition, type BoardDefinition } from "./board";
import {
  classifyGameCommand,
  CommandValidationError,
  parseGameCommand,
  type AppliedActionRecord,
  type GameCommand,
} from "./command";
import { rollDice, type DiceRoll } from "./dice";
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
  parseGameState,
  type AuctionFact,
  type AuctionState,
  type AssetState,
  type GameState,
  type MatchSettings,
  type PlayerState,
  type PendingResolution,
  type TurnIdentity,
} from "./state";
import { dispatchLandedTile, type TileResolution } from "./tile-dispatch";

export type GameplayCommandType =
  | "CONFIGURE_MATCH" | "START_GAME" | "ROLL_DICE" | "END_TURN"
  | "BUY_PROPERTY" | "DECLINE_PROPERTY" | "PLACE_BID" | "PASS_AUCTION"
  | "AUCTION_TIMEOUT" | "BUILD" | "MORTGAGE" | "UNMORTGAGE";

export interface GameplayCommandContext {
  readonly actorUserId: string;
  readonly board: BoardDefinition;
  readonly rng: RandomSource;
  readonly appliedActions?: readonly AppliedActionRecord[];
  readonly currentTime?: number;
  readonly auctionDecisionDeadlineAt?: number;
}

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
      readonly movement: MovementResult;
      readonly resolution: TileResolution;
    }
  | {
      readonly type: "TURN_ENDED";
      readonly endedPlayerId: string;
      readonly activePlayerId: string;
    }
  | {
      readonly type: "GAME_ENDED";
      readonly endedPlayerId: string;
      readonly winnerUserId: string | null;
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
      readonly type: "ASSET_MORTGAGED" | "ASSET_UNMORTGAGED";
      readonly playerId: string;
      readonly assetId: string;
      readonly amount: number;
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
  | "DEVELOPMENT_LIMIT_REACHED"
  | "PLAYER_IN_HOLDING"
  | "ALREADY_MORTGAGED"
  | "NOT_MORTGAGED"
  | "SET_HAS_DEVELOPMENT"
  | "AUCTION_NOT_ACTIVE"
  | "NOT_AUCTION_ACTOR"
  | "BID_TOO_LOW"
  | "BID_EXCEEDS_CASH"
  | "AUCTION_DEADLINE_NOT_EXPIRED"
  | "STALE_AUCTION_TIMEOUT"
  | "AUCTION_SETTLEMENT_UNAFFORDABLE";

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
    };

function identifier(value: string, field: string): string {
  if (value.trim().length === 0) {
    throw new CommandValidationError(field, "expected a non-empty string");
  }
  return value;
}

function gameplayCommand(command: GameCommand): GameplayCommandType {
  if (
    command.type !== "CONFIGURE_MATCH"
    && command.type !== "START_GAME"
    && command.type !== "ROLL_DICE"
    && command.type !== "END_TURN"
    && command.type !== "BUY_PROPERTY"
    && command.type !== "DECLINE_PROPERTY"
    && command.type !== "PLACE_BID"
    && command.type !== "PASS_AUCTION"
    && command.type !== "AUCTION_TIMEOUT"
    && command.type !== "BUILD"
    && command.type !== "MORTGAGE"
    && command.type !== "UNMORTGAGE"
  ) {
    throw new CommandValidationError("type", "unknown gameplay command " + command.type);
  }
  if (command.type === "START_GAME" || command.type === "ROLL_DICE" || command.type === "END_TURN") {
    if (
      typeof command.payload !== "object"
      || command.payload === null
      || Array.isArray(command.payload)
      || Object.keys(command.payload).length !== 0
    ) {
      throw new CommandValidationError("payload", "expected an empty object");
    }
  }
  return command.type;
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

function rejected(
  state: GameState,
  reason: GameplayRejectionReason,
  details: Readonly<{ currentGameId?: string; currentGameVersion?: number }> = {},
): GameplayCommandResult {
  return Object.freeze({ kind: "REJECTED", state, reason, ...details });
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
  };
}

function acceptedState(
  state: GameState,
  board: BoardDefinition,
  nextGameVersion: number,
  changes: Readonly<{
    phase?: GameState["phase"];
    turn?: TurnIdentity | null;
    players?: readonly PlayerState[];
    assets?: readonly AssetState[];
    settings?: MatchSettings;
    pendingResolution?: PendingResolution | null;
    auction?: AuctionState | null;
  }>,
): GameState {
  return parseGameState(
    {
      ...state,
      ...changes,
      gameVersion: nextGameVersion,
    },
    board,
  );
}

function resolutionContinuation(roll: DiceRoll): PendingResolution["continuation"] {
  return roll.doubles ? { type: "ROLL_AGAIN" } : { type: "END_TURN" };
}

function pendingForLanding(
  state: GameState,
  turn: TurnIdentity,
  playerId: string,
  roll: DiceRoll,
  resolution: TileResolution,
  nextGameVersion: number,
): PendingResolution | null {
  let kind: PendingResolution["kind"] | null = null;
  if (
    resolution.kind === "PROPERTY"
    || resolution.kind === "TRANSIT"
    || resolution.kind === "UTILITY"
  ) {
    const asset = state.assets.find((candidate) => candidate.tileIndex === resolution.tileIndex);
    if (asset === undefined) throw new RangeError("landed ownable has no canonical asset");
    if (asset.ownerUserId === null) kind = "BUY_DECISION";
    else if (asset.ownerUserId !== playerId && !asset.mortgaged) kind = "RENT";
  } else if (resolution.kind === "TAX") {
    kind = "TAX";
  } else if (resolution.kind === "SURPRISE" || resolution.kind === "TREASURE") {
    kind = "CARD";
  }
  if (kind === null) return null;
  return {
    resolutionId: turn.turnId + ":landing:" + nextGameVersion,
    kind,
    actorUserId: playerId,
    decisionOwnerUserId: playerId,
    source: { type: "TILE", tileIndex: resolution.tileIndex },
    continuation: resolutionContinuation(roll),
    roll,
    obligation: null,
  };
}

function applyCharge(
  players: readonly PlayerState[],
  turn: TurnIdentity,
  debtorUserId: string,
  amount: number,
  creditorUserId: string | null,
  roll: DiceRoll,
  tileIndex: number,
  nextGameVersion: number,
): Readonly<{ players: readonly PlayerState[]; pendingResolution: PendingResolution | null }> {
  if (!Number.isSafeInteger(amount) || amount < 0) throw new RangeError("charge must be non-negative");
  if (amount === 0) return { players, pendingResolution: null };
  const debtor = players.find((player) => player.userId === debtorUserId);
  if (debtor === undefined) throw new RangeError("charge debtor is not a game player");
  const continuation = resolutionContinuation(roll);
  if (debtor.cash < amount) {
    return {
      players,
      pendingResolution: {
        resolutionId: turn.turnId + ":debt:" + nextGameVersion,
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
  const nextPlayers = players.map((player) => {
    if (player.userId === debtorUserId) return { ...player, cash: player.cash - amount };
    if (creditorUserId !== null && player.userId === creditorUserId) {
      const cash = player.cash + amount;
      if (!Number.isSafeInteger(cash)) throw new RangeError("creditor cash exceeds safe integer range");
      return { ...player, cash };
    }
    return player;
  });
  return { players: nextPlayers, pendingResolution: null };
}

function configureMatch(
  state: GameState,
  board: BoardDefinition,
  command: GameCommand,
  actorUserId: string,
  nextGameVersion: number,
): GameplayCommandResult {
  if (state.phase !== "STARTING") return rejected(state, "SETTINGS_LOCKED");
  if (!state.players.some((player) => player.userId === actorUserId)) {
    return rejected(state, "ACTOR_NOT_IN_GAME");
  }
  const payload = payloadObject(command, ["matchMode", "winMode", "startingCash"]);
  const settings: MatchSettings = {
    matchMode: payload.matchMode === "FFA" || payload.matchMode === "TEAMS"
      ? payload.matchMode
      : (() => { throw new CommandValidationError("payload.matchMode", "expected FFA or TEAMS"); })(),
    winMode: payload.winMode === "LAST_STANDING"
      ? payload.winMode
      : (() => { throw new CommandValidationError("payload.winMode", "expected LAST_STANDING"); })(),
    startingCash: typeof payload.startingCash === "number" ? payload.startingCash : Number.NaN,
    pacing: "CORE",
  };
  const nextState = acceptedState(state, board, nextGameVersion, {
    settings,
    players: state.players.map((player) => ({ ...player, cash: settings.startingCash })),
  });
  return Object.freeze({
    kind: "ACCEPTED",
    state: nextState,
    event: Object.freeze({ type: "MATCH_CONFIGURED", settings: nextState.settings }),
  });
}
function startGame(
  state: GameState,
  board: BoardDefinition,
  actorUserId: string,
  nextGameVersion: number,
): GameplayCommandResult {
  if (state.phase === "GAME_OVER") return rejected(state, "GAME_ALREADY_ENDED");
  if (state.phase !== "STARTING") return rejected(state, "GAME_ALREADY_STARTED");
  if (!state.players.some((player) => player.userId === actorUserId)) {
    return rejected(state, "ACTOR_NOT_IN_GAME");
  }

  const eligibility = evaluateLobbyStart(state.players.length);
  if (!eligibility.ok || state.players.some((player) => player.status !== "ACTIVE")) {
    return rejected(state, "GAME_NOT_STARTABLE");
  }

  const turnOrder = state.players.map((player) => player.userId);
  const activePlayerId = turnOrder[0];
  if (activePlayerId === undefined) return rejected(state, "GAME_NOT_STARTABLE");

  const nextState = acceptedState(state, board, nextGameVersion, {
    phase: "ACTIVE_TURN",
    turn: nextTurn(1, activePlayerId),
  });
  return Object.freeze({
    kind: "ACCEPTED",
    state: nextState,
    event: Object.freeze({
      type: "GAME_STARTED",
      turnOrder: Object.freeze(turnOrder),
      activePlayerId,
    }),
  });
}

function rollCurrentPlayer(
  state: GameState,
  board: BoardDefinition,
  actorUserId: string,
  rng: RandomSource,
  nextGameVersion: number,
): GameplayCommandResult {
  if (state.phase === "STARTING") return rejected(state, "GAME_NOT_STARTED");
  if (state.phase === "GAME_OVER") return rejected(state, "GAME_ALREADY_ENDED");
  const turn = state.turn;
  if (turn === null) return rejected(state, "GAME_NOT_STARTED");
  if (turn.activePlayerId !== actorUserId) return rejected(state, "NOT_YOUR_TURN");
  if (state.pendingResolution !== null) return rejected(state, "PENDING_RESOLUTION");
  if (turn.hasRolled && !turn.rollAgain) return rejected(state, "ROLL_ALREADY_COMPLETED");

  const playerIndex = state.players.findIndex((player) => player.userId === actorUserId);
  const player = state.players[playerIndex];
  if (player === undefined) return rejected(state, "ACTOR_NOT_IN_GAME");
  if (player.status !== "ACTIVE") return rejected(state, "PLAYER_NOT_ELIGIBLE");

  const roll = rollDice(rng, turn.consecutiveDoubles);
  const movement = calculateMovement(board, player.position, roll.total);
  const resolution = dispatchLandedTile(board, movement.to);
  const nextCash = player.cash + movement.startAward;
  if (!Number.isSafeInteger(nextCash)) {
    throw new RangeError("Start award would move player cash outside the safe integer range");
  }

  let players = state.players.map((candidate, index) =>
    index === playerIndex
      ? { ...candidate, position: movement.to, cash: nextCash }
      : candidate,
  );
  let pendingResolution = pendingForLanding(
    state, turn, actorUserId, roll, resolution, nextGameVersion,
  );
  if (
    resolution.kind === "PROPERTY"
    || resolution.kind === "TRANSIT"
    || resolution.kind === "UTILITY"
  ) {
    const asset = state.assets.find((candidate) => candidate.tileIndex === resolution.tileIndex);
    if (asset === undefined) throw new RangeError("landed ownable has no canonical asset");
    if (asset.ownerUserId === actorUserId || asset.mortgaged) {
      pendingResolution = null;
    } else if (asset.ownerUserId !== null) {
      const charge = applyCharge(
        players,
        turn,
        actorUserId,
        rentForAsset(state, board, asset, roll.total),
        asset.ownerUserId,
        roll,
        resolution.tileIndex,
        nextGameVersion,
      );
      players = charge.players.slice();
      pendingResolution = charge.pendingResolution;
    }
  } else if (resolution.kind === "TAX") {
    const charge = applyCharge(
      players,
      turn,
      actorUserId,
      resolution.amount,
      null,
      roll,
      resolution.tileIndex,
      nextGameVersion,
    );
    players = charge.players.slice();
    pendingResolution = charge.pendingResolution;
  }
  const nextState = acceptedState(state, board, nextGameVersion, {
    players,
    turn: {
      ...turn,
      hasRolled: true,
      rollAgain: roll.doubles,
      consecutiveDoubles: roll.consecutiveDoubles,
    },
    pendingResolution,
  });

  return Object.freeze({
    kind: "ACCEPTED",
    state: nextState,
    event: Object.freeze({
      type: "DICE_ROLLED",
      playerId: actorUserId,
      roll,
      movement,
      resolution,
    }),
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

function buyProperty(
  state: GameState,
  board: BoardDefinition,
  command: GameCommand,
  actorUserId: string,
  nextGameVersion: number,
): GameplayCommandResult {
  const payload = payloadObject(command, ["resolutionId"]);
  const resolutionId = payloadIdentifier(payload.resolutionId, "payload.resolutionId");
  const pending = pendingDecision(state, actorUserId, resolutionId);
  if (pending?.kind !== "BUY_DECISION" || pending.source.type !== "TILE") {
    return rejected(state, "RESOLUTION_NOT_PENDING");
  }
  const tileIndex = pending.source.tileIndex;
  const assetIndex = state.assets.findIndex((asset) => asset.tileIndex === tileIndex);
  const asset = state.assets[assetIndex];
  if (asset === undefined) return rejected(state, "RESOLUTION_NOT_PENDING");
  if (asset.ownerUserId !== null) return rejected(state, "ASSET_ALREADY_OWNED");
  const playerIndex = state.players.findIndex((player) => player.userId === actorUserId);
  const player = state.players[playerIndex];
  if (player === undefined) return rejected(state, "ACTOR_NOT_IN_GAME");
  const price = purchasePrice(board, asset);
  if (player.cash < price) return rejected(state, "INSUFFICIENT_FUNDS");
  const players = state.players.map((candidate, index) => index === playerIndex
    ? { ...candidate, cash: candidate.cash - price }
    : candidate);
  const assets = state.assets.map((candidate, index) => index === assetIndex
    ? { ...candidate, ownerUserId: actorUserId }
    : candidate);
  const nextState = acceptedState(state, board, nextGameVersion, {
    players,
    assets,
    pendingResolution: null,
  });
  return Object.freeze({
    kind: "ACCEPTED",
    state: nextState,
    event: Object.freeze({ type: "PROPERTY_BOUGHT", playerId: actorUserId, assetId: asset.assetId, price }),
  });
}

function declineProperty(
  state: GameState,
  board: BoardDefinition,
  command: GameCommand,
  actorUserId: string,
  nextGameVersion: number,
  auctionDecisionDeadlineAt: number | undefined,
): GameplayCommandResult {
  const payload = payloadObject(command, ["resolutionId"]);
  const resolutionId = payloadIdentifier(payload.resolutionId, "payload.resolutionId");
  const pending = pendingDecision(state, actorUserId, resolutionId);
  if (pending?.kind !== "BUY_DECISION" || pending.source.type !== "TILE") {
    return rejected(state, "RESOLUTION_NOT_PENDING");
  }
  const tileIndex = pending.source.tileIndex;
  const asset = state.assets.find((candidate) => candidate.tileIndex === tileIndex);
  if (asset === undefined || asset.ownerUserId !== null) {
    return rejected(state, asset === undefined ? "RESOLUTION_NOT_PENDING" : "ASSET_ALREADY_OWNED");
  }
  const deadline = authoritativeInteger(
    auctionDecisionDeadlineAt, "context.auctionDecisionDeadlineAt",
  );
  const eligiblePlayers = state.players.filter((player) => player.status === "ACTIVE");
  const decliningIndex = eligiblePlayers.findIndex((player) => player.userId === actorUserId);
  const participantOrder = Array.from(
    { length: eligiblePlayers.length },
    (_, offset) => eligiblePlayers[(decliningIndex + offset + 1) % eligiblePlayers.length]!.userId,
  );
  const currentActorUserId = participantOrder[0]!;
  const fact = auctionFact(
    "STARTED", pending.resolutionId, asset.assetId, actorUserId, null,
    nextGameVersion, command.actionId,
  );
  const auction: AuctionState = {
    auctionId: pending.resolutionId,
    assetId: asset.assetId,
    originatingPlayerId: actorUserId,
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
  const nextState = acceptedState(state, board, nextGameVersion, {
    pendingResolution: {
      ...pending,
      kind: "AUCTION",
      decisionOwnerUserId: currentActorUserId,
    },
    auction,
  });
  return Object.freeze({
    kind: "ACCEPTED",
    state: nextState,
    event: Object.freeze({
      type: "PROPERTY_DECLINED",
      playerId: actorUserId,
      assetId: asset.assetId,
      auction: nextState.auction!,
      facts: nextState.auction!.history,
    }),
  });
}

function authoritativeInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new CommandValidationError(field, "expected a non-negative safe integer");
  }
  return value as number;
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
  board: BoardDefinition,
  command: GameCommand,
  nextGameVersion: number,
  pending: PendingResolution,
  changedAuction: AuctionState,
  action: "BID" | "PASS" | "AUTO_PASS",
  nextDecisionDeadlineAt: number | undefined,
): GameplayCommandResult {
  const remaining = changedAuction.participantOrder.filter(
    (playerId) => !changedAuction.passedPlayerIds.includes(playerId),
  );
  const assetIndex = state.assets.findIndex(
    (candidate) => candidate.assetId === changedAuction.assetId,
  );
  const asset = state.assets[assetIndex];
  if (asset === undefined || asset.ownerUserId !== null) return rejected(state, "AUCTION_NOT_ACTIVE");

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
      finalPrice, nextGameVersion, command.actionId,
    );
    const facts = [changedAuction.history.at(-1)!, finalFact];
    const nextState = acceptedState(state, board, nextGameVersion, {
      players: state.players.map((player, index) => index === winnerIndex
        ? { ...player, cash: player.cash - finalPrice }
        : player),
      assets: state.assets.map((candidate, index) => index === assetIndex
        ? { ...candidate, ownerUserId: winnerUserId }
        : candidate),
      pendingResolution: null,
      auction: null,
    });
    return Object.freeze({
      kind: "ACCEPTED",
      state: nextState,
      event: Object.freeze({
        type: "AUCTION_UPDATED",
        action,
        auctionId: changedAuction.auctionId,
        assetId: changedAuction.assetId,
        auction: null,
        facts: Object.freeze(facts),
      }),
    });
  }

  if (!changedAuction.hasBid && remaining.length === 0) {
    const finalFact = auctionFact(
      "NO_BID", changedAuction.auctionId, changedAuction.assetId, null, null,
      nextGameVersion, command.actionId,
    );
    const facts = [changedAuction.history.at(-1)!, finalFact];
    const nextState = acceptedState(state, board, nextGameVersion, {
      pendingResolution: null,
      auction: null,
    });
    return Object.freeze({
      kind: "ACCEPTED",
      state: nextState,
      event: Object.freeze({
        type: "AUCTION_UPDATED",
        action,
        auctionId: changedAuction.auctionId,
        assetId: changedAuction.assetId,
        auction: null,
        facts: Object.freeze(facts),
      }),
    });
  }

  const currentActorUserId = nextAuctionActor(
    changedAuction,
    changedAuction.passedPlayerIds,
    changedAuction.highBidderUserId,
  );
  const nextAuction: AuctionState = {
    ...changedAuction,
    currentActorUserId,
    decisionDeadlineAt: authoritativeInteger(
      nextDecisionDeadlineAt, "context.auctionDecisionDeadlineAt",
    ),
  };
  const nextState = acceptedState(state, board, nextGameVersion, {
    pendingResolution: { ...pending, decisionOwnerUserId: currentActorUserId },
    auction: nextAuction,
  });
  return Object.freeze({
    kind: "ACCEPTED",
    state: nextState,
    event: Object.freeze({
      type: "AUCTION_UPDATED",
      action,
      auctionId: changedAuction.auctionId,
      assetId: changedAuction.assetId,
      auction: nextState.auction,
      facts: Object.freeze([nextState.auction!.history.at(-1)!]),
    }),
  });
}

function placeBid(
  state: GameState,
  board: BoardDefinition,
  command: GameCommand,
  actorUserId: string,
  nextGameVersion: number,
  nextDecisionDeadlineAt: number | undefined,
): GameplayCommandResult {
  const payload = payloadObject(command, ["auctionId", "amount"]);
  const auctionId = payloadIdentifier(payload.auctionId, "payload.auctionId");
  if (!Number.isSafeInteger(payload.amount)) {
    throw new CommandValidationError("payload.amount", "expected a safe integer");
  }
  const amount = payload.amount as number;
  const active = currentAuction(state, auctionId);
  if (active === null) return rejected(state, "AUCTION_NOT_ACTIVE");
  const { auction, pending } = active;
  if (auction.currentActorUserId !== actorUserId) return rejected(state, "NOT_AUCTION_ACTOR");
  const minimum = auction.highBid === null ? 2 : auction.highBid + 2;
  if (!Number.isSafeInteger(minimum)) throw new RangeError("auction minimum exceeds safe integer range");
  if (amount < minimum) return rejected(state, "BID_TOO_LOW");
  const bidder = state.players.find((player) => player.userId === actorUserId);
  if (bidder === undefined || bidder.status !== "ACTIVE") return rejected(state, "PLAYER_NOT_ELIGIBLE");
  if (amount > bidder.cash) return rejected(state, "BID_EXCEEDS_CASH");
  const fact = auctionFact(
    "BID", auction.auctionId, auction.assetId, actorUserId, amount,
    nextGameVersion, command.actionId,
  );
  return auctionTransition(
    state,
    board,
    command,
    nextGameVersion,
    pending,
    {
      ...auction,
      hasBid: true,
      highBid: amount,
      highBidderUserId: actorUserId,
      history: [...auction.history, fact],
    },
    "BID",
    nextDecisionDeadlineAt,
  );
}

function passAuction(
  state: GameState,
  board: BoardDefinition,
  command: GameCommand,
  actorUserId: string,
  nextGameVersion: number,
  nextDecisionDeadlineAt: number | undefined,
  autoPass: boolean,
): GameplayCommandResult {
  const keys = autoPass
    ? ["auctionId", "actorUserId", "decisionDeadlineAt"]
    : ["auctionId"];
  const payload = payloadObject(command, keys);
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
  } else if (auction.currentActorUserId !== actorUserId) {
    return rejected(state, "NOT_AUCTION_ACTOR");
  }
  const passingPlayerId = auction.currentActorUserId;
  const fact = auctionFact(
    autoPass ? "AUTO_PASS" : "PASS",
    auction.auctionId,
    auction.assetId,
    passingPlayerId,
    null,
    nextGameVersion,
    command.actionId,
  );
  return auctionTransition(
    state,
    board,
    command,
    nextGameVersion,
    pending,
    {
      ...auction,
      passedPlayerIds: [...auction.passedPlayerIds, passingPlayerId],
      history: [...auction.history, fact],
    },
    autoPass ? "AUTO_PASS" : "PASS",
    nextDecisionDeadlineAt,
  );
}

function timeoutAuction(
  state: GameState,
  board: BoardDefinition,
  command: GameCommand,
  nextGameVersion: number,
  currentTime: number | undefined,
  nextDecisionDeadlineAt: number | undefined,
): GameplayCommandResult {
  const now = authoritativeInteger(currentTime, "context.currentTime");
  const payload = payloadObject(command, ["auctionId", "actorUserId", "decisionDeadlineAt"]);
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
  return passAuction(
    state,
    board,
    command,
    active.auction.currentActorUserId,
    nextGameVersion,
    nextDecisionDeadlineAt,
    true,
  );
}

function ownedAssetAction(
  state: GameState,
  command: GameCommand,
  actorUserId: string,
): Readonly<{ asset: AssetState; assetIndex: number }> | GameplayCommandResult {
  const payload = payloadObject(command, ["assetId"]);
  const assetId = payloadIdentifier(payload.assetId, "payload.assetId");
  const turn = state.turn;
  if (turn === null || turn.activePlayerId !== actorUserId) return rejected(state, "NOT_YOUR_TURN");
  if (state.pendingResolution !== null) return rejected(state, "PENDING_RESOLUTION");
  const assetIndex = state.assets.findIndex((candidate) => candidate.assetId === assetId);
  const asset = state.assets[assetIndex];
  if (asset === undefined || asset.ownerUserId !== actorUserId) return rejected(state, "ASSET_NOT_OWNED");
  return { asset, assetIndex };
}

function build(
  state: GameState,
  board: BoardDefinition,
  command: GameCommand,
  actorUserId: string,
  nextGameVersion: number,
): GameplayCommandResult {
  const selected = ownedAssetAction(state, command, actorUserId);
  if ("kind" in selected) return selected;
  const { asset, assetIndex } = selected;
  if (asset.kind !== "PROPERTY") return rejected(state, "ASSET_NOT_DEVELOPABLE");
  const turn = state.turn;
  if (turn === null) return rejected(state, "NOT_YOUR_TURN");
  const playerIndex = state.players.findIndex((player) => player.userId === actorUserId);
  const player = state.players[playerIndex];
  if (player === undefined) return rejected(state, "ACTOR_NOT_IN_GAME");
  if (player.inHolding) return rejected(state, "PLAYER_IN_HOLDING");
  if (turn.developmentActionsUsed >= 2) return rejected(state, "DEVELOPMENT_LIMIT_REACHED");
  const setAssets = propertySetAssets(state, board, asset);
  if (!setAssets.every((candidate) => candidate.ownerUserId === actorUserId)) {
    return rejected(state, "INCOMPLETE_SET");
  }
  if (setAssets.some((candidate) => candidate.mortgaged)) return rejected(state, "SET_MORTGAGED");
  if (asset.developmentLevel >= 4) return rejected(state, "ASSET_NOT_DEVELOPABLE");
  const minimumLevel = Math.min(...setAssets.map((candidate) => candidate.developmentLevel));
  if (asset.developmentLevel !== minimumLevel) return rejected(state, "UNEVEN_BUILD");
  const property = propertyForAsset(board, asset);
  if (property === null) return rejected(state, "ASSET_NOT_DEVELOPABLE");
  if (player.cash < property.buildingCost) return rejected(state, "INSUFFICIENT_FUNDS");
  const nextLevel = asset.developmentLevel + 1;
  const nextState = acceptedState(state, board, nextGameVersion, {
    players: state.players.map((candidate, index) => index === playerIndex
      ? { ...candidate, cash: candidate.cash - property.buildingCost }
      : candidate),
    assets: state.assets.map((candidate, index) => index === assetIndex
      ? { ...asset, developmentLevel: nextLevel }
      : candidate),
    turn: { ...turn, developmentActionsUsed: turn.developmentActionsUsed + 1 },
  });
  return Object.freeze({
    kind: "ACCEPTED",
    state: nextState,
    event: Object.freeze({
      type: "DEVELOPMENT_BOUGHT",
      playerId: actorUserId,
      assetId: asset.assetId,
      level: nextLevel,
      price: property.buildingCost,
    }),
  });
}

function changeMortgage(
  state: GameState,
  board: BoardDefinition,
  command: GameCommand,
  actorUserId: string,
  nextGameVersion: number,
  mortgage: boolean,
): GameplayCommandResult {
  const selected = ownedAssetAction(state, command, actorUserId);
  if ("kind" in selected) return selected;
  const { asset, assetIndex } = selected;
  if (mortgage && asset.mortgaged) return rejected(state, "ALREADY_MORTGAGED");
  if (!mortgage && !asset.mortgaged) return rejected(state, "NOT_MORTGAGED");
  if (mortgage && asset.kind === "PROPERTY") {
    const setAssets = propertySetAssets(state, board, asset);
    if (setAssets.some((candidate) => candidate.developmentLevel > 0)) {
      return rejected(state, "SET_HAS_DEVELOPMENT");
    }
  }
  const playerIndex = state.players.findIndex((player) => player.userId === actorUserId);
  const player = state.players[playerIndex];
  if (player === undefined) return rejected(state, "ACTOR_NOT_IN_GAME");
  const amount = mortgage ? mortgageValue(board, asset) : unmortgageCost(board, asset);
  if (!mortgage && player.cash < amount) return rejected(state, "INSUFFICIENT_FUNDS");
  const nextCash = mortgage ? player.cash + amount : player.cash - amount;
  if (!Number.isSafeInteger(nextCash)) throw new RangeError("mortgage cash exceeds safe integer range");
  const nextState = acceptedState(state, board, nextGameVersion, {
    players: state.players.map((candidate, index) => index === playerIndex
      ? { ...candidate, cash: nextCash }
      : candidate),
    assets: state.assets.map((candidate, index) => index === assetIndex
      ? { ...candidate, mortgaged: mortgage }
      : candidate),
  });
  return Object.freeze({
    kind: "ACCEPTED",
    state: nextState,
    event: Object.freeze({
      type: mortgage ? "ASSET_MORTGAGED" : "ASSET_UNMORTGAGED",
      playerId: actorUserId,
      assetId: asset.assetId,
      amount,
    }),
  });
}

function endCurrentTurn(
  state: GameState,
  board: BoardDefinition,
  actorUserId: string,
  nextGameVersion: number,
): GameplayCommandResult {
  if (state.phase === "STARTING") return rejected(state, "GAME_NOT_STARTED");
  if (state.phase === "GAME_OVER") return rejected(state, "GAME_ALREADY_ENDED");
  const turn = state.turn;
  if (turn === null) return rejected(state, "GAME_NOT_STARTED");
  if (turn.activePlayerId !== actorUserId) return rejected(state, "NOT_YOUR_TURN");
  if (state.pendingResolution !== null) return rejected(state, "PENDING_RESOLUTION");
  if (!turn.hasRolled) return rejected(state, "ROLL_REQUIRED");
  if (turn.rollAgain) return rejected(state, "ROLL_REQUIRED");

  const eligiblePlayers = state.players.filter((player) => player.status === "ACTIVE");
  if (eligiblePlayers.length <= 1) {
    const winnerUserId = eligiblePlayers[0]?.userId ?? null;
    const nextState = acceptedState(state, board, nextGameVersion, {
      phase: "GAME_OVER",
      turn: null,
    });
    return Object.freeze({
      kind: "ACCEPTED",
      state: nextState,
      event: Object.freeze({
        type: "GAME_ENDED",
        endedPlayerId: actorUserId,
        winnerUserId,
      }),
    });
  }

  const currentIndex = state.players.findIndex((player) => player.userId === actorUserId);
  for (let offset = 1; offset <= state.players.length; offset += 1) {
    const candidate = state.players[(currentIndex + offset) % state.players.length];
    if (candidate?.status !== "ACTIVE") continue;

    const nextState = acceptedState(state, board, nextGameVersion, {
      turn: nextTurn(turn.turnNumber + 1, candidate.userId),
    });
    return Object.freeze({
      kind: "ACCEPTED",
      state: nextState,
      event: Object.freeze({
        type: "TURN_ENDED",
        endedPlayerId: actorUserId,
        activePlayerId: candidate.userId,
      }),
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
  const state = parseGameState(stateInput, board);
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
      switch (type) {
        case "CONFIGURE_MATCH":
          return configureMatch(state, board, command, actorUserId, decision.nextGameVersion);
        case "START_GAME":
          return startGame(state, board, actorUserId, decision.nextGameVersion);
        case "ROLL_DICE":
          return rollCurrentPlayer(
            state,
            board,
            actorUserId,
            context.rng,
            decision.nextGameVersion,
          );
        case "END_TURN":
          return endCurrentTurn(state, board, actorUserId, decision.nextGameVersion);
        case "BUY_PROPERTY":
          return buyProperty(state, board, command, actorUserId, decision.nextGameVersion);
        case "DECLINE_PROPERTY":
          return declineProperty(
            state,
            board,
            command,
            actorUserId,
            decision.nextGameVersion,
            context.auctionDecisionDeadlineAt,
          );
        case "PLACE_BID":
          return placeBid(
            state,
            board,
            command,
            actorUserId,
            decision.nextGameVersion,
            context.auctionDecisionDeadlineAt,
          );
        case "PASS_AUCTION":
          return passAuction(
            state,
            board,
            command,
            actorUserId,
            decision.nextGameVersion,
            context.auctionDecisionDeadlineAt,
            false,
          );
        case "AUCTION_TIMEOUT":
          return timeoutAuction(
            state,
            board,
            command,
            decision.nextGameVersion,
            context.currentTime,
            context.auctionDecisionDeadlineAt,
          );
        case "BUILD":
          return build(state, board, command, actorUserId, decision.nextGameVersion);
        case "MORTGAGE":
          return changeMortgage(
            state, board, command, actorUserId, decision.nextGameVersion, true,
          );
        case "UNMORTGAGE":
          return changeMortgage(
            state, board, command, actorUserId, decision.nextGameVersion, false,
          );
      }
  }
}
