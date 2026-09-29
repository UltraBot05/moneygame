import type { GameplayEvent, ProjectedGameState } from "@moneygame/game-core";
import type { ChatMessage, ClientMessage, RoomAction, RoomView, ServerMessage, ViewerRole, WireCommand } from "@moneygame/shared";

/**
 * UI-014 live client. The server's last STATE is the only game truth the UI renders: commands
 * are sent, never applied locally. A command keeps its actionId until the server answers, so a
 * resend after a reconnect is deduplicated by the room instead of acting twice.
 */

export type ConnectionStatus =
  | "CONNECTING"
  | "OPEN"
  | "RECONNECTING"
  /** This account opened the room in another tab or device; this tab stops. */
  | "REPLACED"
  /** The socket never opened: the room is missing or full, or the session ended. */
  | "UNREACHABLE";

export interface Notice {
  readonly id: number;
  readonly text: string;
}

export interface RoomSnapshot {
  readonly status: ConnectionStatus;
  readonly room: RoomView | null;
  readonly game: ProjectedGameState | null;
  readonly you: Readonly<{ userId: string; role: ViewerRole }> | null;
  readonly chat: readonly ChatMessage[];
  /** Committed events seen by this tab, oldest first, capped. */
  readonly events: readonly Readonly<{ id: number; event: GameplayEvent; game: ProjectedGameState }>[];
  readonly stateHash: string | null;
  /** serverTime minus local time, for countdowns against server deadlines. */
  readonly clockOffset: number;
  readonly pendingActionIds: readonly string[];
  readonly notice: Notice | null;
}

export interface SocketLike {
  readonly readyState: number;
  onopen: (() => void) | null;
  onmessage: ((message: { data: unknown }) => void) | null;
  onclose: (() => void) | null;
  send(data: string): void;
  close(): void;
}

export interface ClientDeps {
  readonly connect: (roomCode: string) => SocketLike;
  readonly now: () => number;
  readonly newActionId: () => string;
  readonly schedule: (callback: () => void, ms: number) => unknown;
  readonly cancel: (handle: unknown) => void;
}

const OPEN = 1;
const MAX_EVENTS = 120;
const MAX_CHAT = 100;
const BACKOFF_MS = [500, 1000, 2000, 4000, 8000];
/** Consecutive failed first connects before the room is reported unreachable. */
const UNREACHABLE_AFTER = 4;

export const REJECTION_TEXT: Readonly<Record<string, string>> = {
  STALE_GAME_VERSION: "The board changed before your action arrived. Check it and try again.",
  NOT_YOUR_TURN: "It is not your turn.",
  INSUFFICIENT_FUNDS: "Not enough cash for that.",
  PENDING_RESOLUTION: "Finish the current decision first.",
  BID_TOO_LOW: "That bid is too low.",
  BID_EXCEEDS_CASH: "You cannot bid more than your cash.",
  DEBT_BLOCKED: "That player is settling a debt. Only a trade that pays it is allowed.",
  SET_HAS_DEVELOPMENT: "Sell the set's buildings first.",
  TRADE_BLOCKED_DURING_AUCTION: "Trades wait until the auction ends.",
  TRADE_NOT_OPEN: "That trade is no longer open.",
  ASSET_NOT_OWNED: "A deed in that trade changed hands.",
  ROOM_PAUSED: "The host paused the match.",
  RATE_LIMITED: "Slow down a little.",
  NOT_ENOUGH_READY_PLAYERS: "At least three ready players are needed.",
  INVALID_SETTINGS: "Those room settings are not valid.",
  ROOM_FULL: "The room is full.",
  SPECTATORS_CANNOT_ACT: "Spectators can watch but not act.",
  INVALID_CHAT: "Messages must be 1 to 280 characters.",
  GAME_ALREADY_ENDED: "The match is over.",
};

/** What screens need from a room connection (the live client, or the dev preview). */
export type RoomPort = Pick<RoomClient, "command" | "room" | "chat" | "dismissNotice">;

export class RoomClient {
  private snapshot: RoomSnapshot = {
    status: "CONNECTING", room: null, game: null, you: null, chat: [], events: [], stateHash: null,
    clockOffset: 0, pendingActionIds: [], notice: null,
  };
  private socket: SocketLike | null = null;
  private readonly pending = new Map<string, WireCommand>();
  private listeners = new Set<() => void>();
  private attempt = 0;
  private everOpened = false;
  private stopped = false;
  private timer: unknown = null;
  private sequence = 0;

  constructor(private readonly roomCode: string, private readonly deps: ClientDeps) {}

