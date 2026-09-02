import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import {
  ACTIVE_TURN_RECONNECT_EXTENSION_MS,
  connectSeat,
  disconnectSeat,
  DISCONNECT_GRACE_MS,
  ensureSeatSchema,
  isCurrentEpoch,
  seatStatus,
} from "./seats";
import {
  ensureSchema,
  grantTurnExtension,
  handleIncrement,
  readState,
  resolveDueAlarm,
  setActiveTurn,
  startGame,
  type NewGame,
  type SqlDb,
} from "./transition";
import { nodeDb } from "./sqlite.testkit";

/**
 * SPIKE-004 — reconnect + connection epoch, proven on real `node:sqlite`.
 * Seat/epoch/lease truth is durable and re-validated from SQLite, so no
 * in-memory registry is required for correctness. Deterministic injected clock
 * (`now`) — no test waits 89/91 real seconds and no setTimeout is involved.
 */

const USER = "google:alice";
const OTHER = "google:bob";
const GAME_A: NewGame = { gameId: "A", boardId: "world-tour-standard", boardVersion: 1, tileCount: 40 };
const GAME_B: NewGame = { gameId: "B", boardId: "world-tour-grand", boardVersion: 1, tileCount: 52 };
const T0 = 1_000_000;

function seed(): { db: DatabaseSync; sql: SqlDb } {
  const db = new DatabaseSync(":memory:");
  const sql = nodeDb(db);
  ensureSchema(sql);
  ensureSeatSchema(sql);
  return { db, sql };
}

describe("SPIKE-004 seat ownership + epoch", () => {
  it("1. an authenticated user owns/reclaims only their own seat", () => {
    const { sql } = seed();
    const a = connectSeat(sql, USER, T0);
    const b = connectSeat(sql, OTHER, T0);
    expect(a.epoch).toBe(1);
    expect(b.epoch).toBe(1);
    // Bob's connection does not disturb Alice's seat/epoch.
    expect(seatStatus(sql, USER)?.epoch).toBe(1);
    expect(isCurrentEpoch(sql, USER, 1)).toBe(true);
    expect(isCurrentEpoch(sql, OTHER, 1)).toBe(true);
  });

  it("4/6. a new connection increments the epoch; current epoch is accepted", () => {
    const { sql } = seed();
    expect(connectSeat(sql, USER, T0).epoch).toBe(1);
    const second = connectSeat(sql, USER, T0 + 1);
    expect(second.epoch).toBe(2);
    expect(isCurrentEpoch(sql, USER, 2)).toBe(true);
  });

  it("5. a command from an old epoch is rejected", () => {
    const { sql } = seed();
    connectSeat(sql, USER, T0);
    connectSeat(sql, USER, T0 + 1); // epoch 2 now current
    expect(isCurrentEpoch(sql, USER, 1)).toBe(false);
  });

  it("7. taking over a live socket flags SESSION_REPLACED for the old epoch", () => {
    const { sql } = seed();
    connectSeat(sql, USER, T0); // epoch 1, live
    const takeover = connectSeat(sql, USER, T0 + 1);
    expect(takeover.kind).toBe("TAKEOVER");
    expect(takeover.replacedLiveSocket).toBe(true);
    expect(takeover.replacedEpoch).toBe(1); // room sends SESSION_REPLACED to epoch 1
  });

  it("8. a stale old close cannot disconnect the current socket (race)", () => {
    const { sql } = seed();
    connectSeat(sql, USER, T0); // A: epoch 1
    connectSeat(sql, USER, T0 + 1); // B: epoch 2 becomes current, A replaced
    // A's close event arrives AFTER B is current.
    const staleClose = disconnectSeat(sql, USER, 1, T0 + 2);
    expect(staleClose.applied).toBe(false);
    // B remains current and connected.
    expect(seatStatus(sql, USER)).toMatchObject({ epoch: 2, connected: true });
    expect(isCurrentEpoch(sql, USER, 2)).toBe(true);
  });

  it("9. epoch survives reconstruction (fresh adapter, no resident memory)", () => {
    const { db, sql } = seed();
    connectSeat(sql, USER, T0);
    connectSeat(sql, USER, T0 + 1); // epoch 2
    const fresh = nodeDb(db);
    expect(seatStatus(fresh, USER)?.epoch).toBe(2);
    expect(isCurrentEpoch(fresh, USER, 2)).toBe(true);
    expect(isCurrentEpoch(fresh, USER, 1)).toBe(false);
  });
});

