import { describe, expect, it } from "vitest";
import { DEFAULT_ROOM_SETTINGS, type ServerMessage } from "@moneygame/shared";
import { RoomClient, type SocketLike } from "./room-client";

class FakeSocket implements SocketLike {
  readyState = 0;
  sent: unknown[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((message: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  send(data: string): void {
    this.sent.push(JSON.parse(data));
  }
  close(): void {
    this.readyState = 3;
  }
  open(): void {
    this.readyState = 1;
    this.onopen?.();
  }
  drop(): void {
    this.readyState = 3;
    this.onclose?.();
  }
  deliver(message: ServerMessage): void {
    this.onmessage?.({ data: JSON.stringify(message) });
  }
}

function state(gameVersion: number): ServerMessage {
  return {
    type: "STATE",
    room: { roomCode: "ROOM42", hostUserId: "u1", phase: "IN_GAME", paused: false, settings: DEFAULT_ROOM_SETTINGS, members: [], turnDeadlineAt: null },
    game: { gameId: "g1", gameVersion } as never,
    you: { userId: "u1", role: "PLAYER" },
    event: null,
    stateHash: "h" + gameVersion,
    chat: null,
    serverTime: 5000,
  };
}

function setup() {
  const sockets: FakeSocket[] = [];
  const timers: (() => void)[] = [];
  let ids = 0;
  const client = new RoomClient("ROOM42", {
    connect: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
    now: () => 1000,
    newActionId: () => "a" + (ids += 1),
    schedule: (callback) => timers.push(callback),
    cancel: () => undefined,
  });
  client.start();
  return { client, sockets, timers, last: () => sockets.at(-1) as FakeSocket };
}

describe("room client", () => {
  it("never steps back to an older game version and tracks the server clock", () => {
    const { client, last } = setup();
    last().open();
    last().deliver(state(5));
    last().deliver(state(4));
    expect(client.getSnapshot().game?.gameVersion).toBe(5);
    expect(client.getSnapshot().clockOffset).toBe(4000);
  });

  it("resends an unanswered command with the same actionId after a reconnect", () => {
    const { client, last, timers } = setup();
    last().open();
    last().deliver(state(5));
    expect(client.command("ROLL_DICE", {})).toBe("a1");
    expect(last().sent).toEqual([{ type: "COMMAND", command: { type: "ROLL_DICE", gameId: "g1", actionId: "a1", expectedGameVersion: 5, payload: {} } }]);
    last().drop();
    expect(client.getSnapshot().status).toBe("RECONNECTING");
    timers.shift()?.();
    last().open();
    last().deliver(state(5));
    expect(last().sent).toEqual([{ type: "COMMAND", command: expect.objectContaining({ actionId: "a1" }) }]);
    last().deliver(state(6));
    expect(client.getSnapshot().pendingActionIds).toEqual([]);
  });

  it("drops a command the server already moved past instead of resending it", () => {
    const { client, last, timers } = setup();
    last().open();
    last().deliver(state(5));
    client.command("END_TURN", {});
    last().drop();
    timers.shift()?.();
    last().open();
    last().deliver(state(6));
    expect(last().sent).toEqual([]);
    expect(client.getSnapshot().pendingActionIds).toEqual([]);
  });

  it("clears a refused command and resyncs on a stale version", () => {
    const { client, last } = setup();
    last().open();
    last().deliver(state(5));
    client.command("BUILD", { assetId: "x" });
    last().deliver({ type: "REJECTED", actionId: "a1", reason: "STALE_GAME_VERSION", currentGameVersion: 6 });
    expect(client.getSnapshot().pendingActionIds).toEqual([]);
    expect(client.getSnapshot().notice?.text).toContain("board changed");
    expect(last().sent.at(-1)).toEqual({ type: "RESYNC" });
  });

  it("releases pending commands when the room refuses a frame outright", () => {
    const { client, last } = setup();
    last().open();
    last().deliver(state(5));
    client.command("ROLL_DICE", {});
    last().deliver({ type: "ERROR", code: "MALFORMED_MESSAGE" });
    expect(client.getSnapshot().pendingActionIds).toEqual([]);
  });

  it("stops for good when the session is replaced", () => {
    const { client, last, timers, sockets } = setup();
    last().open();
    last().deliver({ type: "SESSION_REPLACED" });
    expect(client.getSnapshot().status).toBe("REPLACED");
    expect(timers).toEqual([]);
    expect(sockets).toHaveLength(1);
  });

  it("reports an unreachable room after repeated failed first connects", () => {
    const { client, last, timers } = setup();
    for (let attempt = 0; attempt < 4; attempt += 1) {
      last().drop();
      timers.shift()?.();
    }
    expect(client.getSnapshot().status).toBe("UNREACHABLE");
    client.retry();
    expect(client.getSnapshot().status).toBe("CONNECTING");
  });
});
