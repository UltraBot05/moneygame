/**
 * RT-001 … RT-018 production room runtime (RUNTIME-E1, RUNTIME-E2). Pure logic over the
 * {@link SqlDb} seam: the GameRoom Durable Object only adapts sockets, alarms, D1, and SQLite to
 * these functions, so the whole authoritative path is testable over real SQLite.
 *
 * Every mutation follows the frozen order: authenticated actor -> current epoch (checked by the
 * caller) -> schema -> game identity/actionId/version (game-core) -> rules -> one SQLite
 * transaction (state + next gameVersion + applied action + deadlines + finalization) -> broadcast.
 */

import {
  applyGameplayCommand,
  canonicalBoard,
  CommandValidationError,
  createInitialGameState,
  GameStateValidationError,
  parseGameState,
  projectGameState,
  SYSTEM_COMMAND_TYPES,
  validStartingCash,
  type GameCommand,
  type GameplayCommandResult,
  type GameplayEvent,
  type GameplayRejectionReason,
  type GameState,
  type ProjectedGameState,
  type RandomSource,
} from "@moneygame/game-core";
import {
  DEFAULT_ROOM_SETTINGS,
  parseRoomSettings,
  sanitizeChat,
  stateHash,
  type ChatMessage,
  type MemberView,
  type RoomAction,
  type RoomRejection,
  type RoomSettings,
  type RoomView,
  type WireCommand,
  COSMETICS,
} from "@moneygame/shared";
import {
  ACTIVE_TURN_RECONNECT_EXTENSION_MS,
  connectSeat,
  disconnectSeat,
  ensureSeatSchema,
  rejoinSeat,
  type ConnectKind,
} from "./seats";
import type { SqlDb } from "./transition";

/** Open auction clock (owner decision 2026-10-06): 20s to open; a bid never leaves less than 10s. */
export const AUCTION_DECISION_MS = 20_000;
export const AUCTION_BID_MS = 10_000;
export const DEBT_WINDOW_MS = 120_000;
export const FINALIZATION_RETRY_MS = 60_000;
export const MAX_SEATS = 10;
export const MAX_SPECTATORS = 20;
const COMMAND_WINDOW_MS = 10_000;
const MAX_COMMANDS_PER_WINDOW = 20;
const MAX_CHATS_PER_WINDOW = 5;
const KEEP_CHAT = 100;
const KEEP_DIAGNOSTICS = 500;
const KEEP_APPLIED_ACTIONS = 500;
const SYSTEM_ACTOR = "system:runtime";
/** Room lifecycle commands are driven by room actions, never sent as raw game commands. */
const ROOM_OWNED_COMMANDS: ReadonlySet<string> = new Set(["CONFIGURE_MATCH", "START_GAME"]);

export interface RuntimeDeps {
  readonly now: number;
  readonly rng: RandomSource;
  readonly newGameId: () => string;
}

export function ensureRoomSchema(db: SqlDb): void {
  ensureSeatSchema(db);
  db.run(`CREATE TABLE IF NOT EXISTS room (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    code TEXT NOT NULL,
    host_user_id TEXT NOT NULL,
    phase TEXT NOT NULL,
    settings_json TEXT NOT NULL,
    current_game_id TEXT,
    paused_at INTEGER,
    created_at INTEGER NOT NULL
  );`);
  db.run(`CREATE TABLE IF NOT EXISTS members (
    user_id TEXT PRIMARY KEY,
    display_name TEXT NOT NULL,
    seat_index INTEGER NOT NULL,
    ready INTEGER NOT NULL,
    rejoins INTEGER NOT NULL DEFAULT 0,
    ring TEXT
  );`);
  db.run(`CREATE TABLE IF NOT EXISTS games (
    game_id TEXT PRIMARY KEY,
    board_ref TEXT NOT NULL,
    state_json TEXT NOT NULL,
    game_version INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  );`);
  db.run(`CREATE TABLE IF NOT EXISTS applied_actions (
    game_id TEXT NOT NULL,
    action_id TEXT NOT NULL,
    game_version INTEGER NOT NULL,
    PRIMARY KEY (game_id, action_id)
  );`);
  db.run(`CREATE TABLE IF NOT EXISTS turn_deadline (
    game_id TEXT PRIMARY KEY,
    turn_id TEXT NOT NULL,
    deadline_at INTEGER,
    extended INTEGER NOT NULL
  );`);
  db.run(`CREATE TABLE IF NOT EXISTS finalizations (
    game_id TEXT PRIMARY KEY,
    payload_json TEXT NOT NULL,
    delivered INTEGER NOT NULL,
    attempts INTEGER NOT NULL,
    next_attempt_at INTEGER NOT NULL
  );`);
  db.run(`CREATE TABLE IF NOT EXISTS chat (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    display_name TEXT NOT NULL,
    text TEXT NOT NULL,
    at INTEGER NOT NULL
  );`);
  db.run(`CREATE TABLE IF NOT EXISTS diagnostics (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    game_id TEXT NOT NULL,
    game_version INTEGER NOT NULL,
    action_id TEXT NOT NULL,
    command_type TEXT NOT NULL,
    actor TEXT NOT NULL,
    outcome TEXT NOT NULL,
    state_hash TEXT NOT NULL,
    at INTEGER NOT NULL
  );`);
}