describe("SPIKE-004 reconnect lease (89s / >90s, fails closed)", () => {
  it("2. reconnect at 89s succeeds within the lease (epoch increments)", () => {
    const { sql } = seed();
    connectSeat(sql, USER, T0); // epoch 1
    const dc = disconnectSeat(sql, USER, 1, T0);
    expect(dc.applied).toBe(true);
    expect(dc.leaseExpiresAt).toBe(T0 + DISCONNECT_GRACE_MS);

    const recon = connectSeat(sql, USER, T0 + 89_000);
    expect(recon.accepted).toBe(true);
    expect(recon.kind).toBe("RECONNECT");
    expect(recon.epoch).toBe(2); // 9. within-lease reconnect increments epoch
    expect(seatStatus(sql, USER)).toMatchObject({ epoch: 2, connected: true });
  });

  it("2b. reconnect exactly at the 90s boundary still succeeds", () => {
    const { sql } = seed();
    connectSeat(sql, USER, T0);
    disconnectSeat(sql, USER, 1, T0);
    const recon = connectSeat(sql, USER, T0 + DISCONNECT_GRACE_MS); // == lease
    expect(recon.accepted).toBe(true);
    expect(recon.kind).toBe("RECONNECT");
  });

  it("3/6. reconnect after >90s fails closed: not accepted, seat not connected", () => {
    const { sql } = seed();
    connectSeat(sql, USER, T0);
    disconnectSeat(sql, USER, 1, T0);
    const recon = connectSeat(sql, USER, T0 + 90_001);
    expect(recon.accepted).toBe(false);
    expect(recon.kind).toBe("RECONNECT_EXPIRED");
    // 6. seat is NOT silently marked connected/current (fails closed).
    expect(seatStatus(sql, USER)).toMatchObject({ connected: false, epoch: 1 });
  });

  it("4/5. an expired reconnect issues no epoch, so it cannot mutate or earn +20s", () => {
    const { sql } = seed();
    startGame(sql, GAME_A, T0);
    setActiveTurn(sql, "A", "turn-1", USER, T0 + 30_000);
    connectSeat(sql, USER, T0);
    disconnectSeat(sql, USER, 1, T0);
    const recon = connectSeat(sql, USER, T0 + 90_001);
    // Not accepted → the room binds no attachment/epoch, so no command from this
    // socket can pass the current-epoch guard (4), and the room only routes +20s
    // on an ACCEPTED within-lease RECONNECT, which this is not (5).
    expect(recon.accepted).toBe(false);
    expect(recon.kind).not.toBe("RECONNECT");
    // The persisted seat is unchanged: still disconnected, still epoch 1.
    expect(seatStatus(sql, USER)).toMatchObject({ connected: false, epoch: 1 });
  });

  it("7. reconstruction before an expired reconnect yields the same rejection", () => {
    const { db, sql } = seed();
    connectSeat(sql, USER, T0);
    disconnectSeat(sql, USER, 1, T0);
    const fresh = nodeDb(db); // DO evict/wake before the late reconnect
    const recon = connectSeat(fresh, USER, T0 + 90_001);
    expect(recon.accepted).toBe(false);
    expect(seatStatus(fresh, USER)?.connected).toBe(false);
  });

  it("8. a stale old epoch stays stale through an expired reconnect", () => {
    const { sql } = seed();
    connectSeat(sql, USER, T0); // epoch 1
    connectSeat(sql, USER, T0 + 1); // epoch 2 (epoch 1 now stale)
    disconnectSeat(sql, USER, 2, T0 + 1); // current (epoch 2) disconnects
    const recon = connectSeat(sql, USER, T0 + 1 + 90_001); // expired
    expect(recon.accepted).toBe(false);
    expect(isCurrentEpoch(sql, USER, 1)).toBe(false); // still stale
  });

  it("10. reconnect lease survives reconstruction (within-lease still honored)", () => {
    const { db, sql } = seed();
    connectSeat(sql, USER, T0);
    disconnectSeat(sql, USER, 1, T0);
    const fresh = nodeDb(db);
    expect(seatStatus(fresh, USER)?.leaseExpiresAt).toBe(T0 + DISCONNECT_GRACE_MS);
    const recon = connectSeat(fresh, USER, T0 + 50_000);
    expect(recon.accepted).toBe(true);
    expect(recon.kind).toBe("RECONNECT");
  });

  it("login lifetime is independent of the 90s seat lease (seats never read the session)", () => {
    // The lease is resolved purely from the injected clock + persisted lease; an
    // expired seat lease does not touch or shorten the app session (ADR-002).
    const { sql } = seed();
    connectSeat(sql, USER, T0);
    disconnectSeat(sql, USER, 1, T0);
    // Far beyond the 90s lease but well within a multi-day login: still just the
    // seat lease that expired — the identity (userId) is unchanged and unaffected.
    const recon = connectSeat(sql, USER, T0 + 3 * 24 * 60 * 60 * 1000);
    expect(recon.kind).toBe("RECONNECT_EXPIRED");
  });
});