  start(): void {
    this.stopped = false;
    this.open();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer !== null) this.deps.cancel(this.timer);
    this.timer = null;
    const socket = this.socket;
    this.socket = null;
    if (socket !== null) {
      socket.onclose = null;
      socket.close();
    }
  }

  /** Manual retry after UNREACHABLE. */
  retry(): void {
    this.attempt = 0;
    this.update({ status: "CONNECTING" });
    this.stop();
    this.start();
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): RoomSnapshot => this.snapshot;

  /** Sends a game command against the current version. Returns its actionId, or null if no game. */
  command(type: string, payload: unknown): string | null {
    const game = this.snapshot.game;
    if (game === null) return null;
    const command: WireCommand = {
      type, gameId: game.gameId, actionId: this.deps.newActionId(), expectedGameVersion: game.gameVersion, payload,
    };
    this.pending.set(command.actionId, command);
    this.update({ pendingActionIds: [...this.pending.keys()] });
    this.transmit({ type: "COMMAND", command });
    return command.actionId;
  }

  room(action: RoomAction): void {
    this.transmit({ type: "ROOM", action });
  }

  chat(text: string): void {
    this.transmit({ type: "CHAT", text });
  }

  dismissNotice(): void {
    this.update({ notice: null });
  }

  private transmit(message: ClientMessage): void {
    if (this.socket?.readyState === OPEN) this.socket.send(JSON.stringify(message));
  }

  private open(): void {
    if (this.stopped) return;
    const socket = this.deps.connect(this.roomCode);
    this.socket = socket;
    socket.onopen = () => {
      this.everOpened = true;
      this.attempt = 0;
    };
    socket.onmessage = (message) => {
      if (typeof message.data !== "string") return;
      let parsed: ServerMessage;
      try {
        parsed = JSON.parse(message.data) as ServerMessage;
      } catch {
        return;
      }
      this.receive(parsed);
    };
    socket.onclose = () => {
      if (this.socket !== socket || this.stopped) return;
      this.socket = null;
      if (this.snapshot.status === "REPLACED") return;
      this.attempt += 1;
      if (!this.everOpened && this.attempt >= UNREACHABLE_AFTER) {
        this.update({ status: "UNREACHABLE" });
        return;
      }
      this.update({ status: this.everOpened ? "RECONNECTING" : "CONNECTING" });
      const delay = BACKOFF_MS[Math.min(this.attempt - 1, BACKOFF_MS.length - 1)] as number;
      this.timer = this.deps.schedule(() => {
        this.timer = null;
        this.open();
      }, delay);
    };
  }

  private receive(message: ServerMessage): void {
    switch (message.type) {
      case "STATE":
        this.receiveState(message);
        return;
      case "CHAT":
        this.update({ chat: [...this.snapshot.chat, message.message].slice(-MAX_CHAT) });
        return;
      case "REJECTED": {
        const hadCommand = this.pending.delete(message.actionId);
        this.update({
          pendingActionIds: [...this.pending.keys()],
          notice: this.notice(REJECTION_TEXT[message.reason] ?? "That action was refused (" + message.reason.toLowerCase().replaceAll("_", " ") + ")."),
        });
        // A stale-version refusal means our view is behind: ask for the current state.
        if (hadCommand && message.reason === "STALE_GAME_VERSION") this.transmit({ type: "RESYNC" });
        return;
      }
      case "ERROR":
        // The frame was refused without an actionId and nothing was committed: release pending commands.
        this.pending.clear();
        this.update({ pendingActionIds: [], notice: this.notice(message.code === "ROOM_TEMPORARILY_UNAVAILABLE" ? "The room hit a problem. Nothing was changed." : "The room could not read that message.") });
        return;
      case "SESSION_REPLACED":
        this.update({ status: "REPLACED" });
        this.stop();
        return;
    }
  }

  private receiveState(message: Extract<ServerMessage, { type: "STATE" }>): void {
    const current = this.snapshot.game;
    const incoming = message.game;
    // Out-of-order safety: never step back to an older version of the same game.
    if (current !== null && incoming !== null && incoming.gameId === current.gameId && incoming.gameVersion < current.gameVersion) return;
    const wasReconnect = this.snapshot.status !== "OPEN";
    // Any command written against an older version is settled: committed, or stale and refused on retry.
    for (const [actionId, command] of this.pending) {
      if (incoming === null || command.gameId !== incoming.gameId || (command.expectedGameVersion ?? 0) < incoming.gameVersion) {
        this.pending.delete(actionId);
      }
    }
    const events = message.event === null || incoming === null
      ? this.snapshot.events
      : [...this.snapshot.events, { id: ++this.sequence, event: message.event, game: incoming }].slice(-MAX_EVENTS);
    this.update({
      status: "OPEN",
      room: message.room,
      game: incoming,
      you: message.you,
      chat: message.chat ?? this.snapshot.chat,
      events,
      stateHash: message.stateHash,
      clockOffset: message.serverTime - this.deps.now(),
      pendingActionIds: [...this.pending.keys()],
    });
    // After a reconnect, resend what the server may not have seen, with the same actionIds.
    if (wasReconnect) for (const command of this.pending.values()) this.transmit({ type: "COMMAND", command });
  }

  private notice(text: string): Notice {
    return { id: ++this.sequence, text };
  }

  private update(changes: Partial<RoomSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...changes };
    for (const listener of this.listeners) listener();
  }
}

/** Browser wiring: same-origin socket, crypto action ids, real timers. */
export function browserDeps(): ClientDeps {
  return {
    connect: (roomCode) => {
      const scheme = location.protocol === "https:" ? "wss:" : "ws:";
      return new WebSocket(scheme + "//" + location.host + "/api/rooms/" + encodeURIComponent(roomCode) + "/ws") as unknown as SocketLike;
    },
    now: () => Date.now(),
    newActionId: () => crypto.randomUUID(),
    schedule: (callback, ms) => setTimeout(callback, ms),
    cancel: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  };
}
