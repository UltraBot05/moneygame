import { parseBoardDefinition, type BoardDefinition } from "./board";
import type { DiceRoll } from "./dice";
import { validStartingCash } from "./economy";
import { assertLobbyCanStart } from "./lobby";

export type PlayerStatus = "ACTIVE" | "BANKRUPT";
export type GamePhase = "STARTING" | "ACTIVE_TURN" | "GAME_OVER";
export type MatchMode = "FFA" | "TEAMS";
export type WinMode = "LAST_STANDING";

export interface MatchSettings {
  readonly matchMode: MatchMode;
  readonly winMode: WinMode;
  readonly startingCash: number;
  readonly pacing: "CORE";
}

export interface GameBoardIdentity {
  readonly ref: string;
  readonly boardId: string;
  readonly boardVersion: number;
  readonly tileCount: number;
}

export interface PlayerState {
  readonly userId: string;
  readonly seatIndex: number;
  readonly cash: number;
  readonly position: number;
  readonly status: PlayerStatus;
  readonly inHolding: boolean;
}

export type AssetState =
  | {
      readonly kind: "PROPERTY";
      readonly assetId: string;
      readonly tileIndex: number;
      readonly ownerUserId: string | null;
      readonly mortgaged: boolean;
      readonly developmentLevel: number;
    }
  | {
      readonly kind: "TRANSIT" | "UTILITY";
      readonly assetId: string;
      readonly tileIndex: number;
      readonly ownerUserId: string | null;
      readonly mortgaged: boolean;
    };

export type ResolutionKind =
  | "BUY_DECISION" | "AUCTION" | "RENT" | "TAX" | "CARD"
  | "DETENTION_FEE" | "DEBT";

export type ResolutionSource =
  | { readonly type: "TILE"; readonly tileIndex: number }
  | { readonly type: "EFFECT"; readonly effectId: string; readonly originTileIndex: number };

export type ResolutionContinuation =
  | { readonly type: "END_TURN" }
  | { readonly type: "ROLL_AGAIN" }
  | { readonly type: "RESUME_EFFECT"; readonly effectId: string };

export type ObligationCreditor =
  | { readonly type: "BANK" }
  | { readonly type: "PLAYER"; readonly userId: string };

export interface MonetaryObligation {
  readonly debtorUserId: string;
  readonly creditor: ObligationCreditor;
  readonly amount: number;
  readonly continuation: ResolutionContinuation;
}

export interface PendingResolution {
  readonly resolutionId: string;
  readonly kind: ResolutionKind;
  readonly actorUserId: string;
  readonly decisionOwnerUserId: string;
  readonly source: ResolutionSource;
  readonly continuation: ResolutionContinuation;
  readonly roll: DiceRoll | null;
  readonly obligation: MonetaryObligation | null;
}

export type AuctionFactType = "STARTED" | "BID" | "PASS" | "AUTO_PASS" | "WINNER" | "NO_BID";

export interface AuctionFact {
  readonly type: AuctionFactType;
  readonly auctionId: string;
  readonly assetId: string;
  readonly actorUserId: string | null;
  readonly amount: number | null;
  readonly gameVersion: number;
  readonly actionId: string;
}

export interface AuctionState {
  readonly auctionId: string;
  readonly assetId: string;
  readonly originatingPlayerId: string;
  readonly continuation: ResolutionContinuation;
  readonly participantOrder: readonly string[];
  readonly passedPlayerIds: readonly string[];
  readonly currentActorUserId: string;
  readonly highBid: number | null;
  readonly highBidderUserId: string | null;
  readonly hasBid: boolean;
  readonly decisionDeadlineAt: number;
  readonly history: readonly AuctionFact[];
}

export interface TurnIdentity {
  readonly turnId: string;
  readonly activePlayerId: string;
  readonly turnNumber: number;
  readonly hasRolled: boolean;
  readonly rollAgain: boolean;
  readonly consecutiveDoubles: number;
  readonly developmentActionsUsed: number;
}

export interface GameState {
  readonly gameId: string;
  readonly gameVersion: number;
  readonly board: GameBoardIdentity;
  readonly settings: MatchSettings;
  readonly phase: GamePhase;
  readonly turn: TurnIdentity | null;
  readonly players: readonly PlayerState[];
  readonly assets: readonly AssetState[];
  readonly pendingResolution: PendingResolution | null;
  readonly auction: AuctionState | null;
}

export interface CreateInitialGameStateInput {
  readonly gameId: string;
  readonly board: BoardDefinition;
  readonly playerIds: readonly string[];
  readonly startingCash?: number;
  readonly matchMode?: MatchMode;
  readonly winMode?: WinMode;
}

export class GameStateValidationError extends Error {
  constructor(readonly path: string, message: string) {
    super(path + ": " + message);
    this.name = "GameStateValidationError";
  }
}

function fail(path: string, message: string): never {
  throw new GameStateValidationError(path, message);
}

function objectAt(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail(path, "expected an object");
  }
  return value as Record<string, unknown>;
}

function arrayAt(value: unknown, path: string): readonly unknown[] {
  if (!Array.isArray(value)) fail(path, "expected an array");
  return value;
}

function exactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  path: string,
): void {
  const expectedSet = new Set(expected);
  for (const key of Object.keys(value)) {
    if (!expectedSet.has(key)) fail(path + "." + key, "unexpected field");
  }
  for (const key of expected) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) fail(path + "." + key, "missing field");
  }
}

function identifierAt(value: unknown, path: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    fail(path, "expected a non-empty string");
  }
  return value;
}

function integerAt(value: unknown, path: string, minimum = 0, maximum?: number): number {
  if (
    !Number.isSafeInteger(value)
    || (value as number) < minimum
    || (maximum !== undefined && (value as number) > maximum)
  ) {
    fail(
      path,
      "expected a safe integer from " + minimum + (maximum === undefined ? "" : " to " + maximum),
    );
  }
  return value as number;
}

function parseBoardIdentity(value: unknown, board: BoardDefinition): GameBoardIdentity {
  const object = objectAt(value, "$.board");
  exactKeys(object, ["ref", "boardId", "boardVersion", "tileCount"], "$.board");
  const identity: GameBoardIdentity = {
    ref: identifierAt(object.ref, "$.board.ref"),
    boardId: identifierAt(object.boardId, "$.board.boardId"),
    boardVersion: integerAt(object.boardVersion, "$.board.boardVersion", 1),
    tileCount: integerAt(object.tileCount, "$.board.tileCount", 1),
  };
  if (
    identity.ref !== board.ref
    || identity.boardId !== board.boardId
    || identity.boardVersion !== board.boardVersion
    || identity.tileCount !== board.tileCount
  ) {
    fail("$.board", "identity does not match the supplied board");
  }
  return identity;
}

function parsePlayer(value: unknown, index: number, tileCount: number): PlayerState {
  const path = "$.players[" + index + "]";
  const object = objectAt(value, path);
  exactKeys(object, ["userId", "seatIndex", "cash", "position", "status", "inHolding"], path);
  const seatIndex = integerAt(object.seatIndex, path + ".seatIndex");
  if (seatIndex !== index) fail(path + ".seatIndex", "must match ordered seat position");
  const status =
    object.status === "ACTIVE" || object.status === "BANKRUPT"
      ? object.status
      : fail(path + ".status", "expected ACTIVE or BANKRUPT");
  if (object.inHolding !== true && object.inHolding !== false) {
    fail(path + ".inHolding", "expected a boolean");
  }
  return {
    userId: identifierAt(object.userId, path + ".userId"),
    seatIndex,
    cash: integerAt(object.cash, path + ".cash"),
    position: integerAt(object.position, path + ".position", 0, tileCount - 1),
    status,
    inHolding: object.inHolding,
  };
}

function parseSettings(value: unknown): MatchSettings {
  const path = "$.settings";
  const object = objectAt(value, path);
  exactKeys(object, ["matchMode", "winMode", "startingCash", "pacing"], path);
  const matchMode = object.matchMode === "FFA" || object.matchMode === "TEAMS"
    ? object.matchMode
    : fail(path + ".matchMode", "expected FFA or TEAMS");
  const winMode = object.winMode === "LAST_STANDING"
    ? object.winMode
    : fail(path + ".winMode", "expected LAST_STANDING");
  const startingCash = integerAt(object.startingCash, path + ".startingCash");
  if (!validStartingCash(startingCash)) {
    fail(path + ".startingCash", "must be an integer from 1500 through 2500");
  }
  if (object.pacing !== "CORE") fail(path + ".pacing", "expected CORE");
  return { matchMode, winMode, startingCash, pacing: object.pacing };
}

function ownableTiles(board: BoardDefinition) {
  return board.economyProfile.tiles.filter(
    (tile) => tile.type === "property" || tile.type === "transit" || tile.type === "utility",
  );
}

function assetIdentity(tile: ReturnType<typeof ownableTiles>[number]): string {
  return tile.type === "property" ? "property:" + tile.propertyId : tile.type + ":" + tile.index;
}

function parseAsset(value: unknown, index: number, board: BoardDefinition): AssetState {
  const path = "$.assets[" + index + "]";
  const object = objectAt(value, path);
  const kind = object.kind;
  if (kind !== "PROPERTY" && kind !== "TRANSIT" && kind !== "UTILITY") {
    fail(path + ".kind", "unknown ownable kind");
  }
  const expected = kind === "PROPERTY"
    ? ["kind", "assetId", "tileIndex", "ownerUserId", "mortgaged", "developmentLevel"]
    : ["kind", "assetId", "tileIndex", "ownerUserId", "mortgaged"];
  exactKeys(object, expected, path);
  const tileIndex = integerAt(object.tileIndex, path + ".tileIndex", 0, board.tileCount - 1);
  const tile = board.economyProfile.tiles[tileIndex];
  const assetId = identifierAt(object.assetId, path + ".assetId");
  if (
    tile === undefined
    || (tile.type !== "property" && tile.type !== "transit" && tile.type !== "utility")
    || kind !== tile.type.toUpperCase()
    || assetId !== assetIdentity(tile)
  ) {
    fail(path, "asset identity does not match its board tile");
  }
  const ownerUserId = object.ownerUserId === null
    ? null
    : identifierAt(object.ownerUserId, path + ".ownerUserId");
  if (object.mortgaged !== true && object.mortgaged !== false) {
    fail(path + ".mortgaged", "expected a boolean");
  }
  if (ownerUserId === null && object.mortgaged) {
    fail(path, "an unowned asset cannot be mortgaged");
  }
  if (kind === "PROPERTY") {
    const developmentLevel = integerAt(object.developmentLevel, path + ".developmentLevel", 0, 4);
    if (ownerUserId === null && developmentLevel !== 0) {
      fail(path, "an unowned property cannot be developed");
    }
    if (object.mortgaged && developmentLevel !== 0) {
      fail(path, "a mortgaged property cannot have development");
    }
    return { kind, assetId, tileIndex, ownerUserId, mortgaged: object.mortgaged, developmentLevel };
  }
  return { kind, assetId, tileIndex, ownerUserId, mortgaged: object.mortgaged };
}

