import { describe, expect, it } from "vitest";
import {
  DEFAULT_ROOM_SETTINGS,
  MAX_CHAT_LENGTH,
  sanitizeChat,
  stateHash,
  MAX_CLIENT_MESSAGE_LENGTH,
  parseClientMessage,
  parseRoomSettings,
  ProtocolError,
} from "./protocol";

function code(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    if (error instanceof ProtocolError) return error.code;
    throw error;
  }
  return "OK";
}

describe("RT-002 shared wire protocol", () => {
  it("parses the three client message kinds strictly", () => {
    expect(parseClientMessage('{"type":"RESYNC"}')).toEqual({ type: "RESYNC" });
    expect(parseClientMessage('{"type":"ROOM","action":{"kind":"SET_READY","ready":true}}'))
      .toEqual({ type: "ROOM", action: { kind: "SET_READY", ready: true } });
    expect(parseClientMessage('{"type":"ROOM","action":{"kind":"PAUSE"}}')).toEqual({ type: "ROOM", action: { kind: "PAUSE" } });
    expect(parseClientMessage('{"type":"CHAT","text":"hi"}')).toEqual({ type: "CHAT", text: "hi" });
    const command = parseClientMessage(JSON.stringify({
      type: "COMMAND",
      command: { type: "ROLL_DICE", gameId: "g", actionId: "a", expectedGameVersion: 3, payload: {} },
    }));
    expect(command).toEqual({
      type: "COMMAND",
      command: { type: "ROLL_DICE", gameId: "g", actionId: "a", expectedGameVersion: 3, payload: {} },
    });
  });

  it("never accepts an actor identity or unknown fields from the client", () => {
    const withActor = JSON.stringify({
      type: "COMMAND",
      command: { type: "ROLL_DICE", gameId: "g", actionId: "a", payload: {}, actorUserId: "someone-else" },
    });
    expect(code(() => parseClientMessage(withActor))).toBe("MALFORMED_MESSAGE");
    expect(code(() => parseClientMessage('{"type":"RESYNC","userId":"x"}'))).toBe("MALFORMED_MESSAGE");
    expect(code(() => parseClientMessage('{"type":"ROOM","action":{"kind":"KICK"}}'))).toBe("MALFORMED_MESSAGE");
    expect(code(() => parseClientMessage('{"type":"CHAT","text":7}'))).toBe("MALFORMED_MESSAGE");
    expect(code(() => parseClientMessage("not json"))).toBe("MALFORMED_MESSAGE");
    expect(code(() => parseClientMessage("[]"))).toBe("MALFORMED_MESSAGE");
  });

  it("bounds message size", () => {
    const huge = JSON.stringify({ type: "RESYNC", pad: "x".repeat(MAX_CLIENT_MESSAGE_LENGTH) });
    expect(code(() => parseClientMessage(huge))).toBe("MESSAGE_TOO_LARGE");
  });

  it("validates room settings against the supported boards and turn clocks", () => {
    expect(parseRoomSettings(DEFAULT_ROOM_SETTINGS)).toEqual(DEFAULT_ROOM_SETTINGS);
    for (const bad of [
      { ...DEFAULT_ROOM_SETTINGS, boardRef: "world-tour-mega@1" },
      { ...DEFAULT_ROOM_SETTINGS, turnSeconds: 0 },
      { ...DEFAULT_ROOM_SETTINGS, startingCash: 1.5 },
      { ...DEFAULT_ROOM_SETTINGS, matchMode: "COOP" },
      { ...DEFAULT_ROOM_SETTINGS, turbo: true },
    ]) {
      expect(code(() => parseRoomSettings(bad))).toBe("MALFORMED_MESSAGE");
    }
  });

  it("sanitises chat and fingerprints state deterministically", () => {
    expect(sanitizeChat("  hello\u0007   there ")).toBe("hello there");
    expect(sanitizeChat("   ")).toBeNull();
    expect(sanitizeChat("x".repeat(MAX_CHAT_LENGTH + 1))).toBeNull();
    expect(stateHash('{"a":1}')).toBe(stateHash('{"a":1}'));
    expect(stateHash('{"a":1}')).not.toBe(stateHash('{"a":2}'));
    expect(stateHash("")).toBe("811c9dc5");
  });
});