interface RoomRow extends Record<string, string | number | null> {
  code: string;
  host_user_id: string;
  phase: string;
  settings_json: string;
  current_game_id: string | null;
  paused_at: number | null;
}

interface MemberRow extends Record<string, string | number | null> {
  user_id: string;
  display_name: string;
  seat_index: number;
  ready: number;
  ring: string | null;
}

interface SeatRow extends Record<string, string | number | null> {
  user_id: string;
  connected: number;
  lease_expires_at: number | null;
}

interface GameRow extends Record<string, string | number | null> {
  game_id: string;
  board_ref: string;
  state_json: string;
  game_version: number;
}

interface DeadlineRow extends Record<string, string | number | null> {
  turn_id: string;
  deadline_at: number | null;
  extended: number;
}

function room(db: SqlDb): RoomRow | undefined {
  return db.get<RoomRow>(`SELECT code, host_user_id, phase, settings_json, current_game_id, paused_at FROM room;`);
}

function settingsOf(row: RoomRow): RoomSettings {
  return parseRoomSettings(JSON.parse(row.settings_json));
}

function members(db: SqlDb): MemberRow[] {
  return db.all<MemberRow>(`SELECT user_id, display_name, seat_index, ready, ring FROM members ORDER BY seat_index;`);
}

function member(db: SqlDb, userId: string): MemberRow | undefined {
  return db.get<MemberRow>(`SELECT user_id, display_name, seat_index, ready, ring FROM members WHERE user_id = ?;`, userId);
}

function seats(db: SqlDb): Map<string, SeatRow> {
  return new Map(db.all<SeatRow>(`SELECT user_id, connected, lease_expires_at FROM seats;`)
    .map((row) => [row.user_id, row]));
}

/** Disconnected with no live lease: the seat's turns are being auto-played. */
function isAway(seat: SeatRow | undefined, now: number): boolean {
  return seat?.connected !== 1 && (seat?.lease_expires_at == null || now > seat.lease_expires_at);
}

function currentGame(db: SqlDb): GameRow | undefined {
  const row = room(db);
  if (row?.current_game_id == null) return undefined;
  return db.get<GameRow>(
    `SELECT game_id, board_ref, state_json, game_version FROM games WHERE game_id = ?;`,
    row.current_game_id,
  );
}

/** Reconstructs the authoritative state for a stored game (full validation, catalog included). */
function loadState(game: GameRow): GameState {
  const { board, cards } = canonicalBoard(game.board_ref);
  return parseGameState(JSON.parse(game.state_json), board, cards);
}

export function isInitialized(db: SqlDb): boolean {
  return room(db) !== undefined;
}

/** Creates the room once for its code; false if this Durable Object already holds a room. */
export function initializeRoom(
  db: SqlDb,
  code: string,
  host: Readonly<{ userId: string; displayName: string }>,
  now: number,
): boolean {
  return db.transaction(() => {
    if (room(db) !== undefined) return false;
    db.run(
      `INSERT INTO room (singleton, code, host_user_id, phase, settings_json, current_game_id, paused_at, created_at)
       VALUES (1, ?, ?, 'LOBBY', ?, NULL, NULL, ?);`,
      code, host.userId, JSON.stringify(DEFAULT_ROOM_SETTINGS), now,
    );
    db.run(`INSERT INTO members (user_id, display_name, seat_index, ready) VALUES (?, ?, 0, 0);`,
      host.userId, host.displayName);
    return true;
  });
}

/**
 * RT-009: hosting moves to the lowest-seat connected member when the host has left or their
 * reconnect lease has expired. Deterministic, persisted, and re-run on every interaction.
 */
