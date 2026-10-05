import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from "react";
import type { ProjectedGameState } from "@moneygame/game-core";
import type { RoomView } from "@moneygame/shared";
import { computeLayout, type TilePos } from "./board/layout";
import { ConfirmDialog, EndgameDialog, PausedOverlay, Token, TradeDialog, type TradeDraft } from "./Dialogs";
import type { RoomPort, RoomSnapshot } from "./room-client";
import {
  boardModel,
  deedModel,
  describeEvent,
  fitName,
  money,
  nameOf,
  PATTERN_CSS,
  playerModels,
  textOn,
  tileBand,
  turnModel,
  type ActionButton,
  type BoardModel,
  type CommandIntent,
  type PlayerModel,
  type TileModel,
} from "./view-model";

/** Ticks local time for countdowns; the server's deadlines stay authoritative. */
export function useNow(intervalMs = 500): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const handle = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(handle);
  }, [intervalMs]);
  return now;
}

function secondsLeft(deadline: number | null | undefined, now: number, offset: number): number | null {
  return deadline === null || deadline === undefined ? null : Math.max(0, Math.ceil((deadline - (now + offset)) / 1000));
}

function clockText(seconds: number | null): string {
  if (seconds === null) return "--:--";
  return Math.floor(seconds / 60) + ":" + String(seconds % 60).padStart(2, "0");
}

/** The set band on a tile's inner edge; buildings sit on it (as on a printed board) in place of the code. */
function Band({ tile, className, level = 0 }: { tile: TileModel; className: string; level?: number }) {
  const band = tileBand(tile);
  if (band === null) return null;
  return (
    <span className={className} style={{ background: band.color, ...PATTERN_CSS[band.pattern] }}>
      {level > 0 ? (
        <span className="tile-dev" aria-label={level === 4 ? "landmark" : level + " buildings"}>
          {level === 4 ? <i className="landmark" /> : Array.from({ length: level }, (_unused, index) => <i key={index} />)}
        </span>
      ) : <span className="tile-code">{band.code}</span>}
    </span>
  );
}

const PIP_CELLS: Readonly<Record<number, readonly number[]>> = {
  1: [4], 2: [0, 8], 3: [0, 4, 8], 4: [0, 2, 6, 8], 5: [0, 2, 4, 6, 8], 6: [0, 2, 3, 5, 6, 8],
};

/**
 * A CSS 3D die: six faces on a cube (opposite faces sum to 7), each with its placement and the
 * cube rotation [x, y] that turns it to the front. A roll tumbles in from extra turns and lands on
 * the server's number; the result is never decided here.
 */
const FACES: readonly (readonly [value: number, place: string, x: number, y: number])[] = [
  [1, "rotateY(0deg)", 0, 0], [6, "rotateY(180deg)", 0, 180], [3, "rotateY(90deg)", 0, -90],
  [4, "rotateY(-90deg)", 0, 90], [2, "rotateX(90deg)", -90, 0], [5, "rotateX(-90deg)", 90, 0],
];

function Die({ face, rolling, spin = 1 }: { face: number | null; rolling: boolean; spin?: 1 | -1 }) {
  const [, , x, y] = FACES.find(([value]) => value === (face ?? 1)) ?? FACES[0] as (typeof FACES)[number];
  // Same function list in both, so the browser interpolates angles (whole extra turns) rather than matrices.
  const cube = {
    "--show": "rotateX(" + x + "deg) rotateY(" + y + "deg) rotateZ(0deg)",
    "--spin": "rotateX(" + (x + 720 * spin) + "deg) rotateY(" + (y + 360 * spin) + "deg) rotateZ(" + 180 * spin + "deg)",
  } as CSSProperties;
  return (
    <span className={"die" + (rolling ? " rolling" : "") + (face === null ? " idle" : "")} role="img" aria-label={face === null ? "die" : "die showing " + face}>
      <span className="die-cube" style={cube}>
        {FACES.map(([value, place]) => (
          <span key={value} className="die-face" style={{ transform: place + " translateZ(calc(var(--die) / 2))" }}>
            <span className="pips">
              {Array.from({ length: 9 }, (_unused, cell) => <i key={cell} style={{ background: PIP_CELLS[value]?.includes(cell) ? "var(--pip)" : "transparent" }} />)}
            </span>
          </span>
        ))}
      </span>
    </span>
  );
}

interface BoardProps {
  readonly game: ProjectedGameState;
  readonly board: BoardModel;
  readonly players: readonly PlayerModel[];
  readonly selected: number | null;
  readonly onSelect: (index: number) => void;
  /** A player hovered or focused in the list: their deeds and pawn light up, the rest dims. */
  readonly spotlight: string | null;
  readonly children: ReactNode;
}

/**
 * Display-only pawn movement: each pawn steps one tile at a time toward its authoritative
 * position (the server state is never changed). Long or backward moves, such as Go To Holding
 * or a card, jump; reduced-motion users always jump.
 */
function useSteppedPositions(game: ProjectedGameState): Readonly<Record<string, number>> {
  const tileCount = game.board.tileCount;
  const target = useMemo(() => Object.fromEntries(game.players.map((player) => [player.userId, player.position])), [game.players]);
  const [shown, setShown] = useState<Readonly<Record<string, number>>>(target);
  useEffect(() => {
    const reduce = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
    const timer = setInterval(() => {
      setShown((previous) => {
        let changed = false;
        const next: Record<string, number> = {};
        for (const [userId, to] of Object.entries(target)) {
          const from = previous[userId];
          const ahead = from === undefined ? 0 : (to - from + tileCount) % tileCount;
          next[userId] = from === undefined || reduce || ahead === 0 || ahead > 16 ? to : (from + 1) % tileCount;
          if (next[userId] !== from) changed = true;
        }
        return changed ? next : previous;
      });
    }, 130);
    return () => clearInterval(timer);
  }, [target, tileCount]);
  return shown;
}

