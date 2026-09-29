import { useState, type CSSProperties } from "react";
import type { AssetState, ProjectedGameState, TradeBundle } from "@moneygame/game-core";
import type { RoomView } from "@moneygame/shared";
import {
  assetFaceValue,
  money,
  nameOf,
  PATTERN_CSS,
  standings,
  tileBand,
  tradeable,
  type BoardModel,
  type CommandIntent,
  type PlayerModel,
} from "./view-model";

export function Token({ player, size, active = false }: { player: PlayerModel; size?: number; active?: boolean }) {
  const style: CSSProperties = { background: player.color, ...(size === undefined ? {} : { width: size, height: size, fontSize: size * 0.4 }) };
  return <span className={"token" + (active ? " active" : "")} style={style} title={player.name}>{player.initials}</span>;
}

export type TradeDraft =
  | { readonly mode: "COMPOSE" }
  | { readonly mode: "REVIEW"; readonly tradeId: string };

export function ConfirmDialog({ title, body, confirmLabel, onConfirm, onCancel }: {
  title: string; body: string; confirmLabel: string; onConfirm: () => void; onCancel: () => void;
}) {
  return (
    <div className="overlay fixed" role="presentation">
      <div className="dialog" role="alertdialog" aria-label={title} style={{ width: "min(440px, 100%)" }}>
        <div className="dialog-head"><span className="dialog-title" style={{ fontSize: 22 }}>{title}</span></div>
        <div className="dialog-body">
          <p className="requirement" style={{ margin: 0 }}>{body}</p>
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
            <button type="button" className="btn btn-paper" onClick={onCancel}>Cancel</button>
            <button type="button" className="btn btn-primary" onClick={onConfirm}>{confirmLabel}</button>
          </div>
        </div>
      </div>
    </div>
  );
}

export function PausedOverlay({ isHost, onResume }: { isHost: boolean; onResume: () => void }) {
  return (
    <div className="overlay" role="dialog" aria-label="Match paused">
      <div className="dialog" style={{ width: "min(380px, 100%)" }}>
        <div className="dialog-head dialog-head-dark"><span className="label" style={{ color: "var(--brass-light)" }}>Paused</span></div>
        <div className="dialog-body">
          <span className="dialog-title">Match paused</span>
          <p className="requirement" style={{ margin: 0 }}>Every clock is frozen and no moves are accepted. Chat stays open.</p>
          {isHost
            ? <button type="button" className="btn btn-primary" onClick={onResume}>Resume the match</button>
            : <span style={{ fontWeight: 700 }}>Waiting for the host to resume.</span>}
        </div>
      </div>
    </div>
  );
}

export function EndgameDialog({ game, room, players, isHost, onRematch }: {
  game: ProjectedGameState; room: RoomView; players: readonly PlayerModel[]; isHost: boolean; onRematch: () => void;
}) {
  const outcome = game.ruleState.outcome;
  const ranked = standings(game, players);
  const winners = outcome?.winnerUserIds ?? [];
  return (
    <div className="overlay overlay-strong" role="dialog" aria-label="Final standings">
      <div className="dialog" style={{ width: "min(520px, 100%)" }}>
        <div className="dialog-head dialog-head-dark">
          <span className="label" style={{ color: "var(--brass-light)" }}>Match over</span>
          {outcome?.winningTeamId != null && <span className="label" style={{ marginLeft: "auto" }}>Team {outcome.winningTeamId} wins</span>}
        </div>
        <div className="dialog-body">
          <span className="dialog-title">Final standings</span>
          <div>
            {ranked.map((player, index) => (
              <div key={player.userId} className="standing-row">
                <span className="tabular" style={{ width: 22, fontWeight: 900, fontSize: 18 }}>{index + 1}</span>
                <Token player={player} size={28} />
                <span style={{ fontWeight: 800, flex: 1 }}>{player.name}</span>
                {winners.includes(player.userId) && <span className="label" style={{ color: "var(--brass)" }}>Winner</span>}
                <span className="tabular" style={{ fontWeight: 800 }}>{player.bankrupt ? "Bankrupt" : money(player.netWorth)}</span>
              </div>
            ))}
          </div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            {isHost
              ? <button type="button" className="btn btn-primary" onClick={onRematch}>Rematch · back to lobby</button>
              : <span style={{ fontWeight: 700, alignSelf: "center" }}>The host ({nameOf(room, room.hostUserId)}) can start a rematch.</span>}
            <a className="btn btn-paper" href="/" style={{ textDecoration: "none" }}>Leave</a>
          </div>
        </div>
      </div>
    </div>
  );
}

interface Side {
  readonly assetIds: readonly string[];
  readonly cash: number;
}