export function refreshHost(db: SqlDb, now: number): void {
  const current = room(db);
  if (current === undefined) return;
  const seatRows = seats(db);
  const hostSeated = member(db, current.host_user_id) !== undefined;
  if (hostSeated && !isAway(seatRows.get(current.host_user_id), now)) return;
  const seated = members(db);
  const next = seated.find((row) => row.user_id !== current.host_user_id && seatRows.get(row.user_id)?.connected === 1)
    ?? (hostSeated ? undefined : seated[0]);
  if (next !== undefined) db.run(`UPDATE room SET host_user_id = ?;`, next.user_id);
}

export type Admission =
  | { readonly role: "PLAYER"; readonly epoch: number; readonly kind: ConnectKind | "REJOIN"; readonly replacedEpoch: number | null }
  | { readonly role: "SPECTATOR" }
  | { readonly role: "REFUSED"; readonly reason: "ROOM_NOT_FOUND" | "ROOM_FULL" };

/**
 * RT-001 / RT-008 admission. Members reclaim their seat (reconnect within the lease, takeover
 * of a live socket, or an explicit REJOIN after it expired). Anyone else joins as a player while
 * the lobby has a free seat, and otherwise watches, up to the spectator cap.
 */
export function admit(
  db: SqlDb,
  user: Readonly<{ userId: string; displayName: string; ring?: string | null }>,
  now: number,
  spectatorsConnected = 0,
): Admission {
  // Stored as "" when none (the SqlDb seam binds strings and numbers only).
  const ring = COSMETICS.some((item) => item.kind === "RING" && item.value === user.ring) ? user.ring ?? null : null;
  const current = room(db);
  if (current === undefined) return { role: "REFUSED", reason: "ROOM_NOT_FOUND" };
  if (member(db, user.userId) === undefined) {
    if (current.phase !== "LOBBY" || members(db).length >= MAX_SEATS) {
      return spectatorsConnected >= MAX_SPECTATORS ? { role: "REFUSED", reason: "ROOM_FULL" } : { role: "SPECTATOR" };
    }
    const seatIndex = members(db).reduce((max, row) => Math.max(max, row.seat_index + 1), 0);
    db.run(`INSERT INTO members (user_id, display_name, seat_index, ready, ring) VALUES (?, ?, ?, 0, ?);`,
      user.userId, user.displayName, seatIndex, ring ?? "");
  } else {
    db.run(`UPDATE members SET display_name = ?, ring = ? WHERE user_id = ?;`, user.displayName, ring ?? "", user.userId);
  }
  const connection = connectSeat(db, user.userId, now);
  let admission: Admission;
  if (connection.accepted) {
    admission = { role: "PLAYER", epoch: connection.epoch, kind: connection.kind, replacedEpoch: connection.replacedEpoch };
  } else {
    db.run(`UPDATE members SET rejoins = rejoins + 1 WHERE user_id = ?;`, user.userId);
    admission = { role: "PLAYER", epoch: rejoinSeat(db, user.userId), kind: "REJOIN", replacedEpoch: null };
  }
  refreshHost(db, now);
  return admission;
}

export function disconnect(db: SqlDb, userId: string, epoch: number, now: number): void {
  disconnectSeat(db, userId, epoch, now);
}

/** The turn owner can act (no auction, no outstanding obligation), so the turn clock runs. */
function ownerDecision(state: GameState): boolean {
  return state.phase === "ACTIVE_TURN" && state.auction === null && state.pendingResolution?.obligation == null;
}

/**
 * Arms the turn clock whenever control reaches the turn owner (a new turn, or an auction/debt
 * handing back), and stops it while others decide. A new turn resets the one-time extension.
 */
function syncTurnDeadline(db: SqlDb, gameId: string, previous: GameState | null, next: GameState, turnMs: number, now: number): void {
  const row = db.get<DeadlineRow>(`SELECT turn_id, deadline_at, extended FROM turn_deadline WHERE game_id = ?;`, gameId);
  const turnId = next.turn?.turnId ?? null;
  if (turnId === null || !ownerDecision(next)) {
    db.run(`UPDATE turn_deadline SET deadline_at = NULL WHERE game_id = ?;`, gameId);
    return;
  }
  const newTurn = row === undefined || row.turn_id !== turnId;
  const regained = previous === null || !ownerDecision(previous) || row?.deadline_at == null;
  if (!newTurn && !regained) return;
  db.run(
    `INSERT INTO turn_deadline (game_id, turn_id, deadline_at, extended) VALUES (?, ?, ?, 0)
       ON CONFLICT (game_id) DO UPDATE SET turn_id = excluded.turn_id, deadline_at = excluded.deadline_at,
         extended = CASE WHEN turn_deadline.turn_id = excluded.turn_id THEN turn_deadline.extended ELSE 0 END;`,
    gameId, turnId, now + turnMs,
  );
}