function BoardView({ game, board, players, selected, onSelect, spotlight, children }: BoardProps) {
  const shown = useSteppedPositions(game);
  const activeUserId = players.find((player) => player.active)?.userId;
  const activeTile = activeUserId === undefined ? null : shown[activeUserId] ?? null;
  const spot = players.find((player) => player.userId === spotlight && !player.bankrupt);
  const spotTile = spot === undefined ? null : shown[spot.userId] ?? null;
  const layout = useMemo(() => computeLayout(board.tiles.length), [board.tiles.length]);
  return (
    <div className={"board" + (spot === undefined ? "" : " spotlit")} role="group" aria-label={board.label + " board"}
      style={spot === undefined ? undefined : { "--spot": spot.color } as CSSProperties}>
      <div className="board-grid" style={{ "--per-side": layout.perSide } as CSSProperties}>
        {layout.tiles.map((position) => {
          const tile = board.tiles[position.index];
          if (tile === undefined) return null;
          const here = players.filter((player) => !player.bankrupt && shown[player.userId] === tile.index);
          return (
            <TileView key={tile.index} tile={tile} position={position} game={game} players={players} here={here}
              selected={selected === tile.index} activeHere={activeTile === tile.index} onSelect={onSelect}
              spotlight={spot?.userId ?? null} spotHere={spotTile === tile.index} />
          );
        })}
        <div className="stage" style={{ gridRow: layout.center.row + " / span " + layout.center.span, gridColumn: layout.center.column + " / span " + layout.center.span }}>
          {children}
        </div>
      </div>
    </div>
  );
}

interface TileProps {
  readonly tile: TileModel;
  readonly position: TilePos;
  readonly game: ProjectedGameState;
  readonly players: readonly PlayerModel[];
  readonly here: readonly PlayerModel[];
  readonly selected: boolean;
  /** The active player's pawn stands here. */
  readonly activeHere: boolean;
  readonly onSelect: (index: number) => void;
  readonly spotlight: string | null;
  /** The spotlit player's pawn stands here. */
  readonly spotHere: boolean;
}

/**
 * Pawns in their own area of the tile. Several on one tile overlap sideways (--n) to fit; five or
 * more (the start of a big match, a full Holding) split into two rows of smaller pawns.
 */
function Tokens({ list }: { list: readonly PlayerModel[] }) {
  if (list.length === 0) return null;
  const half = Math.ceil(list.length / 2);
  const rows = list.length > 4 ? [list.slice(0, half), list.slice(half)] : [list];
  return (
    <span className={"tile-tokens" + (rows.length > 1 ? " crowded" : "")}>
      {rows.map((row, index) => (
        <span key={index} className="token-row" style={{ "--n": row.length } as CSSProperties}>
          {row.map((player) => <Token key={player.userId} player={player} active={player.active} />)}
        </span>
      ))}
    </span>
  );
}

function TileView({ tile, position, game, players, here, selected, activeHere, onSelect, spotlight, spotHere }: TileProps) {
  const place = { gridRow: position.gridRow, gridColumn: position.gridColumn };
  const asset = game.assets.find((candidate) => candidate.tileIndex === tile.index);
  const owner = asset?.ownerUserId === null || asset === undefined ? undefined : players.find((player) => player.userId === asset.ownerUserId);
  const lit = spotHere || (spotlight !== null && owner?.userId === spotlight);
  const highlight = (activeHere ? " tile-active" : "") + (lit ? " tile-lit" : "");
  if (tile.kind === "corner") {
    const holding = tile.corner === "HOLDING";
    const inside = here.filter((player) => player.inHolding);
    const visiting = here.filter((player) => !player.inHolding);
    const glyph = tile.corner === "START" ? "▶" : tile.corner === "VACATION" ? "◍" : tile.corner === "GO_TO_HOLDING" ? "⇥" : "";
    return (
      <div className={"tile corner" + highlight} data-edge="corner" style={place} aria-label={tile.name}>
        {holding ? (
          <>
            <span className="visiting-lane"><span>Visiting</span></span>
            <span className="holding-cell"><span className="corner-name">Holding</span><Tokens list={inside} /></span>
            <Tokens list={visiting} />
          </>
        ) : (
          <>
            <span className="corner-inner">
              <span className="corner-glyph">{glyph}</span>
              <span className="corner-name">{tile.name}</span>
              {tile.corner === "START" && <span className="corner-sub">Pass {money(200)} · Land {money(300)}</span>}
            </span>
            <Tokens list={here} />
          </>
        )}
      </div>
    );
  }
  const levelCount = asset?.kind === "PROPERTY" ? asset.developmentLevel : 0;
  const band = tileBand(tile);
  const ownable = asset !== undefined;
  const label = tile.name + (owner === undefined ? "" : ", owned by " + owner.name) + (asset?.mortgaged ? ", mortgaged" : "");
  const price = tile.price !== null ? money(tile.price) : tile.taxAmount !== null ? money(tile.taxAmount) : null;
  // Side tiles lose width to the outer strip; card tiles (no price) have none and keep the room.
  const side = position.edge === "left" || position.edge === "right";
  const fitted = fitName(tile.name, side ? (owner !== undefined || price !== null ? 6 : 8.5) : 6.5);
  // Inner edge: set band (and buildings). Body: the name, then the pawn area (with the tile's icon
  // behind it). Outer edge: the price, replaced by the owner's colour once bought.
  const content = (
    <>
      <Band tile={tile} className="tile-band" level={levelCount} />
      <span className="tile-body">
        <span className="tile-name" style={{ "--fit": fitted.fit } as CSSProperties}>{fitted.text}</span>
        <span className="tile-zone">
          {tile.kind !== "property" && band !== null && <span className="tile-glyph" style={{ color: "color-mix(in srgb, " + band.color + " 60%, #fff)" }}>{band.glyph}</span>}
          <Tokens list={here} />
        </span>
      </span>
      {owner !== undefined
        ? <span className={"tile-strip owned" + (asset?.mortgaged ? " mortgaged" : "")} style={{ background: owner.color, color: textOn(owner.color) }}>{owner.initials}</span>
        : price !== null && <span className="tile-strip tabular">{price}</span>}
    </>
  );
  return ownable ? (
    <button type="button" className={"tile" + highlight} data-edge={position.edge} style={place} aria-pressed={selected} aria-label={label} onClick={() => onSelect(tile.index)}>
      {content}
    </button>
  ) : (
    <div className={"tile" + highlight} data-edge={position.edge} style={place} aria-label={label}>{content}</div>
  );
}

