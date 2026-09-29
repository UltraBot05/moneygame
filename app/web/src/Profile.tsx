import { useEffect, useState } from "react";
import { ACHIEVEMENTS, COSMETICS, type ProfileView } from "@moneygame/shared";
import { equipCosmetic, getProfile, purchaseCosmetic, type Me } from "./api";
import { MessagePage, PageTop } from "./Landing";
import { initials } from "./view-model";

/** META-007: everything shown here comes from the server; the page only asks it to buy or equip. */
export function ProfilePage({ me }: { me: Me }) {
  const [profile, setProfile] = useState<ProfileView | null | undefined>(undefined);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let live = true;
    void getProfile().then((loaded) => {
      if (live) setProfile(loaded);
    });
    return () => {
      live = false;
    };
  }, [attempt]);
  if (profile === undefined) return <MessagePage me={me} title="Your profile" body="Loading…" actions={null} />;
  if (profile === null) {
    return <MessagePage me={me} title="Profile unavailable" body="The profile could not be loaded. Nothing was changed."
      actions={<><button type="button" className="btn btn-primary" onClick={() => { setProfile(undefined); setAttempt(attempt + 1); }}>Try again</button><a className="btn btn-paper" href="/" style={{ textDecoration: "none" }}>Home</a></>} />;
  }
  const act = async (request: Promise<Awaited<ReturnType<typeof purchaseCosmetic>>>) => {
    setBusy(true);
    const result = await request;
    setBusy(false);
    if (result === null) setNotice("That did not go through. Try again.");
    else if (result.ok) {
      setProfile(result.profile);
      setNotice(null);
    } else setNotice(result.error === "NOT_ENOUGH_COINS" ? "Not enough coins yet." : "That item is not available.");
  };
  const ring = COSMETICS.find((item) => item.itemId === profile.equipped.RING)?.value;
  const title = COSMETICS.find((item) => item.itemId === profile.equipped.TITLE)?.value;
  const span = Math.max(1, profile.nextLevelXp - profile.levelStartXp);
  const progress = Math.min(100, ((profile.xp - profile.levelStartXp) / span) * 100);
  return (
    <div className="page">
      <PageTop me={me} />
      <div className="lobby" style={{ alignItems: "start" }}>
        <div className="lobby-col">
          <section className="panel-paper" aria-label="Level">
            <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
              <span className="token" style={{ width: 56, height: 56, fontSize: 20, background: "var(--table)", boxShadow: ring === undefined ? undefined : "0 0 0 3px " + ring }}>{initials(profile.displayName)}</span>
              <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                <span className="dialog-title">{profile.displayName}</span>
                {title !== undefined && <span className="label" style={{ color: "var(--brass-text)" }}>{title}</span>}
              </div>
              <div style={{ marginLeft: "auto", textAlign: "right" }}>
                <div className="label" style={{ color: "var(--ink-mute)" }}>Coins</div>
                <div className="tabular" style={{ fontSize: 26, fontWeight: 900 }}>{profile.coins}</div>
              </div>
            </div>
            <div>
              <div style={{ display: "flex", justifyContent: "space-between", fontWeight: 800 }}>
                <span>Level {profile.level}</span>
                <span className="tabular" style={{ color: "var(--ink-mute)" }}>{profile.xp} / {profile.nextLevelXp} XP</span>
              </div>
              <div style={{ height: 8, background: "var(--line-warm)", marginTop: 6 }}><div style={{ height: 8, width: progress + "%", background: "var(--brass)" }} /></div>
            </div>
            <div style={{ display: "flex", gap: 28 }}>
              <div><div className="label" style={{ color: "var(--ink-mute)" }}>Matches</div><b className="tabular" style={{ fontSize: 20 }}>{profile.gamesPlayed}</b></div>
              <div><div className="label" style={{ color: "var(--ink-mute)" }}>Wins</div><b className="tabular" style={{ fontSize: 20 }}>{profile.wins}</b></div>
            </div>
            <span style={{ fontSize: 12, color: "var(--ink-mute)" }}>XP and coins come only from finished matches. Players removed by the Collusion Guard earn nothing from that match.</span>
          </section>
          <section className="panel-slate" aria-label="Achievements">
            <div className="panel-slate-head"><span className="label">Achievements</span><span className="label">{profile.achievements.length} / {ACHIEVEMENTS.length}</span></div>
            {ACHIEVEMENTS.map((achievement) => {
              const earned = profile.achievements.includes(achievement.achievementId);
              return (
                <div key={achievement.achievementId} className="player-row" style={{ opacity: earned ? 1 : 0.5 }}>
                  <span className="token" style={{ width: 24, height: 24, fontSize: 12, background: earned ? "var(--brass)" : "var(--line)" }}>{earned ? "✓" : ""}</span>
                  <div style={{ display: "flex", flexDirection: "column" }}>
                    <span className="player-name">{achievement.name}</span>
                    <span className="player-sub">{achievement.description}</span>
                  </div>
                </div>
              );
            })}
          </section>
        </div>
        <div className="lobby-col">
          <section className="panel-slate" aria-label="Cosmetics">
            <div className="panel-slate-head"><span className="label">Cosmetics</span><span className="label">Looks only · no gameplay effect</span></div>
            {notice !== null && <div className="notice urgent" role="status" style={{ margin: 12 }}>{notice}</div>}
            {COSMETICS.map((item) => {
              const owned = profile.inventory.includes(item.itemId);
              const equipped = profile.equipped[item.kind] === item.itemId;
              return (
                <div key={item.itemId} className="player-row">
                  {item.kind === "RING"
                    ? <span className="token" style={{ width: 26, height: 26, fontSize: 10, background: "var(--table)", boxShadow: "0 0 0 3px " + item.value }}>{initials(profile.displayName)}</span>
                    : <span className="label" style={{ width: 26, color: "var(--brass-light)" }}>T</span>}
                  <div style={{ display: "flex", flexDirection: "column" }}>
                    <span className="player-name">{item.name}</span>
                    <span className="player-sub">{item.kind === "RING" ? "Token ring" : "Profile title"} · {item.price} coins</span>
                  </div>
                  <div style={{ marginLeft: "auto" }}>
                    {!owned
                      ? <button type="button" className="btn btn-outline-light" style={{ padding: "6px 10px" }} disabled={busy || profile.coins < item.price} onClick={() => void act(purchaseCosmetic(item.itemId))}>Buy</button>
                      : <button type="button" className={equipped ? "btn btn-slate" : "btn btn-outline-light"} style={{ padding: "6px 10px" }} disabled={busy}
                        onClick={() => void act(equipCosmetic(item.kind, equipped ? null : item.itemId))}>{equipped ? "Unequip" : "Equip"}</button>}
                  </div>
                </div>
              );
            })}
          </section>
          <section className="panel-slate" aria-label="Match history">
            <div className="panel-slate-head"><span className="label">Recent matches</span><span className="label">{profile.history.length}</span></div>
            {profile.history.length === 0
              ? <div className="chat-text" style={{ padding: 12, color: "var(--muted)" }}>No finished matches yet. Create a room and play one.</div>
              : profile.history.map((entry) => (
                <div key={entry.gameId} className="player-row">
                  <span className="tabular" style={{ fontWeight: 900, width: 28 }}>#{entry.placement}</span>
                  <div style={{ display: "flex", flexDirection: "column" }}>
                    <span className="player-name">{entry.boardRef.includes("grand") ? "Grand" : "Standard"} · {entry.players} players{entry.matchMode === "TEAMS" ? " · Teams" : ""}</span>
                    <span className="player-sub">{new Date(entry.endedAt).toLocaleDateString()}</span>
                  </div>
                  <span className="player-status" style={{ marginLeft: "auto", color: entry.removed ? "var(--primary)" : entry.winner ? "var(--brass-light)" : "var(--muted)" }}>
                    {entry.removed ? "Removed" : entry.winner ? "Winner" : "Finished"}
                  </span>
                </div>
              ))}
          </section>
        </div>
      </div>
    </div>
  );
}
