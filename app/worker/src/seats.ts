/**
 * SPIKE-004 room-scoped seat / connection-epoch / reconnect-lease logic.
 *
 * A seat binds to the authenticated internal `userId` (ARCHITECTURE §12) — never
 * to a socket, tab or IP. This state is ROOM-scoped: it survives a rematch (a new
 * gameId) unchanged, because connection lifecycle and game lifecycle are
 * orthogonal (SPIKE-004/005 cross-invariants A & F).
 *
 * Durable truth lives in SQLite:
 *
 *   seats(user_id PK, connection_epoch, connected, lease_expires_at)
 *
 * Each socket carries only a non-authoritative attachment `{ userId, epoch }`
 * (no reusable auth token). Every command re-validates that epoch against the
 * persisted `connection_epoch`, so a stale socket — even one that survived
 * hibernation — cannot mutate anything. `connection_epoch` advances on every
 * accepted connection, so the previous socket becomes stale immediately.
 *
 * These constants are the room reconnect lease, NOT the application-session
 * lifetime (which is issued/verified separately in session.ts and long outlives
 * this lease — ADR-002).
 */

import type { SqlDb } from "./transition";

export const DISCONNECT_GRACE_MS = 90_000;
export const ACTIVE_TURN_RECONNECT_EXTENSION_MS = 20_000;

const SEATS_SCHEMA = `CREATE TABLE IF NOT EXISTS seats (
  user_id TEXT PRIMARY KEY,
  connection_epoch INTEGER NOT NULL,
  connected INTEGER NOT NULL,
  lease_expires_at INTEGER
);`;

export function ensureSeatSchema(db: SqlDb): void {
  db.run(SEATS_SCHEMA);
}

/** How a new accepted connection relates to the seat's prior state. */
export type ConnectKind =
  | "NEW" // first connection for this seat
  | "TAKEOVER" // replaced a still-live socket (second tab / duplicate session)
  | "RECONNECT" // reclaimed a disconnected seat within the lease
  | "RECONNECT_EXPIRED"; // reclaimed after the lease expired (policy applies)

export interface ConnectResult {
  /**
   * True when the connection was accepted as the seat's authoritative socket.
   * False ONLY for `RECONNECT_EXPIRED` — the lease elapsed, so the seat is not
   * reclaimed and NO authoritative epoch is issued to this socket (fail closed).
   * The caller MUST NOT bind an attachment/epoch when this is false.
   */
  accepted: boolean;
  /**
   * The authoritative epoch bound to the accepted socket. When `accepted` is
   * false this is the seat's UNCHANGED persisted epoch (informational only — no
   * new epoch was issued) and must not be treated as authoritative for the
   * connecting socket.
   */
  epoch: number;
  kind: ConnectKind;
  /** True when a still-live previous socket was superseded (send it SESSION_REPLACED). */
  replacedLiveSocket: boolean;
  /** The superseded epoch (the socket that is now stale), or null. */
  replacedEpoch: number | null;
}

interface SeatRow extends Record<string, string | number | null> {
  connection_epoch: number;
  connected: number;
  lease_expires_at: number | null;
}

/**
 * Accepts an authenticated connection for `userId` and atomically advances the
 * seat's `connection_epoch`. Identity comes from the caller (derived from the
 * verified app session) — never from client-supplied userId/epoch/IP. Returns
 * the new epoch and how it relates to the seat's prior state so the caller can
 * apply the correct policy (send SESSION_REPLACED, allow turn extension, …).
 */
export function connectSeat(
  db: SqlDb,
  userId: string,
  now: number,
): ConnectResult {
  return db.transaction((): ConnectResult => {
    const seat = db.get<SeatRow>(
      `SELECT connection_epoch, connected, lease_expires_at FROM seats WHERE user_id = ?;`,
      userId,
    );

    if (seat === undefined) {
      db.run(
        `INSERT INTO seats (user_id, connection_epoch, connected, lease_expires_at)
         VALUES (?, 1, 1, NULL);`,
        userId,
      );
      return {
        accepted: true,
        epoch: 1,
        kind: "NEW",
        replacedLiveSocket: false,
        replacedEpoch: null,
      };
    }

    const withinLease =
      seat.lease_expires_at !== null && now <= seat.lease_expires_at;

    // Fail closed: once the 90s lease has elapsed, a reconnect does NOT reclaim
    // the seat. We write nothing — the seat stays disconnected with its expired
    // lease — and issue no epoch, so the socket cannot become authoritative or
    // mutate anything. A future re-seat/rejoin flow (lobby, RT-001) is the only
    // path back; that policy is deliberately NOT decided in this spike.
    if (seat.connected === 0 && !withinLease) {
      return {
        accepted: false,
        epoch: seat.connection_epoch, // unchanged; NOT issued to this socket
        kind: "RECONNECT_EXPIRED",
        replacedLiveSocket: false,
        replacedEpoch: null,
      };
    }

    const newEpoch = seat.connection_epoch + 1;
    const kind: ConnectKind = seat.connected === 1 ? "TAKEOVER" : "RECONNECT";
    db.run(
      `UPDATE seats SET connection_epoch = ?, connected = 1, lease_expires_at = NULL
         WHERE user_id = ?;`,
      newEpoch,
      userId,
    );
    return {
      accepted: true,
      epoch: newEpoch,
      kind,
      replacedLiveSocket: seat.connected === 1,
      replacedEpoch: seat.connection_epoch,
    };
  });
}

export interface DisconnectResult {
  /** True only when the CURRENT socket disconnected and a lease was opened. */
  applied: boolean;
  leaseExpiresAt: number | null;
}

/**
 * Records that a socket closed. Only the seat's CURRENT socket (matching epoch)
 * may open a reconnect lease; a stale socket closing later is a no-op, so it can
 * never mark the current connection as disconnected (SPIKE-004 stale-close race).
 */
export function disconnectSeat(
  db: SqlDb,
  userId: string,
  epoch: number,
  now: number,
  graceMs: number = DISCONNECT_GRACE_MS,
): DisconnectResult {
  return db.transaction((): DisconnectResult => {
    const seat = db.get<SeatRow>(
      `SELECT connection_epoch, connected, lease_expires_at FROM seats WHERE user_id = ?;`,
      userId,
    );
    if (seat === undefined || seat.connection_epoch !== epoch) {
      return { applied: false, leaseExpiresAt: null };
    }
    const leaseExpiresAt = now + graceMs;
    db.run(
      `UPDATE seats SET connected = 0, lease_expires_at = ? WHERE user_id = ?;`,
      leaseExpiresAt,
      userId,
    );
    return { applied: true, leaseExpiresAt };
  });
}

/** True when `epoch` is the seat's current epoch — the guard for every command. */
export function isCurrentEpoch(db: SqlDb, userId: string, epoch: number): boolean {
  const seat = db.get<{ connection_epoch: number }>(
    `SELECT connection_epoch FROM seats WHERE user_id = ?;`,
    userId,
  );
  return seat !== undefined && seat.connection_epoch === epoch;
}

export interface SeatStatus {
  epoch: number;
  connected: boolean;
  leaseExpiresAt: number | null;
}

/** Reads persisted seat truth (used after reconstruction and in tests). */
export function seatStatus(db: SqlDb, userId: string): SeatStatus | undefined {
  const seat = db.get<SeatRow>(
    `SELECT connection_epoch, connected, lease_expires_at FROM seats WHERE user_id = ?;`,
    userId,
  );
  if (seat === undefined) return undefined;
  return {
    epoch: seat.connection_epoch,
    connected: seat.connected === 1,
    leaseExpiresAt: seat.lease_expires_at,
  };
}
