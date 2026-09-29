import { useState, type ReactNode } from "react";
import { CANDIDATE_RULES } from "@moneygame/game-core";
import { BOARD_REFS, TURN_SECONDS, type RoomSettings, type RoomView } from "@moneygame/shared";
import { cleanRoomCode, createRoom, loginUrl, type Me } from "./api";
import { Token } from "./Dialogs";
import { Feed } from "./Game";
import type { RoomPort, RoomSnapshot } from "./room-client";
import { initials, playerColor, type PlayerModel } from "./view-model";

function PageTop({ me, children }: { me: Me | null | undefined; children?: ReactNode }) {
  return (
    <header className="page-top">
      <a className="brand" href="/">Money<span className="brand-dot">·</span>Game</a>
      {children}
      <div className="topbar-right">
        {me === null && <a className="btn btn-slate" href={loginUrl(null)} style={{ textDecoration: "none" }}>Sign in with Google</a>}
        {me != null && (
          <form method="post" action="/auth/logout" style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <span style={{ fontWeight: 700, color: "var(--on-slate)" }}>{me.displayName}</span>
            <button type="submit" className="btn btn-ghost" style={{ color: "var(--on-slate-mute)" }}>Sign out</button>
          </form>
        )}
      </div>
    </header>
  );
}

const STEPS: readonly (readonly [string, string])[] = [
  ["Gather the table", "Three to ten players join a private room with a short code. Everyone signs in with Google."],
  ["Buy the world", "Roll, move and buy cities. Decline one and it goes to auction for everyone."],
  ["Corner a country", "Own a full set to double its rent, then build up to a landmark."],
  ["Outlast everyone", "Rent, taxes and cards drain cash. The last player, or team, standing wins."],
];

export function Landing({ me, navigate }: { me: Me | null | undefined; navigate: (path: string) => void }) {
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const create = async () => {
    if (me === null) {
      location.assign(loginUrl(null));
      return;
    }
    setCreating(true);
    const result = await createRoom();
    setCreating(false);
    if ("roomCode" in result) navigate("/r/" + result.roomCode);
    else setError(result.error === "RATE_LIMITED" ? "You have created a lot of rooms. Try again later." : "Could not create a room. Try again.");
  };
  const join = () => {
    const clean = cleanRoomCode(code);
    if (clean === null) setError("Room codes are letters and digits.");
    else navigate("/r/" + clean);
  };
  return (
    <div className="page">
      <PageTop me={me} />
      <div className="hero">
        <section className="hero-left">
          <h1 className="hero-title">Money<span style={{ color: "var(--brass-light)" }}>·</span>Game</h1>
          <hr className="hero-rule" />
          <p style={{ fontSize: 18, fontWeight: 600, lineHeight: 1.4, margin: 0, color: "var(--on-slate)" }}>
            Buy the world&apos;s cities, corner a country, and charge everyone else for the privilege.
          </p>
          <div style={{ display: "flex", flexDirection: "column", gap: 10, maxWidth: 420 }}>
            <button type="button" className="btn btn-primary" style={{ justifyContent: "center", padding: "14px 18px", fontSize: 16 }} disabled={creating || me === undefined} onClick={() => void create()}>
              Create a private room
            </button>
            <form style={{ display: "flex", gap: 8 }} onSubmit={(event) => { event.preventDefault(); join(); }}>
              <label className="visually-hidden" htmlFor="join-code">Room code</label>
              <input id="join-code" className="text-input code" style={{ flex: 1, minWidth: 0, textTransform: "uppercase" }} placeholder="Room code" value={code}
                maxLength={32} onChange={(event) => setCode(event.target.value)} />
              <button type="submit" className="btn btn-outline-light">Join with a code</button>
            </form>
            {error !== null && <span role="alert" style={{ color: "#ff8a78", fontWeight: 700 }}>{error}</span>}
            <span style={{ fontSize: 12, color: "var(--on-slate-mute)" }}>You sign in with Google. The room shows only your Google display name.</span>
          </div>
          <div className="fact-row">
            <div className="fact"><b>3-10</b><span className="label" style={{ color: "var(--on-slate-mute)" }}>Players</span></div>
            <div className="fact"><b>2</b><span className="label" style={{ color: "var(--on-slate-mute)" }}>Boards</span></div>
            <div className="fact"><b>45-90s</b><span className="label" style={{ color: "var(--on-slate-mute)" }}>Turns</span></div>
          </div>
        </section>
        <section className="hero-right">
          <span className="label" style={{ color: "var(--brass-light)", marginBottom: 8 }}>How a match runs</span>
          {STEPS.map(([title, body], index) => (
            <div key={title} className="step">
              <span className="step-n tabular">0{index + 1}</span>
              <div>
                <div style={{ fontWeight: 900, fontSize: 19, color: "var(--paper-3)" }}>{title}</div>
                <div style={{ color: "var(--on-slate-mute)", marginTop: 4 }}>{body}</div>
              </div>
            </div>
          ))}
        </section>
      </div>
    </div>
  );
}