function parseTurn(value: unknown, playerIds: ReadonlySet<string>): TurnIdentity | null {
  if (value === null) return null;
  const object = objectAt(value, "$.turn");
  exactKeys(
    object,
    ["turnId", "activePlayerId", "turnNumber", "hasRolled", "rollAgain", "consecutiveDoubles",
      "developmentActionsUsed"],
    "$.turn",
  );
  if (object.hasRolled !== true && object.hasRolled !== false) {
    fail("$.turn.hasRolled", "expected a boolean");
  }
  if (object.rollAgain !== true && object.rollAgain !== false) {
    fail("$.turn.rollAgain", "expected a boolean");
  }
  const consecutiveDoubles = integerAt(
    object.consecutiveDoubles,
    "$.turn.consecutiveDoubles",
  );
  const developmentActionsUsed = integerAt(
    object.developmentActionsUsed,
    "$.turn.developmentActionsUsed",
    0,
    2,
  );
  if (!object.hasRolled && (object.rollAgain || consecutiveDoubles !== 0)) {
    fail("$.turn", "a turn cannot continue before its first roll");
  }
  if (object.rollAgain !== (consecutiveDoubles > 0)) {
    fail("$.turn", "rollAgain must match the consecutive doubles count");
  }
  const turn = {
    turnId: identifierAt(object.turnId, "$.turn.turnId"),
    activePlayerId: identifierAt(object.activePlayerId, "$.turn.activePlayerId"),
    turnNumber: integerAt(object.turnNumber, "$.turn.turnNumber", 1),
    hasRolled: object.hasRolled,
    rollAgain: object.rollAgain,
    consecutiveDoubles,
    developmentActionsUsed,
  };
  if (!playerIds.has(turn.activePlayerId)) {
    fail("$.turn.activePlayerId", "must identify a player in this game");
  }
  return turn;
}

function parseContinuation(value: unknown, path: string): ResolutionContinuation {
  const object = objectAt(value, path);
  if (object.type === "END_TURN") {
    exactKeys(object, ["type"], path);
    return { type: "END_TURN" };
  }
  if (object.type === "ROLL_AGAIN") {
    exactKeys(object, ["type"], path);
    return { type: "ROLL_AGAIN" };
  }
  if (object.type === "RESUME_EFFECT") {
    exactKeys(object, ["type", "effectId"], path);
    return { type: "RESUME_EFFECT", effectId: identifierAt(object.effectId, path + ".effectId") };
  }
  return fail(path + ".type", "unknown continuation");
}

function sameContinuation(left: ResolutionContinuation, right: ResolutionContinuation): boolean {
  return left.type === right.type
    && (left.type !== "RESUME_EFFECT"
      || (right.type === "RESUME_EFFECT" && left.effectId === right.effectId));
}

function parseRoll(value: unknown, path: string): DiceRoll | null {
  if (value === null) return null;
  const object = objectAt(value, path);
  exactKeys(
    object,
    ["dice", "total", "doubles", "consecutiveDoubles", "isThirdConsecutiveDouble"],
    path,
  );
  const dice = arrayAt(object.dice, path + ".dice");
  if (dice.length !== 2) fail(path + ".dice", "expected two dice");
  const first = integerAt(dice[0], path + ".dice[0]", 1, 6);
  const second = integerAt(dice[1], path + ".dice[1]", 1, 6);
  const total = integerAt(object.total, path + ".total", 2, 12);
  const consecutiveDoubles = integerAt(
    object.consecutiveDoubles, path + ".consecutiveDoubles",
  );
  if (
    total !== first + second
    || object.doubles !== (first === second)
    || (first !== second && consecutiveDoubles !== 0)
    || (first === second && consecutiveDoubles < 1)
    || object.isThirdConsecutiveDouble !== (first === second && consecutiveDoubles === 3)
  ) {
    fail(path, "inconsistent authoritative roll context");
  }
  return {
    dice: [first, second],
    total,
    doubles: first === second,
    consecutiveDoubles,
    isThirdConsecutiveDouble: first === second && consecutiveDoubles === 3,
  };
}

