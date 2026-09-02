import { DurableObject } from "cloudflare:workers";
import standardBoard from "../../../boards/world-tour/standard.json";
import grandBoard from "../../../boards/world-tour/grand.json";
import {
  checkGameScoped,
  currentGameId,
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
import {
  ACTIVE_TURN_RECONNECT_EXTENSION_MS,
  connectSeat,
  disconnectSeat,
  ensureSeatSchema,
  isCurrentEpoch,
} from "./seats";

/**
 * SPIKE-001 room, extended for SPIKE-004 (authenticated reconnect + connection
 * epoch, room-scoped) and SPIKE-005 (rematch / game-scoped isolation).
 *
 * NOT the production game runtime — a minimal authoritative counter used to
 * falsify/validate the Cloudflare runtime. Identity is the internal `userId`
 * derived by the Worker from the verified first-party session (SPIKE-003) and
 * handed in via the `x-mg-user` header on the internal upgrade subrequest; the
 * DO is not publicly addressable, and the Worker always overwrites that header
 * from the session, so a public request cannot spoof it. Google tokens never
 * reach the DO. Each socket's hibernation attachment carries only a
 * non-authoritative `{ userId, epoch }` — every command re-validates the epoch
 * against durable SQLite, so a stale socket (even one that survived hibernation)
 * cannot mutate state.
 */

/** Immutable board identity the runtime records with each game (from canonical JSON). */
interface BoardIdentity {
  boardId: string;
  boardVersion: number;
  tileCount: number;
}

const BOARDS: Record<string, BoardIdentity> = {
  standard: standardBoard,
  grand: grandBoard,
};

const SESSION_REPLACED = JSON.stringify({ type: "SESSION_REPLACED" });

interface SocketAttachment {
  userId: string;
  epoch: number;
}

interface FireAtRow extends Record<string, SqlStorageValue> {
  fire_at: number;
}

// Every game-scoped mutation carries the originating `gameId` (validated against
// current_game_id before any write); GET_* are read-only and need none.
type ClientCommand =
  | { type: "INCREMENT"; actionId?: string; gameId?: string }
  | { type: "GET_STATE" }
  | { type: "GET_METRICS" }
  | { type: "SET_DEADLINE"; ms: number; gameId?: string }
  | { type: "SET_TURN"; turnId: string; ms: number; gameId?: string }
  | { type: "REMATCH"; board: "standard" | "grand"; gameId?: string }
  | { type: "DEADLINE_STRESS"; resolved: number; pending: number; gameId?: string };

interface StateMessage {
  type: "STATE";
  gameId: string;
  gameVersion: number;
  value: number;
}

interface MetricsMessage {
  type: "METRICS";
  rowsRead: number;
  rowsWritten: number;
  setAlarmCount: number;
  connections: number;
}

interface StressMessage {
  type: "STRESS";
  totalRows: number;
  resolved: number;
  pending: number;
  readFullScanAll: number;
  readEarliestPending: number;
  readDuePending: number;
  readResolveOne: number;
  readNextPending: number;
}

export class SpikeRoom extends DurableObject<Env> {
  private readonly sql: SqlStorage;
  private readonly db: SqlDb;
  private rowsRead = 0;
  private rowsWritten = 0;
  private setAlarmCount = 0;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.db = this.makeDb(ctx);

    // Runtime-level ping/pong keeps connections healthy WITHOUT waking the DO.
    ctx.setWebSocketAutoResponse(
      new WebSocketRequestResponsePair("ping", "pong"),
    );

    ctx.blockConcurrencyWhile(async () => {
      ensureSchema(this.db); // room_state + games + game_state + applied_actions + deadlines + turns
      ensureSeatSchema(this.db); // room-scoped seats
      this.exec(
        `CREATE INDEX IF NOT EXISTS idx_deadlines_pending
           ON deadlines (game_id, resolved, fire_at);`,
      );
      // Bootstrap a first game so the room is usable; a REMATCH replaces it.
      if (currentGameId(this.db) === null) {
        startGame(this.db, this.newGame("standard"), Date.now());
      }
    });
  }

  /** Adapts the DO's `SqlStorage` to the {@link SqlDb} seam (atomic via `transactionSync`). */
  private makeDb(ctx: DurableObjectState): SqlDb {
    return {
      run: (query: string, ...params: (string | number)[]): number => {
        const cursor = this.sql.exec(query, ...params);
        cursor.toArray();
        this.rowsRead += cursor.rowsRead;
        this.rowsWritten += cursor.rowsWritten;
        return cursor.rowsWritten;
      },
      get: <T extends Record<string, string | number | null>>(
        query: string,
        ...params: (string | number)[]
      ): T | undefined => {
        const cursor = this.sql.exec(query, ...params);
        const rows = cursor.toArray();
        this.rowsRead += cursor.rowsRead;
        this.rowsWritten += cursor.rowsWritten;
        return rows[0] as T | undefined;
      },
      transaction: <T>(fn: () => T): T => ctx.storage.transactionSync(fn),
    };
  }

  private newGame(board: "standard" | "grand"): NewGame {
    const def = BOARDS[board] as BoardIdentity;
    return {
      gameId: crypto.randomUUID(),
      boardId: def.boardId,
      boardVersion: def.boardVersion,
      tileCount: def.tileCount,
    };
  }

  override async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("expected websocket", { status: 426 });
    }
    // Trusted identity, set by the Worker from the verified session. Absent →
    // the request did not come through the authenticated Worker path.
    const userId = request.headers.get("x-mg-user");
    if (userId === null || userId.length === 0) {
      return new Response("unauthenticated", { status: 401 });
    }

    const { 0: client, 1: server } = new WebSocketPair();
    this.ctx.acceptWebSocket(server);

    // Advance the seat epoch atomically and bind it to THIS socket.
    const conn = connectSeat(this.db, userId, Date.now());

    // Fail closed: an expired reconnect lease does NOT reclaim the seat. The
    // socket receives no authoritative attachment/epoch and is closed cleanly,
    // so it can neither mutate state nor earn a turn extension. (Re-seat/rejoin
    // after expiry is later lobby work — deliberately not decided here.)
    if (!conn.accepted) {
      server.send(JSON.stringify({ type: "ERROR", code: "RECONNECT_EXPIRED" }));
      server.close(1008, "reconnect lease expired");
      return new Response(null, { status: 101, webSocket: client });
    }

    const attachment: SocketAttachment = { userId, epoch: conn.epoch };
    server.serializeAttachment(attachment);

    if (conn.replacedLiveSocket && conn.replacedEpoch !== null) {
      this.replaceOldSockets(userId, conn.replacedEpoch, server);
    }
    // A genuine within-lease reconnect by the active-turn owner earns the +20s.
    if (conn.kind === "RECONNECT") {
      this.maybeExtendActiveTurn(userId);
    }

    server.send(JSON.stringify(this.stateMessage()));
    return new Response(null, { status: 101, webSocket: client });
  }

  override async webSocketMessage(
    ws: WebSocket,
    message: string | ArrayBuffer,
  ): Promise<void> {
    if (typeof message !== "string") return;
    const attachment = ws.deserializeAttachment() as SocketAttachment | null;
    if (attachment === null) return;

    // Stale-epoch guard: a superseded socket cannot mutate anything.
    if (!isCurrentEpoch(this.db, attachment.userId, attachment.epoch)) {
      ws.send(SESSION_REPLACED);
      return;
    }

    let command: ClientCommand;
    try {
      command = JSON.parse(message) as ClientCommand;
    } catch {
      return;
    }
    switch (command.type) {
      case "INCREMENT": {
        const gameId = this.guard(ws, command.gameId);
        if (gameId === null) return;
        const actionId = command.actionId ?? crypto.randomUUID();
        const outcome = handleIncrement(this.db, gameId, actionId);
        if (outcome.broadcast !== null) {
          this.broadcast(this.stateMessage());
        } else {
          ws.send(JSON.stringify(this.stateMessage()));
        }
        return;
      }
      case "REMATCH": {
        // The rematch targets the game the client believes is current; a stale
        // gameId is rejected here, before any new game is started.
        if (this.guard(ws, command.gameId) === null) return;
        // Atomic new-game transition; broadcast the fresh game only after commit.
        startGame(this.db, this.newGame(command.board), Date.now());
        this.broadcast(this.stateMessage());
        return;
      }
      case "SET_TURN": {
        const gameId = this.guard(ws, command.gameId);
        if (gameId === null) return;
        setActiveTurn(
          this.db,
          gameId,
          command.turnId,
          attachment.userId,
          Date.now() + command.ms,
        );
        void this.scheduleEarliest();
        return;
      }
      case "SET_DEADLINE": {
        const gameId = this.guard(ws, command.gameId);
        if (gameId === null) return;
        await this.scheduleDeadline(gameId, command.ms);
        return;
      }
      case "DEADLINE_STRESS": {
        const gameId = this.guard(ws, command.gameId);
        if (gameId === null) return;
        ws.send(JSON.stringify(this.runStress(gameId, command.resolved, command.pending)));
        return;
      }
      case "GET_STATE":
        ws.send(JSON.stringify(this.stateMessage()));
        return;
      case "GET_METRICS":
        ws.send(JSON.stringify(this.readMetrics()));
        return;
    }
  }

  /**
   * Validates the client-supplied `gameId` for a game-scoped mutation BEFORE any
   * write: missing → `GAME_ID_REQUIRED`, not-current → `STALE_GAME`. Returns the
   * validated gameId, or null (after sending the error) to abort the command.
   */
  private guard(ws: WebSocket, gameId: string | undefined): string | null {
    const check = checkGameScoped(this.db, gameId);
    if (!check.ok) {
      ws.send(JSON.stringify({ type: "ERROR", code: check.code }));
      return null;
    }
    return check.gameId;
  }

  override async webSocketClose(
    ws: WebSocket,
    code: number,
    reason: string,
  ): Promise<void> {
    const attachment = ws.deserializeAttachment() as SocketAttachment | null;
    if (attachment !== null) {
      // Only the CURRENT socket opens a reconnect lease; a stale close is a
      // no-op inside disconnectSeat, so it cannot disconnect the new socket.
      disconnectSeat(this.db, attachment.userId, attachment.epoch, Date.now());
    }
    ws.close(code, reason);
  }

  override async alarm(): Promise<void> {
    // Resolve the CURRENT game's due deadlines + advance state in one atomic
    // transaction (SPIKE-002 B2); old-game deadlines are in another namespace
    // and can never fire against the current game (SPIKE-005 E).
    const outcome = resolveDueAlarm(this.db, Date.now());
    if (outcome.broadcast !== null) {
      this.broadcast(this.stateMessage());
    }
    await this.scheduleEarliest();
  }

  // --- seat helpers ----------------------------------------------------------

  /** Sends SESSION_REPLACED to and closes every live socket at the old epoch. */
  private replaceOldSockets(
    userId: string,
    oldEpoch: number,
    keep: WebSocket,
  ): void {
    for (const ws of this.ctx.getWebSockets()) {
      if (ws === keep) continue;
      const att = ws.deserializeAttachment() as SocketAttachment | null;
      if (att !== null && att.userId === userId && att.epoch === oldEpoch) {
        try {
          ws.send(SESSION_REPLACED);
          ws.close(1000, "session replaced");
        } catch {
          // already closing
        }
      }
    }
  }

  /** Grants the one-time +20s if `userId` owns the current game's active turn. */
  private maybeExtendActiveTurn(userId: string): void {
    const gameId = currentGameId(this.db);
    if (gameId === null) return;
    const turn = this.exec<{ turn_id: string }>(
      `SELECT turn_id FROM active_turn WHERE game_id = ?;`,
      gameId,
    )[0];
    if (turn === undefined) return;
    const result = grantTurnExtension(
      this.db,
      gameId,
      turn.turn_id,
      userId,
      ACTIVE_TURN_RECONNECT_EXTENSION_MS,
    );
    if (result.granted) void this.scheduleEarliest();
  }

  // --- game/deadline plumbing ------------------------------------------------

  private exec<T extends Record<string, SqlStorageValue>>(
    query: string,
    ...bindings: SqlStorageValue[]
  ): T[] {
    const cursor = this.sql.exec<T>(query, ...bindings);
    const rows = cursor.toArray();
    this.rowsRead += cursor.rowsRead;
    this.rowsWritten += cursor.rowsWritten;
    return rows;
  }

  private stateMessage(): StateMessage {
    const gameId = currentGameId(this.db) ?? "";
    const state = readState(this.db, gameId);
    return {
      type: "STATE",
      gameId,
      gameVersion: state.gameVersion,
      value: state.value,
    };
  }

  private async scheduleDeadline(gameId: string, ms: number): Promise<void> {
    this.exec(
      `INSERT INTO deadlines (game_id, id, fire_at, resolved) VALUES (?, ?, ?, 0);`,
      gameId,
      crypto.randomUUID(),
      Date.now() + ms,
    );
    await this.scheduleEarliest();
  }

  /** Schedules the one DO alarm for the CURRENT game's earliest unresolved deadline. */
  private async scheduleEarliest(): Promise<void> {
    const gameId = currentGameId(this.db);
    if (gameId === null) return;
    const [row] = this.exec<FireAtRow>(
      `SELECT fire_at FROM deadlines
         WHERE game_id = ? AND resolved = 0 ORDER BY fire_at LIMIT 1;`,
      gameId,
    );
    if (row !== undefined) {
      this.setAlarmCount += 1;
      await this.ctx.storage.setAlarm(row.fire_at);
    }
  }

  private readMetrics(): MetricsMessage {
    return {
      type: "METRICS",
      rowsRead: this.rowsRead,
      rowsWritten: this.rowsWritten,
      setAlarmCount: this.setAlarmCount,
      connections: this.ctx.getWebSockets().length,
    };
  }

  /**
   * SPIKE-001 M2 measurement only: seed resolved/pending deadlines for the
   * current game and report per-query `cursor.rowsRead`, proving the
   * scheduling/resolution queries do not scan resolved history. Now game-scoped.
   */
  private runStress(gameId: string, resolved: number, pending: number): StressMessage {
    this.sql.exec(`DELETE FROM deadlines WHERE game_id = ?;`, gameId);
    const base = Date.now();
    for (let i = 0; i < resolved; i++) {
      this.sql.exec(
        `INSERT INTO deadlines (game_id, id, fire_at, resolved) VALUES (?, ?, ?, 1);`,
        gameId,
        `r${i}`,
        base + i,
      );
    }
    for (let i = 0; i < pending; i++) {
      this.sql.exec(
        `INSERT INTO deadlines (game_id, id, fire_at, resolved) VALUES (?, ?, ?, 0);`,
        gameId,
        `p${i}`,
        base + 1_000_000 + i,
      );
    }
    const rowsRead = (query: string, ...bindings: SqlStorageValue[]): number => {
      const cursor = this.sql.exec(query, ...bindings);
      cursor.toArray();
      return cursor.rowsRead;
    };
    const now = base + 2_000_000;
    return {
      type: "STRESS",
      totalRows: resolved + pending,
      resolved,
      pending,
      readFullScanAll: rowsRead(`SELECT id FROM deadlines WHERE game_id = ?;`, gameId),
      readEarliestPending: rowsRead(
        `SELECT fire_at FROM deadlines WHERE game_id = ? AND resolved = 0 ORDER BY fire_at LIMIT 1;`,
        gameId,
      ),
      readDuePending: rowsRead(
        `SELECT id FROM deadlines WHERE game_id = ? AND resolved = 0 AND fire_at <= ?;`,
        gameId,
        now,
      ),
      readResolveOne: rowsRead(
        `UPDATE deadlines SET resolved = 1 WHERE game_id = ? AND id = ?;`,
        gameId,
        "p0",
      ),
      readNextPending: rowsRead(
        `SELECT fire_at FROM deadlines WHERE game_id = ? AND resolved = 0 ORDER BY fire_at LIMIT 1;`,
        gameId,
      ),
    };
  }

  private broadcast(state: StateMessage): void {
    const payload = JSON.stringify(state);
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(payload);
      } catch {
        // Socket is closing; ignore.
      }
    }
  }
}