function bundleValue(board: BoardModel, game: ProjectedGameState, side: Side): number {
  return side.cash + side.assetIds.reduce((sum, assetId) => {
    const asset = game.assets.find((candidate) => candidate.assetId === assetId);
    return sum + (asset === undefined ? 0 : assetFaceValue(board, asset));
  }, 0);
}

function DeedList({ game, board, owner, side, onToggle, editable }: {
  game: ProjectedGameState; board: BoardModel; owner: string; side: Side; onToggle: (assetId: string) => void; editable: boolean;
}) {
  const assets = game.assets.filter((asset) => asset.ownerUserId === owner && (editable || side.assetIds.includes(asset.assetId)));
  if (assets.length === 0) return <span style={{ fontSize: 12, color: "var(--ink-mute)", padding: 4 }}>No deeds.</span>;
  return (
    <>
      {assets.map((asset: AssetState) => {
        const tile = board.tiles[asset.tileIndex];
        if (tile === undefined) return null;
        const band = tileBand(tile);
        const allowed = tradeable(game, board, asset);
        const chosen = side.assetIds.includes(asset.assetId);
        return (
          <button key={asset.assetId} type="button" className="trade-item" aria-pressed={chosen}
            disabled={!editable || (!allowed && !chosen)} title={allowed ? undefined : "Tiles with buildings in their set cannot be traded"}
            style={{ borderLeftColor: band?.color }} onClick={() => onToggle(asset.assetId)}>
            <span className="trade-tick">{chosen ? "✓" : ""}</span>
            <span style={{ display: "flex", flexDirection: "column", minWidth: 0 }}>
              <span style={{ fontWeight: 800, fontSize: 13 }}>{tile.name}</span>
              <span style={{ fontSize: 10, fontWeight: 700, color: "var(--ink-mute)" }}>
                {band?.code}{asset.mortgaged ? " · mortgaged" : ""}{allowed ? "" : " · has buildings"}
              </span>
            </span>
            <span className="tabular" style={{ marginLeft: "auto", fontWeight: 800, fontSize: 12 }}>{money(assetFaceValue(board, asset))}</span>
            <span style={{ width: 10, height: 10, flex: "none", background: band?.color, ...PATTERN_CSS[band?.pattern ?? "solid"] }} />
          </button>
        );
      })}
    </>
  );
}

function CashField({ value, max, onChange, editable, label }: { value: number; max: number; onChange: (value: number) => void; editable: boolean; label: string }) {
  return (
    <label className="cash-input" title={"Up to " + money(max)}>
      <span>$</span>
      <span className="visually-hidden">{label}</span>
      <input inputMode="numeric" value={value === 0 ? "" : String(value)} placeholder="0" disabled={!editable}
        onChange={(event) => onChange(Math.min(max, Number.parseInt(event.target.value.replace(/\D/g, "") || "0", 10)))} />
    </label>
  );
}

function toBundle(side: Side): TradeBundle {
  return { cash: side.cash, assetIds: [...side.assetIds] };
}