function parseSource(value: unknown, path: string, board: BoardDefinition): ResolutionSource {
  const object = objectAt(value, path);
  if (object.type === "TILE") {
    exactKeys(object, ["type", "tileIndex"], path);
    return {
      type: "TILE",
      tileIndex: integerAt(object.tileIndex, path + ".tileIndex", 0, board.tileCount - 1),
    };
  }
  if (object.type === "EFFECT") {
    exactKeys(object, ["type", "effectId", "originTileIndex"], path);
    const originTileIndex = integerAt(
      object.originTileIndex, path + ".originTileIndex", 0, board.tileCount - 1,
    );
    if (board.economyProfile.tiles[originTileIndex]?.type !== "card") {
      fail(path + ".originTileIndex", "effect origin must be a card tile");
    }
    return {
      type: "EFFECT",
      effectId: identifierAt(object.effectId, path + ".effectId"),
      originTileIndex,
    };
  }
  return fail(path + ".type", "unknown resolution source");
}

function parseObligation(
  value: unknown,
  path: string,
  playerIds: ReadonlySet<string>,
  actorUserId: string,
  continuation: ResolutionContinuation,
): MonetaryObligation | null {
  if (value === null) return null;
  const object = objectAt(value, path);
  exactKeys(object, ["debtorUserId", "creditor", "amount", "continuation"], path);
  const debtorUserId = identifierAt(object.debtorUserId, path + ".debtorUserId");
  if (debtorUserId !== actorUserId || !playerIds.has(debtorUserId)) {
    fail(path + ".debtorUserId", "debtor must be the responsible game player");
  }
  const creditor = objectAt(object.creditor, path + ".creditor");
  let parsedCreditor: ObligationCreditor;
  if (creditor.type === "BANK") {
    exactKeys(creditor, ["type"], path + ".creditor");
    parsedCreditor = { type: "BANK" };
  } else if (creditor.type === "PLAYER") {
    exactKeys(creditor, ["type", "userId"], path + ".creditor");
    const userId = identifierAt(creditor.userId, path + ".creditor.userId");
    if (!playerIds.has(userId)) fail(path + ".creditor.userId", "unknown creditor player");
    parsedCreditor = { type: "PLAYER", userId };
  } else {
    fail(path + ".creditor.type", "unknown creditor type");
  }
  const obligationContinuation = parseContinuation(object.continuation, path + ".continuation");
  if (!sameContinuation(continuation, obligationContinuation)) {
    fail(path + ".continuation", "must match pending continuation");
  }
  return {
    debtorUserId,
    creditor: parsedCreditor,
    amount: integerAt(object.amount, path + ".amount", 1),
    continuation: obligationContinuation,
  };
}

function parsePending(
  value: unknown,
  board: BoardDefinition,
  playerIds: ReadonlySet<string>,
  turn: TurnIdentity | null,
): PendingResolution | null {
  if (value === null) return null;
  const path = "$.pendingResolution";
  if (turn === null) fail(path, "pending resolution requires an active turn");
  const object = objectAt(value, path);
  exactKeys(
    object,
    ["resolutionId", "kind", "actorUserId", "decisionOwnerUserId", "source",
      "continuation", "roll", "obligation"],
    path,
  );
  const kind = object.kind;
  if (
    kind !== "BUY_DECISION" && kind !== "AUCTION" && kind !== "RENT" && kind !== "TAX"
    && kind !== "CARD" && kind !== "DETENTION_FEE" && kind !== "DEBT"
  ) {
    fail(path + ".kind", "unknown resolution kind");
  }
  const actorUserId = identifierAt(object.actorUserId, path + ".actorUserId");
  const decisionOwnerUserId = identifierAt(
    object.decisionOwnerUserId, path + ".decisionOwnerUserId",
  );
  if (!playerIds.has(actorUserId) || !playerIds.has(decisionOwnerUserId)) {
    fail(path, "pending actor and decision owner must be game players");
  }
  if (actorUserId !== turn.activePlayerId) {
    fail(path + ".actorUserId", "responsible actor must own the current turn");
  }
  if (kind !== "AUCTION" && decisionOwnerUserId !== actorUserId) {
    fail(path + ".decisionOwnerUserId", "only an auction may hand off decision ownership");
  }
  const source = parseSource(object.source, path + ".source", board);
  const continuation = parseContinuation(object.continuation, path + ".continuation");
  if (
    source.type === "EFFECT"
    && continuation.type === "RESUME_EFFECT"
    && continuation.effectId !== source.effectId
  ) {
    fail(path + ".continuation.effectId", "must resume its source effect");
  }
  const roll = parseRoll(object.roll, path + ".roll");
  if (source.type === "TILE") {
    const tile = board.economyProfile.tiles[source.tileIndex];
    const ownable = tile?.type === "property" || tile?.type === "transit"
      || tile?.type === "utility";
    if (
      ((kind === "BUY_DECISION" || kind === "AUCTION" || kind === "RENT") && !ownable)
      || (kind === "TAX" && tile?.type !== "tax")
      || (kind === "CARD" && tile?.type !== "card")
      || (kind === "DETENTION_FEE" && tile?.type !== "corner")
    ) {
      fail(path + ".source", "resolution kind does not match its source tile");
    }
    if (
      kind !== "DEBT" && kind !== "DETENTION_FEE"
      && (roll === null || !turn.hasRolled)
    ) {
      fail(path + ".roll", "landing resolution requires authoritative roll context");
    }
  }
  const obligation = parseObligation(
    object.obligation, path + ".obligation", playerIds, actorUserId, continuation,
  );
  if (kind === "DEBT" && obligation === null) {
    fail(path + ".obligation", "DEBT requires an outstanding monetary obligation");
  }
  if (
    obligation !== null
    && (kind === "BUY_DECISION" || kind === "AUCTION")
  ) {
    fail(path + ".obligation", "purchase and auction decisions do not yet owe money");
  }
  if (continuation.type === "ROLL_AGAIN" && !turn.rollAgain) {
    fail(path + ".continuation", "ROLL_AGAIN requires canonical doubles continuation");
  }
  if (roll !== null) {
    if (roll.consecutiveDoubles !== turn.consecutiveDoubles) {
      fail(path + ".roll.consecutiveDoubles", "must match the current turn");
    }
    const expectedContinuation = turn.rollAgain ? "ROLL_AGAIN" : "END_TURN";
    if (continuation.type !== expectedContinuation) {
      fail(path + ".continuation", "must match the authoritative roll continuation");
    }
  }
  return {
    resolutionId: identifierAt(object.resolutionId, path + ".resolutionId"),
    kind,
    actorUserId,
    decisionOwnerUserId,
    source,
    continuation,
    roll,
    obligation,
  };
}

