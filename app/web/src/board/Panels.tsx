import { useState, type CSSProperties, type FormEvent } from "react";
import { SETS, type DemoPlayer, type DemoScene, type DemoTile } from "./fixtures";

type Vars = CSSProperties & Record<`--${string}`, string | number>;
type SocialTab = "chat" | "log";

interface GameRailProps {
  players: DemoPlayer[];
  activeId: string;
  scene: DemoScene;
  selectedTile: DemoTile | undefined;
}

export function GameRail({ players, activeId, scene, selectedTile }: GameRailProps) {
  return (
    <>
      <TurnStatus activePlayer={players.find((player) => player.id === activeId)} scene={scene} />
      <ContextPanel scene={scene} selectedTile={selectedTile} />
      <section className="panel rail-lower" aria-label="Players and room conversation">
        <PlayerList players={players} activeId={activeId} />
        <SocialPanel />
      </section>
    </>
  );
}

function TurnStatus({ activePlayer, scene }: { activePlayer: DemoPlayer | undefined; scene: DemoScene }) {
  const urgent = scene === "debt";
  return (
    <section className="panel turn-panel" aria-label="Current turn status" data-urgent={urgent}>
      <div className="turn-copy">
        <span className="status-dot" aria-hidden="true" />
        <div>
          <h2>{urgent ? "Payment due" : (activePlayer?.name ?? "Current player") + "’s turn"}</h2>
          <p>{urgent ? "Ava must raise $620 before play continues." : "1:24 remaining · Post-roll actions"}</p>
        </div>
      </div>
      <span className="turn-number">Turn 18</span>
    </section>
  );
}

function ContextPanel({ scene, selectedTile }: { scene: DemoScene; selectedTile: DemoTile | undefined }) {
  if (scene === "debt") {
    return (
      <section className="panel context-panel debt-panel" aria-label="Debt resolution">
        <h2>Resolve $620 payment</h2>
        <p>The board stays available while you mortgage or sell assets.</p>
        <div className="action-grid">
          <button type="button">Inspect assets</button>
          <button type="button">Mortgage</button>
          <button type="button">Sell blocks</button>
          <button type="button" disabled>Pay $620</button>
        </div>
      </section>
    );
  }

  if (scene === "property" && selectedTile !== undefined) {
    return (
      <section className="panel context-panel" aria-label="Selected property summary">
        <h2>Selected tile</h2>
        <div className="selected-summary">
          <strong>{selectedTile.name}</strong>
          <span>${selectedTile.price?.toLocaleString() ?? "—"} · {selectedTile.mortgaged === true ? "Mortgaged" : "Available actions"}</span>
        </div>
        <p>The deed is anchored inward on desktop and this inspector remains available on narrow screens.</p>
      </section>
    );
  }

  const copy: Record<DemoScene, [string, string]> = {
    turn: ["Actions", "Roll, inspect a property, or review the room before ending the turn."],
    property: ["Property", "Select any property tile to inspect its synthetic deed."],
    auction: ["Auction in progress", "Seven bidders remain. Bids commit only after server confirmation."],
    event: ["Event revealed", "The board centre holds the event while the room keeps its context."],
    trade: ["Trade draft", "Ava and Ben can propose, counter, accept, reject, or cancel."],
    debt: ["Debt", "Resolve the payment while keeping access to the board."],
    results: ["Match complete", "The final board remains visible behind the standings."],
  };
  const [title, body] = copy[scene];
  return (
    <section className="panel context-panel">
      <h2>{title}</h2>
      <p>{body}</p>
      {scene === "turn" && (
        <div className="action-grid">
          <button type="button">Buy property</button>
          <button type="button" className="quiet">Start trade</button>
        </div>
      )}
      {scene === "trade" && (
        <div className="action-grid">
          <button type="button">Accept</button>
          <button type="button" className="quiet">Counter</button>
          <button type="button" className="quiet">Reject</button>
          <button type="button" className="quiet">Cancel</button>
        </div>
      )}
      <Legend />
    </section>
  );
}

function PlayerList({ players, activeId }: { players: DemoPlayer[]; activeId: string }) {
  return (
    <section className="players-section" aria-label={"Players · " + players.length}>
      <div className="section-heading">
        <h2>Players</h2>
        <span>{players.length} seated</span>
      </div>
      <div className="players-scroll">
        {players.map((player) => (
          <div className={"player-row" + (player.id === activeId ? " active" : "")} key={player.id}>
            <span
              className={"pip " + player.shape}
              style={{ "--p-color": "var(" + player.colorVar + ")" } as Vars}
              aria-hidden="true"
            />
            <span className="player-name">
              <strong>{player.name}</strong>
              <small>{player.connection === "online" ? "At the table" : player.connection}</small>
            </span>
            <span className="bal">${player.balance.toLocaleString()}</span>
          </div>
        ))}
      </div>
    </section>
  );
}

function SocialPanel() {
  const [tab, setTab] = useState<SocialTab>("chat");
  const [draft, setDraft] = useState("");
  const [messages, setMessages] = useState([
    { id: 1, name: "Ava", text: "That transit move changed everything." },
    { id: 2, name: "Ben", text: "Trade after this turn?" },
  ]);

  const send = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const text = draft.trim();
    if (text.length === 0) return;
    setMessages((current) => [...current, { id: current.length + 1, name: "You", text }]);
    setDraft("");
  };

  return (
    <section className="social-section" aria-label="Room conversation">
      <div className="social-tabs" role="tablist" aria-label="Conversation view">
        <button type="button" role="tab" aria-selected={tab === "chat"} onClick={() => setTab("chat")}>Chat</button>
        <button type="button" role="tab" aria-selected={tab === "log"} onClick={() => setTab("log")}>Game log</button>
      </div>
      {tab === "chat" ? (
        <>
          <div className="message-list" role="tabpanel" aria-label="Chat messages" aria-live="polite">
            {messages.map((message) => (
              <p key={message.id}><strong>{message.name}</strong><span>{message.text}</span></p>
            ))}
          </div>
          <form className="chat-form" onSubmit={send}>
            <label className="sr-only" htmlFor="chat-message">Message the room</label>
            <input
              id="chat-message"
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              placeholder="Message the room"
              autoComplete="off"
            />
            <button type="submit" disabled={draft.trim().length === 0}>Send</button>
          </form>
        </>
      ) : (
        <div className="message-list game-log" role="tabpanel" aria-label="Game log">
          <p><strong>Turn 18</strong><span>Ben rolled 6 and moved to Territory 17.</span></p>
          <p><strong>Ownership</strong><span>Ava claimed Territory 08 for $156.</span></p>
          <p><strong>Auction</strong><span>Cy won Territory 04 with a $340 bid.</span></p>
          <p><strong>Reconnect</strong><span>Hana returned to the table.</span></p>
        </div>
      )}
    </section>
  );
}

/** Compact proof that every set identity uses colour, code, and pattern. */
export function Legend() {
  return (
    <details className="set-guide">
      <summary>12-set identity guide</summary>
      <div className="legend">
        {SETS.map((set) => (
          <div className="item" key={set.code}>
            <span
              className={"swatch pat-" + set.pattern}
              style={{ "--band-color": "var(" + set.colorVar + ")", background: "var(" + set.colorVar + ")" } as Vars}
              aria-hidden="true"
            />
            <span>{set.code}</span>
          </div>
        ))}
      </div>
    </details>
  );
}