/** Everything D1 needs to record one finished game (RT-012); written with the ending commit. */
export interface FinalizedGame {
  readonly gameId: string;
  readonly roomCode: string;
  readonly boardRef: string;
  readonly matchMode: "FFA" | "TEAMS";
  readonly endedAt: number;
  readonly outcome: NonNullable<GameState["ruleState"]["outcome"]>;
  readonly players: readonly Readonly<{ userId: string; displayName: string; placement: number; winner: boolean }>[];
  readonly eliminations: GameState["ruleState"]["eliminations"];
  readonly incidents: GameState["ruleState"]["fairPlay"]["incidents"];
}

function finalizationFor(db: SqlDb, current: RoomRow, game: GameRow, state: GameState, now: number): FinalizedGame {
  const outcome = state.ruleState.outcome as NonNullable<GameState["ruleState"]["outcome"]>;
  const names = new Map(members(db).map((row) => [row.user_id, row.display_name]));
  return {
    gameId: state.gameId,
    roomCode: current.code,
    boardRef: game.board_ref,
    matchMode: state.settings.matchMode,
    endedAt: now,
    outcome,
    players: outcome.placements.map((userId, index) => ({
      userId,
      displayName: names.get(userId) ?? "Player",
      placement: index + 1,
      winner: outcome.winnerUserIds.includes(userId),
    })),
    eliminations: state.ruleState.eliminations,
    incidents: state.ruleState.fairPlay.incidents,
  };
}

/** RT-018: bounded, secret-free audit trail keyed by game, version, and action. */
function diagnose(db: SqlDb, gameId: string, state: GameState | null, command: GameCommand, actor: string, outcome: string, now: number): void {
  db.run(
    `INSERT INTO diagnostics (game_id, game_version, action_id, command_type, actor, outcome, state_hash, at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?);`,
    gameId, state?.gameVersion ?? -1, command.actionId.slice(0, 128), command.type.slice(0, 32), actor, outcome,
    state === null ? "" : stateHash(JSON.stringify(state)), now,
  );
  db.run(`DELETE FROM diagnostics WHERE id <= (SELECT MAX(id) FROM diagnostics) - ?;`, KEEP_DIAGNOSTICS);
}

export type RoomOutcome =
  | { readonly kind: "COMMITTED"; readonly event: GameplayEvent | null }
  | { readonly kind: "DUPLICATE" }
  | {
      readonly kind: "REJECTED";
      readonly actionId: string;
      readonly reason: GameplayRejectionReason | RoomRejection;
      readonly currentGameVersion?: number;
    };

function roomRejected(reason: RoomRejection): RoomOutcome {
  return { kind: "REJECTED", actionId: "room", reason };
}

/**
 * Runs one game command through game-core and commits it atomically. The actor is always the
 * authenticated socket user (or the runtime for timeouts), never a payload field.
 */
function commit(db: SqlDb, deps: RuntimeDeps, actorUserId: string, command: GameCommand): RoomOutcome {
  const game = currentGame(db);
  const current = room(db);
  if (game === undefined || current === undefined) {
    return { kind: "REJECTED", actionId: command.actionId, reason: "GAME_NOT_STARTED" };
  }
  const { board, cards } = canonicalBoard(game.board_ref);
  const previous = loadState(game);
  const applied = db.get<{ game_version: number }>(
    `SELECT game_version FROM applied_actions WHERE game_id = ? AND action_id = ?;`,
    command.gameId, command.actionId,
  );
  let result: GameplayCommandResult;
  try {
    result = applyGameplayCommand(previous, command, {
      actorUserId,
      board,
      rng: deps.rng,
      cardCatalog: cards,
      currentTime: deps.now,
      auctionDecisionDeadlineAt: deps.now + (command.type === "PLACE_BID" ? AUCTION_BID_MS : AUCTION_DECISION_MS),
      debtDeadlineAt: deps.now + DEBT_WINDOW_MS,
      appliedActions: applied === undefined
        ? []
        : [{ gameId: command.gameId, actionId: command.actionId, resultingGameVersion: applied.game_version }],
    });
  } catch (error) {
    if (error instanceof CommandValidationError) {
      diagnose(db, game.game_id, previous, command, actorUserId, "MALFORMED_COMMAND", deps.now);
      return { kind: "REJECTED", actionId: command.actionId, reason: "MALFORMED_COMMAND" };
    }
    throw error;
  }
  if (result.kind === "DUPLICATE_ACTION") {
    diagnose(db, game.game_id, previous, command, actorUserId, "DUPLICATE", deps.now);
    return { kind: "DUPLICATE" };
  }
  if (result.kind === "REJECTED") {
    diagnose(db, game.game_id, previous, command, actorUserId, result.reason, deps.now);
    return {
      kind: "REJECTED",
      actionId: command.actionId,
      reason: result.reason,
      currentGameVersion: result.state.gameVersion,
    };
  }
  const next = result.state;
  const turnMs = settingsOf(current).turnSeconds * 1000;
  db.transaction(() => {
    db.run(`UPDATE games SET state_json = ?, game_version = ? WHERE game_id = ?;`,
      JSON.stringify(next), next.gameVersion, game.game_id);
    db.run(`INSERT INTO applied_actions (game_id, action_id, game_version) VALUES (?, ?, ?);`,
      game.game_id, command.actionId, next.gameVersion);
    db.run(`DELETE FROM applied_actions WHERE game_id = ? AND game_version <= ?;`,
      game.game_id, next.gameVersion - KEEP_APPLIED_ACTIONS);
    syncTurnDeadline(db, game.game_id, previous, next, turnMs, deps.now);
    if (next.phase === "GAME_OVER" && previous.phase !== "GAME_OVER") {
      db.run(
        `INSERT INTO finalizations (game_id, payload_json, delivered, attempts, next_attempt_at) VALUES (?, ?, 0, 0, ?);`,
        game.game_id, JSON.stringify(finalizationFor(db, current, game, next, deps.now)), deps.now,
      );
    }
    diagnose(db, game.game_id, next, command, actorUserId, "ACCEPTED", deps.now);
  });
  return { kind: "COMMITTED", event: result.event };
}

