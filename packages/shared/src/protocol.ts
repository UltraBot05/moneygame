import type {
  GameplayEvent,
  GameplayRejectionReason,
  ProjectedGameState,
  TeamDefinition,
} from "@moneygame/game-core";

/** Wire-protocol version. Bump when the client/worker contract changes. */
export const PROTOCOL_VERSION = 4;

/** Longest chat message, after trimming (RT-011). */
export const MAX_CHAT_LENGTH = 280;

/** Largest client message the room accepts, in UTF-16 code units (RT-002 / RT-015 bound). */
export const MAX_CLIENT_MESSAGE_LENGTH = 16 * 1024;

export const BOARD_REFS = ["world-tour-standard@1", "world-tour-grand@1"] as const;
export type BoardRef = (typeof BOARD_REFS)[number];

export const TURN_SECONDS = [45, 90] as const;
export type TurnSeconds = (typeof TURN_SECONDS)[number];

/** Host-editable lobby settings; frozen into the game's MatchSettings at start. */
export interface RoomSettings {
  readonly boardRef: BoardRef;
  readonly startingCash: number;
  readonly matchMode: "FFA" | "TEAMS";
  readonly teams: readonly TeamDefinition[];
  readonly turnSeconds: TurnSeconds;
}

export const DEFAULT_ROOM_SETTINGS: RoomSettings = Object.freeze({
  boardRef: "world-tour-standard@1",
  startingCash: 2000,
  matchMode: "FFA",
  teams: Object.freeze([]),
  turnSeconds: 90,
});

export interface WireCommand {
  readonly type: string;
  readonly gameId: string;
  readonly actionId: string;
  readonly expectedGameVersion?: number;
  readonly payload: unknown;
}

/** Room lifecycle actions: lobby (ready/leave/configure/start) and host controls (pause/resume/rematch). */
export type RoomAction =
  | { readonly kind: "SET_READY"; readonly ready: boolean }
  | { readonly kind: "LEAVE" }
  | { readonly kind: "CONFIGURE"; readonly settings: RoomSettings }
  | { readonly kind: "START" }
  | { readonly kind: "PAUSE" }
  | { readonly kind: "RESUME" }
  | { readonly kind: "REMATCH" };

export type ClientMessage =
  | { readonly type: "COMMAND"; readonly command: WireCommand }
  | { readonly type: "ROOM"; readonly action: RoomAction }
  | { readonly type: "CHAT"; readonly text: string }
  | { readonly type: "RESYNC" };

export interface ChatMessage {
  readonly id: number;
  readonly userId: string;
  readonly displayName: string;
  readonly text: string;
  readonly at: number;
}

export interface MemberView {
  readonly userId: string;
  readonly displayName: string;
  readonly seatIndex: number;
  readonly ready: boolean;
  readonly connected: boolean;
  /** Reconnect lease expired; turns are being auto-played until an explicit rejoin. */
  readonly away: boolean;
  /** Equipped cosmetic token ring colour (looks only), or null. */
  readonly ring: string | null;
}

export interface RoomView {
  readonly roomCode: string;
  readonly hostUserId: string;
  readonly phase: "LOBBY" | "IN_GAME";
  /** Host pause (RT-010): game commands and every clock are frozen. */
  readonly paused: boolean;
  readonly settings: RoomSettings;
  readonly members: readonly MemberView[];
  /** Absolute server time the current turn auto-plays at, or null outside a turn. */
  readonly turnDeadlineAt: number | null;
}

export type ViewerRole = "PLAYER" | "SPECTATOR";

export type ServerMessage =
  | {
      /** Authoritative committed view for this viewer; `event` explains the change, if any. */
      readonly type: "STATE";
      readonly room: RoomView;
      readonly game: ProjectedGameState | null;
      readonly you: Readonly<{ userId: string; role: ViewerRole }>;
      readonly event: GameplayEvent | null;
      /** Diagnostic FNV-1a hash of the canonical state at this gameVersion (RT-014/018). */
      readonly stateHash: string | null;
      /** Full recent chat on connect and resync; null when unchanged. */
      readonly chat: readonly ChatMessage[] | null;
      readonly serverTime: number;
    }
  | { readonly type: "CHAT"; readonly message: ChatMessage }
  | {
      readonly type: "REJECTED";
      readonly actionId: string;
      readonly reason: GameplayRejectionReason | RoomRejection;
      readonly currentGameVersion?: number;
    }
  | { readonly type: "ERROR"; readonly code: ProtocolErrorCode }
  | { readonly type: "SESSION_REPLACED" };

export type RoomRejection =
  | "NOT_HOST"
  | "NOT_IN_LOBBY"
  | "NOT_A_MEMBER"
  | "HOST_CANNOT_LEAVE"
  | "NOT_ENOUGH_READY_PLAYERS"
  | "SPECTATORS_CANNOT_ACT"
  | "SYSTEM_COMMAND"
  | "INVALID_SETTINGS"
  | "MALFORMED_COMMAND"
  | "ROOM_PAUSED"
  | "NOT_PAUSED"
  | "GAME_NOT_OVER"
  | "RATE_LIMITED"
  | "INVALID_CHAT"
  | "ROOM_FULL"
  | "NOT_IN_GAME";

export type ProtocolErrorCode =
  | "MESSAGE_TOO_LARGE"
  | "MALFORMED_MESSAGE"
  | "RECONNECT_EXPIRED"
  | "ROOM_TEMPORARILY_UNAVAILABLE";