/** UI-007 trade flow: pick a partner, then two columns plus a deal tray; or review an offer. */
export function TradeDialog({ draft, game, room, board, players, viewerUserId, busy, act, onClose }: {
  draft: TradeDraft; game: ProjectedGameState; room: RoomView; board: BoardModel; players: readonly PlayerModel[];
  viewerUserId: string; busy: boolean; act: (intent: CommandIntent) => void; onClose: () => void;
}) {
  const reviewing = draft.mode === "REVIEW" ? game.ruleState.trades.find((trade) => trade.tradeId === draft.tradeId) ?? null : null;
  const [countering, setCountering] = useState(false);
  const [partner, setPartner] = useState<string | null>(reviewing?.proposerUserId ?? null);
  // In a counter, "mine" is what I give: the original request. "theirs" is what they give.
  const [mine, setMine] = useState<Side>(reviewing === null ? { assetIds: [], cash: 0 } : reviewing.requested);
  const [theirs, setTheirs] = useState<Side>(reviewing === null ? { assetIds: [], cash: 0 } : reviewing.offered);
  const me = game.players.find((player) => player.userId === viewerUserId);
  const stale = draft.mode === "REVIEW" && reviewing === null;
  const editable = draft.mode === "COMPOSE" || countering;
  const partnerPlayer = game.players.find((player) => player.userId === partner);
  const toggle = (side: Side, set: (side: Side) => void) => (assetId: string) =>
    set({ ...side, assetIds: side.assetIds.includes(assetId) ? side.assetIds.filter((id) => id !== assetId) : [...side.assetIds, assetId] });
  const net = bundleValue(board, game, theirs) - bundleValue(board, game, mine);
  const empty = mine.cash === 0 && theirs.cash === 0 && mine.assetIds.length === 0 && theirs.assetIds.length === 0;
  const partnerModel = players.find((player) => player.userId === partner);
  const send = () => {
    if (partner === null) return;
    if (countering && reviewing !== null) {
      act({ type: "COUNTER_TRADE", payload: { tradeId: reviewing.tradeId, offered: toBundle(mine), requested: toBundle(theirs) } });
    } else {
      act({ type: "PROPOSE_TRADE", payload: { recipientUserId: partner, offered: toBundle(mine), requested: toBundle(theirs) } });
    }
  };
  return (
    <div className="overlay fixed" role="presentation">
      <div className="dialog" role="dialog" aria-label="Trade" style={{ width: "min(900px, 100%)", height: partner === null ? "auto" : "min(640px, 100%)" }}>
        <div className="dialog-head">
          <span className="dialog-title" style={{ fontSize: 24 }}>{draft.mode === "REVIEW" && !countering ? "Trade offer" : countering ? "Counter offer" : "Propose a trade"}</span>
          {draft.mode === "COMPOSE" && (
            <span className="label" style={{ color: "var(--ink-mute)" }}>{partner === null ? "1 Player" : "2 Deeds and cash"} · 3 Send</span>
          )}
          <button type="button" className="btn btn-ghost" style={{ marginLeft: "auto" }} onClick={onClose} aria-label="Close trade">✕</button>
        </div>
        <div className="dialog-body" style={{ flex: 1 }}>
          {stale ? (
            <div className="notice urgent">This offer is no longer open. It was accepted, withdrawn or voided.</div>
          ) : partner === null ? (
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))", gap: 8 }}>
              {players.filter((player) => player.userId !== viewerUserId && !player.bankrupt).map((player) => (
                <button key={player.userId} type="button" className="trade-item" style={{ borderLeftColor: player.color }} onClick={() => setPartner(player.userId)}>
                  <Token player={player} size={26} />
                  <span style={{ display: "flex", flexDirection: "column" }}>
                    <span style={{ fontWeight: 800 }}>{player.name}</span>
                    <span style={{ fontSize: 11, color: "var(--ink-mute)" }}>{player.deeds} deeds · {money(player.cash)}</span>
                  </span>
                </button>
              ))}
            </div>
          ) : (
            <>
              <div className="trade-columns">
                <div className="trade-side">
                  <div className="trade-side-head">
                    <span className="label">You give</span>
                    <CashField label="Cash you give" value={mine.cash} max={me?.cash ?? 0} editable={editable} onChange={(cash) => setMine({ ...mine, cash })} />
                  </div>
                  <div className="trade-list scroll">
                    <DeedList game={game} board={board} owner={viewerUserId} side={mine} editable={editable} onToggle={toggle(mine, setMine)} />
                  </div>
                </div>
                <div className="deal-tray" aria-live="polite">
                  <span className="label" style={{ color: "var(--brass-light)" }}>Deal</span>
                  <span style={{ fontSize: 11, fontWeight: 700, color: "var(--on-slate-mute)" }}>Net to you</span>
                  <span className="tabular" style={{ fontSize: 26, fontWeight: 900, color: net >= 0 ? "var(--positive-light)" : "#ff8a78" }}>{net >= 0 ? "+" : ""}{money(net)}</span>
                  <span style={{ fontSize: 11, color: "var(--on-slate-mute)" }}>List prices plus cash</span>
                </div>
                <div className="trade-side">
                  <div className="trade-side-head">
                    {partnerModel !== undefined && <Token player={partnerModel} size={20} />}
                    <span className="label">{nameOf(room, partner)} gives</span>
                    <CashField label="Cash they give" value={theirs.cash} max={partnerPlayer?.cash ?? 0} editable={editable} onChange={(cash) => setTheirs({ ...theirs, cash })} />
                  </div>
                  <div className="trade-list scroll">
                    <DeedList game={game} board={board} owner={partner} side={theirs} editable={editable} onToggle={toggle(theirs, setTheirs)} />
                  </div>
                </div>
              </div>
              <span style={{ fontSize: 12, color: "var(--ink-mute)" }}>Tiles with buildings in their set cannot be traded. Very one-sided deals are checked by the Collusion Guard.</span>
              <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", flexWrap: "wrap" }}>
                {editable ? (
                  <>
                    {draft.mode === "COMPOSE" && <button type="button" className="btn btn-ghost" onClick={() => setPartner(null)}>Change player</button>}
                    <button type="button" className="btn btn-primary" disabled={busy || empty} onClick={send}>{countering ? "Send counter" : "Send offer"}</button>
                  </>
                ) : reviewing !== null && (
                  <>
                    <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => act({ type: "REJECT_TRADE", payload: { tradeId: reviewing.tradeId } })}>Reject</button>
                    <button type="button" className="btn btn-paper" disabled={busy} onClick={() => setCountering(true)}>Counter</button>
                    <button type="button" className="btn btn-primary" disabled={busy} onClick={() => act({ type: "ACCEPT_TRADE", payload: { tradeId: reviewing.tradeId } })}>Accept</button>
                  </>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
