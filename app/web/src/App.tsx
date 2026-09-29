import { lazy, Suspense, useEffect, useState, useSyncExternalStore } from "react";
import { getMe, loginUrl, type Me } from "./api";
import { GameScreen } from "./Game";
import { Landing, Lobby, MessagePage } from "./Landing";
import { browserDeps, RoomClient } from "./room-client";
import "./styles.css";

// Dev-only hot-seat preview; the DEV guard lets the production build drop it entirely.
const DevPreview = import.meta.env.DEV ? lazy(() => import("./dev-preview").then((module) => ({ default: module.DevPreview }))) : null;

/** Two routes: "/" (landing) and "/r/CODE" (a room). History API, no router dependency. */
function usePath(): [string, (path: string) => void] {
  const [path, setPath] = useState(() => location.pathname);
  useEffect(() => {
    const onPop = () => setPath(location.pathname);
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);
  return [path, (next) => {
    history.pushState(null, "", next);
    setPath(next);
  }];
}

function RoomScreen({ code, me }: { code: string; me: Me }) {
  const [client] = useState(() => new RoomClient(code, browserDeps()));
  useEffect(() => {
    client.start();
    return () => client.stop();
  }, [client]);
  const snapshot = useSyncExternalStore(client.subscribe, client.getSnapshot);
  const home = <a className="btn btn-paper" href="/" style={{ textDecoration: "none" }}>Home</a>;
  if (snapshot.status === "REPLACED") {
    return <MessagePage me={me} title="Opened somewhere else" body="This room is open in another tab or device with your account. Only one connection plays at a time."
      actions={<><button type="button" className="btn btn-primary" onClick={() => client.retry()}>Play here instead</button>{home}</>} />;
  }
  if (snapshot.status === "UNREACHABLE") {
    return <MessagePage me={me} title={"Can't open room " + code} body="The room may not exist, may be full, or the connection failed. Check the code with the host."
      actions={<><button type="button" className="btn btn-primary" onClick={() => client.retry()}>Try again</button>{home}</>} />;
  }
  if (snapshot.room === null) {
    return <MessagePage me={me} title={"Joining " + code} body="Connecting to the room…" actions={home} />;
  }
  return (
    <>
      {snapshot.room.phase === "LOBBY" || snapshot.game === null
        ? <Lobby snapshot={snapshot} client={client} me={me} />
        : <GameScreen snapshot={snapshot} client={client} />}
      {snapshot.status !== "OPEN" && <div className="banner" role="status" style={{ position: "fixed" }}>Reconnecting… your seat is held.</div>}
    </>
  );
}

export function App() {
  const [path, navigate] = usePath();
  const [me, setMe] = useState<Me | null | undefined>(undefined);
  useEffect(() => {
    let live = true;
    void getMe().then((user) => {
      if (live) setMe(user);
    });
    return () => {
      live = false;
    };
  }, []);
  if (DevPreview !== null && path === "/dev/preview") return <Suspense fallback={null}><DevPreview /></Suspense>;
  const room = path.match(/^\/r\/([A-Za-z0-9]{4,32})\/?$/);
  if (room === null) return <Landing me={me} navigate={navigate} />;
  const code = (room[1] as string).toUpperCase();
  if (me === undefined) return <MessagePage me={me} title={"Room " + code} body="Checking your sign-in…" actions={null} />;
  if (me === null) {
    return <MessagePage me={me} title={"Join room " + code} body="Sign in with Google to take a seat. You come straight back to this room."
      actions={<a className="btn btn-primary" href={loginUrl(code)} style={{ textDecoration: "none" }}>Sign in with Google</a>} />;
  }
  return <RoomScreen key={code} code={code} me={me} />;
}
