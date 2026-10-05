import { useState, useSyncExternalStore } from "react";
import {
  applyGameplayCommand,
  canonicalBoard,
  createInitialGameState,
  createSeededRandom,
  parseGameState,
  projectGameState,
  type GameState,
} from "@moneygame/game-core";
import { DEFAULT_ROOM_SETTINGS, type ChatMessage, type RoomAction, type RoomSettings, type RoomView } from "@moneygame/shared";
import { GameScreen } from "./Game";
import { Lobby } from "./Landing";
import type { RoomPort, RoomSnapshot } from "./room-client";

/**
 * DEV ONLY (tree-shaken from production builds): a hot-seat preview that runs game-core in the
 * browser so every screen can be exercised without Google sign-in or a Worker. It acts as
 * whoever the rules are waiting on. Never a source of truth for real games.
 */

const NAMES = ["Asha Rao", "Ben Ortiz", "Chen Wei", "Dara Okafor", "Eli Novak", "Farah Aziz", "Gus Lind", "Hana Sato", "Ivo Petrov", "Jo March"];

type Scene = "start" | "mid" | "debt";

function scene(ref: string, count: number, kind: Scene): GameState {
  const { board, cards } = canonicalBoard(ref);
  const ids = NAMES.slice(0, count).map((_name, index) => "p" + index);
  const initial = createInitialGameState({ gameId: "preview", board, playerIds: ids, startingCash: 2000 });
  const result = applyGameplayCommand(initial, { type: "START_GAME", gameId: "preview", actionId: "start", payload: {} },
    { actorUserId: "p0", board, rng: createSeededRandom(7), cardCatalog: cards, currentTime: Date.now() });
  if (result.kind !== "ACCEPTED") throw new Error("preview start failed");
  if (kind === "start") return result.state;
  // Deal every other set to a player, develop the first, mortgage one deed, jail someone.
  const sets = board.economyProfile.sets;
  const owner = new Map<string, string>();
  sets.forEach((set, index) => {
    for (const property of set.properties) owner.set(property.id, ids[index % ids.length] as string);
  });
  const tiles = board.economyProfile.tiles;
  const firstSet = new Set(sets[0]?.properties.map((property) => property.id));
  const state = {
    ...result.state,
    assets: result.state.assets.map((asset, index) => {
      const tile = tiles[asset.tileIndex];
      if (tile?.type !== "property") return index % 3 === 0 || kind === "debt" ? { ...asset, ownerUserId: ids[count - 1] as string } : asset;
      const ownerUserId = owner.get(tile.propertyId) ?? null;
      return asset.kind === "PROPERTY"
        ? { ...asset, ownerUserId, developmentLevel: firstSet.has(tile.propertyId) ? 2 : 0, mortgaged: tile.propertyId === sets[3]?.properties[0]?.id }
        : asset;
    }),
    players: result.state.players.map((player, index) => index === 2
      ? { ...player, inHolding: true, position: tiles.findIndex((tile) => tile.type === "corner" && tile.name === "HOLDING") }
      : { ...player, position: (index * 7) % tiles.length, cash: kind === "debt" && index < count - 1 ? 5 : player.cash }),
  };
  return parseGameState(state, board, cards);
}

class LocalRoom implements RoomPort {
  private state: GameState;
  private snapshot: RoomSnapshot;
  private readonly listeners = new Set<() => void>();
  private readonly rng = createSeededRandom(11);
  private sequence = 0;
  private paused = false;
  private settings: RoomSettings = DEFAULT_ROOM_SETTINGS;
  private readonly ready = new Set<string>(["p1", "p2"]);
  private chatLog: ChatMessage[] = [];

  constructor(private readonly ref: string, private readonly count: number, kind: Scene, private readonly lobby = false) {
    this.state = scene(ref, count, kind);
    this.snapshot = this.build(null);
  }

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = () => this.snapshot;

  /** The player the rules are waiting on. */
  private actor(): string {
    const auction = this.state.auction;
    // Open auction, hot-seat: hand the controls to the first player still in who is not leading.
    if (auction !== null) return auction.participantOrder.find((userId) => !auction.passedPlayerIds.includes(userId) && userId !== auction.highBidderUserId) ?? auction.originatingPlayerId;
    const trade = this.state.ruleState.trades.at(-1);
    if (trade !== undefined) return trade.recipientUserId;
    return this.state.pendingResolution?.decisionOwnerUserId ?? this.state.turn?.activePlayerId ?? "p0";
  }

