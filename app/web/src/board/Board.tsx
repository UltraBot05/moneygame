import type { CSSProperties } from "react";
import { ActionCard, DeedCard } from "./Cards";
import { SETS, type DemoBoard, type DemoPlayer, type DemoScene, type DemoTile } from "./fixtures";
import { computeLayout, type TilePos } from "./layout";

type Vars = CSSProperties & Record<`--${string}`, string | number>;

const CORNER = "1.4fr";

interface BoardProps {
  tileCount: number;
  board: DemoBoard;
  scene: DemoScene;
  selectedIndex: number;
  onSelect: (index: number) => void;
  onCloseDetail: () => void;
}

export function Board({
  tileCount,
  board,
  scene,
  selectedIndex,
  onSelect,
  onCloseDetail,
}: BoardProps) {
  const layout = computeLayout(tileCount);
  const side = layout.perSide;
  const players = new Map(board.players.map((player) => [player.id, player]));
  const byIndex = new Map(board.tiles.map((tile) => [tile.index, tile]));
  const gridStyle: CSSProperties = {
    gridTemplateColumns: CORNER + " repeat(" + side + ", minmax(0,1fr)) " + CORNER,
    gridTemplateRows: CORNER + " repeat(" + side + ", minmax(0,1fr)) " + CORNER,
  };

  return (
    <div className="board-shell" data-scene={scene}>
      <div
        className="board"
        data-density={tileCount === 52 ? "grand" : "standard"}
        style={gridStyle}
        role="grid"
        aria-label={tileCount + "-tile board"}
      >
        {layout.tiles.map((pos) => {
          const tile = byIndex.get(pos.index);
          if (tile === undefined) return null;
          return (
            <Tile
              key={pos.index}
              pos={pos}
              tile={tile}
              players={players}
              selected={selectedIndex === tile.index}
              showDetail={scene === "property" && selectedIndex === tile.index}
              onSelect={onSelect}
              onCloseDetail={onCloseDetail}
            />
          );
        })}
        <div
          className="face"
          style={{ gridColumn: "2 / span " + side, gridRow: "2 / span " + side }}
        >
          <CenterStage scene={scene} tileCount={tileCount} />
        </div>
      </div>
      {scene === "results" && <ResultsOverlay />}
    </div>
  );
}

function Tile({
  pos,
  tile,
  players,
  selected,
  showDetail,
  onSelect,
  onCloseDetail,
}: {
  pos: TilePos;
  tile: DemoTile;
  players: Map<string, DemoPlayer>;
  selected: boolean;
  showDetail: boolean;
  onSelect: (index: number) => void;
  onCloseDetail: () => void;
}) {
  const cell: CSSProperties = { gridRow: pos.gridRow, gridColumn: pos.gridColumn };
  const owner = tile.ownerId !== undefined ? players.get(tile.ownerId) : undefined;
  const set = tile.setIndex !== undefined ? SETS[tile.setIndex] : undefined;
  const classes = "tile-cell" + (selected ? " selected" : "");

  if (tile.type === "corner") {
    return (
      <div className={classes} style={cell} role="gridcell">
        <button
          className="tile"
          data-type="corner"
          type="button"
          aria-label={tile.name + " corner"}
          onClick={() => onSelect(tile.index)}
        >
          <span className="cname">{tile.name}</span>
        </button>
      </div>
    );
  }

  return (
    <div className={classes} style={cell} data-anchor={pos.edge} role="gridcell">
      <button
        className="tile"
        data-edge={pos.edge}
        data-type={tile.type}
        data-mortgaged={tile.mortgaged === true ? "true" : undefined}
        type="button"
        aria-label={ariaLabel(tile, owner, set?.code)}
        aria-pressed={selected}
        title={tile.name}
        onClick={() => onSelect(tile.index)}
      >
        {set !== undefined ? (
          <span
            className={"band pat-" + set.pattern}
            style={{ "--band-color": "var(" + set.colorVar + ")" } as Vars}
          >
            <span className="code">{set.code}</span>
          </span>
        ) : (
          <span className="band" aria-hidden="true" />
        )}
        <span className="tbody">
          <span className="tname">{tile.name}</span>
          {tile.type !== "property" && <span className="tglyph">{glyph(tile.type)}</span>}
          {tile.price !== undefined && <span className="tprice">${tile.price.toLocaleString()}</span>}
          <span className="tmeta">
            {owner !== undefined && (
              <span className="owner">
                <span
                  className={"pip " + owner.shape}
                  style={{ "--p-color": "var(" + owner.colorVar + ")" } as Vars}
                  aria-hidden="true"
                />
                {owner.initials}
              </span>
            )}
            {tile.buildings !== undefined && tile.buildings > 0 && <Builds n={tile.buildings} />}
            {tile.tokens.length > 0 && <TokenCluster ids={tile.tokens} players={players} />}
          </span>
        </span>
      </button>
      {showDetail && tile.type === "property" && (
        <div className="property-popover">
          <DeedCard tile={tile} owner={owner} onClose={onCloseDetail} />
        </div>
      )}
    </div>
  );
}