function parseAuctionFact(
  value: unknown,
  index: number,
  auctionId: string,
  assetId: string,
  playerIds: ReadonlySet<string>,
): AuctionFact {
  const path = "$.auction.history[" + index + "]";
  const object = objectAt(value, path);
  exactKeys(
    object,
    ["type", "auctionId", "assetId", "actorUserId", "amount", "gameVersion", "actionId"],
    path,
  );
  const type = object.type;
  if (
    type !== "STARTED" && type !== "BID" && type !== "PASS"
    && type !== "AUTO_PASS" && type !== "WINNER" && type !== "NO_BID"
  ) {
    fail(path + ".type", "unknown auction fact");
  }
  if (object.auctionId !== auctionId || object.assetId !== assetId) {
    fail(path, "fact identity must match its auction");
  }
  const actorUserId = object.actorUserId === null
    ? null
    : identifierAt(object.actorUserId, path + ".actorUserId");
  if (actorUserId !== null && !playerIds.has(actorUserId)) {
    fail(path + ".actorUserId", "must identify a player in this game");
  }
  const amount = object.amount === null ? null : integerAt(object.amount, path + ".amount", 2);
  if ((type === "BID" || type === "WINNER") !== (amount !== null)) {
    fail(path + ".amount", "amount is required only for bid and winner facts");
  }
  if ((type === "NO_BID") !== (actorUserId === null)) {
    fail(path + ".actorUserId", "only a no-bid fact omits its actor");
  }
  return {
    type,
    auctionId,
    assetId,
    actorUserId,
    amount,
    gameVersion: integerAt(object.gameVersion, path + ".gameVersion"),
    actionId: identifierAt(object.actionId, path + ".actionId"),
  };
}

