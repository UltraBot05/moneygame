import { DurableObject } from "cloudflare:workers";
import {
  DEADLINES_SCHEMA,
  ensureSchema,
  handleIncrement,
  resolveDueAlarm,
  type SqlDb,
} from "./transition";

/**
 * SPIKE-001 room. NOT the production game runtime — a minimal authoritative
 * counter used to falsify/validate the Cloudflare room runtime:
 *   Worker -> one SQLite-backed DO -> Hibernation WS API -> persisted state
 *   -> Alarm API -> wake/reconstruction.
 *
 * Rules proven here:
 *  - SQLite is the durable source of truth (no in-memory state is authoritative);
 *  - authoritative state is persisted BEFORE it is broadcast;
 *  - ALL pending absolute deadlines are persisted; the Alarm API is always
 *    scheduled for the EARLIEST unresolved one (ARCHITECTURE.md §8);
 *  - deadline scheduling/resolution query `resolved = 0` rows only, using an
 *    index, so reads do NOT grow with resolved history;
 *  - alarm resolution is idempotent (at-least-once delivery safe);
 *  - no gameplay setTimeout/setInterval/heartbeat/keep-warm loop.
 *
 * The `rowsRead`/`rowsWritten`/`setAlarmCount` tallies exist for SPIKE-001
 * resource measurement: `SqlStorageCursor.rowsRead`/`.rowsWritten` are the exact
 * values Cloudflare bills for SQL, and `setAlarm()` is billed as one row write.
 */

interface GameStateRow extends Record<string, SqlStorageValue> {
  game_version: number;
  value: number;
}

interface FireAtRow extends Record<string, SqlStorageValue> {
  fire_at: number;
}

type ClientCommand =
  | { type: "INCREMENT"; actionId?: string }
  | { type: "GET_STATE" }
  | { type: "GET_METRICS" }
  | { type: "SET_DEADLINE"; ms: number }
  | { type: "DEADLINE_STRESS"; resolved: number; pending: number };

interface StateMessage {
  type: "STATE";
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

    // Runtime-level ping/pong: keeps connections healthy WITHOUT waking the DO.
    // This is not a JS timer/heartbeat and does not pin the object to memory.
    ctx.setWebSocketAutoResponse(
      new WebSocketRequestResponsePair("ping", "pong"),
    );

