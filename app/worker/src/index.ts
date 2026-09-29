import { PROTOCOL_VERSION } from "@moneygame/shared";
import { AuthStore } from "./auth-do";
import type { ConsumeResult, OAuthTransaction, TransactionStore } from "./auth-store";
import { handleCallback, sanitizeRoomCode, startAuth, type FlowDeps } from "./auth-flow";
import { GameRoom, NAME_HEADER, USER_HEADER } from "./game-room";
import { d1Identity, type IdentityStore, type UserRecord } from "./identity";
import { createGoogleProvider } from "./oidc";
import { SpikeRoom } from "./room";
import { clearCookie, parseCookies, SESSION_COOKIE, verifySession } from "./session";

// Durable Object classes must be exported from the Worker entry module.
export { AuthStore, GameRoom, SpikeRoom };

const SESSION_TTL_SEC = 7 * 24 * 60 * 60; // app session outlives the 90s room lease
const TXN_TTL_SEC = 10 * 60; // OAuth transaction validity
const ROOM_CODE_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
const ROOM_CODE_LENGTH = 6;

function doStore(env: Env): TransactionStore {
  const stub = env.AUTH_STORE.getByName("global");
  return {
    create: (txn: OAuthTransaction): Promise<void> => stub.createTxn(txn),
    consume: (state: string, bindingHash: string, now: number): Promise<ConsumeResult> =>
      stub.consumeTxn(state, bindingHash, now),
  };
}

function flowDeps(env: Env, identity: IdentityStore): FlowDeps {
  return {
    store: doStore(env),
    identity,
    google: createGoogleProvider(env.GOOGLE_CLIENT_ID, env.GOOGLE_CLIENT_SECRET),
    clientId: env.GOOGLE_CLIENT_ID,
    sessionSecret: env.SESSION_SECRET,
    now: () => Date.now(),
    sessionTtlSec: SESSION_TTL_SEC,
    txnTtlSec: TXN_TTL_SEC,
  };
}

/** The signed-in user from the first-party session cookie, or null. */
async function sessionUser(request: Request, env: Env, identity: IdentityStore): Promise<UserRecord | null> {
  const token = parseCookies(request.headers.get("Cookie"))[SESSION_COOKIE];
  if (token === undefined) return null;
  try {
    const { sub } = await verifySession(token, env.SESSION_SECRET, Date.now());
    return await identity.get(sub);
  } catch {
    return null;
  }
}

/** Defense in depth beside SameSite=Lax: state changes and sockets must come from our own origin. */
function sameOrigin(request: Request, url: URL): boolean {
  const origin = request.headers.get("Origin");
  return origin === null || origin === url.origin;
}

function newRoomCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(ROOM_CODE_LENGTH));
  return Array.from(bytes, (byte) => ROOM_CODE_ALPHABET[byte % ROOM_CODE_ALPHABET.length]).join("");
}

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { "cache-control": "no-store" } });
}

async function createRoom(env: Env, user: UserRecord): Promise<Response> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const roomCode = newRoomCode();
    if (await env.GAME_ROOM.getByName(roomCode).initialize(roomCode, user.userId, user.displayName)) {
      return json({ roomCode }, 201);
    }
  }
  return json({ error: "ROOM_TEMPORARILY_UNAVAILABLE" }, 503);
}

async function openRoomSocket(request: Request, env: Env, url: URL, rawCode: string, user: UserRecord): Promise<Response> {
  const roomCode = sanitizeRoomCode(rawCode);
  if (roomCode === null) return json({ error: "ROOM_NOT_FOUND" }, 404);
  if (!sameOrigin(request, url)) return json({ error: "FORBIDDEN_ORIGIN" }, 403);
  // Identity comes only from the verified session; any client-supplied header is overwritten.
  const headers = new Headers(request.headers);
  headers.set(USER_HEADER, user.userId);
  headers.set(NAME_HEADER, user.displayName);
  return env.GAME_ROOM.getByName(roomCode).fetch(new Request(request, { headers }));
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const identity = d1Identity(env.DB);
    const cookies = request.headers.get("Cookie");

    if (url.pathname === "/auth/login") {
      return startAuth(url.searchParams.get("room"), cookies, url.origin, flowDeps(env, identity));
    }
    if (url.pathname === "/auth/callback") {
      return handleCallback(url, cookies, url.origin, flowDeps(env, identity));
    }
    if (url.pathname === "/auth/logout" && request.method === "POST") {
      return new Response(null, { status: 303, headers: { Location: "/", "Set-Cookie": clearCookie(SESSION_COOKIE) } });
    }
    if (url.pathname === "/api/health") return json({ ok: true, protocolVersion: PROTOCOL_VERSION });

    if (url.pathname.startsWith("/api/")) {
      const user = await sessionUser(request, env, identity);
      if (user === null) return json({ error: "AUTHENTICATION_REQUIRED" }, 401);
      if (url.pathname === "/api/me") return json(user);
      if (url.pathname === "/api/rooms" && request.method === "POST") {
        return sameOrigin(request, url) ? createRoom(env, user) : json({ error: "FORBIDDEN_ORIGIN" }, 403);
      }
      const socket = url.pathname.match(/^\/api\/rooms\/([^/]+)\/ws$/);
      if (socket !== null && request.headers.get("Upgrade") === "websocket") {
        return openRoomSocket(request, env, url, decodeURIComponent(socket[1] as string), user);
      }
      return json({ error: "NOT_FOUND" }, 404);
    }
    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
