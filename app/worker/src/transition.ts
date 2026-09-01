/**
 * SPIKE-002 authoritative transition — the persist-before-broadcast pipeline
 * from ADR-003, made idempotent and crash-safe.
 *
 * SPIKE-001 committed state with a single `UPDATE … RETURNING` but persisted NO
 * idempotency metadata, so a retried command could not be recognised as a
 * duplicate from durable state. That is the ADR-003 `actionId` requirement;
 * SPIKE-002 adds the minimum persisted mechanism:
 *
 *   - `applied_actions(action_id PRIMARY KEY, game_version, value)` records the
 *     RESULT of each committed action;
 *   - the `game_state` mutation and the `applied_actions` insert commit in ONE
 *     SQLite transaction, so there is no crash window where state advances
 *     without its idempotency record (or vice-versa);
 *   - a retry of an already-committed `actionId` returns the recorded result
 *     from durable state — it never re-applies, so `gameVersion` advances at
 *     most once per unique action.
 *
 * Runtime-agnostic: it operates on the {@link SqlDb} seam (implemented over the
 * DO's `SqlStorage` in production and `node:sqlite` in tests), so the exact
 * transaction logic is exercised against real SQLite. Fault injection is opt-in
 * (`opts.fault`) and test-only — production callers pass nothing, so no fault
 * or "broken ordering" code path is reachable at runtime.
 */

export interface GameState {
  gameVersion: number;
  value: number;
}

/** Minimal transaction-capable SQL seam. `transaction` must roll back on throw. */
export interface SqlDb {
  /** Runs a mutating statement; returns rows written/changed. */
  run(sql: string, ...params: (string | number)[]): number;
  get<T extends Record<string, string | number>>(
    sql: string,
    ...params: (string | number)[]
  ): T | undefined;
  transaction<T>(fn: () => T): T;
}

/**
 * Deterministic fault boundaries. `DURING_WRITE_*` fire inside the transaction
 * (must roll back); `AFTER_WRITE_BEFORE_BROADCAST` fires after commit (state is
 * durable, but the caller never broadcasts).
 */
export type FaultPoint =
  | "BEFORE_WRITE"
  | "DURING_WRITE_AFTER_UPDATE"
  | "DURING_WRITE_AFTER_INSERT"
  | "AFTER_WRITE_BEFORE_BROADCAST";

export class FaultInjected extends Error {
  constructor(readonly point: FaultPoint) {
    super(`fault:${point}`);
    this.name = "FaultInjected";
  }
}

export interface ApplyOptions {
  /** Test-only: throws {@link FaultInjected} at the chosen boundary. */
  fault?: (point: FaultPoint) => void;
  /**
   * NEGATIVE-SANITY ONLY: commit the state mutation and the idempotency record
   * in SEPARATE transactions instead of one. This re-introduces the exact
   * crash window ADR-003 forbids and lets a test prove the suite detects it. It
   * is never set by production callers.
   */
  brokenOrdering?: boolean;
}

export interface ApplyResult {
  state: GameState;
  /** true when the actionId was already committed (no mutation happened). */
  duplicate: boolean;
}

const GAME_STATE_SCHEMA = `CREATE TABLE IF NOT EXISTS game_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  game_version INTEGER NOT NULL,
  value INTEGER NOT NULL
);`;

const APPLIED_ACTIONS_SCHEMA = `CREATE TABLE IF NOT EXISTS applied_actions (
  action_id TEXT PRIMARY KEY,
  game_version INTEGER NOT NULL,
  value INTEGER NOT NULL
);`;

interface StateRow extends Record<string, string | number> {
  game_version: number;
  value: number;
}

export function ensureSchema(db: SqlDb): void {
  db.run(GAME_STATE_SCHEMA);
  db.run(APPLIED_ACTIONS_SCHEMA);
  db.run(
    `INSERT OR IGNORE INTO game_state (id, game_version, value) VALUES (1, 0, 0);`,
  );
}

export function readState(db: SqlDb): GameState {
  const row = db.get<StateRow>(
    `SELECT game_version, value FROM game_state WHERE id = 1;`,
  );
  if (row === undefined) throw new Error("game_state row missing");
  return { gameVersion: row.game_version, value: row.value };
}

/** Reads a committed action's recorded result from durable state, if any. */
export function recordedResult(
  db: SqlDb,
  actionId: string,
): GameState | undefined {
  const row = db.get<StateRow>(
    `SELECT game_version, value FROM applied_actions WHERE action_id = ?;`,
    actionId,
  );
  return row === undefined
    ? undefined
    : { gameVersion: row.game_version, value: row.value };
}

function mutate(db: SqlDb): GameState {
  const row = db.get<StateRow>(
    `UPDATE game_state
       SET game_version = game_version + 1, value = value + 1
       WHERE id = 1
       RETURNING game_version, value;`,
  );
  if (row === undefined) throw new Error("game_state row missing");
  return { gameVersion: row.game_version, value: row.value };
}