function rateLimited(db: SqlDb, actor: string, now: number): boolean {
  const recent = db.get<{ count: number }>(
    `SELECT COUNT(*) AS count FROM diagnostics WHERE actor = ? AND at > ?;`, actor, now - COMMAND_WINDOW_MS,
  );
  return (recent?.count ?? 0) >= MAX_COMMANDS_PER_WINDOW;
}

/** RT-004: a client's game command. Only seated members may act; system/room commands are refused. */
export function handleCommand(db: SqlDb, userId: string, wire: WireCommand, deps: RuntimeDeps): RoomOutcome {
  if (SYSTEM_COMMAND_TYPES.has(wire.type) || ROOM_OWNED_COMMANDS.has(wire.type)) {
    return { kind: "REJECTED", actionId: wire.actionId, reason: "SYSTEM_COMMAND" };
  }
  if (member(db, userId) === undefined) return { kind: "REJECTED", actionId: wire.actionId, reason: "NOT_A_MEMBER" };
  if (room(db)?.paused_at != null) return { kind: "REJECTED", actionId: wire.actionId, reason: "ROOM_PAUSED" };
  if (rateLimited(db, userId, deps.now)) return { kind: "REJECTED", actionId: wire.actionId, reason: "RATE_LIMITED" };
  return commit(db, deps, userId, wire);
}

/** RT-001 / RT-009 / RT-010 / RT-013 room actions. */
export function handleRoomAction(db: SqlDb, userId: string, action: RoomAction, deps: RuntimeDeps): RoomOutcome {
  refreshHost(db, deps.now);
  const current = room(db);
  if (current === undefined || member(db, userId) === undefined) return roomRejected("NOT_A_MEMBER");
  const isHost = current.host_user_id === userId;
  const inLobby = current.phase === "LOBBY";
  switch (action.kind) {
    case "SET_READY":
      if (!inLobby) return roomRejected("NOT_IN_LOBBY");
      db.run(`UPDATE members SET ready = ? WHERE user_id = ?;`, action.ready ? 1 : 0, userId);
      return { kind: "COMMITTED", event: null };
    case "LEAVE":
      if (!inLobby) return roomRejected("NOT_IN_LOBBY");
      db.transaction(() => {
        db.run(`DELETE FROM members WHERE user_id = ?;`, userId);
        db.run(`DELETE FROM seats WHERE user_id = ?;`, userId);
        refreshHost(db, deps.now);
      });
      return { kind: "COMMITTED", event: null };
    case "CONFIGURE":
      if (!inLobby) return roomRejected("NOT_IN_LOBBY");
      if (!isHost) return roomRejected("NOT_HOST");
      if (!validStartingCash(action.settings.startingCash)) return roomRejected("INVALID_SETTINGS");
      db.transaction(() => {
        db.run(`UPDATE room SET settings_json = ?;`, JSON.stringify(action.settings));
        db.run(`UPDATE members SET ready = 0;`);
      });
      return { kind: "COMMITTED", event: null };
    case "START":
      if (!inLobby) return roomRejected("NOT_IN_LOBBY");
      if (!isHost) return roomRejected("NOT_HOST");
      return startGame(db, current, deps);
    case "PAUSE":
      if (!isHost) return roomRejected("NOT_HOST");
      if (inLobby || currentGameState(db)?.phase !== "ACTIVE_TURN") return roomRejected("NOT_IN_GAME");
      if (current.paused_at !== null) return roomRejected("ROOM_PAUSED");
      db.run(`UPDATE room SET paused_at = ?;`, deps.now);
      return { kind: "COMMITTED", event: null };
    case "RESUME":
      if (!isHost) return roomRejected("NOT_HOST");
      if (current.paused_at === null) return roomRejected("NOT_PAUSED");
      return resume(db, current.paused_at, deps);
    case "REMATCH":
      if (!isHost) return roomRejected("NOT_HOST");
      if (inLobby || currentGameState(db)?.phase !== "GAME_OVER") return roomRejected("GAME_NOT_OVER");
      db.transaction(() => {
        db.run(`UPDATE room SET phase = 'LOBBY', paused_at = NULL;`);
        db.run(`UPDATE members SET ready = 0;`);
      });
      return { kind: "COMMITTED", event: null };
  }
}