function parseAuction(
  value: unknown,
  pendingResolution: PendingResolution | null,
  players: readonly PlayerState[],
  assets: readonly AssetState[],
  gameVersion: number,
): AuctionState | null {
  if (value === null) {
    if (pendingResolution?.kind === "AUCTION") {
      fail("$.auction", "an auction pending resolution requires canonical auction state");
    }
    return null;
  }
  const path = "$.auction";
  const object = objectAt(value, path);
  exactKeys(object, [
    "auctionId", "assetId", "originatingPlayerId", "continuation", "participantOrder",
    "passedPlayerIds", "currentActorUserId", "highBid", "highBidderUserId", "hasBid",
    "decisionDeadlineAt", "history",
  ], path);
  if (pendingResolution?.kind !== "AUCTION" || pendingResolution.source.type !== "TILE") {
    fail(path, "canonical auction state requires an auction pending resolution");
  }
  const playerIds = new Set(players.map((player) => player.userId));
  const activePlayerIds = new Set(
    players.filter((player) => player.status === "ACTIVE").map((player) => player.userId),
  );
  const auctionId = identifierAt(object.auctionId, path + ".auctionId");
  const assetId = identifierAt(object.assetId, path + ".assetId");
  const originatingPlayerId = identifierAt(
    object.originatingPlayerId, path + ".originatingPlayerId",
  );
  if (
    auctionId !== pendingResolution.resolutionId
    || originatingPlayerId !== pendingResolution.actorUserId
  ) {
    fail(path, "auction identity and origin must match the pending resolution");
  }
  const asset = assets.find((candidate) => candidate.assetId === assetId);
  if (
    asset === undefined
    || asset.tileIndex !== pendingResolution.source.tileIndex
    || asset.ownerUserId !== null
  ) {
    fail(path + ".assetId", "must identify the unowned pending auction asset");
  }
  const continuation = parseContinuation(object.continuation, path + ".continuation");
  if (!sameContinuation(continuation, pendingResolution.continuation)) {
    fail(path + ".continuation", "must match the originating continuation");
  }
  const participantOrder = arrayAt(object.participantOrder, path + ".participantOrder")
    .map((entry, index) => identifierAt(entry, path + ".participantOrder[" + index + "]"));
  if (
    participantOrder.length === 0
    || new Set(participantOrder).size !== participantOrder.length
    || participantOrder.some((playerId) => !activePlayerIds.has(playerId))
    || participantOrder.length !== activePlayerIds.size
  ) {
    fail(path + ".participantOrder", "must contain every eligible game player exactly once");
  }
  const eligibleSeatOrder = players
    .filter((player) => player.status === "ACTIVE")
    .map((player) => player.userId);
  const originIndex = eligibleSeatOrder.indexOf(originatingPlayerId);
  const expectedOrder = Array.from(
    { length: eligibleSeatOrder.length },
    (_, offset) => eligibleSeatOrder[(originIndex + offset + 1) % eligibleSeatOrder.length],
  );
  if (participantOrder.some((playerId, index) => playerId !== expectedOrder[index])) {
    fail(path + ".participantOrder", "must rotate canonically after the originating player");
  }
  const passedPlayerIds = arrayAt(object.passedPlayerIds, path + ".passedPlayerIds")
    .map((entry, index) => identifierAt(entry, path + ".passedPlayerIds[" + index + "]"));
  if (
    new Set(passedPlayerIds).size !== passedPlayerIds.length
    || passedPlayerIds.some((playerId) => !participantOrder.includes(playerId))
  ) {
    fail(path + ".passedPlayerIds", "must contain unique auction participants");
  }
  const currentActorUserId = identifierAt(
    object.currentActorUserId, path + ".currentActorUserId",
  );
  if (
    !participantOrder.includes(currentActorUserId)
    || passedPlayerIds.includes(currentActorUserId)
  ) {
    fail(path + ".currentActorUserId", "must be an unpassed auction participant");
  }
  if (pendingResolution.decisionOwnerUserId !== currentActorUserId) {
    fail(path + ".currentActorUserId", "must own the pending auction decision");
  }
  if (object.hasBid !== true && object.hasBid !== false) {
    fail(path + ".hasBid", "expected a boolean");
  }
  const hasBid = object.hasBid;
  const highBid = object.highBid === null ? null : integerAt(object.highBid, path + ".highBid", 2);
  const highBidderUserId = object.highBidderUserId === null
    ? null
    : identifierAt(object.highBidderUserId, path + ".highBidderUserId");
  if (
    hasBid !== (highBid !== null && highBidderUserId !== null)
    || (highBidderUserId !== null
      && (!participantOrder.includes(highBidderUserId) || passedPlayerIds.includes(highBidderUserId)))
  ) {
    fail(path, "high bid fields must consistently identify an unpassed participant");
  }
  if (hasBid && highBidderUserId === currentActorUserId) {
    fail(path + ".currentActorUserId", "the current actor cannot bid against their own high bid");
  }
  if (highBid !== null && highBidderUserId !== null) {
    const highBidder = players.find((player) => player.userId === highBidderUserId);
    if (highBidder === undefined || highBidder.cash < highBid) {
      fail(path + ".highBidderUserId", "active high bidder must be able to cover the high bid");
    }
  }
  const remaining = participantOrder.filter((playerId) => !passedPlayerIds.includes(playerId));
  if ((hasBid && remaining.length < 2) || (!hasBid && remaining.length < 1)) {
    fail(path, "a terminal auction must already be settled");
  }
  const history = arrayAt(object.history, path + ".history").map((fact, index) =>
    parseAuctionFact(fact, index, auctionId, assetId, playerIds),
  );
  if (history[0]?.type !== "STARTED") fail(path + ".history", "must begin with STARTED");
  if (history.at(-1)!.gameVersion > gameVersion) {
    fail(path + ".history", "fact version cannot exceed canonical gameVersion");
  }
  if (history[0]?.actorUserId !== originatingPlayerId) {
    fail(path + ".history[0].actorUserId", "must identify the originating player");
  }
  const replayPassed: string[] = [];
  let replayActor = participantOrder[0]!;
  let replayHighBid: number | null = null;
  let replayHighBidder: string | null = null;
  let previousFactVersion = history[0]!.gameVersion;
  const actionIds = new Set([history[0]!.actionId]);
  const replayNextActor = (): string => {
    const currentIndex = participantOrder.indexOf(replayActor);
    for (let offset = 1; offset <= participantOrder.length; offset += 1) {
      const candidate = participantOrder[(currentIndex + offset) % participantOrder.length]!;
      if (!replayPassed.includes(candidate) && candidate !== replayHighBidder) return candidate;
    }
    return fail(path + ".history", "nonterminal history has no next actor");
  };
  for (let index = 1; index < history.length; index += 1) {
    const fact = history[index]!;
    if (fact.gameVersion <= previousFactVersion) {
      fail(path + ".history[" + index + "].gameVersion", "must increase per accepted action");
    }
    previousFactVersion = fact.gameVersion;
    if (actionIds.has(fact.actionId)) {
      fail(path + ".history[" + index + "].actionId", "must be unique within the auction");
    }
    actionIds.add(fact.actionId);
    if (fact.actorUserId !== replayActor) {
      fail(path + ".history[" + index + "].actorUserId", "must match deterministic actor order");
    }
    if (fact.type === "BID") {
      const minimum = replayHighBid === null ? 2 : replayHighBid + 2;
      if (fact.amount === null || fact.amount < minimum) {
        fail(path + ".history[" + index + "].amount", "does not satisfy the auction minimum");
      }
      replayHighBid = fact.amount;
      replayHighBidder = replayActor;
    } else if (fact.type === "PASS" || fact.type === "AUTO_PASS") {
      replayPassed.push(replayActor);
    } else {
      fail(path + ".history[" + index + "].type", "terminal facts cannot remain active");
    }
    const replayRemaining = participantOrder.filter(
      (playerId) => !replayPassed.includes(playerId),
    );
    if (
      (replayHighBid !== null && replayRemaining.length === 1)
      || (replayHighBid === null && replayRemaining.length === 0)
    ) {
      fail(path + ".history", "terminal history must already be settled");
    }
    replayActor = replayNextActor();
  }
  if (
    replayActor !== currentActorUserId
    || replayHighBid !== highBid
    || replayHighBidder !== highBidderUserId
    || replayPassed.length !== passedPlayerIds.length
    || replayPassed.some((playerId, index) => playerId !== passedPlayerIds[index])
  ) {
    fail(path, "auction fields must match deterministic history replay");
  }
  return {
    auctionId,
    assetId,
    originatingPlayerId,
    continuation,
    participantOrder,
    passedPlayerIds,
    currentActorUserId,
    highBid,
    highBidderUserId,
    hasBid,
    decisionDeadlineAt: integerAt(object.decisionDeadlineAt, path + ".decisionDeadlineAt"),
    history,
  };
}

