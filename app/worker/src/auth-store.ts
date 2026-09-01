/**
 * SPIKE-003 server-side OAuth transaction store.
 *
 * Owns the `state -> {sanitized room, expiry, browser binding, PKCE verifier,
 * nonce}` mapping (ARCHITECTURE.md §11). The security-critical property is
 * one-time consumption: a single atomic `UPDATE ... WHERE consumed=0 AND
 * expires_at>? AND binding_hash=?` claims the row, so a replayed or concurrent
 * callback can never both succeed. Expiry and binding are enforced *inside* the
 * same statement (no check-then-consume TOCTOU) and a failed claim never burns
 * the row, so a wrong-binding attacker cannot DoS a victim's pending login.
 *
 * `SqlExec` is a minimal seam so the exact SQL runs against both the DO's
 * `SqlStorage` (production) and `node:sqlite` (tests) — see auth-store.test.ts.
 */

export interface SqlExec {
  /** Runs a mutating statement; returns rows written/changed. */
  run(sql: string, ...params: (string | number)[]): number;
  all<T>(sql: string, ...params: (string | number)[]): T[];
}

export interface OAuthTransaction {
  state: string;
  /** Already-sanitized room code; the store never sees raw input. */
  roomCode: string;
  nonce: string;
  verifier: string;
  bindingHash: string;
  /** Absolute expiry, ms since epoch. */
  expiresAt: number;
}

export type ConsumeFailure =
  | "NOT_FOUND"
  | "ALREADY_CONSUMED"
  | "EXPIRED"
  | "BINDING_MISMATCH";

export type ConsumeResult =
  | { ok: true; txn: OAuthTransaction }
  | { ok: false; reason: ConsumeFailure };

export interface TransactionStore {
  create(txn: OAuthTransaction): Promise<void>;
  consume(
    state: string,
    bindingHash: string,
    now: number,
  ): Promise<ConsumeResult>;
}

export const SCHEMA = `CREATE TABLE IF NOT EXISTS oauth_txn (
  state        TEXT PRIMARY KEY,
  room_code    TEXT NOT NULL,
  nonce        TEXT NOT NULL,
  verifier     TEXT NOT NULL,
  binding_hash TEXT NOT NULL,
  expires_at   INTEGER NOT NULL,
  consumed     INTEGER NOT NULL DEFAULT 0
);`;

interface Row extends Record<string, string | number> {
  state: string;
  room_code: string;
  nonce: string;
  verifier: string;
  binding_hash: string;
  expires_at: number;
  consumed: number;
}

function toTxn(row: Row): OAuthTransaction {
  return {
    state: row.state,
    roomCode: row.room_code,
    nonce: row.nonce,
    verifier: row.verifier,
    bindingHash: row.binding_hash,
    expiresAt: row.expires_at,
  };
}

const SELECT_ONE =
  `SELECT state, room_code, nonce, verifier, binding_hash, expires_at, consumed
     FROM oauth_txn WHERE state = ?;`;

export function createSqlTxnStore(sql: SqlExec): TransactionStore {
  sql.run(SCHEMA);
  return {
    // Methods are async to match the store interface used across the Durable
    // Object RPC boundary; the SQL itself is synchronous.
    async create(txn: OAuthTransaction): Promise<void> {
      sql.run(
        `INSERT INTO oauth_txn
           (state, room_code, nonce, verifier, binding_hash, expires_at, consumed)
         VALUES (?, ?, ?, ?, ?, ?, 0);`,
        txn.state,
        txn.roomCode,
        txn.nonce,
        txn.verifier,
        txn.bindingHash,
        txn.expiresAt,
      );
    },

    async consume(
      state: string,
      bindingHash: string,
      now: number,
    ): Promise<ConsumeResult> {
      // Atomic one-time claim: only an unconsumed, unexpired, correctly-bound
      // row can be marked consumed, and exactly one caller wins the write.
      const claimed = sql.run(
        `UPDATE oauth_txn SET consumed = 1
           WHERE state = ? AND consumed = 0 AND expires_at > ? AND binding_hash = ?;`,
        state,
        now,
        bindingHash,
      );
      if (claimed === 1) {
        const [row] = sql.all<Row>(SELECT_ONE, state);
        return { ok: true, txn: toTxn(row as Row) };
      }
      // Claim failed: report the precise reason without burning the row.
      const [row] = sql.all<Row>(SELECT_ONE, state);
      if (row === undefined) return { ok: false, reason: "NOT_FOUND" };
      if (row.consumed === 1) return { ok: false, reason: "ALREADY_CONSUMED" };
      if (row.expires_at <= now) return { ok: false, reason: "EXPIRED" };
      return { ok: false, reason: "BINDING_MISMATCH" };
    },
  };
}
