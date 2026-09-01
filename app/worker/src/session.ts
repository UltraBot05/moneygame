/**
 * SPIKE-003 first-party application session.
 *
 * The app session is OUR credential, issued after Google authentication —
 * Google's tokens are never used as the game session. It is a compact
 * HMAC-SHA256 signed token (`payload.signature`, base64url), which is the
 * smallest tamper-resistant mechanism that proves the architecture without a
 * session datastore. Tamper or expiry fails verification.
 *
 * The token is delivered only in an HttpOnly cookie, so it is not readable from
 * JS/`localStorage`. Revocation is out of scope for the spike (stateless token);
 * a production revocation list is a later decision, not frozen here.
 */

import { bytesToB64url, b64urlToBytes, timingSafeEqual } from "./oidc";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export const SESSION_COOKIE = "mg_session";
export const TXN_COOKIE = "mg_txn";

export type SessionErrorCode = "MALFORMED" | "BAD_SIGNATURE" | "EXPIRED";

export class SessionError extends Error {
  constructor(readonly code: SessionErrorCode) {
    super(code);
    this.name = "SessionError";
  }
}

interface SessionPayload {
  sub: string;
  iat: number;
  exp: number;
}

export interface Session {
  sub: string;
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
}

async function sign(payloadB64: string, secret: string): Promise<Uint8Array> {
  const key = await hmacKey(secret);
  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(payloadB64));
  return new Uint8Array(sig);
}

/** Issues a signed session for `sub`, valid for `ttlSec` from `now` (ms). */
export async function issueSession(
  sub: string,
  secret: string,
  ttlSec: number,
  now: number,
): Promise<string> {
  const payload: SessionPayload = {
    sub,
    iat: Math.floor(now / 1000),
    exp: Math.floor(now / 1000) + ttlSec,
  };
  const payloadB64 = bytesToB64url(encoder.encode(JSON.stringify(payload)));
  const sig = await sign(payloadB64, secret);
  return `${payloadB64}.${bytesToB64url(sig)}`;
}

/** Verifies a session token; throws {@link SessionError} on any failure. */
export async function verifySession(
  token: string,
  secret: string,
  now: number,
): Promise<Session> {
  const parts = token.split(".");
  if (parts.length !== 2) throw new SessionError("MALFORMED");
  const [payloadB64, sigB64] = parts as [string, string];

  const expected = await sign(payloadB64, secret);
  if (!timingSafeEqual(b64urlToBytes(sigB64), expected)) {
    throw new SessionError("BAD_SIGNATURE");
  }

  let payload: SessionPayload;
  try {
    payload = JSON.parse(
      decoder.decode(b64urlToBytes(payloadB64)),
    ) as SessionPayload;
  } catch {
    throw new SessionError("MALFORMED");
  }
  if (typeof payload.exp !== "number" || payload.exp * 1000 <= now) {
    throw new SessionError("EXPIRED");
  }
  if (typeof payload.sub !== "string" || payload.sub.length === 0) {
    throw new SessionError("MALFORMED");
  }
  return { sub: payload.sub };
}

// ---- cookies ----------------------------------------------------------------

export function parseCookies(header: string | null): Record<string, string> {
  const out: Record<string, string> = {};
  if (header === null) return out;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx < 0) continue;
    const name = part.slice(0, idx).trim();
    if (name.length === 0) continue;
    out[name] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return out;
}

interface CookieOptions {
  maxAgeSec: number;
}

/**
 * Serializes a hardened cookie: HttpOnly + Secure + Path=/, never scoped with
 * Domain (host-only). SameSite=Lax so the cookie survives Google's top-level
 * redirect back. Secure is safe locally too: `wrangler dev` and workers.dev are
 * HTTPS.
 */
export function serializeCookie(
  name: string,
  value: string,
  opts: CookieOptions,
): string {
  return [
    `${name}=${encodeURIComponent(value)}`,
    "HttpOnly",
    "Secure",
    "SameSite=Lax",
    "Path=/",
    `Max-Age=${opts.maxAgeSec}`,
  ].join("; ");
}

/** Expires a cookie immediately (same attributes so browsers accept it). */
export function clearCookie(name: string): string {
  return serializeCookie(name, "", { maxAgeSec: 0 });
}