export function MessagePage({ me, title, body, actions }: { me: Me | null | undefined; title: string; body: string; actions: ReactNode }) {
  return (
    <div className="page">
      <PageTop me={me} />
      <div style={{ flex: 1, display: "grid", placeItems: "center", padding: 24 }}>
        <div className="dialog" style={{ width: "min(460px, 100%)" }}>
          <div className="dialog-body">
            <span className="dialog-title">{title}</span>
            <p className="requirement" style={{ margin: 0 }}>{body}</p>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>{actions}</div>
          </div>
        </div>
      </div>
    </div>
  );
}

const TEAM_IDS = ["RED", "BLUE", "GREEN", "GOLD"] as const;

function Segmented<T extends string | number>({ value, options, onChange, disabled, label }: {
  value: T; options: readonly (readonly [T, string])[]; onChange: (value: T) => void; disabled: boolean; label: string;
}) {
  return (
    <div className="segmented" role="group" aria-label={label}>
      {options.map(([option, text]) => (
        <button key={String(option)} type="button" aria-pressed={option === value} disabled={disabled && option !== value} onClick={() => onChange(option)}>{text}</button>
      ))}
    </div>
  );
}

function memberModel(member: RoomView["members"][number]): PlayerModel {
  return {
    userId: member.userId, name: member.displayName, initials: initials(member.displayName), color: playerColor(member.seatIndex),
    seatIndex: member.seatIndex, cash: 0, netWorth: 0, deeds: 0, active: false, bankrupt: false, inHolding: false,
    connected: member.connected, away: member.away, teamId: null,
  };
}