function CenterStage({ scene, tileCount }: { scene: DemoScene; tileCount: number }) {
  if (scene === "auction") {
    return (
      <section className="center-state auction-state" aria-label="Auction demo">
        <span className="sub">Live auction · 00:18</span>
        <h2>Territory 17</h2>
        <strong className="bid">$460</strong>
        <p>Ben leads · 7 bidders active</p>
        <div className="action-row">
          <button type="button">Bid $480</button>
          <button type="button" className="quiet">Pass</button>
        </div>
      </section>
    );
  }

  if (scene === "event") {
    return (
      <section className="center-state event-state" aria-label="Event reveal demo">
        <ActionCard />
      </section>
    );
  }

  if (scene === "trade") {
    return (
      <section className="center-state trade-state" aria-label="Trade demo">
        <div className="trade-party">
          <span>Ava offers</span>
          <strong>$300</strong>
          <small>Territory 08</small>
        </div>
        <div className="deal-tray">
          <span>Deal</span>
          <b>2 assets</b>
          <button type="button">Propose</button>
        </div>
        <div className="trade-party">
          <span>Ben offers</span>
          <strong>$120</strong>
          <small>Territory 21</small>
        </div>
      </section>
    );
  }

  return (
    <section className="center-state turn-state" aria-label="Current turn demo">
      <div className="sub">World Tour · {tileCount === 40 ? "Standard" : "Grand"}</div>
      <div className="brandline">Money<span className="dot">·</span>Game</div>
      <div className="dice-result" aria-label="Dice result six">
        <span className="die">4</span>
        <span className="die">2</span>
      </div>
      <p>{scene === "debt" ? "Resolve payment to continue" : "Ben rolled 6 · moving to Territory 17"}</p>
      <button type="button" disabled={scene === "debt"}>{scene === "debt" ? "Roll locked" : "Roll dice"}</button>
    </section>
  );
}

function ResultsOverlay() {
  return (
    <section className="results-overlay" aria-label="Final results demo">
      <span className="sub">Final standings</span>
      <h2>Ava wins the world tour</h2>
      <ol>
        <li><span>Ava Rao</span><strong>$1,284,500</strong></li>
        <li><span>Ben Okafor</span><strong>$8,640</strong></li>
        <li><span>Cy Park</span><strong>$5,710</strong></li>
      </ol>
      <div className="action-row">
        <button type="button">Play again</button>
        <button type="button" className="quiet">Return to room</button>
      </div>
    </section>
  );
}

function Builds({ n }: { n: number }) {
  return (
    <span className="builds" aria-label={n + " development blocks"}>
      {Array.from({ length: Math.min(n, 5) }, (_, index) => (
        <i key={index} className={index === 4 ? "hi" : undefined} />
      ))}
    </span>
  );
}

function TokenCluster({ ids, players }: { ids: string[]; players: Map<string, DemoPlayer> }) {
  const shown = ids.slice(0, 4);
  const extra = ids.length - shown.length;
  return (
    <span className="tokens" aria-label={ids.length + " players here"}>
      {shown.map((id) => {
        const player = players.get(id);
        return (
          <span
            key={id}
            className="tok"
            style={{ "--t-color": "var(" + (player?.colorVar ?? "--ink") + ")" } as Vars}
          >
            {player?.initials.slice(0, 1)}
          </span>
        );
      })}
      {extra > 0 && <span className="tok more">+{extra}</span>}
    </span>
  );
}

function glyph(type: DemoTile["type"]): string {
  return {
    transit: "HUB",
    utility: "GRID",
    tax: "LEVY",
    surprise: "SURP",
    chest: "RSRV",
    property: "",
    corner: "",
  }[type];
}

function ariaLabel(tile: DemoTile, owner: DemoPlayer | undefined, setCode?: string): string {
  const parts = [tile.name];
  if (setCode !== undefined) parts.push("set " + setCode);
  if (tile.price !== undefined) parts.push("price " + tile.price);
  if (owner !== undefined) parts.push("owned by " + owner.name);
  else if (tile.type === "property") parts.push("unowned");
  if (tile.buildings !== undefined && tile.buildings > 0) parts.push(tile.buildings + " development blocks");
  if (tile.mortgaged === true) parts.push("mortgaged");
  if (tile.tokens.length > 0) parts.push(tile.tokens.length + " players here");
  return parts.join(", ");
}