function freezeGameState(state: GameState): GameState {
  state.players.forEach(Object.freeze);
  state.assets.forEach(Object.freeze);
  Object.freeze(state.players);
  Object.freeze(state.assets);
  Object.freeze(state.board);
  Object.freeze(state.settings);
  if (state.turn !== null) Object.freeze(state.turn);
  if (state.pendingResolution !== null) {
    Object.freeze(state.pendingResolution.source);
    Object.freeze(state.pendingResolution.continuation);
    if (state.pendingResolution.roll !== null) {
      Object.freeze(state.pendingResolution.roll.dice);
      Object.freeze(state.pendingResolution.roll);
    }
    if (state.pendingResolution.obligation !== null) {
      Object.freeze(state.pendingResolution.obligation.creditor);
      Object.freeze(state.pendingResolution.obligation.continuation);
      Object.freeze(state.pendingResolution.obligation);
    }
    Object.freeze(state.pendingResolution);
  }
  if (state.auction !== null) {
    state.auction.history.forEach(Object.freeze);
    Object.freeze(state.auction.history);
    Object.freeze(state.auction.participantOrder);
    Object.freeze(state.auction.passedPlayerIds);
    Object.freeze(state.auction.continuation);
    Object.freeze(state.auction);
  }
  return Object.freeze(state);
}

