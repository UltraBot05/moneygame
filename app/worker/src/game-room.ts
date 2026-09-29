import { DurableObject } from "cloudflare:workers";
import type { GameplayEvent, RandomSource } from "@moneygame/game-core";
import {
  parseClientMessage,
  ProtocolError,
  type ServerMessage,
  type ViewerRole,
} from "@moneygame/shared";
import { deliverFinalization } from "./finalization";
import {
  admit,
  disconnect,
  dueFinalizations,
  ensureRoomSchema,
  grantReconnectExtension,
  handleCommand,
  handleRoomAction,
  initializeRoom,
  markFinalizationFailed,
  markFinalized,
  nextAlarmAt,
  postChat,
  recentChat,
  roomView,
  runDueTimeouts,
  viewerGame,
  type RoomOutcome,
  type RuntimeDeps,
} from "./room-runtime";
import { isCurrentEpoch } from "./seats";
import type { SqlDb } from "./transition";

/** Internal headers set only by the Worker from the verified session (never by clients). */
export const USER_HEADER = "x-mg-user";
export const NAME_HEADER = "x-mg-name";
/** Equipped token ring colour, set by the Worker from D1 (never trusted from the client). */
export const RING_HEADER = "x-mg-ring";

/** Non-authoritative socket tag; every command re-checks the epoch against SQLite. */
interface Attachment {
  readonly userId: string;
  readonly epoch: number;
  readonly role: ViewerRole;
}

/** Server-side randomness injected into game-core (never Math.random in game logic). */
const cryptoRng: RandomSource = () => (crypto.getRandomValues(new Uint32Array(1))[0] as number) / 4294967296;

/**
 * RT-001 … RT-018: one GameRoom per room code, reused across rematches. A thin adapter:
 * sockets use the Hibernation API, the single alarm drives every deadline and finalization
 * retry, SQLite is the only truth, and all rules live in room-runtime.ts and game-core.
 */