    // Reconstruct the durable schema on every wake before any event is handled.
    // Idempotent, so it is safe after hibernation/eviction/restart.
    ctx.blockConcurrencyWhile(async () => {
      // game_state + applied_actions (SPIKE-002 idempotency) + default row.
      ensureSchema(this.db);
      this.exec(DEADLINES_SCHEMA);
      // Index the (resolved, fire_at) lookup so pending-deadline queries seek
      // directly to unresolved rows in fire_at order instead of scanning history.
      this.exec(
        `CREATE INDEX IF NOT EXISTS idx_deadlines_pending
           ON deadlines (resolved, fire_at);`,
      );
    });
  }

  /**
   * Adapts the DO's `SqlStorage` to the transition module's {@link SqlDb} seam.
   * `transaction` uses `transactionSync` so the state mutation and its
   * idempotency record commit atomically (or roll back together). Reads/writes
   * are tallied into the same SPIKE-001 billing counters.
   */
  private makeDb(ctx: DurableObjectState): SqlDb {
    return {
      run: (query: string, ...params: (string | number)[]): number => {
        const cursor = this.sql.exec(query, ...params);
        cursor.toArray();
        this.rowsRead += cursor.rowsRead;
        this.rowsWritten += cursor.rowsWritten;
        return cursor.rowsWritten;
      },
      get: <T extends Record<string, string | number>>(
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

  override async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("expected websocket", { status: 426 });
    }
    const { 0: client, 1: server } = new WebSocketPair();
    // Hibernation API: the runtime may evict this DO while the socket stays open.
    this.ctx.acceptWebSocket(server);
    // Give the new client the committed state (also correct after a wake).
    server.send(JSON.stringify(this.readState()));
    return new Response(null, { status: 101, webSocket: client });
  }

  override async webSocketMessage(
    ws: WebSocket,
    message: string | ArrayBuffer,
  ): Promise<void> {
    if (typeof message !== "string") return;
    let command: ClientCommand;
    try {
      command = JSON.parse(message) as ClientCommand;
    } catch {
      return;
    }
    switch (command.type) {
      case "INCREMENT": {
        // Persist-before-broadcast, idempotent by actionId (ADR-003). A retry
        // of the same actionId does not re-apply or advance gameVersion, and
        // never broadcasts its (possibly stale) historical snapshot — the
        // requester just gets the CURRENT authoritative state. A client that
        // sends no actionId gets a fresh action.
        const actionId = command.actionId ?? crypto.randomUUID();
        const outcome = handleIncrement(this.db, actionId);
        if (outcome.broadcast !== null) {
          this.broadcast({
            type: "STATE",
            gameVersion: outcome.broadcast.gameVersion,
            value: outcome.broadcast.value,
          });
        } else {
          ws.send(
            JSON.stringify({
              type: "STATE",
              gameVersion: outcome.current.gameVersion,
              value: outcome.current.value,
            }),
          );
        }
        return;
      }
      case "SET_DEADLINE":
        await this.scheduleDeadline(command.ms);
        return;
      case "GET_STATE":
        ws.send(JSON.stringify(this.readState()));
        return;
      case "GET_METRICS":
        ws.send(JSON.stringify(this.readMetrics()));
        return;
      case "DEADLINE_STRESS":
        ws.send(JSON.stringify(this.runStress(command.resolved, command.pending)));
        return;
    }
  }

  override async webSocketClose(
    ws: WebSocket,
    code: number,
    reason: string,
  ): Promise<void> {
    ws.close(code, reason);
  }

  override async alarm(): Promise<void> {
    // Resolve every due deadline AND advance canonical state in one atomic
    // transaction (SPIKE-002 B2). A crash cannot leave a deadline resolved
    // without its state change; the resolved=0 guard makes replay idempotent.
    // Broadcast only after the transaction commits.
    const outcome = resolveDueAlarm(this.db, Date.now());
    if (outcome.broadcast !== null) {
      this.broadcast({
        type: "STATE",
        gameVersion: outcome.broadcast.gameVersion,
        value: outcome.broadcast.value,
      });
    }
    // Reschedule the earliest remaining deadline; if none remain, the just-fired
    // alarm is consumed and no new alarm is left behind.
    await this.scheduleEarliest();
  }

  /** Runs a statement and tallies the billed SQL row counts. */
  private exec<T extends Record<string, SqlStorageValue> = GameStateRow>(
    query: string,
    ...bindings: SqlStorageValue[]
  ): T[] {
    const cursor = this.sql.exec<T>(query, ...bindings);
    const rows = cursor.toArray();
    this.rowsRead += cursor.rowsRead;
    this.rowsWritten += cursor.rowsWritten;
    return rows;
  }

  private readState(): StateMessage {
    const [row] = this.exec<GameStateRow>(
      `SELECT game_version, value FROM game_state WHERE id = 1;`,
    );
    if (row === undefined) throw new Error("game_state row missing");
    return { type: "STATE", gameVersion: row.game_version, value: row.value };
  }

  private async scheduleDeadline(ms: number): Promise<void> {
    this.exec(
      `INSERT INTO deadlines (id, fire_at, resolved) VALUES (?, ?, 0);`,
      crypto.randomUUID(),
      Date.now() + ms,
    );
    // Persist all deadlines; schedule whichever is earliest (not necessarily
    // the one just inserted).
    await this.scheduleEarliest();
  }

  private async scheduleEarliest(): Promise<void> {
    const [row] = this.exec<FireAtRow>(
      `SELECT fire_at FROM deadlines WHERE resolved = 0 ORDER BY fire_at LIMIT 1;`,
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
   * SPIKE-001 M2 measurement only: seed a mix of resolved/pending deadlines and
   * report per-query `cursor.rowsRead`, proving the scheduling/resolution queries
   * do not scan resolved history.
   */
  private runStress(resolved: number, pending: number): StressMessage {
    this.sql.exec(`DELETE FROM deadlines;`);
    const base = Date.now();
    for (let i = 0; i < resolved; i++) {
      this.sql.exec(
        `INSERT INTO deadlines (id, fire_at, resolved) VALUES (?, ?, 1);`,
        `r${i}`,
        base + i,
      );
    }
    for (let i = 0; i < pending; i++) {
      this.sql.exec(
        `INSERT INTO deadlines (id, fire_at, resolved) VALUES (?, ?, 0);`,
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
      readFullScanAll: rowsRead(`SELECT id FROM deadlines;`),
      readEarliestPending: rowsRead(
        `SELECT fire_at FROM deadlines WHERE resolved = 0 ORDER BY fire_at LIMIT 1;`,
      ),
      readDuePending: rowsRead(
        `SELECT id FROM deadlines WHERE resolved = 0 AND fire_at <= ?;`,
        now,
      ),
      readResolveOne: rowsRead(
        `UPDATE deadlines SET resolved = 1 WHERE id = ?;`,
        "p0",
      ),
      readNextPending: rowsRead(
        `SELECT fire_at FROM deadlines WHERE resolved = 0 ORDER BY fire_at LIMIT 1;`,
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
