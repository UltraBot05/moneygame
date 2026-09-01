/**
 * SPIKE-003 invite-first auth handlers (the testable core of the flow).
 *
 * These are pure HTTP handlers that depend on injected `FlowDeps` (store,
 * provider, secrets, clock) rather than the Workers runtime, so the full
 * security logic — state creation, one-time consume, browser binding, PKCE
 * passthrough, ID-token verification, session issuance, redirect building — is
 * exercised end-to-end in auth-flow.test.ts against a real SQLite store and a
 * real locally-signed ID token, with only Google's network boundary stubbed.
 */

import {
  buildAuthUrl,
  createPkce,
  randomB64url,
  sha256B64url,
  verifyIdToken,
  type GoogleProvider,
} from "./oidc";
import type { TransactionStore } from "./auth-store";
import {
  clearCookie,
  issueSession,
  parseCookies,
  serializeCookie,
  verifySession,
  SESSION_COOKIE,
  TXN_COOKIE,
} from "./session";

const ROOM_CODE_RE = /^[A-Za-z0-9]{4,32}$/;

/**
 * Returns the normalized room code, or null if unsafe. Rejecting anything
 * outside `[A-Za-z0-9]{4,32}` is the open-redirect / path-traversal defense:
 * values like `../evil`, `https://evil.com`, or CRLF never reach the store, and
 * the callback only ever redirects to `/r/<stored sanitized code>`.
 */
export function sanitizeRoomCode(raw: string): string | null {
  const code = raw.trim();
  return ROOM_CODE_RE.test(code) ? code.toUpperCase() : null;
}

export function roomPath(roomCode: string): string {
  return `/r/${roomCode}`;
}

export interface FlowDeps {
  store: TransactionStore;
  google: GoogleProvider;
  clientId: string;
  sessionSecret: string;
  now: () => number;
  sessionTtlSec: number;
  txnTtlSec: number;
}

function redirect(location: string, cookies: string[] = []): Response {
  const headers = new Headers({ Location: location });
  for (const c of cookies) headers.append("Set-Cookie", c);
  return new Response(null, { status: 302, headers });
}

/**
 * Entry for `/r/:roomCode`. Serves the room directly if a valid app session is
 * present (no Google round-trip); otherwise opens a new auth transaction and
 * redirects to Google. The room code lives only in the server-side transaction
 * record — never in `state` or the redirect URI.
 */
export async function startAuth(
  rawRoomCode: string,
  cookieHeader: string | null,
  origin: string,
  deps: FlowDeps,
): Promise<Response> {
  const roomCode = sanitizeRoomCode(rawRoomCode);
  if (roomCode === null) {
    return new Response("invalid room code", { status: 400 });
  }

  const existing = parseCookies(cookieHeader)[SESSION_COOKIE];
  if (existing !== undefined) {
    try {
      const session = await verifySession(
        existing,
        deps.sessionSecret,
        deps.now(),
      );
      // Valid first-party session: skip Google entirely.
      return new Response(`room ${roomCode} for ${session.sub}`, {
        status: 200,
        headers: { "content-type": "text/plain" },
      });
    } catch {
      // Fall through to re-authenticate on tampered/expired sessions.
    }
  }

  const state = randomB64url(32);
  const nonce = randomB64url(16);
  const binding = randomB64url(32);
  const pkce = await createPkce();
  const bindingHash = await sha256B64url(binding);

  await deps.store.create({
    state,
    roomCode,
    nonce,
    verifier: pkce.verifier,
    bindingHash,
    expiresAt: deps.now() + deps.txnTtlSec * 1000,
  });

  const { authorizationEndpoint } = await deps.google.config();
  const authUrl = buildAuthUrl({
    authorizationEndpoint,
    clientId: deps.clientId,
    redirectUri: `${origin}/auth/callback`,
    state,
    nonce,
    challenge: pkce.challenge,
  });

  // Pre-auth binding cookie ties this browser to the transaction it created.
  return redirect(authUrl, [
    serializeCookie(TXN_COOKIE, binding, { maxAgeSec: deps.txnTtlSec }),
  ]);
}

/**
 * Entry for `/auth/callback`. Validates + atomically consumes state, verifies
 * the browser binding, exchanges the code (PKCE), verifies the Google ID token,
 * derives identity from `sub`, issues the app session, and redirects to the
 * original room. Emits no token material in the body or headers.
 */
export async function handleCallback(
  url: URL,
  cookieHeader: string | null,
  origin: string,
  deps: FlowDeps,
): Promise<Response> {
  const state = url.searchParams.get("state");
  const code = url.searchParams.get("code");
  if (url.searchParams.get("error") !== null) {
    return new Response("authorization denied", { status: 400 });
  }
  if (state === null) return new Response("missing state", { status: 400 });
  if (code === null) return new Response("missing code", { status: 400 });

  const binding = parseCookies(cookieHeader)[TXN_COOKIE];
  if (binding === undefined) {
    return new Response("missing binding", { status: 401 });
  }
  const bindingHash = await sha256B64url(binding);

  const consumed = await deps.store.consume(state, bindingHash, deps.now());
  if (!consumed.ok) {
    const status = consumed.reason === "BINDING_MISMATCH" ? 401 : 400;
    return new Response(`invalid state: ${consumed.reason}`, { status });
  }
  const txn = consumed.txn;

  const { jwks } = await deps.google.config();
  const { idToken } = await deps.google.exchange({
    code,
    verifier: txn.verifier,
    redirectUri: `${origin}/auth/callback`,
  });

  let sub: string;
  try {
    const claims = await verifyIdToken(idToken, {
      jwks,
      audience: deps.clientId,
      nonce: txn.nonce,
      now: deps.now(),
    });
    sub = claims.sub;
  } catch {
    return new Response("invalid identity", { status: 401 });
  }

  // Stable identity is the Google `sub`, mapped to an internal id. Email is
  // never used as the key. Profile persistence (META-001) is intentionally out
  // of scope here.
  const userId = `google:${sub}`;
  const session = await issueSession(
    userId,
    deps.sessionSecret,
    deps.sessionTtlSec,
    deps.now(),
  );

  return redirect(roomPath(txn.roomCode), [
    serializeCookie(SESSION_COOKIE, session, { maxAgeSec: deps.sessionTtlSec }),
    clearCookie(TXN_COOKIE),
  ]);
}