describe("SPIKE-004 active-turn +20s extension", () => {
  const TURN = "turn-1";
  const TURN_DEADLINE = T0 + 30_000;

  function seedTurn(): { db: DatabaseSync; sql: SqlDb } {
    const s = seed();
    startGame(s.sql, GAME_A, T0);
    setActiveTurn(s.sql, "A", TURN, USER, TURN_DEADLINE);
    return s;
  }

  it("11. grants +20s exactly once on an eligible active-turn reconnect", () => {
    const { sql } = seedTurn();
    const r = grantTurnExtension(sql, "A", TURN, USER, ACTIVE_TURN_RECONNECT_EXTENSION_MS);
    expect(r.granted).toBe(true);
    expect(r.deadlineAt).toBe(TURN_DEADLINE + 20_000);
  });

  it("12. repeated same-turn reconnect does not stack the extension", () => {
    const { sql } = seedTurn();
    grantTurnExtension(sql, "A", TURN, USER, ACTIVE_TURN_RECONNECT_EXTENSION_MS);
    const second = grantTurnExtension(sql, "A", TURN, USER, ACTIVE_TURN_RECONNECT_EXTENSION_MS);
    expect(second.granted).toBe(false);
    const dl = sql.get<{ fire_at: number }>(
      `SELECT fire_at FROM deadlines WHERE game_id = 'A' AND id = ?;`,
      TURN,
    );
    expect(dl?.fire_at).toBe(TURN_DEADLINE + 20_000); // only one +20s total
  });

  it("13. a non-owner cannot obtain the current player's turn extension", () => {
    const { sql } = seedTurn();
    // A second live connection belongs to a different user (or is a takeover the
    // room never routes to grant); either way OTHER is not the turn owner.
    const r = grantTurnExtension(sql, "A", TURN, OTHER, ACTIVE_TURN_RECONNECT_EXTENSION_MS);
    expect(r.granted).toBe(false);
  });

  it("14. the next distinct turn independently receives one extension", () => {
    const { sql } = seedTurn();
    grantTurnExtension(sql, "A", TURN, USER, ACTIVE_TURN_RECONNECT_EXTENSION_MS);
    // A new turn owned by OTHER.
    const nextDeadline = T0 + 60_000;
    setActiveTurn(sql, "A", "turn-2", OTHER, nextDeadline);
    const r = grantTurnExtension(sql, "A", "turn-2", OTHER, ACTIVE_TURN_RECONNECT_EXTENSION_MS);
    expect(r.granted).toBe(true);
    expect(r.deadlineAt).toBe(nextDeadline + 20_000);
    // The old turn's extension record does not affect the new turn.
  });

  it("cannot resurrect an already-resolved/advanced turn", () => {
    const { sql } = seed();
    startGame(sql, GAME_A, T0);
    setActiveTurn(sql, "A", TURN, USER, T0 - 1); // already due
    resolveDueAlarm(sql, T0); // turn deadline fires and resolves
    const r = grantTurnExtension(sql, "A", TURN, USER, ACTIVE_TURN_RECONNECT_EXTENSION_MS);
    expect(r.granted).toBe(false);
  });
});

