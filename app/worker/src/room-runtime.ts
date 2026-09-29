/**
 * RT-001 … RT-008 production room runtime (RUNTIME-E1). Pure logic over the {@link SqlDb} seam:
 * the GameRoom Durable Object only adapts sockets, alarms, and SQLite to these functions, so the
 * whole authoritative path is testable over real SQLite.
 *
 * Every mutation follows the frozen order: authenticated actor -> current epoch (checked by the
 * caller) -> schema -> game identity/actionId/version (game-core) -> rules -> one SQLite
 * transaction (state + next gameVersion + applied action + deadlines) -> broadcast by the caller.
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
  type LobbyAction,
  type LobbyRejection,
  type MemberView,
  type RoomSettings,
  type RoomView,
  type WireCommand,
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

export const AUCTION_DECISION_MS = 20_000;
export const DEBT_WINDOW_MS = 120_000;
export const MAX_SEATS = 10;
const SYSTEM_ACTOR = "system:runtime";
/** Lobby lifecycle commands are driven by lobby actions, never sent as raw game commands. */
const LOBBY_OWNED_COMMANDS: ReadonlySet<string> = new Set(["CONFIGURE_MATCH", "START_GAME"]);

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
    created_at INTEGER NOT NULL
  );`);
  db.run(`CREATE TABLE IF NOT EXISTS members (
    user_id TEXT PRIMARY KEY,
    display_name TEXT NOT NULL,
    seat_index INTEGER NOT NULL,
    ready INTEGER NOT NULL,
    rejoins INTEGER NOT NULL DEFAULT 0
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
}

interface RoomRow extends Record<string, string | number | null> {
  code: string;
  host_user_id: string;
  phase: string;
  settings_json: string;
  current_game_id: string | null;
}

interface MemberRow extends Record<string, string | number | null> {
  user_id: string;
  display_name: string;
  seat_index: number;
  ready: number;
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
  return db.get<RoomRow>(`SELECT code, host_user_id, phase, settings_json, current_game_id FROM room;`);
}

function settingsOf(row: RoomRow): RoomSettings {
  return parseRoomSettings(JSON.parse(row.settings_json));
}

function members(db: SqlDb): MemberRow[] {
  return db.all<MemberRow>(`SELECT user_id, display_name, seat_index, ready FROM members ORDER BY seat_index;`);
}

function member(db: SqlDb, userId: string): MemberRow | undefined {
  return db.get<MemberRow>(`SELECT user_id, display_name, seat_index, ready FROM members WHERE user_id = ?;`, userId);
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
      `INSERT INTO room (singleton, code, host_user_id, phase, settings_json, current_game_id, created_at)
       VALUES (1, ?, ?, 'LOBBY', ?, NULL, ?);`,
      code, host.userId, JSON.stringify(DEFAULT_ROOM_SETTINGS), now,
    );
    db.run(`INSERT INTO members (user_id, display_name, seat_index, ready) VALUES (?, ?, 0, 0);`,
      host.userId, host.displayName);
    return true;
  });
}

export type Admission =
  | { readonly role: "PLAYER"; readonly epoch: number; readonly kind: ConnectKind | "REJOIN"; readonly replacedEpoch: number | null }
  | { readonly role: "SPECTATOR" }
  | { readonly role: "REFUSED" };

/**
 * RT-001 / RT-008 admission. Members reclaim their seat (reconnect within the lease, takeover
 * of a live socket, or an explicit REJOIN after it expired). Anyone else joins as a player while
 * the lobby has a free seat, and otherwise watches as a spectator.
 */