function currentGameState(db: SqlDb): GameState | null {
  const game = currentGame(db);
  return game === undefined ? null : loadState(game);
}

/**
 * RT-010: every live deadline moves later by the paused duration. The in-state clocks shift
 * through game-core's RESUME_CLOCKS under a deterministic actionId, so a retried resume after a
 * crash is a duplicate, never a second shift.
 */
function resume(db: SqlDb, pausedAt: number, deps: RuntimeDeps): RoomOutcome {
  const game = currentGame(db);
  const pausedMs = Math.max(0, deps.now - pausedAt);
  let event: GameplayEvent | null = null;
  if (game !== undefined && pausedMs > 0) {
    const state = loadState(game);
    const shifted = commit(db, deps, SYSTEM_ACTOR, {
      type: "RESUME_CLOCKS", gameId: state.gameId, actionId: "resume:" + state.gameId + ":" + pausedAt, payload: { pausedMs },
    });
    if (shifted.kind === "COMMITTED") event = shifted.event;
  }
  db.transaction(() => {
    if (game !== undefined) {
      db.run(`UPDATE turn_deadline SET deadline_at = deadline_at + ? WHERE game_id = ? AND deadline_at IS NOT NULL;`,
        pausedMs, game.game_id);
    }
    db.run(`UPDATE room SET paused_at = NULL;`);
  });
  return { kind: "COMMITTED", event };
}

function startGame(db: SqlDb, current: RoomRow, deps: RuntimeDeps): RoomOutcome {
  const seated = members(db);
  if (seated.length < 3 || seated.length > MAX_SEATS || seated.some((row) => row.ready !== 1)) {
    return roomRejected("NOT_ENOUGH_READY_PLAYERS");
  }
  const settings = settingsOf(current);
  const { board, cards } = canonicalBoard(settings.boardRef);
  const gameId = deps.newGameId();
  let initial: GameState;
  try {
    initial = createInitialGameState({
      gameId,
      board,
      playerIds: seated.map((row) => row.user_id),
      startingCash: settings.startingCash,
      matchMode: settings.matchMode,
      teams: settings.teams,
    });
  } catch (error) {
    if (error instanceof GameStateValidationError) return roomRejected("INVALID_SETTINGS");
    throw error;
  }
  const started = applyGameplayCommand(
    initial,
    { type: "START_GAME", gameId, actionId: "start:" + gameId, payload: {} },
    { actorUserId: current.host_user_id, board, rng: deps.rng, cardCatalog: cards, currentTime: deps.now },
  );
  if (started.kind !== "ACCEPTED") return roomRejected("INVALID_SETTINGS");
  db.transaction(() => {
    db.run(`INSERT INTO games (game_id, board_ref, state_json, game_version, created_at) VALUES (?, ?, ?, ?, ?);`,
      gameId, settings.boardRef, JSON.stringify(started.state), started.state.gameVersion, deps.now);
    db.run(`INSERT INTO applied_actions (game_id, action_id, game_version) VALUES (?, ?, ?);`,
      gameId, "start:" + gameId, started.state.gameVersion);
    db.run(`UPDATE room SET phase = 'IN_GAME', current_game_id = ?, paused_at = NULL;`, gameId);
    syncTurnDeadline(db, gameId, null, started.state, settings.turnSeconds * 1000, deps.now);
  });
  return { kind: "COMMITTED", event: started.event };
}