/** UI-002/003 lobby: seats, ready state, and only the settings the server actually supports. */
export function Lobby({ snapshot, client, me }: { snapshot: RoomSnapshot; client: RoomPort; me: Me }) {
  const room = snapshot.room;
  const [customCash, setCustomCash] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  if (room === null) return null;
  const isHost = room.hostUserId === me.userId;
  const settings = room.settings;
  const members = [...room.members].sort((a, b) => a.seatIndex - b.seatIndex);
  const self = members.find((member) => member.userId === me.userId);
  const configure = (changes: Partial<RoomSettings>) => client.room({ kind: "CONFIGURE", settings: { ...settings, ...changes } });
  const presets: readonly number[] = CANDIDATE_RULES.startingCashPresets;
  const cashIsCustom = !presets.includes(settings.startingCash);
  const teamOf = (userId: string) => settings.teams.find((team) => team.memberUserIds.includes(userId))?.teamId ?? null;
  const assign = (userId: string, teamId: string) => {
    const teams = TEAM_IDS.map((id) => ({
      teamId: id,
      memberUserIds: members.map((member) => member.userId).filter((memberId) => memberId === userId ? id === teamId : teamOf(memberId) === id),
    })).filter((team) => team.memberUserIds.length > 0);
    configure({ teams });
  };
  const setMode = (matchMode: "FFA" | "TEAMS") => configure({
    matchMode,
    teams: matchMode === "FFA" ? [] : TEAM_IDS.slice(0, 2).map((teamId, teamIndex) => ({
      teamId, memberUserIds: members.filter((_member, index) => index % 2 === teamIndex).map((member) => member.userId),
    })),
  });
  const unassigned = settings.matchMode === "TEAMS" && members.some((member) => teamOf(member.userId) === null);
  const readyCount = members.filter((member) => member.ready).length;
  const canStart = members.length >= 3 && readyCount === members.length && !unassigned;
  const invite = location.origin + "/r/" + room.roomCode;
  const commitCustom = () => {
    const value = Number.parseInt(customCash ?? "", 10);
    if (Number.isSafeInteger(value) && value >= CANDIDATE_RULES.customStartingCashMin && value <= CANDIDATE_RULES.customStartingCashMax) configure({ startingCash: value });
    setCustomCash(null);
  };
  return (
    <div className="page" style={{ height: "100%" }}>
      <PageTop me={me}>
        <span className="room-chip"><span className="label">Room</span><span className="code">{room.roomCode}</span></span>
      </PageTop>
      {snapshot.notice !== null && <button type="button" className="banner" style={{ top: 66 }} onClick={() => client.dismissNotice()}>{snapshot.notice.text} ✕</button>}
      <div className="lobby">
        <div className="lobby-col">
          <section className="panel-slate">
            <div className="panel-slate-head"><span className="label">Invite</span><span className="label">{members.length} / 10 seats</span></div>
            <div style={{ padding: 16, display: "flex", alignItems: "center", gap: 16, flexWrap: "wrap" }}>
              <span className="big-code">{room.roomCode}</span>
              <button type="button" className="btn btn-outline-light" onClick={() => { void navigator.clipboard?.writeText(invite).then(() => setCopied(true)); }}>
                {copied ? "Link copied" : "Copy invite link"}
              </button>
            </div>
          </section>
          <section className="panel-slate" style={{ flex: "none" }}>
            <div className="panel-slate-head"><span className="label">Players</span><span className="label">{readyCount} ready</span></div>
            {members.map((member) => (
              <div key={member.userId} className="player-row">
                <Token player={memberModel(member)} size={28} />
                <div style={{ display: "flex", flexDirection: "column", minWidth: 0 }}>
                  <span className="player-name">{member.displayName}{member.userId === me.userId ? " (you)" : ""}</span>
                  <span className="player-sub">{member.userId === room.hostUserId ? "Host" : "Seat " + (member.seatIndex + 1)}{member.connected ? "" : " · offline"}</span>
                </div>
                {settings.matchMode === "TEAMS" && (
                  <div style={{ marginLeft: "auto" }}>
                    <Segmented label={"Team for " + member.displayName} value={teamOf(member.userId) ?? ""} disabled={!isHost}
                      options={TEAM_IDS.slice(0, Math.max(2, Math.min(4, Math.floor(members.length / 2)))).map((id) => [id, id[0] + id.slice(1).toLowerCase()] as const)}
                      onChange={(teamId) => assign(member.userId, teamId)} />
                  </div>
                )}
                <span className="player-status" style={{ marginLeft: settings.matchMode === "TEAMS" ? 10 : "auto", color: member.ready ? "var(--positive-light)" : "var(--muted)" }}>
                  {member.ready ? "Ready" : "Not ready"}
                </span>
              </div>
            ))}
            <div style={{ padding: 12, display: "flex", gap: 8, flexWrap: "wrap" }}>
              {self !== undefined && (
                <button type="button" className={self.ready ? "btn btn-slate" : "btn btn-outline-light"} onClick={() => client.room({ kind: "SET_READY", ready: !self.ready })}>
                  {self.ready ? "Not ready" : "I'm ready"}
                </button>
              )}
              {isHost && (
                <button type="button" className="btn btn-primary" disabled={!canStart} onClick={() => client.room({ kind: "START" })}>Start the match</button>
              )}
              {!isHost && (
                <button type="button" className="btn btn-ghost" style={{ color: "var(--on-slate-mute)" }}
                  onClick={() => {
                    client.room({ kind: "LEAVE" });
                    // Give the socket a moment to flush the LEAVE frame before the page unloads.
                    setTimeout(() => location.assign("/"), 200);
                  }}>Leave room</button>
              )}
            </div>
            <div style={{ padding: "0 12px 12px", fontSize: 12, color: "var(--on-slate-mute)" }}>
              {members.length < 3 ? "At least three players are needed." : unassigned ? "Put every player on a team." : readyCount < members.length ? "Waiting for everyone to be ready. Changing a setting clears ready." : isHost ? "Everyone is ready." : "Waiting for the host to start."}
            </div>
          </section>
        </div>
        <div className="lobby-col">
          <section className="panel-slate" style={{ flex: "none" }}>
            <div className="panel-slate-head"><span className="label">Room settings</span><span className="label">{isHost ? "You are host" : "Host sets these"}</span></div>
            <div className="setting-row">
              <div><div className="setting-title">Board</div><div className="setting-note">Standard fits 3-6 players, Grand fits 6-10.</div></div>
              <Segmented label="Board" value={settings.boardRef} disabled={!isHost} onChange={(boardRef) => configure({ boardRef })}
                options={BOARD_REFS.map((ref) => [ref, ref.includes("grand") ? "Grand" : "Standard"] as const)} />
            </div>
            <div className="setting-row">
              <div><div className="setting-title">Starting cash</div><div className="setting-note">Custom from $1,500 to $2,500.</div></div>
              <div style={{ marginLeft: "auto", display: "flex", gap: 8, alignItems: "center" }}>
                <Segmented label="Starting cash" value={cashIsCustom ? -1 : settings.startingCash} disabled={!isHost}
                  onChange={(value) => value === -1 ? setCustomCash(String(settings.startingCash)) : configure({ startingCash: value })}
                  options={[...presets.map((value) => [value, "$" + value.toLocaleString("en-US")] as const), [-1, cashIsCustom ? "$" + settings.startingCash.toLocaleString("en-US") : "Custom"] as const]} />
                {isHost && customCash !== null && (
                  <input className="text-input" style={{ width: 90, padding: "6px 8px", fontSize: 13 }} inputMode="numeric" aria-label="Custom starting cash" value={customCash}
                    autoFocus onChange={(event) => setCustomCash(event.target.value.replace(/\D/g, ""))} onBlur={commitCustom}
                    onKeyDown={(event) => { if (event.key === "Enter") commitCustom(); }} />
                )}
              </div>
            </div>
            <div className="setting-row">
              <div><div className="setting-title">Match mode</div><div className="setting-note">Teams win together when every rival is out.</div></div>
              <Segmented label="Match mode" value={settings.matchMode} disabled={!isHost} onChange={setMode} options={[["FFA", "Free for all"], ["TEAMS", "Teams"]]} />
            </div>
            <div className="setting-row">
              <div><div className="setting-title">Turn timer</div><div className="setting-note">An expired turn is auto-played.</div></div>
              <Segmented label="Turn timer" value={settings.turnSeconds} disabled={!isHost} onChange={(turnSeconds) => configure({ turnSeconds })}
                options={TURN_SECONDS.map((seconds) => [seconds, seconds + "s"] as const)} />
            </div>
          </section>
          <Feed snapshot={snapshot} client={client} board={null} room={room} spectator={false} />
        </div>
      </div>
    </div>
  );
}