export function admit(
  db: SqlDb,
  user: Readonly<{ userId: string; displayName: string }>,
  now: number,
): Admission {
  const current = room(db);
  if (current === undefined) return { role: "REFUSED" };
  if (member(db, user.userId) === undefined) {
    if (current.phase !== "LOBBY" || members(db).length >= MAX_SEATS) return { role: "SPECTATOR" };
    const seatIndex = members(db).reduce((max, row) => Math.max(max, row.seat_index + 1), 0);
    db.run(`INSERT INTO members (user_id, display_name, seat_index, ready) VALUES (?, ?, ?, 0);`,
      user.userId, user.displayName, seatIndex);
  } else {
    db.run(`UPDATE members SET display_name = ? WHERE user_id = ?;`, user.displayName, user.userId);
  }
  const connection = connectSeat(db, user.userId, now);
  if (connection.accepted) {
    return { role: "PLAYER", epoch: connection.epoch, kind: connection.kind, replacedEpoch: connection.replacedEpoch };
  }
  db.run(`UPDATE members SET rejoins = rejoins + 1 WHERE user_id = ?;`, user.userId);
  return { role: "PLAYER", epoch: rejoinSeat(db, user.userId), kind: "REJOIN", replacedEpoch: null };
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

export type RoomOutcome =
  | { readonly kind: "COMMITTED"; readonly event: GameplayEvent | null }
  | { readonly kind: "DUPLICATE" }
  | {
      readonly kind: "REJECTED";
      readonly actionId: string;
      readonly reason: GameplayRejectionReason | LobbyRejection | "MALFORMED_COMMAND";
      readonly currentGameVersion?: number;
    };

function lobbyRejected(reason: LobbyRejection): RoomOutcome {
  return { kind: "REJECTED", actionId: "lobby", reason };
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
      auctionDecisionDeadlineAt: deps.now + AUCTION_DECISION_MS,
      debtDeadlineAt: deps.now + DEBT_WINDOW_MS,
      appliedActions: applied === undefined
        ? []
        : [{ gameId: command.gameId, actionId: command.actionId, resultingGameVersion: applied.game_version }],
    });
  } catch (error) {
    if (error instanceof CommandValidationError) {
      return { kind: "REJECTED", actionId: command.actionId, reason: "MALFORMED_COMMAND" };
    }
    throw error;
  }
  if (result.kind === "DUPLICATE_ACTION") return { kind: "DUPLICATE" };
  if (result.kind === "REJECTED") {
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
    syncTurnDeadline(db, game.game_id, previous, next, turnMs, deps.now);
  });
  return { kind: "COMMITTED", event: result.event };
}

/** RT-004: a client's game command. Only seated members may act; system/lobby commands are refused. */
export function handleCommand(db: SqlDb, userId: string, wire: WireCommand, deps: RuntimeDeps): RoomOutcome {
  if (SYSTEM_COMMAND_TYPES.has(wire.type) || LOBBY_OWNED_COMMANDS.has(wire.type)) {
    return { kind: "REJECTED", actionId: wire.actionId, reason: "SYSTEM_COMMAND" };
  }
  if (member(db, userId) === undefined) return { kind: "REJECTED", actionId: wire.actionId, reason: "NOT_A_MEMBER" };
  return commit(db, deps, userId, wire);
}

/** RT-001 lobby actions: ready/leave for members, configure/start for the host. */
export function handleLobby(db: SqlDb, userId: string, action: LobbyAction, deps: RuntimeDeps): RoomOutcome {
  const current = room(db);
  if (current === undefined) return lobbyRejected("NOT_A_MEMBER");
  if (current.phase !== "LOBBY") return lobbyRejected("NOT_IN_LOBBY");
  const self = member(db, userId);
  if (self === undefined) return lobbyRejected("NOT_A_MEMBER");
  const isHost = current.host_user_id === userId;
  switch (action.kind) {
    case "SET_READY":
      db.run(`UPDATE members SET ready = ? WHERE user_id = ?;`, action.ready ? 1 : 0, userId);
      return { kind: "COMMITTED", event: null };
    case "LEAVE":
      if (isHost) return lobbyRejected("HOST_CANNOT_LEAVE");
      db.transaction(() => {
        db.run(`DELETE FROM members WHERE user_id = ?;`, userId);
        db.run(`DELETE FROM seats WHERE user_id = ?;`, userId);
      });
      return { kind: "COMMITTED", event: null };
    case "CONFIGURE":
      if (!isHost) return lobbyRejected("NOT_HOST");
      if (!validStartingCash(action.settings.startingCash)) return lobbyRejected("INVALID_SETTINGS");
      db.run(`UPDATE room SET settings_json = ?;`, JSON.stringify(action.settings));
      db.run(`UPDATE members SET ready = 0;`);
      return { kind: "COMMITTED", event: null };
    case "START":
      if (!isHost) return lobbyRejected("NOT_HOST");
      return startGame(db, current, deps);
  }
}