export class ProtocolError extends Error {
  constructor(readonly code: ProtocolErrorCode, message: string) {
    super(code + ": " + message);
    this.name = "ProtocolError";
  }
}

function malformed(message: string): never {
  throw new ProtocolError("MALFORMED_MESSAGE", message);
}

function object(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) malformed(field + " must be an object");
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[], field: string): void {
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(value)) if (!allowed.has(key)) malformed(field + "." + key + " is not allowed");
  for (const key of required) if (!(key in value)) malformed(field + "." + key + " is required");
}

function identifier(value: unknown, field: string, maxLength = 128): string {
  if (typeof value !== "string" || value.trim() === "" || value.length > maxLength) {
    malformed(field + " must be a non-empty string of at most " + maxLength + " characters");
  }
  return value;
}

/** Validates room settings wherever they come from (lobby form or wire). */
export function parseRoomSettings(value: unknown): RoomSettings {
  const settings = object(value, "settings");
  exactKeys(settings, ["boardRef", "startingCash", "matchMode", "teams", "turnSeconds"], [], "settings");
  const boardRef = BOARD_REFS.find((ref) => ref === settings.boardRef) ?? malformed("settings.boardRef is unknown");
  const turnSeconds = TURN_SECONDS.find((seconds) => seconds === settings.turnSeconds)
    ?? malformed("settings.turnSeconds must be 45 or 90");
  if (!Number.isSafeInteger(settings.startingCash)) malformed("settings.startingCash must be an integer");
  if (settings.matchMode !== "FFA" && settings.matchMode !== "TEAMS") malformed("settings.matchMode is unknown");
  if (!Array.isArray(settings.teams) || settings.teams.length > 10) malformed("settings.teams must be a short array");
  const teams = settings.teams.map((entry, index): TeamDefinition => {
    const team = object(entry, "settings.teams[" + index + "]");
    exactKeys(team, ["teamId", "memberUserIds"], [], "settings.teams[" + index + "]");
    if (!Array.isArray(team.memberUserIds) || team.memberUserIds.length > 10) malformed("team members must be a short array");
    return {
      teamId: identifier(team.teamId, "teamId", 32),
      memberUserIds: team.memberUserIds.map((member, memberIndex) => identifier(member, "member[" + memberIndex + "]")),
    };
  });
  return { boardRef, startingCash: settings.startingCash as number, matchMode: settings.matchMode, teams, turnSeconds };
}

function parseRoomAction(value: unknown): RoomAction {
  const action = object(value, "action");
  switch (action.kind) {
    case "SET_READY":
      exactKeys(action, ["kind", "ready"], [], "action");
      if (typeof action.ready !== "boolean") malformed("action.ready must be a boolean");
      return { kind: "SET_READY", ready: action.ready };
    case "LEAVE":
    case "START":
    case "PAUSE":
    case "RESUME":
    case "REMATCH":
      exactKeys(action, ["kind"], [], "action");
      return { kind: action.kind };
    case "CONFIGURE":
      exactKeys(action, ["kind", "settings"], [], "action");
      return { kind: "CONFIGURE", settings: parseRoomSettings(action.settings) };
    default:
      return malformed("unknown room action");
  }
}

/**
 * Parses one raw client frame: size-bounded, strict keys, no actor identity. Game-command
 * payloads are validated further by game-core's own strict command parser.
 */
export function parseClientMessage(raw: string): ClientMessage {
  if (raw.length > MAX_CLIENT_MESSAGE_LENGTH) {
    throw new ProtocolError("MESSAGE_TOO_LARGE", "client message exceeds " + MAX_CLIENT_MESSAGE_LENGTH + " characters");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return malformed("not JSON");
  }
  const message = object(parsed, "message");
  switch (message.type) {
    case "RESYNC":
      exactKeys(message, ["type"], [], "message");
      return { type: "RESYNC" };
    case "ROOM":
      exactKeys(message, ["type", "action"], [], "message");
      return { type: "ROOM", action: parseRoomAction(message.action) };
    case "CHAT":
      exactKeys(message, ["type", "text"], [], "message");
      if (typeof message.text !== "string") malformed("message.text must be a string");
      return { type: "CHAT", text: message.text };
    case "COMMAND": {
      exactKeys(message, ["type", "command"], [], "message");
      const command = object(message.command, "command");
      exactKeys(command, ["type", "gameId", "actionId", "payload"], ["expectedGameVersion"], "command");
      return {
        type: "COMMAND",
        command: {
          type: identifier(command.type, "command.type", 32),
          gameId: identifier(command.gameId, "command.gameId"),
          actionId: identifier(command.actionId, "command.actionId"),
          ...(command.expectedGameVersion === undefined ? {} : { expectedGameVersion: command.expectedGameVersion as number }),
          payload: command.payload,
        },
      };
    }
    default:
      return malformed("unknown message type");
  }
}

/** Trimmed, printable, single-spaced chat text, or null when empty or too long (RT-011). */
export function sanitizeChat(raw: string): string | null {
  const printable = Array.from(raw).filter((char) => {
    const point = char.codePointAt(0) ?? 0;
    return point >= 0x20 && point !== 0x7f;
  }).join("");
  const text = printable.replace(/\s+/g, " ").trim();
  return text === "" || Array.from(text).length > MAX_CHAT_LENGTH ? null : text;
}

/** 32-bit FNV-1a over a string: a cheap, deterministic diagnostic fingerprint (not security). */
export function stateHash(text: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}