  private roomView(): RoomView {
    return {
      roomCode: "PREVIEW", hostUserId: "p0", phase: this.lobby ? "LOBBY" : "IN_GAME", paused: this.paused,
      settings: this.lobby ? this.settings : { ...DEFAULT_ROOM_SETTINGS, boardRef: this.ref as RoomView["settings"]["boardRef"] },
      members: NAMES.slice(0, this.count).map((displayName, seatIndex) => ({
        userId: "p" + seatIndex, displayName, seatIndex, ready: !this.lobby || this.ready.has("p" + seatIndex), connected: seatIndex !== 3, away: false, ring: seatIndex === 1 ? "#E3BC63" : null,
      })),
      turnDeadlineAt: this.paused ? null : Date.now() + 60_000,
    };
  }

  private build(event: RoomSnapshot["events"][number]["event"] | null, notice: string | null = null): RoomSnapshot {
    const viewer = this.lobby ? "p0" : this.actor();
    const game = projectGameState(this.state, viewer);
    const previous = this.snapshot?.events ?? [];
    return {
      status: "OPEN", room: this.roomView(), game, you: { userId: viewer, role: "PLAYER" }, chat: this.chatLog,
      events: event === null ? previous : [...previous, { id: ++this.sequence, event, game }].slice(-120),
      stateHash: "preview", clockOffset: 0, pendingActionIds: [],
      notice: notice === null ? null : { id: ++this.sequence, text: notice },
    };
  }

  private emit(snapshot: RoomSnapshot) {
    this.snapshot = snapshot;
    for (const listener of this.listeners) listener();
  }

  command(type: string, payload: unknown): string {
    const { board, cards } = canonicalBoard(this.ref);
    const now = Date.now();
    const actionId = "local-" + (this.sequence + 1);
    const result = applyGameplayCommand(this.state, { type, gameId: this.state.gameId, actionId, expectedGameVersion: this.state.gameVersion, payload },
      { actorUserId: this.actor(), board, rng: this.rng, cardCatalog: cards, currentTime: now, auctionDecisionDeadlineAt: now + (type === "PLACE_BID" ? 10_000 : 20_000), debtDeadlineAt: now + 120_000 });
    if (result.kind === "ACCEPTED") {
      this.state = result.state;
      this.emit(this.build(result.event));
    } else {
      this.emit(this.build(null, "Refused: " + ("reason" in result ? String(result.reason) : result.kind)));
    }
    return actionId;
  }

  room(action: RoomAction): void {
    if (action.kind === "PAUSE" || action.kind === "RESUME") this.paused = action.kind === "PAUSE";
    if (action.kind === "CONFIGURE") {
      this.settings = action.settings;
      this.ready.clear();
    }
    if (action.kind === "SET_READY") {
      if (action.ready) this.ready.add("p0");
      else this.ready.delete("p0");
    }
    this.emit(this.build(null));
  }

  chat(text: string): void {
    this.chatLog = [...this.chatLog, { id: ++this.sequence, userId: this.actor(), displayName: "You", text, at: Date.now() }];
    this.emit(this.build(null));
  }

  dismissNotice(): void {
    this.emit({ ...this.snapshot, notice: null });
  }
}

export function DevPreview() {
  const params = new URLSearchParams(location.search);
  const ref = params.get("board") === "grand" ? "world-tour-grand@1" : "world-tour-standard@1";
  const count = Math.min(10, Math.max(3, Number.parseInt(params.get("players") ?? "", 10) || (ref.includes("grand") ? 8 : 4)));
  const kind = params.get("scene");
  const [room] = useState(() => new LocalRoom(ref, count, kind === "start" || kind === "debt" ? kind : "mid", kind === "lobby"));
  const snapshot = useSyncExternalStore(room.subscribe, room.getSnapshot);
  return kind === "lobby"
    ? <Lobby snapshot={snapshot} client={room} me={{ userId: "p0", displayName: NAMES[0] as string }} />
    : <GameScreen snapshot={snapshot} client={room} />;
}