function startGame(db: SqlDb, current: RoomRow, deps: RuntimeDeps): RoomOutcome {
  const seated = members(db);
  if (seated.length < 3 || seated.length > MAX_SEATS || seated.some((row) => row.ready !== 1)) {
    return lobbyRejected("NOT_ENOUGH_READY_PLAYERS");
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
    if (error instanceof GameStateValidationError) return lobbyRejected("INVALID_SETTINGS");
    throw error;
  }
  const started = applyGameplayCommand(
    initial,
    { type: "START_GAME", gameId, actionId: "start:" + gameId, payload: {} },
    { actorUserId: current.host_user_id, board, rng: deps.rng, cardCatalog: cards, currentTime: deps.now },
  );
  if (started.kind !== "ACCEPTED") return lobbyRejected("INVALID_SETTINGS");
  db.transaction(() => {
    db.run(`INSERT INTO games (game_id, board_ref, state_json, game_version, created_at) VALUES (?, ?, ?, ?, ?);`,
      gameId, settings.boardRef, JSON.stringify(started.state), started.state.gameVersion, deps.now);
    db.run(`INSERT INTO applied_actions (game_id, action_id, game_version) VALUES (?, ?, ?);`,
      gameId, "start:" + gameId, started.state.gameVersion);
    db.run(`UPDATE room SET phase = 'IN_GAME', current_game_id = ?;`, gameId);
    syncTurnDeadline(db, gameId, null, started.state, settings.turnSeconds * 1000, deps.now);
  });
  return { kind: "COMMITTED", event: started.event };
}

interface DueTimeout {
  readonly at: number;
  readonly command: GameCommand;
}

function dueTimeouts(db: SqlDb, now: number): DueTimeout[] {
  const game = currentGame(db);
  if (game === undefined) return [];
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
        "timeout:auction:" + auction.auctionId + ":" + auction.currentActorUserId + ":" + auction.decisionDeadlineAt,
        { auctionId: auction.auctionId, actorUserId: auction.currentActorUserId, decisionDeadlineAt: auction.decisionDeadlineAt }),
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

/** The single alarm time: the earliest pending auction, debt, or turn deadline. */
export function nextAlarmAt(db: SqlDb): number | null {
  const game = currentGame(db);
  if (game === undefined) return null;
  const state = loadState(game);
  if (state.phase !== "ACTIVE_TURN") return null;
  const turn = db.get<DeadlineRow>(`SELECT turn_id, deadline_at, extended FROM turn_deadline WHERE game_id = ?;`, game.game_id);
  const candidates = [
    state.auction?.decisionDeadlineAt,
    state.ruleState.debt?.deadlineAt,
    ownerDecision(state) ? turn?.deadline_at ?? undefined : undefined,
  ].filter((value): value is number => typeof value === "number");
  return candidates.length === 0 ? null : Math.min(...candidates);
}

/** RT-008: a genuine within-lease reconnect by the turn owner earns +20 s once per turn. */
export function grantReconnectExtension(db: SqlDb, userId: string): boolean {
  const game = currentGame(db);
  if (game === undefined) return false;
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
  const seats = new Map(db.all<{ user_id: string; connected: number; lease_expires_at: number | null }>(
    `SELECT user_id, connected, lease_expires_at FROM seats;`,
  ).map((row) => [row.user_id, row]));
  const game = currentGame(db);
  const turn = game === undefined
    ? undefined
    : db.get<DeadlineRow>(`SELECT turn_id, deadline_at, extended FROM turn_deadline WHERE game_id = ?;`, game.game_id);
  return {
    roomCode: current.code,
    hostUserId: current.host_user_id,
    phase: current.phase === "IN_GAME" ? "IN_GAME" : "LOBBY",
    settings: settingsOf(current),
    members: members(db).map((row): MemberView => {
      const seat = seats.get(row.user_id);
      const connected = seat?.connected === 1;
      return {
        userId: row.user_id,
        displayName: row.display_name,
        seatIndex: row.seat_index,
        ready: row.ready === 1,
        connected,
        away: !connected && (seat?.lease_expires_at == null || now > seat.lease_expires_at),
      };
    }),
    turnDeadlineAt: turn?.deadline_at ?? null,
  };
}

/** RT-014 foundation: the current game as this viewer may see it. */
export function viewerGame(db: SqlDb, viewerUserId: string | null): ProjectedGameState | null {
  const game = currentGame(db);
  return game === undefined ? null : projectGameState(loadState(game), viewerUserId);
}