export type ChatOutcome =
  | { readonly kind: "POSTED"; readonly message: ChatMessage }
  | { readonly kind: "REJECTED"; readonly reason: RoomRejection };

/** RT-011: bounded, rate-limited chat that never touches game state. */
export function postChat(db: SqlDb, userId: string, text: string, now: number): ChatOutcome {
  const author = member(db, userId);
  if (author === undefined) return { kind: "REJECTED", reason: "NOT_A_MEMBER" };
  const clean = sanitizeChat(text);
  if (clean === null) return { kind: "REJECTED", reason: "INVALID_CHAT" };
  const recent = db.get<{ count: number }>(
    `SELECT COUNT(*) AS count FROM chat WHERE user_id = ? AND at > ?;`, userId, now - COMMAND_WINDOW_MS,
  );
  if ((recent?.count ?? 0) >= MAX_CHATS_PER_WINDOW) return { kind: "REJECTED", reason: "RATE_LIMITED" };
  return db.transaction(() => {
    db.run(`INSERT INTO chat (user_id, display_name, text, at) VALUES (?, ?, ?, ?);`,
      userId, author.display_name, clean, now);
    const id = db.get<{ id: number }>(`SELECT MAX(id) AS id FROM chat;`)?.id ?? 0;
    db.run(`DELETE FROM chat WHERE id <= ?;`, id - KEEP_CHAT);
    return { kind: "POSTED" as const, message: { id, userId, displayName: author.display_name, text: clean, at: now } };
  });
}

export function recentChat(db: SqlDb): ChatMessage[] {
  return db.all<{ id: number; user_id: string; display_name: string; text: string; at: number }>(
    `SELECT id, user_id, display_name, text, at FROM chat ORDER BY id;`,
  ).map((row) => ({ id: row.id, userId: row.user_id, displayName: row.display_name, text: row.text, at: row.at }));
}

interface DueTimeout {
  readonly at: number;
  readonly command: GameCommand;
}

function dueTimeouts(db: SqlDb, now: number): DueTimeout[] {
  const game = currentGame(db);
  if (game === undefined || room(db)?.paused_at != null) return [];
  const state = loadState(game);
  if (state.phase !== "ACTIVE_TURN") return [];
  const due: DueTimeout[] = [];
  const command = (type: string, actionId: string, payload: unknown): GameCommand =>
    ({ type, gameId: state.gameId, actionId, payload });
  const auction = state.auction;
  if (auction !== null && auction.decisionDeadlineAt <= now) {
    due.push({
      at: auction.decisionDeadlineAt,
      command: command("AUCTION_TIMEOUT",
        "timeout:auction:" + auction.auctionId + ":" + auction.decisionDeadlineAt,
        { auctionId: auction.auctionId, decisionDeadlineAt: auction.decisionDeadlineAt }),
    });
  }
  const debt = state.ruleState.debt;
  if (debt !== null && debt.deadlineAt <= now) {
    due.push({
      at: debt.deadlineAt,
      command: command("DEBT_TIMEOUT", "timeout:debt:" + debt.resolutionId + ":" + debt.deadlineAt,
        { resolutionId: debt.resolutionId, deadlineAt: debt.deadlineAt }),
    });
  }
  const turn = db.get<DeadlineRow>(`SELECT turn_id, deadline_at, extended FROM turn_deadline WHERE game_id = ?;`, game.game_id);
  if (turn?.deadline_at != null && turn.deadline_at <= now && ownerDecision(state)) {
    due.push({
      at: turn.deadline_at,
      command: command("TURN_TIMEOUT", "timeout:turn:" + turn.turn_id + ":" + turn.deadline_at, { turnId: turn.turn_id }),
    });
  }
  return due.sort((left, right) => left.at - right.at);
}

/**
 * RT-007 alarm body: resolves every due deadline in order through the normal commit path.
 * Deterministic actionIds make an at-least-once redelivery a duplicate; a stale timeout is
 * rejected by game-core's own identity checks, and a stale turn clock is simply cleared.
 */
export function runDueTimeouts(db: SqlDb, deps: RuntimeDeps): GameplayEvent[] {
  refreshHost(db, deps.now);
  const events: GameplayEvent[] = [];
  for (let guard = 0; guard < 32; guard += 1) {
    const next = dueTimeouts(db, deps.now)[0];
    if (next === undefined) break;
    const outcome = commit(db, deps, SYSTEM_ACTOR, next.command);
    if (outcome.kind === "COMMITTED") {
      if (outcome.event !== null) events.push(outcome.event);
      continue;
    }
    if (next.command.type !== "TURN_TIMEOUT") break;
    const game = currentGame(db);
    if (game !== undefined) db.run(`UPDATE turn_deadline SET deadline_at = NULL WHERE game_id = ?;`, game.game_id);
  }
  return events;
}