function ActionButtons({ primary, secondary, busy, act, dark = false }: {
  primary: ActionButton | null; secondary: readonly ActionButton[]; busy: boolean; act: (intent: CommandIntent) => void; dark?: boolean;
}) {
  return (
    <>
      {primary !== null && (
        // Rolling happens on the board beside the dice; the rail copy only shows on phones (see .rail-roll).
        <button type="button" className={"btn btn-primary" + (primary.intent.type === "ROLL_DICE" ? " rail-roll" : "")} disabled={busy || primary.disabledReason !== undefined}
          title={primary.disabledReason} onClick={() => act(primary.intent)}>
          {primary.label}{primary.disabledReason !== undefined && <span style={{ fontWeight: 600, fontSize: 11 }}> · {primary.disabledReason}</span>}
        </button>
      )}
      {secondary.map((action) => (
        <button key={action.label} type="button" className={dark ? "btn btn-slate" : "btn btn-paper"} disabled={busy || action.disabledReason !== undefined}
          title={action.disabledReason} onClick={() => act(action.intent)}>
          {action.label}
        </button>
      ))}
    </>
  );
}

function lastRoll(snapshot: RoomSnapshot): Readonly<{ id: number; dice: readonly [number, number]; total: number; playerId: string; to: number | null }> | null {
  for (let index = snapshot.events.length - 1; index >= 0; index -= 1) {
    const entry = snapshot.events[index];
    if (entry === undefined) continue;
    const found = [entry.event, ...(entry.event.type === "TURN_AUTO_PLAYED" ? entry.event.steps : [])].reverse()
      .find((event) => event.type === "DICE_ROLLED");
    if (found?.type === "DICE_ROLLED") {
      return { id: entry.id, dice: found.roll.dice, total: found.roll.total, playerId: found.playerId, to: found.movement?.to ?? null };
    }
  }
  return null;
}

interface StageProps {
  readonly snapshot: RoomSnapshot;
  readonly game: ProjectedGameState;
  readonly room: RoomView;
  readonly board: BoardModel;
  readonly players: readonly PlayerModel[];
  readonly viewerUserId: string;
  readonly busy: boolean;
  readonly act: (intent: CommandIntent) => void;
  readonly now: number;
}

function CenterStage(props: StageProps) {
  const { snapshot, game, room, board, players, viewerUserId, busy, act } = props;
  const [dismissedCard, setDismissedCard] = useState(0);
  const latest = snapshot.events.at(-1);
  if (game.auction !== null) return <AuctionStage {...props} />;
  if (latest !== undefined && latest.id !== dismissedCard) {
    const card = [latest.event, ...(latest.event.type === "TURN_AUTO_PLAYED" ? latest.event.steps : [])].find((event) => event.type === "CARD_RESOLVED");
    if (card?.type === "CARD_RESOLVED") {
      const cardId = card.drawnCardIds.at(-1);
      const deckId = game.ruleState.decks.find((deck) => cardId !== undefined && deck.discardPile.includes(cardId))?.deckId
        ?? (game.ruleState.heldCards.find((held) => held.cardId === cardId)?.deckId ?? "surprise");
      const copy = cardId === undefined ? undefined : board.cardCopy[cardId];
      return (
        <div className="stage-pad" style={{ alignItems: "center", justifyContent: "center" }}>
          <div className="event-card" role="dialog" aria-label="Card drawn">
            <div className="event-card-head" style={{ background: deckId === "treasure" ? "var(--positive)" : "var(--brass)", color: "#fff" }}>
              <span className="label">{deckId === "treasure" ? "Treasure" : "Surprise"}</span>
              <span className="label">{nameOf(room, card.playerId)}</span>
            </div>
            <div className="event-card-body">
              <div className="event-card-title">{copy?.title ?? "Card"}</div>
              <div className="event-card-text">{copy?.text ?? ""}</div>
              {card.outcome === "SUSPENDED" && <div className="notice urgent">Payment due. Raise cash to continue.</div>}
              <button type="button" className="btn btn-dark" onClick={() => setDismissedCard(latest.id)}>Continue</button>
            </div>
          </div>
        </div>
      );
    }
  }
  const turn = turnModel(game, room, board, viewerUserId);
  const roll = lastRoll(snapshot);
  const rollAction = turn.primary?.intent.type === "ROLL_DICE" ? turn.primary : null;
  // The latest few log lines sit under the dice, newest first, so the centre tells the story of the turn.
  const recent = snapshot.events.slice(-4).flatMap((entry) => describeEvent(entry.event, entry.game, board, (userId) => nameOf(room, userId))).slice(-5).reverse();
  const order = players.filter((player) => !player.bankrupt);
  const mySets = board.sets.filter((set) => set.tileIndexes.some((index) => game.assets.find((asset) => asset.tileIndex === index)?.ownerUserId === viewerUserId));
  return (
    <div className="stage-pad">
      <div className="stage-head">
        <span className="stage-brand">Money<span>·</span>Game</span>
        <span className="label" style={{ color: "var(--on-slate-mute)" }}>{board.label}</span>
      </div>
      <div className="stage-mid">
        <span className="label" style={{ color: turn.isMine ? "var(--primary-light)" : "var(--on-slate-mute)" }}>{turn.kicker}</span>
        <div className="stage-dice">
          <Die key={"a" + (roll?.id ?? 0)} face={roll?.dice[0] ?? null} rolling={roll !== null} />
          <Die key={"b" + (roll?.id ?? 0)} face={roll?.dice[1] ?? null} rolling={roll !== null} spin={-1} />
        </div>
        {roll !== null && (
          <span className="total-chip">
            <span className="label">Total</span><b className="tabular">{roll.total}</b>
            {roll.to !== null && <span style={{ fontWeight: 700 }}>{nameOf(room, roll.playerId)} to {board.tiles[roll.to]?.name}</span>}
          </span>
        )}
        {rollAction !== null && (
          <button type="button" className="btn btn-primary stage-roll" disabled={busy}
            onClick={() => act(rollAction.intent)}>{rollAction.label}</button>
        )}
        {recent.length > 0 && (
          <ol className="stage-log" aria-label="Recent moves">
            {recent.map((line, index) => <li key={index}>{line}</li>)}
          </ol>
        )}
      </div>
      <div className="stage-foot">
        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          <span className="label" style={{ color: "var(--on-slate-mute)" }}>Turn order</span>
          {order.map((player) => <Token key={player.userId} player={player} size={22} active={player.active} />)}
          {mySets.length > 0 && <span className="label" style={{ color: "var(--on-slate-mute)", marginLeft: "auto" }}>Your sets</span>}
          {mySets.map((set) => <span key={set.setId} title={set.country} style={{ width: 12, height: 12, background: set.color, ...PATTERN_CSS[set.pattern] }} />)}
        </div>
      </div>
    </div>
  );
}