export class GameRoom extends DurableObject<Env> {
  private readonly db: SqlDb;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const sql = ctx.storage.sql;
    this.db = {
      run: (query, ...params) => sql.exec(query, ...params).rowsWritten,
      get: <T extends Record<string, string | number | null>>(query: string, ...params: (string | number)[]) =>
        sql.exec(query, ...params).toArray()[0] as T | undefined,
      all: <T extends Record<string, string | number | null>>(query: string, ...params: (string | number)[]) =>
        sql.exec(query, ...params).toArray() as T[],
      transaction: (fn) => ctx.storage.transactionSync(fn),
    };
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
    ctx.blockConcurrencyWhile(async () => ensureRoomSchema(this.db));
  }

  private deps(): RuntimeDeps {
    return { now: Date.now(), rng: cryptoRng, newGameId: () => crypto.randomUUID() };
  }

  /** RPC from the Worker when a room is created; false if the code is already taken. */
  async initialize(code: string, hostUserId: string, hostName: string): Promise<boolean> {
    return initializeRoom(this.db, code, { userId: hostUserId, displayName: hostName }, Date.now());
  }

  override async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade") !== "websocket") return new Response("expected websocket", { status: 426 });
    const userId = request.headers.get(USER_HEADER);
    const displayName = request.headers.get(NAME_HEADER) ?? "Player";
    const ring = request.headers.get(RING_HEADER);
    if (userId === null || userId === "") return new Response("unauthenticated", { status: 401 });
    const spectators = this.ctx.getWebSockets()
      .filter((ws) => (ws.deserializeAttachment() as Attachment | null)?.role === "SPECTATOR").length;
    const admission = admit(this.db, { userId, displayName, ring }, Date.now(), spectators);
    if (admission.role === "REFUSED") {
      return new Response(admission.reason, { status: admission.reason === "ROOM_FULL" ? 429 : 404 });
    }

    const { 0: client, 1: server } = new WebSocketPair();
    this.ctx.acceptWebSocket(server);
    const epoch = admission.role === "PLAYER" ? admission.epoch : 0;
    const attachment: Attachment = { userId, epoch, role: admission.role };
    server.serializeAttachment(attachment);
    if (admission.role === "PLAYER") {
      this.replaceStaleSockets(userId, epoch, server);
      if (admission.kind === "RECONNECT" && grantReconnectExtension(this.db, userId)) await this.scheduleAlarm();
    }
    this.broadcast(null, server);
    this.send(server, this.stateFor(attachment, null, true));
    return new Response(null, { status: 101, webSocket: client });
  }

  override async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    const attachment = ws.deserializeAttachment() as Attachment | null;
    if (attachment === null) return;
    if (attachment.role === "PLAYER" && !isCurrentEpoch(this.db, attachment.userId, attachment.epoch)) {
      this.send(ws, { type: "SESSION_REPLACED" });
      return;
    }
    try {
      if (typeof raw !== "string") throw new ProtocolError("MALFORMED_MESSAGE", "binary frames are not accepted");
      const message = parseClientMessage(raw);
      if (message.type === "RESYNC") {
        this.send(ws, this.stateFor(attachment, null, true));
        return;
      }
      if (attachment.role === "SPECTATOR") {
        const actionId = message.type === "COMMAND" ? message.command.actionId : "room";
        this.send(ws, { type: "REJECTED", actionId, reason: "SPECTATORS_CANNOT_ACT" });
        return;
      }
      if (message.type === "CHAT") {
        const posted = postChat(this.db, attachment.userId, message.text, Date.now());
        if (posted.kind === "POSTED") this.broadcastRaw({ type: "CHAT", message: posted.message });
        else this.send(ws, { type: "REJECTED", actionId: "chat", reason: posted.reason });
        return;
      }
      const outcome = message.type === "ROOM"
        ? handleRoomAction(this.db, attachment.userId, message.action, this.deps())
        : handleCommand(this.db, attachment.userId, message.command, this.deps());
      await this.deliver(ws, attachment, outcome);
    } catch (error) {
      if (error instanceof ProtocolError) {
        this.send(ws, { type: "ERROR", code: error.code });
        return;
      }
      // Unexpected: nothing was committed (commits are single transactions). No secrets in the log.
      console.error("room command failed", { userId: attachment.userId, error: String(error) });
      this.send(ws, { type: "ERROR", code: "ROOM_TEMPORARILY_UNAVAILABLE" });
    }
  }

  override async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    const attachment = ws.deserializeAttachment() as Attachment | null;
    if (attachment?.role === "PLAYER") disconnect(this.db, attachment.userId, attachment.epoch, Date.now());
    ws.close(code, reason);
    this.broadcast(null);
  }

  override async alarm(): Promise<void> {
    const events = runDueTimeouts(this.db, this.deps());
    for (const event of events) this.broadcast(event);
    await this.deliverFinalizations();
    await this.scheduleAlarm();
  }

  private async deliver(ws: WebSocket, attachment: Attachment, outcome: RoomOutcome): Promise<void> {
    if (outcome.kind === "COMMITTED") {
      this.broadcast(outcome.event);
      await this.deliverFinalizations();
      await this.scheduleAlarm();
      return;
    }
    if (outcome.kind === "DUPLICATE") {
      this.send(ws, this.stateFor(attachment, null, false));
      return;
    }
    this.send(ws, {
      type: "REJECTED",
      actionId: outcome.actionId,
      reason: outcome.reason,
      ...(outcome.currentGameVersion === undefined ? {} : { currentGameVersion: outcome.currentGameVersion }),
    });
  }

  /** RT-012: best-effort delivery now; a failure keeps the row and the alarm retries it. */
  private async deliverFinalizations(): Promise<void> {
    for (const game of dueFinalizations(this.db, Date.now())) {
      try {
        await deliverFinalization(this.env.DB, game);
        markFinalized(this.db, game.gameId);
      } catch (error) {
        console.error("finalization delivery failed", { gameId: game.gameId, error: String(error) });
        markFinalizationFailed(this.db, game.gameId, Date.now());
      }
    }
  }

  private async scheduleAlarm(): Promise<void> {
    const at = nextAlarmAt(this.db);
    if (at === null) await this.ctx.storage.deleteAlarm();
    else await this.ctx.storage.setAlarm(at);
  }

  private stateFor(attachment: Attachment, event: GameplayEvent | null, withChat: boolean): ServerMessage {
    const room = roomView(this.db, Date.now());
    if (room === null) return { type: "ERROR", code: "ROOM_TEMPORARILY_UNAVAILABLE" };
    const view = viewerGame(this.db, attachment.role === "PLAYER" ? attachment.userId : null);
    return {
      type: "STATE",
      room,
      game: view?.game ?? null,
      you: { userId: attachment.userId, role: attachment.role },
      event,
      stateHash: view?.hash ?? null,
      chat: withChat ? recentChat(this.db) : null,
      serverTime: Date.now(),
    };
  }

  /** Committed-state fan-out: every socket gets its own projection, so private data stays private. */
  private broadcast(event: GameplayEvent | null, except?: WebSocket): void {
    for (const ws of this.ctx.getWebSockets()) {
      if (ws === except) continue;
      const attachment = ws.deserializeAttachment() as Attachment | null;
      if (attachment !== null) this.send(ws, this.stateFor(attachment, event, false));
    }
  }

  private broadcastRaw(message: ServerMessage): void {
    for (const ws of this.ctx.getWebSockets()) this.send(ws, message);
  }

  private replaceStaleSockets(userId: string, currentEpoch: number, keep: WebSocket): void {
    for (const ws of this.ctx.getWebSockets()) {
      if (ws === keep) continue;
      const attachment = ws.deserializeAttachment() as Attachment | null;
      if (attachment?.userId === userId && attachment.role === "PLAYER" && attachment.epoch !== currentEpoch) {
        this.send(ws, { type: "SESSION_REPLACED" });
        try {
          ws.close(1000, "session replaced");
        } catch {
          // already closing
        }
      }
    }
  }

  private send(ws: WebSocket, message: ServerMessage): void {
    try {
      ws.send(JSON.stringify(message));
    } catch {
      // socket closing; its close handler owns the cleanup
    }
  }
}