describe("SPIKE-004 B2: turn-deadline retirement on turn advance", () => {
  const A_TURN = "turn-A";
  const B_TURN = "turn-B";
  const A_DEADLINE = T0 + 30_000;
  const B_DEADLINE = T0 + 90_000;

  function isResolved(sql: SqlDb, id: string): number {
    const row = sql.get<{ resolved: number }>(
      `SELECT resolved FROM deadlines WHERE game_id = 'A' AND id = ?;`,
      id,
    );
    return row === undefined ? -1 : row.resolved;
  }
  function activeTurn(sql: SqlDb): string | undefined {
    return sql.get<{ turn_id: string }>(
      `SELECT turn_id FROM active_turn WHERE game_id = 'A';`,
    )?.turn_id;
  }
  function seedTurnA(): { db: DatabaseSync; sql: SqlDb } {
    const s = seed();
    startGame(s.sql, GAME_A, T0);
    setActiveTurn(s.sql, "A", A_TURN, USER, A_DEADLINE);
    return s;
  }

  it("1/3/4. advancing A->B retires A's deadline and installs B", () => {
    const { sql } = seedTurnA();
    setActiveTurn(sql, "A", B_TURN, OTHER, B_DEADLINE);
    expect(isResolved(sql, A_TURN)).toBe(1); // A retired
    expect(isResolved(sql, B_TURN)).toBe(0); // B pending
    expect(activeTurn(sql)).toBe(B_TURN); // B active
  });

  it("5. the retired A deadline can no longer fire during turn B", () => {
    const { sql } = seedTurnA();
    setActiveTurn(sql, "A", B_TURN, OTHER, B_DEADLINE);
    // Alarm fires when A's ORIGINAL deadline would have been due; B is not due.
    const outcome = resolveDueAlarm(sql, A_DEADLINE + 1);
    expect(outcome.resolved).toBe(0);
    expect(outcome.broadcast).toBeNull();
    expect(readState(sql, "A").gameVersion).toBe(0);
  });

  it("6. a reconnect extension cannot extend the superseded turn A", () => {
    const { sql } = seedTurnA();
    setActiveTurn(sql, "A", B_TURN, OTHER, B_DEADLINE);
    const r = grantTurnExtension(sql, "A", A_TURN, USER, ACTIVE_TURN_RECONNECT_EXTENSION_MS);
    expect(r.granted).toBe(false);
  });

  it("7. only turn B's deadline receives B's reconnect extension", () => {
    const { sql } = seedTurnA();
    setActiveTurn(sql, "A", B_TURN, OTHER, B_DEADLINE);
    const r = grantTurnExtension(sql, "A", B_TURN, OTHER, ACTIVE_TURN_RECONNECT_EXTENSION_MS);
    expect(r.granted).toBe(true);
    expect(r.deadlineAt).toBe(B_DEADLINE + 20_000);
    // A's retired deadline is untouched by B's extension.
    const aFire = sql.get<{ fire_at: number }>(
      `SELECT fire_at FROM deadlines WHERE game_id = 'A' AND id = ?;`,
      A_TURN,
    );
    expect(aFire?.fire_at).toBe(A_DEADLINE);
    expect(isResolved(sql, A_TURN)).toBe(1);
  });

  it("8. reconstruction preserves the retirement", () => {
    const { db, sql } = seedTurnA();
    setActiveTurn(sql, "A", B_TURN, OTHER, B_DEADLINE);
    const fresh = nodeDb(db);
    expect(isResolved(fresh, A_TURN)).toBe(1);
    expect(activeTurn(fresh)).toBe(B_TURN);
  });

  it("9. an unrelated non-turn deadline is left untouched", () => {
    const { sql } = seedTurnA();
    sql.run(
      `INSERT INTO deadlines (game_id, id, fire_at, resolved) VALUES ('A', 'auction-1', ?, 0);`,
      T0 + 45_000,
    );
    setActiveTurn(sql, "A", B_TURN, OTHER, B_DEADLINE);
    expect(isResolved(sql, "auction-1")).toBe(0); // not retired
    expect(isResolved(sql, A_TURN)).toBe(1); // only the prior turn retired
  });

  it("10. a failure during turn-advance rolls everything back", () => {
    const { sql } = seedTurnA();
    expect(() =>
      setActiveTurn(sql, "A", B_TURN, OTHER, B_DEADLINE, {
        fault: () => {
          throw new Error("boom");
        },
      }),
    ).toThrow("boom");
    // A remains active, A's deadline still valid (unresolved), B not installed.
    expect(activeTurn(sql)).toBe(A_TURN);
    expect(isResolved(sql, A_TURN)).toBe(0);
    expect(isResolved(sql, B_TURN)).toBe(-1); // B deadline never created
  });
});

describe("SPIKE-004/005 combined: connection lifecycle vs game lifecycle", () => {
  it("A. a room seat survives a rematch unchanged", () => {
    const { sql } = seed();
    startGame(sql, GAME_A, T0);
    const conn = connectSeat(sql, USER, T0); // epoch 1 in game A
    // Rematch to a new game — seat/epoch are room-scoped and untouched.
    startGame(sql, GAME_B, T0 + 1);
    expect(seatStatus(sql, USER)?.epoch).toBe(conn.epoch);
    expect(isCurrentEpoch(sql, USER, 1)).toBe(true);
  });

  it("F. epoch and gameId are orthogonal across a rematch", () => {
    const { sql } = seed();
    startGame(sql, GAME_A, T0);
    connectSeat(sql, USER, T0); // epoch 1, game A
    startGame(sql, GAME_B, T0 + 1); // rematch → game B, same socket still epoch 1
    expect(isCurrentEpoch(sql, USER, 1)).toBe(true); // socket valid for game B

    // The user reconnects → epoch 2; old socket rejected; game B authoritative.
    connectSeat(sql, USER, T0 + 2);
    expect(isCurrentEpoch(sql, USER, 1)).toBe(false);
    expect(isCurrentEpoch(sql, USER, 2)).toBe(true);
    handleIncrement(sql, "B", "b1");
    expect(readState(sql, "B")).toEqual({ gameVersion: 1, value: 1 });
  });
});
