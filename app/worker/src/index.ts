import { PROTOCOL_VERSION } from "@moneygame/shared";
import { AuthStore } from "./auth-do";
import type { ConsumeResult, OAuthTransaction, TransactionStore } from "./auth-store";
import { handleCallback, sanitizeRoomCode, startAuth, type FlowDeps } from "./auth-flow";
import { reserveRoomCreation } from "./finalization";
import { GameRoom, NAME_HEADER, RING_HEADER, USER_HEADER } from "./game-room";
import { d1Identity, type IdentityStore, type UserRecord } from "./identity";
import { equippedRing, equipCosmetic, loadProfile, purchaseCosmetic } from "./profile";
import { createGoogleProvider } from "./oidc";
import { clearCookie, parseCookies, SESSION_COOKIE, verifySession } from "./session";

// Durable Object classes must be exported from the Worker entry module.
export { AuthStore, GameRoom };

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
  if (!await reserveRoomCreation(env.DB, user.userId, Date.now())) return json({ error: "RATE_LIMITED" }, 429);
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const roomCode = newRoomCode();
    if (await env.GAME_ROOM.getByName(roomCode).initialize(roomCode, user.userId, user.displayName)) {
      return json({ roomCode }, 201);
    }
  }
  return json({ error: "ROOM_TEMPORARILY_UNAVAILABLE" }, 503);
}

const MAX_BODY_LENGTH = 1024;

/** Small strict JSON body for profile actions; null when missing, oversized or malformed. */
async function smallJson(request: Request): Promise<Record<string, unknown> | null> {
  if (Number(request.headers.get("content-length") ?? 0) > MAX_BODY_LENGTH) return null;
  const text = await request.text();
  if (text.length > MAX_BODY_LENGTH) return null;
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

/** META-001..007 profile API: reads are derived server-side; writes are same-origin POSTs. */
async function profileRoute(request: Request, env: Env, url: URL, user: UserRecord): Promise<Response> {
  if (url.pathname === "/api/profile" && request.method === "GET") return json(await loadProfile(env.DB, user));
  if (request.method !== "POST") return json({ error: "NOT_FOUND" }, 404);
  if (!sameOrigin(request, url)) return json({ error: "FORBIDDEN_ORIGIN" }, 403);
  const body = await smallJson(request);
  if (url.pathname === "/api/profile/purchase" && body !== null && typeof body.itemId === "string" && Object.keys(body).length === 1) {
    const result = await purchaseCosmetic(env.DB, user, body.itemId, Date.now());
    return json(result, result.ok ? 200 : 409);
  }
  if (url.pathname === "/api/profile/equip" && body !== null && (body.kind === "RING" || body.kind === "TITLE")
    && (typeof body.itemId === "string" || body.itemId === null) && Object.keys(body).length === 2) {
    const result = await equipCosmetic(env.DB, user, body.kind, body.itemId);
    return json(result, result.ok ? 200 : 409);
  }
  return json({ error: "BAD_REQUEST" }, 400);
}

async function openRoomSocket(request: Request, env: Env, url: URL, rawCode: string, user: UserRecord): Promise<Response> {
  const roomCode = sanitizeRoomCode(rawCode);
  if (roomCode === null) return json({ error: "ROOM_NOT_FOUND" }, 404);
  if (!sameOrigin(request, url)) return json({ error: "FORBIDDEN_ORIGIN" }, 403);
  // Identity comes only from the verified session; any client-supplied header is overwritten.
  const headers = new Headers(request.headers);
  headers.set(USER_HEADER, user.userId);
  headers.set(NAME_HEADER, user.displayName);
  const ring = await equippedRing(env.DB, user.userId);
  if (ring === null) headers.delete(RING_HEADER);
  else headers.set(RING_HEADER, ring);
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
      if (url.pathname.startsWith("/api/profile")) return profileRoute(request, env, url, user);
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
