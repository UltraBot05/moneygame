import { useEffect, useMemo, useState } from "react";
import { PROTOCOL_VERSION } from "@moneygame/shared";
import "./board/board.css";
import { Board } from "./board/Board";
import { GameRail } from "./board/Panels";
import {
  DEMO_SCENES,
  DEMO_SCENE_LABELS,
  demoBoard,
  type DemoScene,
} from "./board/fixtures";

/**
 * SPIKE-006 renderer/demo only. Canonical money, ownership, and game state will
 * remain server-derived; every value on this page is deterministic synthetic data.
 */
export function App() {
  const [tileCount, setTileCount] = useState<40 | 52>(40);
  const [stress, setStress] = useState(true);
  const [scene, setScene] = useState<DemoScene>("turn");
  const [selectedIndex, setSelectedIndex] = useState(4);
  const board = useMemo(() => demoBoard(tileCount, { stress }), [tileCount, stress]);
  const activeId = board.players[1]?.id ?? board.players[0]?.id ?? "";
  const firstProperty = board.tiles.find((tile) => tile.type === "property");
  const selectedTile =
    board.tiles.find((tile) => tile.index === selectedIndex && tile.type === "property") ??
    firstProperty;
  const effectiveSelectedIndex = selectedTile?.index ?? 0;

  useEffect(() => {
    const cycleScene = (event: KeyboardEvent): void => {
      if (event.altKey || event.ctrlKey || event.metaKey) return;
      const tag = event.target instanceof HTMLElement ? event.target.tagName : "";
      if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") return;
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      event.preventDefault();
      setScene((current) => {
        const currentIndex = DEMO_SCENES.indexOf(current);
        const delta = event.key === "ArrowRight" ? 1 : -1;
        return DEMO_SCENES[(currentIndex + delta + DEMO_SCENES.length) % DEMO_SCENES.length] ?? current;
      });
    };
    window.addEventListener("keydown", cycleScene);
    return () => window.removeEventListener("keydown", cycleScene);
  }, []);

  const selectTile = (index: number): void => {
    const tile = board.tiles.find((candidate) => candidate.index === index);
    setSelectedIndex(index);
    if (tile?.type === "property") setScene("property");
    else if (tile?.type === "surprise" || tile?.type === "chest") setScene("event");
  };

  return (
    <main className="stage">
      <header className="masthead">
        <div className="wordmark">
          <span className="eyebrow">World Tour · Renderer Spike</span>
          <h1>Money<span className="dot">·</span>Game</h1>
          <span className="rule" aria-hidden="true" />
        </div>
        <div className="controls" aria-label="Renderer demo controls">
          <div className="seg" role="group" aria-label="Board definition">
            <button type="button" aria-pressed={tileCount === 40} onClick={() => setTileCount(40)}>
              Standard · 40
            </button>
            <button type="button" aria-pressed={tileCount === 52} onClick={() => setTileCount(52)}>
              Grand · 52
            </button>
          </div>
          <label className="state-select">
            <span>Demo state</span>
            <select value={scene} onChange={(event) => setScene(event.target.value as DemoScene)}>
              {DEMO_SCENES.map((option) => (
                <option value={option} key={option}>{DEMO_SCENE_LABELS[option]}</option>
              ))}
            </select>
          </label>
          <label className="toggle" data-on={stress}>
            <input type="checkbox" checked={stress} onChange={(event) => setStress(event.target.checked)} />
            10-player stress
          </label>
          <span className="key-hint">← → states · protocol v{PROTOCOL_VERSION}</span>
        </div>
      </header>

      <div className="layout" data-scene={scene}>
        <div className="board-frame">
          <Board
            tileCount={tileCount}
            board={board}
            scene={scene}
            selectedIndex={effectiveSelectedIndex}
            onSelect={selectTile}
            onCloseDetail={() => setScene("turn")}
          />
        </div>
        <aside className="rail">
          <GameRail
            players={board.players}
            activeId={activeId}
            scene={scene}
            selectedTile={selectedTile}
          />
        </aside>
      </div>
    </main>
  );
}
