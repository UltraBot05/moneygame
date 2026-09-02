/**
 * Authoritative game-scoped persistence — the ADR-003 persist-before-broadcast
 * pipeline (SPIKE-002), now namespaced by `gameId` so a rematch in the same room
 * cannot alias or collide with the previous game (SPIKE-005).
 *
 * SPIKE-002 proved crash-safe idempotency for a single game. SPIKE-005 audited
 * that persistence and found it keyed only by `action_id`, `id`, or a single
 * `id = 1` row — not sufficient across independent games. Every game-scoped table
 * now carries `game_id`:
 *
 *   - `game_state(game_id PK, game_version, value)`   — one canonical row per game
 *   - `applied_actions(game_id, action_id, …) PK(game_id, action_id)` — idempotency
 *   - `deadlines(game_id, id, fire_at, resolved) PK(game_id, id)`     — timers
 *
 * A tiny room-scoped registry names the current game:
 *
 *   - `games(game_id PK, board_id, board_version, tile_count, created_at)`
 *   - `room_state(id=1, current_game_id)`
 *
 * Commands are validated against `current_game_id` (`requireCurrentGame`), so a
 * delayed command or alarm targeting an ended game is rejected/ignored and can
 * never mutate the new game. `value` is SPIKE-002's toy canonical counter; the
 * rich mutable GameState (ownership/decks/…) is proven isolated in game-core.
 *
 * Runtime-agnostic over the {@link SqlDb} seam (DO `SqlStorage` in production,
 * `node:sqlite` in tests). Fault injection is opt-in and test-only.
 */

export interface GameState {
  gameVersion: number;
  value: number;
}

/** Minimal transaction-capable SQL seam. `transaction` must roll back on throw. */
export interface SqlDb {
  /** Runs a mutating statement; returns rows written/changed. */
  run(sql: string, ...params: (string | number)[]): number;
  // `null` is included because nullable SQLite columns (e.g. a reconnect lease)
  // read back as null.
  get<T extends Record<string, string | number | null>>(
    sql: string,
    ...params: (string | number)[]
  ): T | undefined;
  transaction<T>(fn: () => T): T;
}

export type FaultPoint =
  | "BEFORE_WRITE"
  | "DURING_WRITE_AFTER_UPDATE"
  | "DURING_WRITE_AFTER_INSERT"
  | "AFTER_WRITE_BEFORE_BROADCAST";

export class FaultInjected extends Error {
  constructor(point: FaultPoint) {
    super(`fault:${point}`);
    this.name = "FaultInjected";
  }
}

/** Thrown when a command/alarm targets a game that is no longer the room's current game. */
export class StaleGameError extends Error {
  constructor(targetGameId: string, currentGameId: string | null) {
    super(`STALE_GAME: ${targetGameId} != current ${currentGameId ?? "none"}`);
    this.name = "StaleGameError";
  }
}

export interface ApplyOptions {
  /** Test-only: throws {@link FaultInjected} at the chosen boundary. */
  fault?: (point: FaultPoint) => void;
  /**
   * NEGATIVE-SANITY ONLY: commit the state mutation and the idempotency record
   * in SEPARATE transactions instead of one, re-introducing the crash window
   * ADR-003 forbids so a test can prove the suite detects it. Never set in prod.
   */
  brokenOrdering?: boolean;
}

export interface ApplyResult {
  state: GameState;
  duplicate: boolean;
}