export function parseGameState(input: unknown, boardInput: BoardDefinition): GameState {
  const board = parseBoardDefinition(boardInput);
  const root = objectAt(input, "$");
  exactKeys(
    root,
    ["gameId", "gameVersion", "board", "settings", "phase", "turn", "players", "assets",
      "pendingResolution", "auction"],
    "$",
  );
  const gameVersion = integerAt(root.gameVersion, "$.gameVersion");

  const players = arrayAt(root.players, "$.players").map((player, index) =>
    parsePlayer(player, index, board.tileCount),
  );
  if (players.length === 0 || players.length > 10) {
    fail("$.players", "expected between one and ten current players");
  }
  const playerIds = new Set<string>();
  for (const player of players) {
    if (playerIds.has(player.userId)) fail("$.players", "duplicate userId " + player.userId);
    playerIds.add(player.userId);
  }

  const assets = arrayAt(root.assets, "$.assets").map((asset, index) =>
    parseAsset(asset, index, board),
  );
  const expectedAssets = ownableTiles(board);
  if (assets.length !== expectedAssets.length) {
    fail("$.assets", "must contain every board ownable exactly once");
  }
  const seenAssetIds = new Set<string>();
  const seenTiles = new Set<number>();
  for (const [index, asset] of assets.entries()) {
    if (seenAssetIds.has(asset.assetId) || seenTiles.has(asset.tileIndex)) {
      fail("$.assets", "duplicate asset identity or tile");
    }
    seenAssetIds.add(asset.assetId);
    seenTiles.add(asset.tileIndex);
    if (asset.ownerUserId !== null && !playerIds.has(asset.ownerUserId)) {
      fail("$.assets", "owner must identify a player in this game");
    }
    if (asset.tileIndex !== expectedAssets[index]?.index) {
      fail("$.assets[" + index + "]", "assets must follow canonical board order");
    }
  }
  for (const expected of expectedAssets) {
    if (!seenTiles.has(expected.index)) {
      fail("$.assets", "missing ownable tile " + expected.index);
    }
  }

  const phase =
    root.phase === "STARTING" || root.phase === "ACTIVE_TURN" || root.phase === "GAME_OVER"
      ? root.phase
      : fail("$.phase", "unknown phase");
  const turn = parseTurn(root.turn, playerIds);
  const settings = parseSettings(root.settings);
  if (
    phase === "STARTING"
    && players.some((player) => player.cash !== settings.startingCash || player.status !== "ACTIVE")
  ) {
    fail("$.players", "starting players must match immutable starting settings");
  }
  if ((phase === "ACTIVE_TURN") !== (turn !== null)) {
    fail("$.turn", "turn identity is required only during ACTIVE_TURN");
  }
  if (turn !== null) {
    const activePlayer = players.find((player) => player.userId === turn.activePlayerId);
    if (activePlayer?.status !== "ACTIVE") {
      fail("$.turn.activePlayerId", "active turn owner must be an eligible player");
    }
  }
  const pendingResolution = parsePending(root.pendingResolution, board, playerIds, turn);

  if (pendingResolution !== null) {
    const decisionOwner = players.find(
      (player) => player.userId === pendingResolution.decisionOwnerUserId,
    );
    if (decisionOwner?.status !== "ACTIVE") {
      fail(
        "$.pendingResolution.decisionOwnerUserId",
        "pending decision owner must be an eligible player",
      );
    }
  }
  const auction = parseAuction(root.auction, pendingResolution, players, assets, gameVersion);

  if (pendingResolution?.source.type === "TILE") {
    const tileIndex = pendingResolution.source.tileIndex;
    const actor = players.find((player) => player.userId === pendingResolution.actorUserId);
    if (
      pendingResolution.kind !== "DEBT"
      && pendingResolution.kind !== "DETENTION_FEE"
      && actor?.position !== tileIndex
    ) {
      fail("$.pendingResolution.source.tileIndex", "landing source must match actor position");
    }
    const asset = assets.find((candidate) => candidate.tileIndex === tileIndex);
    if (
      (pendingResolution.kind === "BUY_DECISION" || pendingResolution.kind === "AUCTION")
      && asset?.ownerUserId !== null
    ) {
      fail("$.pendingResolution", "purchase or auction source must be unowned");
    }
    if (
      pendingResolution.kind === "RENT"
      && (
        asset?.ownerUserId === null
        || asset?.ownerUserId === pendingResolution.actorUserId
        || asset?.mortgaged
      )
    ) {
      fail("$.pendingResolution", "rent source must be owned by another player and unmortgaged");
    }
    const obligation = pendingResolution.obligation;
    if (
      obligation !== null
      && pendingResolution.kind === "RENT"
      && (
        obligation.creditor.type !== "PLAYER"
        || obligation.creditor.userId !== asset?.ownerUserId
      )
    ) {
      fail("$.pendingResolution.obligation.creditor", "rent creditor must own the source asset");
    }
    if (
      obligation !== null
      && (pendingResolution.kind === "TAX" || pendingResolution.kind === "DETENTION_FEE")
      && obligation.creditor.type !== "BANK"
    ) {
      fail("$.pendingResolution.obligation.creditor", "tax and detention fees are owed to the bank");
    }
  }
  return freezeGameState({
    gameId: identifierAt(root.gameId, "$.gameId"),
    gameVersion,
    board: parseBoardIdentity(root.board, board),
    settings,
    phase,
    turn,
    players,
    assets,
    pendingResolution,
    auction,
  });
}

export function createInitialGameState(input: CreateInitialGameStateInput): GameState {
  const board = parseBoardDefinition(input.board);
  assertLobbyCanStart(input.playerIds.length);

  const gameId = identifierAt(input.gameId, "$.gameId");
  const playerIds = input.playerIds.map((playerId, index) =>
    identifierAt(playerId, "$.playerIds[" + index + "]"),
  );
  if (new Set(playerIds).size !== playerIds.length) {
    fail("$.playerIds", "player ids must be unique");
  }

  const startingCash = input.startingCash ?? board.economyProfile.startingCash;
  if (!validStartingCash(startingCash)) {
    fail("$.startingCash", "must be an integer from 1500 through 2500");
  }

  const assets: AssetState[] = ownableTiles(board).map((tile) => (
    tile.type === "property"
      ? {
          kind: "PROPERTY",
          assetId: assetIdentity(tile),
          tileIndex: tile.index,
          ownerUserId: null,
          mortgaged: false,
          developmentLevel: 0,
        }
      : {
          kind: tile.type === "transit" ? "TRANSIT" : "UTILITY",
          assetId: assetIdentity(tile),
          tileIndex: tile.index,
          ownerUserId: null,
          mortgaged: false,
        }
  ));

  return parseGameState(
    {
      gameId,
      gameVersion: 0,
      board: {
        ref: board.ref,
        boardId: board.boardId,
        boardVersion: board.boardVersion,
        tileCount: board.tileCount,
      },
      settings: {
        matchMode: input.matchMode ?? "FFA",
        winMode: input.winMode ?? "LAST_STANDING",
        startingCash,
        pacing: "CORE",
      },
      phase: "STARTING",
      turn: null,
      players: playerIds.map((userId, seatIndex) => ({
        userId,
        seatIndex,
        cash: startingCash,
        position: 0,
        status: "ACTIVE",
        inHolding: false,
      })),
      assets,
      pendingResolution: null,
      auction: null,
    },
    board,
  );
}

export function assertPendingDecisionOwner(
  state: GameState,
  resolutionId: string,
  actorUserId: string,
): PendingResolution {
  const pending = state.pendingResolution;
  if (pending === null || pending.resolutionId !== resolutionId) {
    fail("$.pendingResolution", "resolution is no longer pending");
  }
  if (pending.decisionOwnerUserId !== actorUserId) {
    fail("$.pendingResolution.decisionOwnerUserId", "wrong actor for pending decision");
  }
  return pending;
}