function AuctionStage({ game, room, board, players, viewerUserId, busy, act, now, snapshot }: StageProps) {
  const auction = game.auction;
  const [custom, setCustom] = useState("");
  if (auction === null) return null;
  const asset = game.assets.find((candidate) => candidate.assetId === auction.assetId);
  const tile = asset === undefined ? undefined : board.tiles[asset.tileIndex];
  const me = game.players.find((player) => player.userId === viewerUserId);
  const minimum = auction.highBid === null ? 2 : auction.highBid + 2;
  const myTurn = auction.currentActorUserId === viewerUserId && me !== undefined;
  const seconds = secondsLeft(auction.decisionDeadlineAt, now, snapshot.clockOffset);
  const bid = (amount: number) => act({ type: "PLACE_BID", payload: { auctionId: auction.auctionId, amount } });
  const base = auction.highBid ?? 0;
  const customAmount = Number.parseInt(custom, 10);
  return (
    <div className="stage-pad">
      <div className="stage-head">
        <span className="label" style={{ color: "var(--primary-light)" }}>Auction live</span>
        <span className="label" style={{ color: seconds !== null && seconds <= 5 ? "var(--primary-light)" : "var(--on-slate-mute)" }}>
          {nameOf(room, auction.currentActorUserId)} to act · closes {clockText(seconds)}
        </span>
      </div>
      <div className="stage-mid" style={{ flexDirection: "row", gap: 22 }}>
        {tile !== undefined && (
          <div className="auction-lot">
            <span className="auction-lot-band" style={{ background: tileBand(tile)?.color, ...PATTERN_CSS[tileBand(tile)?.pattern ?? "solid"] }}>{tileBand(tile)?.code}</span>
            <span style={{ padding: 8, fontWeight: 900, textTransform: "uppercase", fontSize: 14, lineHeight: 1.1 }}>{tile.name}</span>
            <span style={{ padding: "0 8px 8px", fontSize: 11, fontWeight: 700, color: "var(--on-slate-mute)" }}>List {money(tile.price ?? 0)}</span>
          </div>
        )}
        <div style={{ display: "flex", flexDirection: "column", gap: 10, minWidth: 0 }}>
          <span className="label" style={{ color: "var(--on-slate-mute)" }}>Current bid</span>
          <span className="auction-figure tabular">{auction.highBid === null ? "No bids" : money(auction.highBid)}</span>
          <span style={{ fontWeight: 700 }}>
            {auction.highBidderUserId === null ? "Opening bid " + money(minimum) : "Leader: " + nameOf(room, auction.highBidderUserId)}
          </span>
          {myTurn ? (
            <>
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                {[10, 50, 100].map((step) => {
                  const amount = Math.max(minimum, base + step);
                  return (
                    <button key={step} type="button" className="btn btn-paper" disabled={busy || amount > me.cash} onClick={() => bid(amount)}>
                      {money(amount)}
                    </button>
                  );
                })}
              </div>
              <div style={{ display: "flex", gap: 6 }}>
                <label className="input-box">
                  <span className="visually-hidden">Custom bid</span>
                  <input inputMode="numeric" value={custom} placeholder={String(minimum)} onChange={(event) => setCustom(event.target.value.replace(/\D/g, ""))} />
                </label>
                <button type="button" className="btn btn-primary" disabled={busy || !(customAmount >= minimum && customAmount <= me.cash)} onClick={() => bid(customAmount)}>Bid</button>
                <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => act({ type: "PASS_AUCTION", payload: { auctionId: auction.auctionId } })}>Pass</button>
              </div>
              <span style={{ fontSize: 12, color: "var(--on-slate-mute)" }}>Minimum {money(minimum)} · your cash {money(me.cash)}</span>
            </>
          ) : (
            <span style={{ fontSize: 12, color: "var(--on-slate-mute)" }}>Waiting for {nameOf(room, auction.currentActorUserId)}.</span>
          )}
        </div>
      </div>
      <div className="stage-foot">
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
          <span className="label" style={{ color: "var(--on-slate-mute)" }}>In the room</span>
          {auction.participantOrder.map((userId) => {
            const player = players.find((candidate) => candidate.userId === userId);
            if (player === undefined) return null;
            const passed = auction.passedPlayerIds.includes(userId);
            return (
              <span key={userId} className="bidder-chip" style={{ opacity: passed ? 0.5 : 1 }}>
                <Token player={player} size={16} />{player.name}{passed ? " · passed" : userId === auction.highBidderUserId ? " · leading" : ""}
              </span>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function DeedPanel({ game, board, tileIndex, viewerUserId, players, busy, act, onClose }: {
  game: ProjectedGameState; board: BoardModel; tileIndex: number; viewerUserId: string; players: readonly PlayerModel[];
  busy: boolean; act: (intent: CommandIntent) => void; onClose: () => void;
}) {
  const deed = deedModel(game, board, tileIndex, viewerUserId);
  if (deed === null) return null;
  const band = tileBand(deed.tile);
  const owner = players.find((player) => player.userId === deed.ownerUserId);
  return (
    <div className="deed" role="dialog" aria-label={deed.tile.name + " deed"} style={{ left: 16, top: 16 }}>
      <div className="deed-head" style={{ background: band?.color, ...PATTERN_CSS[band?.pattern ?? "solid"] }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 6, minWidth: 0 }}>
          <span className="deed-set">{deed.tile.set?.country ?? band?.code}</span>
          <span className="deed-name">{deed.tile.name}</span>
        </div>
        <button type="button" className="deed-close" aria-label="Close deed" onClick={onClose}>✕</button>
      </div>
      <div className="deed-owner">
        {owner === undefined ? <span>Unowned · bank</span> : <><Token player={owner} size={20} /><span>{owner.name}</span></>}
        {deed.asset?.mortgaged && <span style={{ marginLeft: "auto", color: "var(--danger)" }} className="label">Mortgaged</span>}
      </div>
      <div style={{ padding: "8px 14px" }}>
        {deed.rentRows.map(([label, value, active]) => (
          <div key={label} className={"deed-row" + (active ? " active" : "")}><span>{label}</span><b className="tabular">{value}</b></div>
        ))}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", columnGap: 12, marginTop: 6 }}>
          {deed.costRows.map(([label, value]) => (
            <div key={label} className="deed-row"><span>{label}</span><b className="tabular">{value}</b></div>
          ))}
        </div>
      </div>
      {deed.actions.length > 0 && (
        <div className="deed-actions">
          {deed.actions.map((action) => (
            <button key={action.label} type="button" className="btn btn-paper" style={{ padding: "7px 10px", fontSize: 12 }}
              disabled={busy || action.disabledReason !== undefined} title={action.disabledReason} onClick={() => act(action.intent)}>
              {action.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

interface RailProps {
  readonly snapshot: RoomSnapshot;
  readonly client: RoomPort;
  readonly game: ProjectedGameState;
  readonly room: RoomView;
  readonly board: BoardModel;
  readonly players: readonly PlayerModel[];
  readonly viewerUserId: string;
  readonly spectator: boolean;
  readonly busy: boolean;
  readonly act: (intent: CommandIntent) => void;
  readonly now: number;
  readonly onTrade: (draft: TradeDraft) => void;
  readonly onSelect: (index: number) => void;
  readonly onBankrupt: () => void;
  readonly onResign: () => void;
  readonly spotlight: string | null;
  readonly onSpotlight: (userId: string | null) => void;
}

function DebtPanel({ game, room, board, viewerUserId, now, snapshot, onSelect, onTrade, onBankrupt, busy }: RailProps) {
  const pending = game.pendingResolution;
  const obligation = pending?.obligation;
  if (pending === null || obligation === null || obligation === undefined || obligation.debtorUserId !== viewerUserId) return null;
  const me = game.players.find((player) => player.userId === viewerUserId);
  const creditor = obligation.creditor.type === "BANK" ? "the bank" : nameOf(room, obligation.creditor.userId);
  const seconds = secondsLeft(game.ruleState.debt?.deadlineAt, now, snapshot.clockOffset);
  const mine = game.assets.filter((asset) => asset.ownerUserId === viewerUserId);
  const options = mine.flatMap((asset) => {
    const deed = deedModel(game, board, asset.tileIndex, viewerUserId);
    const action = deed?.actions.find((candidate) => candidate.disabledReason === undefined);
    return deed === null || action === undefined ? [] : [{ tileIndex: asset.tileIndex, name: deed.tile.name, label: action.label }];
  });
  return (
    <section className="debt-panel" aria-label="Payment due">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
        <span className="label">Payment due to {creditor}</span>
        <span className="label tabular">{clockText(seconds)}</span>
      </div>
      <span className="debt-figure tabular">{money(obligation.amount)}</span>
      <span style={{ fontWeight: 600 }}>You have {money(me?.cash ?? 0)}. Raise {money(obligation.amount - (me?.cash ?? 0))} by selling buildings, mortgaging or trading. It pays automatically once covered.</span>
      <div style={{ display: "flex", flexDirection: "column", gap: 5, maxHeight: 150, overflowY: "auto" }} className="scroll">
        {options.map((option) => (
          <button key={option.tileIndex} type="button" className="debt-option" onClick={() => onSelect(option.tileIndex)}>
            <span style={{ fontWeight: 800 }}>{option.name}</span><span style={{ fontSize: 12 }}>{option.label}</span>
          </button>
        ))}
      </div>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        <button type="button" className="btn btn-outline-light" disabled={busy} onClick={() => onTrade({ mode: "COMPOSE" })}>Trade for cash</button>
        <button type="button" className="btn btn-dark" disabled={busy} onClick={onBankrupt}>Declare bankruptcy</button>
      </div>
    </section>
  );
}

function TurnPanel(props: RailProps) {
  const { game, room, board, players, viewerUserId, spectator, busy, act, now, snapshot, onTrade, onSelect, onResign } = props;
  const turn = turnModel(game, room, board, viewerUserId);
  const active = players.find((player) => player.active);
  const seconds = secondsLeft(room.turnDeadlineAt, now, snapshot.clockOffset);
  const total = room.settings.turnSeconds;
  const me = game.players.find((player) => player.userId === viewerUserId);
  const roll = lastRoll(snapshot);
  const mine = game.assets.filter((asset) => asset.ownerUserId === viewerUserId).map((asset) => asset.tileIndex).sort((a, b) => a - b);
  const [deedCursor, setDeedCursor] = useState(0);
  const canTrade = !spectator && me?.status === "ACTIVE" && game.phase === "ACTIVE_TURN" && game.auction === null;
  return (
    <section className="panel-paper" aria-label="Turn">
      <div className="turn-head">
        {active !== undefined && <Token player={active} size={34} active />}
        <div style={{ display: "flex", flexDirection: "column", gap: 4, minWidth: 0 }}>
          <span className="label" style={{ color: turn.isMine ? "var(--primary-light)" : "var(--on-slate-mute)" }}>{turn.kicker}</span>
          <span className="turn-name">{active?.name ?? "Match"}</span>
        </div>
        <div style={{ marginLeft: "auto", display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 4 }}>
          <span className="tabular" style={{ fontWeight: 800, fontSize: 15, color: seconds !== null && seconds <= 10 ? "var(--primary-light)" : "var(--paper-3)" }}>{clockText(seconds)}</span>
          <span className="timer-bar"><span style={{ width: seconds === null ? 0 : Math.min(100, (seconds / total) * 100) + "%" }} /></span>
        </div>
      </div>
      {roll !== null && (
        <div className="turn-dice">
          <span className="mini-die">{roll.dice[0]}</span><span className="mini-die">{roll.dice[1]}</span>
          <span style={{ fontWeight: 700 }}>{nameOf(room, roll.playerId)} rolled {roll.total}{roll.to !== null ? ", to " + board.tiles[roll.to]?.name : ""}</span>
        </div>
      )}
      {active?.inHolding && (
        <div className="holding-strip">
          <span className="label" style={{ color: "var(--brass-light)" }}>Holding</span>
          {[0, 1, 2].map((attempt) => {
            const used = attempt < (game.players.find((player) => player.userId === active.userId)?.holdingAttempts ?? 0);
            return <span key={attempt} className="pip" style={{ background: used ? "var(--danger)" : "var(--panel)", border: "1px solid var(--line)" }}>{attempt + 1}</span>;
          })}
          <span style={{ fontSize: 12, fontWeight: 600, color: "var(--on-slate-mute)" }}>Doubles to leave, or {money(50)}</span>
        </div>
      )}
      <p className="requirement" style={{ margin: 0 }}>{turn.requirement}</p>
      {!spectator && game.phase === "ACTIVE_TURN" && (
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <ActionButtons primary={turn.primary} secondary={turn.secondary} busy={busy} act={act} />
          <div style={{ display: "flex", gap: 6 }}>
            <button type="button" className="btn btn-paper" style={{ flex: 1 }} disabled={!canTrade} onClick={() => onTrade({ mode: "COMPOSE" })}>Trade</button>
            <button type="button" className="btn btn-paper" style={{ flex: 1 }} disabled={mine.length === 0}
              onClick={() => {
                const index = mine[deedCursor % mine.length];
                if (index !== undefined) onSelect(index);
                setDeedCursor(deedCursor + 1);
              }}>Manage deeds</button>
          </div>
          {me?.status === "ACTIVE" && (
            <button type="button" className="btn btn-ghost" style={{ alignSelf: "flex-end", padding: "4px 0", fontSize: 12 }}
              disabled={busy || game.auction !== null} title={game.auction !== null ? "Wait for the auction to end" : undefined} onClick={onResign}>
              Resign from match
            </button>
          )}
        </div>
      )}
    </section>
  );
}

function TradeInbox({ game, room, viewerUserId, onTrade, busy, act }: RailProps) {
  const open = game.ruleState.trades.filter((trade) => trade.proposerUserId === viewerUserId || trade.recipientUserId === viewerUserId);
  const warning = [...game.ruleState.fairPlay.incidents].reverse()
    .find((incident) => incident.consequence === "WARNING" && (incident.giverUserId === viewerUserId || incident.receiverUserId === viewerUserId));
  if (open.length === 0 && warning === undefined) return null;
  return (
    <section style={{ display: "flex", flexDirection: "column", gap: 6 }} aria-label="Trades">
      {warning !== undefined && (
        <div className="notice urgent" role="status">
          <span className="label" style={{ color: "var(--danger)" }}>Fair play</span>
          <span>The Collusion Guard flagged a lopsided trade between {nameOf(room, warning.giverUserId)} and {nameOf(room, warning.receiverUserId)}. One more lopsided trade between them removes both from the match.</span>
        </div>
      )}
      {open.map((trade) => {
        const incoming = trade.recipientUserId === viewerUserId;
        return (
          <div key={trade.tradeId} className="notice">
            <span className="label" style={{ color: "var(--brass-light)" }}>{incoming ? "Offer" : "Sent"}</span>
            <span style={{ flex: 1 }}>{incoming ? "From " + nameOf(room, trade.proposerUserId) : "To " + nameOf(room, trade.recipientUserId)}</span>
            {incoming
              ? <button type="button" className="btn btn-dark" style={{ padding: "5px 10px", fontSize: 12 }} onClick={() => onTrade({ mode: "REVIEW", tradeId: trade.tradeId })}>Review</button>
              : <button type="button" className="btn btn-ghost" style={{ padding: "5px 10px", fontSize: 12 }} disabled={busy} onClick={() => act({ type: "CANCEL_TRADE", payload: { tradeId: trade.tradeId } })}>Withdraw</button>}
          </div>
        );
      })}
    </section>
  );
}

function PlayersPanel({ players, room, spotlight, onSpotlight }: RailProps) {
  return (
    <section className="panel-slate" aria-label="Players" style={{ flex: "none" }}>
      <div className="panel-slate-head"><span className="label">Players</span><span className="label">{players.filter((player) => !player.bankrupt).length} in</span></div>
      <div className="scroll" style={{ overflowY: "auto", maxHeight: "min(520px, 42vh)" }}>
        {players.map((player) => (
          // Hover or focus a row to light up that player's deeds and pawn on the board.
          <div key={player.userId} className={"player-row" + (player.active ? " current" : "") + (player.bankrupt ? " out" : "") + (spotlight === player.userId ? " lit" : "")}
            style={{ borderLeftColor: player.active || spotlight === player.userId ? player.color : "transparent" }}
            tabIndex={player.bankrupt ? undefined : 0} title={player.bankrupt ? undefined : "Show " + player.name + "'s deeds and pawn"}
            onMouseEnter={() => onSpotlight(player.userId)} onMouseLeave={() => onSpotlight(null)}
            onFocus={() => onSpotlight(player.userId)} onBlur={() => onSpotlight(null)}>
            <Token player={player} size={26} />
            <div style={{ display: "flex", flexDirection: "column", minWidth: 0 }}>
              <span className="player-name">{player.name}{player.userId === room.hostUserId ? " · host" : ""}</span>
              <span className="player-sub">{player.deeds} deeds{player.teamId !== null ? " · team " + player.teamId : ""}</span>
            </div>
            <div className="player-money">
              <b className="tabular">{player.bankrupt ? "Out" : money(player.cash)}</b>
              <span className="player-status" style={{ color: player.bankrupt ? "var(--muted)" : !player.connected ? "var(--brass-light)" : player.inHolding ? "var(--primary)" : "var(--positive-light)" }}>
                {player.bankrupt ? "bankrupt" : player.away ? "away · auto" : !player.connected ? "reconnecting" : player.inHolding ? "in holding" : "worth " + money(player.netWorth)}
              </span>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

export function Feed({ snapshot, client, board, room, spectator }: {
  snapshot: RoomSnapshot; client: RoomPort; board: BoardModel | null; room: RoomView; spectator: boolean;
}) {
  const [tab, setTab] = useState<"chat" | "log">("chat");
  const [text, setText] = useState("");
  const [seenChat, setSeenChat] = useState(0);
  // Frames are not queued while reconnecting, so the composer waits for the connection.
  const offline = snapshot.status !== "OPEN";
  const names = (userId: string) => nameOf(room, userId);
  const logLines = board === null ? [] : snapshot.events.flatMap((entry) => describeEvent(entry.event, entry.game, board, names).map((line, index) => ({ key: entry.id + ":" + index, line })));
  const unread = tab === "chat" ? 0 : snapshot.chat.length - seenChat;
  const send = () => {
    if (text.trim() === "") return;
    client.chat(text);
    setText("");
  };
  const show = (next: "chat" | "log") => {
    setTab(next);
    setSeenChat(snapshot.chat.length);
  };
  return (
    <section className="panel-slate" style={{ flex: 1, minHeight: 160 }} aria-label="Chat and game log">
      <div className="tabs" role="tablist">
        <button type="button" role="tab" className="tab" aria-selected={tab === "chat"} onClick={() => show("chat")}>
          Chat {unread > 0 && <span className="badge">{unread}</span>}
        </button>
        {board !== null && (
          <button type="button" role="tab" className="tab" aria-selected={tab === "log"} onClick={() => show("log")}>
            Game log <span className="badge badge-brass">{logLines.length}</span>
          </button>
        )}
      </div>
      <div className="feed scroll" role="tabpanel" aria-live="polite">
        {tab === "chat"
          ? snapshot.chat.length === 0
            ? <span className="chat-text" style={{ color: "var(--muted)" }}>No messages yet.</span>
            : snapshot.chat.map((message) => {
              const member = room.members.find((candidate) => candidate.userId === message.userId);
              return (
                <div key={message.id}>
                  <div style={{ display: "flex", gap: 6 }}>
                    <span className="chat-who" style={{ color: member === undefined ? "var(--muted)" : "var(--brass-light)" }}>{message.displayName}</span>
                    <span className="chat-time">{new Date(message.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>
                  </div>
                  <div className="chat-text">{message.text}</div>
                </div>
              );
            })
          : [...logLines].reverse().map((entry) => <div key={entry.key} className="log-line">{entry.line}</div>)}
      </div>
      {tab === "chat" && !spectator && (
        <form className="composer" onSubmit={(event) => { event.preventDefault(); send(); }}>
          <label className="visually-hidden" htmlFor="chat-input">Message</label>
          <input id="chat-input" value={text} maxLength={280} placeholder={offline ? "Reconnecting…" : "Message the room…"} disabled={offline}
            onChange={(event) => setText(event.target.value)} />
          <button type="submit" disabled={offline}>Send</button>
        </form>
      )}
    </section>
  );
}

export function TopBar({ room, boardLabel, center, right }: { room: RoomView; boardLabel: string; center: ReactNode; right: ReactNode }) {
  return (
    <header className="topbar">
      <a className="brand" href="/">Money<span className="brand-dot">·</span>Game</a>
      <span className="room-chip"><span className="label">Room</span><span className="code">{room.roomCode}</span></span>
      <div className="topbar-meta">
        <span>{boardLabel}</span><span className="topbar-sep" />
        <span>{room.members.length} players</span>
        {center}
      </div>
      <div className="topbar-right">{right}</div>
    </header>
  );
}

export function GameScreen({ snapshot, client }: { snapshot: RoomSnapshot; client: RoomPort }) {
  const { room, game, you } = snapshot;
  const [selected, setSelected] = useState<number | null>(null);
  const [trade, setTrade] = useState<TradeDraft | null>(null);
  const [confirmBankrupt, setConfirmBankrupt] = useState(false);
  const [confirmResign, setConfirmResign] = useState(false);
  const [spotlight, setSpotlight] = useState<string | null>(null);
  const now = useNow();
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setSelected(null);
      setTrade(null);
      setConfirmBankrupt(false);
      setConfirmResign(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  if (room === null || game === null || you === null) return null;
  const board = boardModel(game.board.ref);
  const players = playerModels(game, room, board);
  const viewerUserId = you.userId;
  const spectator = you.role === "SPECTATOR" || !game.players.some((player) => player.userId === viewerUserId);
  const busy = snapshot.pendingActionIds.length > 0 || snapshot.status !== "OPEN" || room.paused;
  const act = (intent: CommandIntent) => {
    client.command(intent.type, intent.payload);
  };
  const isHost = room.hostUserId === viewerUserId;
  const pending = game.pendingResolution;
  const railProps: RailProps = {
    snapshot, client, game, room, board, players, viewerUserId, spectator, busy, act, now,
    onTrade: setTrade, onSelect: setSelected, onBankrupt: () => setConfirmBankrupt(true), onResign: () => setConfirmResign(true),
    spotlight, onSpotlight: setSpotlight,
  };
  const seconds = secondsLeft(room.turnDeadlineAt, now, snapshot.clockOffset);
  return (
    <div className="frame">
      <TopBar room={room} boardLabel={board.label}
        center={<><span className="topbar-sep" /><span>Turn {game.turn?.turnNumber ?? "-"}</span>{spectator && <><span className="topbar-sep" /><span>Spectating</span></>}</>}
        right={<>
          <span className="clock" aria-label="Turn clock"><span className="clock-dot" style={{ background: room.paused ? "var(--brass)" : seconds !== null && seconds <= 10 ? "var(--primary)" : undefined }} /><span className="tabular">{room.paused ? "Paused" : clockText(seconds)}</span></span>
          {isHost && game.phase === "ACTIVE_TURN" && (
            <button type="button" className="btn btn-slate" style={{ padding: "6px 10px" }} onClick={() => client.room({ kind: room.paused ? "RESUME" : "PAUSE" })}>
              {room.paused ? "Resume" : "Pause"}
            </button>
          )}
          <span className="diag" title="Game version and state fingerprint (support diagnostics)">v{game.gameVersion} · {snapshot.stateHash ?? ""}</span>
        </>}
      />
      <div className="game-body">
        <main className="board-area">
          <BoardView game={game} board={board} players={players} selected={selected} onSelect={(index) => setSelected(index === selected ? null : index)} spotlight={spotlight}>
            <CenterStage snapshot={snapshot} game={game} room={room} board={board} players={players} viewerUserId={viewerUserId} busy={busy || spectator} act={act} now={now} />
          </BoardView>
          {selected !== null && (
            <DeedPanel game={game} board={board} tileIndex={selected} viewerUserId={viewerUserId} players={players} busy={busy} act={act} onClose={() => setSelected(null)} />
          )}
          {snapshot.notice !== null && (
            <button type="button" className="banner" role="status" onClick={() => client.dismissNotice()}>{snapshot.notice.text} ✕</button>
          )}
          {room.paused && game.phase === "ACTIVE_TURN" && <PausedOverlay isHost={isHost} onResume={() => client.room({ kind: "RESUME" })} />}
          {game.phase === "GAME_OVER" && (
            <EndgameDialog game={game} room={room} players={players} isHost={isHost} onRematch={() => client.room({ kind: "REMATCH" })} />
          )}
        </main>
        <aside className="rail scroll" style={{ overflowY: "auto" }}>
          <DebtPanel {...railProps} />
          <TurnPanel {...railProps} />
          <TradeInbox {...railProps} />
          <PlayersPanel {...railProps} />
          <Feed snapshot={snapshot} client={client} board={board} room={room} spectator={spectator} />
        </aside>
      </div>
      {trade !== null && (
        <TradeDialog draft={trade} game={game} room={room} board={board} players={players} viewerUserId={viewerUserId} busy={busy}
          act={(intent) => { act(intent); setTrade(null); }} onClose={() => setTrade(null)} />
      )}
      {confirmBankrupt && pending !== null && (
        <ConfirmDialog title="Declare bankruptcy?" confirmLabel="Declare bankruptcy"
          body="Your cash and building sell-back go to the creditor and your deeds leave the game. You will be out of the match. This cannot be undone."
          onCancel={() => setConfirmBankrupt(false)}
          onConfirm={() => { act({ type: "DECLARE_BANKRUPTCY", payload: { resolutionId: pending.resolutionId } }); setConfirmBankrupt(false); }} />
      )}
      {confirmResign && (
        <ConfirmDialog title="Resign from the match?" confirmLabel="Resign"
          body={pending?.obligation?.debtorUserId === viewerUserId
            ? "You owe a payment, so resigning is the same as declaring bankruptcy: your cash and building sell-back go to the creditor. You will watch the rest of the match. This cannot be undone."
            : "Your cash and deeds go back to the bank and you will watch the rest of the match. This cannot be undone."}
          onCancel={() => setConfirmResign(false)}
          onConfirm={() => { act({ type: "RESIGN", payload: {} }); setConfirmResign(false); }} />
      )}
    </div>
  );
}
