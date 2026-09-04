import type { CSSProperties } from "react";
import { SETS, type DemoPlayer, type DemoTile } from "./fixtures";

type Vars = CSSProperties & Record<`--${string}`, string | number>;

interface DeedCardProps {
  tile: DemoTile;
  owner?: DemoPlayer | undefined;
  onClose?: (() => void) | undefined;
}

/** Synthetic property detail used by the anchored tile inspector. */
export function DeedCard({ tile, owner, onClose }: DeedCardProps) {
  const set = SETS[tile.setIndex ?? 0] ?? SETS[0];
  const price = tile.price ?? 120;
  return (
    <article className="deed" aria-label={tile.name + " property detail"}>
      <header className="head" style={{ background: "var(" + (set?.colorVar ?? "--set-1") + ")" } as Vars}>
        <div>
          <div className="kicker">Deed · Set {set?.code ?? "AM"}</div>
          <div className="ttl">{tile.name}</div>
        </div>
        {onClose !== undefined && (
          <button className="deed-close" type="button" onClick={onClose} aria-label="Close property detail">
            Close
          </button>
        )}
      </header>
      <div className="perf" aria-hidden="true" />
      <dl>
        <dt>Owner</dt><dd>{owner?.name ?? "Available"}</dd>
        <dt>Purchase</dt><dd>${price.toLocaleString()}</dd>
        <dt>Base rent</dt><dd>${Math.max(8, Math.round(price * 0.11)).toLocaleString()}</dd>
        <dt>Full set</dt><dd>${Math.max(16, Math.round(price * 0.22)).toLocaleString()}</dd>
        <dt>Mortgage</dt><dd>${Math.round(price * 0.5).toLocaleString()}</dd>
        <dt>Development</dt><dd>{tile.buildings ?? 0} / 5 blocks</dd>
      </dl>
      <footer className="foot">Synthetic values · renderer proof only</footer>
    </article>
  );
}

export function ActionCard() {
  return (
    <article className="actioncard" aria-label="Synthetic event card">
      <span className="mark">Surprise</span>
      <p className="body">Take the scenic route. Advance three spaces and collect $40.</p>
      <span className="synthetic">Synthetic event · no game state changed</span>
    </article>
  );
}