// --- schema ------------------------------------------------------------------

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS room_state (
     id INTEGER PRIMARY KEY CHECK (id = 1),
     current_game_id TEXT
   );`,
  `CREATE TABLE IF NOT EXISTS games (
     game_id TEXT PRIMARY KEY,
     board_id TEXT NOT NULL,
     board_version INTEGER NOT NULL,
     tile_count INTEGER NOT NULL,
     created_at INTEGER NOT NULL
   );`,
  `CREATE TABLE IF NOT EXISTS game_state (
     game_id TEXT PRIMARY KEY,
     game_version INTEGER NOT NULL,
     value INTEGER NOT NULL
   );`,
  `CREATE TABLE IF NOT EXISTS applied_actions (
     game_id TEXT NOT NULL,
     action_id TEXT NOT NULL,
     game_version INTEGER NOT NULL,
     value INTEGER NOT NULL,
     PRIMARY KEY (game_id, action_id)
   );`,
  `CREATE TABLE IF NOT EXISTS active_turn (
     game_id TEXT PRIMARY KEY,
     turn_id TEXT NOT NULL,
     owner_user_id TEXT NOT NULL
   );`,
  `CREATE TABLE IF NOT EXISTS turn_extensions (
     game_id TEXT NOT NULL,
     turn_id TEXT NOT NULL,
     PRIMARY KEY (game_id, turn_id)
   );`,
];

/**
 * Deadlines are game-scoped and (game_id, id) unique. `resolved = 0`-filtered
 * queries are indexed so reads do not grow with resolved history (SPIKE-001 M2).
 */
const DEADLINES_SCHEMA = `CREATE TABLE IF NOT EXISTS deadlines (
  game_id TEXT NOT NULL,
  id TEXT NOT NULL,
  fire_at INTEGER NOT NULL,
  resolved INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (game_id, id)
);`;

interface StateRow extends Record<string, string | number> {
  game_version: number;
  value: number;
}

export function ensureSchema(db: SqlDb): void {
  for (const stmt of SCHEMA) db.run(stmt);
  db.run(DEADLINES_SCHEMA);
  db.run(`INSERT OR IGNORE INTO room_state (id, current_game_id) VALUES (1, NULL);`);
}

// --- game registry / rematch -------------------------------------------------

export interface NewGame {
  gameId: string;
  boardId: string;
  boardVersion: number;
  tileCount: number;
}

export function currentGameId(db: SqlDb): string | null {
  const row = db.get<{ current_game_id: string }>(
    `SELECT current_game_id FROM room_state WHERE id = 1;`,
  );
  return row === undefined || row.current_game_id === null
    ? null
    : row.current_game_id;
}

/**
 * Atomically starts a fresh game and makes it the room's current game. The
 * `games` row, the fresh `game_state` row, and the `room_state.current_game_id`
 * pointer commit together, so no reader ever sees `new gameId + old state` or
 * `old gameId + new state`. The caller broadcasts only after this returns.
 * Old games' rows are left in place, harmlessly, because every game-scoped read
 * is filtered by `game_id` — isolation is by namespace, not by cleanup.
 */
export function startGame(db: SqlDb, game: NewGame, now: number): GameState {
  return db.transaction(() => {
    db.run(
      `INSERT INTO games (game_id, board_id, board_version, tile_count, created_at)
       VALUES (?, ?, ?, ?, ?);`,
      game.gameId,
      game.boardId,
      game.boardVersion,
      game.tileCount,
      now,
    );
    db.run(
      `INSERT INTO game_state (game_id, game_version, value) VALUES (?, 0, 0);`,
      game.gameId,
    );
    db.run(`UPDATE room_state SET current_game_id = ? WHERE id = 1;`, game.gameId);
    return { gameVersion: 0, value: 0 };
  });
}

/**
 * Throws {@link StaleGameError} unless `gameId` is the room's current game. This
 * is the guard that stops a delayed command aimed at an ended game from touching
 * the new game (SPIKE-005 cross-invariant C).
 */
function requireCurrentGame(db: SqlDb, gameId: string): void {
  const current = currentGameId(db);
  if (current !== gameId) throw new StaleGameError(gameId, current);
}

export type GameScopedCheck =
  | { ok: true; gameId: string }
  | { ok: false; code: "GAME_ID_REQUIRED" | "STALE_GAME" };

/**
 * The single protocol guard every client-originated game-scoped mutation runs
 * BEFORE any write (SPIKE-005): a missing `gameId` is rejected `GAME_ID_REQUIRED`;
 * a present-but-not-current `gameId` is rejected `STALE_GAME`. It never
 * substitutes the current game for a missing/stale one, so a delayed command
 * created during an ended game cannot silently mutate the new game. Read-only —
 * a rejected command performs zero writes.
 */
export function checkGameScoped(
  db: SqlDb,
  providedGameId: string | undefined,
): GameScopedCheck {
  if (providedGameId === undefined) return { ok: false, code: "GAME_ID_REQUIRED" };
  if (providedGameId !== currentGameId(db)) return { ok: false, code: "STALE_GAME" };
  return { ok: true, gameId: providedGameId };
}

// --- canonical state ---------------------------------------------------------

export function readState(db: SqlDb, gameId: string): GameState {
  const row = db.get<StateRow>(
    `SELECT game_version, value FROM game_state WHERE game_id = ?;`,
    gameId,
  );
  if (row === undefined) throw new Error(`game_state row missing: ${gameId}`);
  return { gameVersion: row.game_version, value: row.value };
}

export function recordedResult(
  db: SqlDb,
  gameId: string,
  actionId: string,
): GameState | undefined {
  const row = db.get<StateRow>(
    `SELECT game_version, value FROM applied_actions WHERE game_id = ? AND action_id = ?;`,
    gameId,
    actionId,
  );
  return row === undefined
    ? undefined
    : { gameVersion: row.game_version, value: row.value };
}

function mutate(db: SqlDb, gameId: string): GameState {
  const row = db.get<StateRow>(
    `UPDATE game_state
       SET game_version = game_version + 1, value = value + 1
       WHERE game_id = ?
       RETURNING game_version, value;`,
    gameId,
  );
  if (row === undefined) throw new Error(`game_state row missing: ${gameId}`);
  return { gameVersion: row.game_version, value: row.value };
}

function recordAction(
  db: SqlDb,
  gameId: string,
  actionId: string,
  state: GameState,
): void {
  db.run(
    `INSERT INTO applied_actions (game_id, action_id, game_version, value)
     VALUES (?, ?, ?, ?);`,
    gameId,
    actionId,
    state.gameVersion,
    state.value,
  );
}

/**
 * Idempotently applies one INCREMENT for `(gameId, actionId)`, committing state
 * + record atomically, and returns the authoritative post-state. Broadcast only
 * after this returns (persist-before-broadcast).
 */
export function applyIncrement(
  db: SqlDb,
  gameId: string,
  actionId: string,
  opts: ApplyOptions = {},
): ApplyResult {
  opts.fault?.("BEFORE_WRITE");

  const prior = recordedResult(db, gameId, actionId);
  if (prior !== undefined) return { state: prior, duplicate: true };

  if (opts.brokenOrdering === true) {
    const state = db.transaction(() => mutate(db, gameId));
    opts.fault?.("DURING_WRITE_AFTER_UPDATE");
    db.transaction(() => {
      recordAction(db, gameId, actionId, state);
    });
    opts.fault?.("AFTER_WRITE_BEFORE_BROADCAST");
    return { state, duplicate: false };
  }

  const state = db.transaction(() => {
    const next = mutate(db, gameId);
    opts.fault?.("DURING_WRITE_AFTER_UPDATE");
    recordAction(db, gameId, actionId, next);
    opts.fault?.("DURING_WRITE_AFTER_INSERT");
    return next;
  });

  opts.fault?.("AFTER_WRITE_BEFORE_BROADCAST");
  return { state, duplicate: false };
}

export interface IncrementOutcome {
  duplicate: boolean;
  /** Snapshot to broadcast to all sockets, or null when nothing changed. */
  broadcast: GameState | null;
  /** Current authoritative snapshot for the requester (never a stale one). */
  current: GameState;
}

/**
 * Command entry for a client INCREMENT. Rejects a command aimed at a stale game
 * BEFORE any mutation or idempotency write (SPIKE-005 C). Otherwise applies
 * SPIKE-002 B1 semantics: a fresh commit broadcasts the new state; a duplicate
 * retry broadcasts nothing and returns the CURRENT snapshot to the requester.
 */
export function handleIncrement(
  db: SqlDb,
  gameId: string,
  actionId: string,
  opts: ApplyOptions = {},
): IncrementOutcome {
  requireCurrentGame(db, gameId);
  const result = applyIncrement(db, gameId, actionId, opts);
  if (result.duplicate) {
    return { duplicate: true, broadcast: null, current: readState(db, gameId) };
  }
  return { duplicate: false, broadcast: result.state, current: result.state };
}

// --- alarm -------------------------------------------------------------------

export interface AlarmOutcome {
  resolved: number;
  broadcast: GameState | null;
}

/**
 * Resolves every due deadline of the CURRENT game and advances its canonical
 * state ONCE, atomically. Deadlines belonging to an ended game are never in the
 * current namespace, so an old-game alarm can never mutate the new game
 * (SPIKE-005 E). Batch semantics (SPIKE-001): one firing with ≥1 due deadline
 * resolves them all and advances `gameVersion` exactly once. The `resolved = 0`
 * guard keeps at-least-once alarm delivery idempotent. Broadcast after commit.
 */
export function resolveDueAlarm(
  db: SqlDb,
  now: number,
  opts: ApplyOptions = {},
): AlarmOutcome {
  const gameId = currentGameId(db);
  if (gameId === null) return { resolved: 0, broadcast: null };

  opts.fault?.("BEFORE_WRITE");
  const outcome = db.transaction((): { resolved: number; state: GameState | null } => {
    const resolved = db.run(
      `UPDATE deadlines SET resolved = 1
         WHERE game_id = ? AND resolved = 0 AND fire_at <= ?;`,
      gameId,
      now,
    );
    opts.fault?.("DURING_WRITE_AFTER_UPDATE");
    if (resolved === 0) return { resolved: 0, state: null };
    const state = mutate(db, gameId);
    opts.fault?.("DURING_WRITE_AFTER_INSERT");
    return { resolved, state };
  });
  opts.fault?.("AFTER_WRITE_BEFORE_BROADCAST");
  return { resolved: outcome.resolved, broadcast: outcome.state };
}

// --- turn deadline + active-turn reconnect extension (SPIKE-004) --------------

export interface SetTurnOptions {
  /** Test-only: throws after retiring the old turn, before installing the new. */
  fault?: () => void;
}

/**
 * Advances the active turn to `turnId` atomically. In ONE transaction it:
 *   1. retires the PREVIOUS active turn's deadline (identified explicitly by its
 *      `turnId`, not "the earliest deadline") if still pending — so the old turn
 *      deadline can never fire during the new turn;
 *   2. installs the new active turn;
 *   3. persists the new turn's absolute deadline.
 * Only the specific prior turn deadline is touched; unrelated (auction/trade/…)
 * deadlines are left alone. The caller reschedules the earliest alarm afterward.
 * Turn state is game-scoped, so a rematch starts with no turn and no extension
 * history.
 */
export function setActiveTurn(
  db: SqlDb,
  gameId: string,
  turnId: string,
  ownerUserId: string,
  deadlineAt: number,
  opts: SetTurnOptions = {},
): void {
  db.transaction(() => {
    const prev = db.get<{ turn_id: string }>(
      `SELECT turn_id FROM active_turn WHERE game_id = ?;`,
      gameId,
    );
    if (prev !== undefined && prev.turn_id !== turnId) {
      db.run(
        `UPDATE deadlines SET resolved = 1
           WHERE game_id = ? AND id = ? AND resolved = 0;`,
        gameId,
        prev.turn_id,
      );
    }
    opts.fault?.();
    db.run(
      `INSERT INTO active_turn (game_id, turn_id, owner_user_id) VALUES (?, ?, ?)
         ON CONFLICT (game_id) DO UPDATE SET turn_id = excluded.turn_id,
                                             owner_user_id = excluded.owner_user_id;`,
      gameId,
      turnId,
      ownerUserId,
    );
    db.run(
      `INSERT INTO deadlines (game_id, id, fire_at, resolved) VALUES (?, ?, ?, 0)
         ON CONFLICT (game_id, id) DO UPDATE SET fire_at = excluded.fire_at, resolved = 0;`,
      gameId,
      turnId,
      deadlineAt,
    );
  });
}

export interface ExtensionResult {
  granted: boolean;
  /** The turn deadline after extension (or the unchanged value when not granted). */
  deadlineAt: number | null;
}

/**
 * Grants the ACTIVE_TURN_RECONNECT_EXTENSION_MS at most once per `turnId`, only
 * when `userId` owns the still-active, still-unresolved turn. Non-stacking (a
 * second reconnect on the same turn is a no-op), local to that turn, and unable
 * to resurrect an already-resolved turn. The caller invokes this ONLY on a
 * genuine disconnect→reconnect (not a live-socket takeover), so merely opening a
 * second connection never extends the turn.
 */
export function grantTurnExtension(
  db: SqlDb,
  gameId: string,
  turnId: string,
  userId: string,
  extensionMs: number,
): ExtensionResult {
  return db.transaction((): ExtensionResult => {
    const turn = db.get<{ turn_id: string; owner_user_id: string }>(
      `SELECT turn_id, owner_user_id FROM active_turn WHERE game_id = ?;`,
      gameId,
    );
    // Not the active turn, or not owned by this user → ineligible.
    if (turn === undefined || turn.turn_id !== turnId || turn.owner_user_id !== userId) {
      return { granted: false, deadlineAt: null };
    }
    const deadline = db.get<{ fire_at: number; resolved: number }>(
      `SELECT fire_at, resolved FROM deadlines WHERE game_id = ? AND id = ?;`,
      gameId,
      turnId,
    );
    // Turn already resolved/advanced (or gone) → cannot be resurrected.
    if (deadline === undefined || deadline.resolved !== 0) {
      return { granted: false, deadlineAt: null };
    }
    // Already extended this turn → non-stacking no-op.
    const already = db.get<{ turn_id: string }>(
      `SELECT turn_id FROM turn_extensions WHERE game_id = ? AND turn_id = ?;`,
      gameId,
      turnId,
    );
    if (already !== undefined) {
      return { granted: false, deadlineAt: deadline.fire_at };
    }
    db.run(
      `INSERT INTO turn_extensions (game_id, turn_id) VALUES (?, ?);`,
      gameId,
      turnId,
    );
    const newDeadline = deadline.fire_at + extensionMs;
    db.run(
      `UPDATE deadlines SET fire_at = ? WHERE game_id = ? AND id = ? AND resolved = 0;`,
      newDeadline,
      gameId,
      turnId,
    );
    return { granted: true, deadlineAt: newDeadline };
  });
}