/** RT-012: finalizations whose D1 delivery is due (never deleted until delivered). */
export function dueFinalizations(db: SqlDb, now: number): FinalizedGame[] {
  return db.all<{ payload_json: string }>(
    `SELECT payload_json FROM finalizations WHERE delivered = 0 AND next_attempt_at <= ? ORDER BY next_attempt_at;`, now,
  ).map((row) => JSON.parse(row.payload_json) as FinalizedGame);
}

/** Delivery confirmed by D1: the game's idempotency ledger is no longer needed (RT-016). */
export function markFinalized(db: SqlDb, gameId: string): void {
  db.transaction(() => {
    db.run(`UPDATE finalizations SET delivered = 1 WHERE game_id = ?;`, gameId);
    db.run(`DELETE FROM applied_actions WHERE game_id = ?;`, gameId);
  });
}

export function markFinalizationFailed(db: SqlDb, gameId: string, now: number): void {
  db.run(`UPDATE finalizations SET attempts = attempts + 1, next_attempt_at = ? WHERE game_id = ?;`,
    now + FINALIZATION_RETRY_MS, gameId);
}

/** The single alarm time: the earliest pending game deadline or finalization retry. */
export function nextAlarmAt(db: SqlDb): number | null {
  const candidates: number[] = [];
  const retry = db.get<{ at: number | null }>(`SELECT MIN(next_attempt_at) AS at FROM finalizations WHERE delivered = 0;`);
  if (retry?.at != null) candidates.push(retry.at);
  const game = currentGame(db);
  if (game !== undefined && room(db)?.paused_at == null) {
    const state = loadState(game);
    if (state.phase === "ACTIVE_TURN") {
      const turn = db.get<DeadlineRow>(`SELECT turn_id, deadline_at, extended FROM turn_deadline WHERE game_id = ?;`, game.game_id);
      for (const value of [
        state.auction?.decisionDeadlineAt,
        state.ruleState.debt?.deadlineAt,
        ownerDecision(state) ? turn?.deadline_at ?? undefined : undefined,
      ]) {
        if (typeof value === "number") candidates.push(value);
      }
    }
  }
  return candidates.length === 0 ? null : Math.min(...candidates);
}

/** RT-008: a genuine within-lease reconnect by the turn owner earns +20 s once per turn. */
export function grantReconnectExtension(db: SqlDb, userId: string): boolean {
  const game = currentGame(db);
  if (game === undefined || room(db)?.paused_at != null) return false;
  const state = loadState(game);
  if (state.turn?.activePlayerId !== userId || !ownerDecision(state)) return false;
  const changed = db.run(
    `UPDATE turn_deadline SET deadline_at = deadline_at + ?, extended = 1
       WHERE game_id = ? AND turn_id = ? AND extended = 0 AND deadline_at IS NOT NULL;`,
    ACTIVE_TURN_RECONNECT_EXTENSION_MS, game.game_id, state.turn.turnId,
  );
  return changed > 0;
}

export function roomView(db: SqlDb, now: number): RoomView | null {
  const current = room(db);
  if (current === undefined) return null;
  const seatRows = seats(db);
  const game = currentGame(db);
  const turn = game === undefined
    ? undefined
    : db.get<DeadlineRow>(`SELECT turn_id, deadline_at, extended FROM turn_deadline WHERE game_id = ?;`, game.game_id);
  return {
    roomCode: current.code,
    hostUserId: current.host_user_id,
    phase: current.phase === "IN_GAME" ? "IN_GAME" : "LOBBY",
    paused: current.paused_at !== null,
    settings: settingsOf(current),
    members: members(db).map((row): MemberView => {
      const seat = seatRows.get(row.user_id);
      return {
        userId: row.user_id,
        displayName: row.display_name,
        seatIndex: row.seat_index,
        ready: row.ready === 1,
        connected: seat?.connected === 1,
        away: isAway(seat, now),
        ring: row.ring === "" ? null : row.ring,
      };
    }),
    turnDeadlineAt: current.paused_at === null ? turn?.deadline_at ?? null : null,
  };
}

/** RT-014: the current game as this viewer may see it, with its diagnostic hash. */
export function viewerGame(db: SqlDb, viewerUserId: string | null): Readonly<{ game: ProjectedGameState; hash: string }> | null {
  const game = currentGame(db);
  if (game === undefined) return null;
  const state = loadState(game);
  return { game: projectGameState(state, viewerUserId), hash: stateHash(JSON.stringify(state)) };
}