function recordAction(db: SqlDb, actionId: string, state: GameState): void {
  db.run(
    `INSERT INTO applied_actions (action_id, game_version, value) VALUES (?, ?, ?);`,
    actionId,
    state.gameVersion,
    state.value,
  );
}

/**
 * Idempotently applies one INCREMENT for `actionId`, committing state + record
 * atomically, and returns the authoritative post-state. The caller broadcasts
 * ONLY after this returns (persist-before-broadcast).
 */
export function applyIncrement(
  db: SqlDb,
  actionId: string,
  opts: ApplyOptions = {},
): ApplyResult {
  opts.fault?.("BEFORE_WRITE");

  // Idempotency comes from PERSISTED state, not an in-memory Set — a freshly
  // reconstructed instance recognises the duplicate just the same.
  const prior = recordedResult(db, actionId);
  if (prior !== undefined) return { state: prior, duplicate: true };

  if (opts.brokenOrdering === true) {
    // Deliberately non-atomic: state and record in two transactions with a
    // crash window between them. Used only by the negative-sanity test.
    const state = db.transaction(() => mutate(db));
    opts.fault?.("DURING_WRITE_AFTER_UPDATE");
    db.transaction(() => {
      recordAction(db, actionId, state);
    });
    opts.fault?.("AFTER_WRITE_BEFORE_BROADCAST");
    return { state, duplicate: false };
  }

  // Correct: single atomic transaction. A throw at either DURING_WRITE point
  // rolls the whole transaction back — no torn state, no orphan record.
  const state = db.transaction(() => {
    const next = mutate(db);
    opts.fault?.("DURING_WRITE_AFTER_UPDATE");
    recordAction(db, actionId, next);
    opts.fault?.("DURING_WRITE_AFTER_INSERT");
    return next;
  });

  // Committed and durable. A fault here loses only the broadcast; the retry
  // recovers the recorded result above without advancing gameVersion again.
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
 * Resolves what a client INCREMENT should emit, fixing the stale-broadcast bug:
 * a fresh commit broadcasts the new (current) state; a duplicate retry — even of
 * an action that committed BEFORE newer ones — never broadcasts its historical
 * snapshot. The persisted action result is retained (idempotency metadata); it
 * is simply not published as current room state.
 */
export function handleIncrement(
  db: SqlDb,
  actionId: string,
  opts: ApplyOptions = {},
): IncrementOutcome {
  const result = applyIncrement(db, actionId, opts);
  if (result.duplicate) {
    return { duplicate: true, broadcast: null, current: readState(db) };
  }
  // A fresh commit is, by definition, the current authoritative snapshot.
  return { duplicate: false, broadcast: result.state, current: result.state };
}

/** Owned by the alarm resolution logic (below); created by the DO + tests. */
export const DEADLINES_SCHEMA = `CREATE TABLE IF NOT EXISTS deadlines (
  id TEXT PRIMARY KEY,
  fire_at INTEGER NOT NULL,
  resolved INTEGER NOT NULL DEFAULT 0
);`;

export interface AlarmOutcome {
  /** How many due deadlines this firing resolved. */
  resolved: number;
  /** Post-commit snapshot to broadcast, or null when nothing was due. */
  broadcast: GameState | null;
}

/**
 * Resolves every due deadline and advances canonical state ONCE, atomically.
 *
 * Batch semantics (consistent with SPIKE-001): one alarm firing that finds ≥1
 * due deadline resolves them all and advances `gameVersion` exactly once. The
 * deadline resolution AND the state mutation commit in one transaction, so a
 * crash can never leave a deadline resolved without its state change (or the
 * reverse). The `resolved = 0` guard makes an alarm replay a no-op, so
 * at-least-once alarm delivery cannot double-apply. Broadcast happens only after
 * this returns (i.e. after commit).
 */
export function resolveDueAlarm(
  db: SqlDb,
  now: number,
  opts: ApplyOptions = {},
): AlarmOutcome {
  opts.fault?.("BEFORE_WRITE");
  const outcome = db.transaction((): { resolved: number; state: GameState | null } => {
    const resolved = db.run(
      `UPDATE deadlines SET resolved = 1 WHERE resolved = 0 AND fire_at <= ?;`,
      now,
    );
    // For the alarm path: after the deadline-resolution write, before state.
    opts.fault?.("DURING_WRITE_AFTER_UPDATE");
    if (resolved === 0) return { resolved: 0, state: null };
    const state = mutate(db);
    // After the canonical state write, before commit.
    opts.fault?.("DURING_WRITE_AFTER_INSERT");
    return { resolved, state };
  });
  opts.fault?.("AFTER_WRITE_BEFORE_BROADCAST");
  return { resolved: outcome.resolved, broadcast: outcome.state };
}
