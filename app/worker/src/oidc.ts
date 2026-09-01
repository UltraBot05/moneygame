/**
 * SPIKE-003 OpenID Connect primitives (Authorization Code + PKCE S256).
 *
 * Runtime-agnostic: uses only the global `crypto`/`fetch`/`TextEncoder` that
 * exist in both the Workers runtime and Node 22, so this module is unit-tested
 * directly under vitest with a locally-signed ID token and a fake JWKS.
 *
 * The signature primitive is WebCrypto (`crypto.subtle.verify`), NOT hand-rolled
 * RSA. This module only parses the JWT/JWKS envelope and enforces the OIDC
 * claim checks Google requires (issuer, audience, expiry, nonce, sub).
 */

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** Google's accepted `iss` values (both forms are issued in practice). */
const GOOGLE_ISSUERS: readonly string[] = [
  "https://accounts.google.com",
  "accounts.google.com",
];

export type OidcErrorCode =
  | "INVALID_JWT"
  | "UNSUPPORTED_ALG"
  | "UNKNOWN_KID"
  | "BAD_SIGNATURE"
  | "WRONG_ISSUER"
  | "WRONG_AUDIENCE"
  | "WRONG_AZP"
  | "TOKEN_EXPIRED"
  | "WRONG_NONCE"
  | "MISSING_SUB";

export class OidcError extends Error {
  constructor(readonly code: OidcErrorCode) {
    super(code);
    this.name = "OidcError";
  }
}

export interface Jwk extends JsonWebKey {
  kid?: string;
}
export interface JwkSet {
  keys: Jwk[];
}

export interface IdTokenClaims {
  iss: string;
  aud: string | string[];
  sub: string;
  exp: number;
  nonce?: string;
  /** Authorized party; present when the token has multiple audiences. */
  azp?: string;
}

export interface VerifyOptions {
  jwks: JwkSet;
  audience: string;
  /** Expected transaction nonce; when set it MUST match the token's nonce. */
  nonce?: string;
  /** Current time in ms (injected for deterministic tests). */
  now: number;
}

// ---- base64url / crypto helpers (shared with session.ts) --------------------

export function bytesToB64url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function b64urlToBytes(input: string): Uint8Array {
  const b64 = input
    .replace(/-/g, "+")
    .replace(/_/g, "/")
    .padEnd(Math.ceil(input.length / 4) * 4, "=");
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function randomB64url(byteLength: number): string {
  return bytesToB64url(crypto.getRandomValues(new Uint8Array(byteLength)));
}

export async function sha256B64url(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(value));
  return bytesToB64url(new Uint8Array(digest));
}

export function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= (a[i] as number) ^ (b[i] as number);
  return diff === 0;
}

// ---- PKCE -------------------------------------------------------------------

export interface Pkce {
  verifier: string;
  challenge: string;
}

/** Fresh PKCE pair. verifier is high-entropy; challenge is S256(verifier). */
export async function createPkce(): Promise<Pkce> {
  const verifier = randomB64url(32);
  const challenge = await sha256B64url(verifier);
  return { verifier, challenge };
}

// ---- ID-token verification --------------------------------------------------

function decodeJson<T>(part: string): T {
  try {
    return JSON.parse(decoder.decode(b64urlToBytes(part))) as T;
  } catch {
    throw new OidcError("INVALID_JWT");
  }
}

/**
 * Verifies a Google ID token and returns its claims. Throws {@link OidcError}
 * with a specific code for each failure so callers/tests can assert *why* a
 * token was rejected. The order matters: signature is checked before claims so
 * an attacker cannot probe claim logic with an unsigned token.
 */
export async function verifyIdToken(
  idToken: string,
  options: VerifyOptions,
): Promise<IdTokenClaims> {
  const parts = idToken.split(".");
  if (parts.length !== 3) throw new OidcError("INVALID_JWT");
  const [headerB64, payloadB64, sigB64] = parts as [string, string, string];

  const header = decodeJson<{ alg?: string; kid?: string }>(headerB64);
  if (header.alg !== "RS256") throw new OidcError("UNSUPPORTED_ALG");

  const jwk = options.jwks.keys.find((k) => k.kid === header.kid);
  if (jwk === undefined) throw new OidcError("UNKNOWN_KID");

  const key = await crypto.subtle.importKey(
    "jwk",
    jwk,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"],
  );
  const valid = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    key,
    b64urlToBytes(sigB64),
    encoder.encode(`${headerB64}.${payloadB64}`),
  );
  if (!valid) throw new OidcError("BAD_SIGNATURE");

  const claims = decodeJson<IdTokenClaims>(payloadB64);

  if (!GOOGLE_ISSUERS.includes(claims.iss)) throw new OidcError("WRONG_ISSUER");

  // Single-client flow: `aud` must be exactly our client id. A string must
  // equal it; an array must hold exactly that one entry. Multiple audiences are
  // rejected (do NOT merely `aud.includes(clientId)`), so a token also minted
  // for another client is not accepted here.
  const audOk = Array.isArray(claims.aud)
    ? claims.aud.length === 1 && claims.aud[0] === options.audience
    : claims.aud === options.audience;
  if (!audOk) throw new OidcError("WRONG_AUDIENCE");

  // If `azp` (authorized party) is present it MUST be our client id. Google
  // sets it when the token has multiple audiences; a mismatch means the token
  // was issued for a different client.
  if (claims.azp !== undefined && claims.azp !== options.audience) {
    throw new OidcError("WRONG_AZP");
  }

  if (typeof claims.exp !== "number" || claims.exp * 1000 <= options.now) {
    throw new OidcError("TOKEN_EXPIRED");
  }

  // nonce is only checked when the transaction supplied one; when checked it
  // must match exactly (defeats ID-token replay across transactions).
  if (options.nonce !== undefined && claims.nonce !== options.nonce) {
    throw new OidcError("WRONG_NONCE");
  }

  if (typeof claims.sub !== "string" || claims.sub.length === 0) {
    throw new OidcError("MISSING_SUB");
  }

  return claims;
}

// ---- Provider (discovery + JWKS + token exchange) ---------------------------

export interface GoogleConfig {
  authorizationEndpoint: string;
  tokenEndpoint: string;
  jwks: JwkSet;
}

export interface ExchangeInput {
  code: string;
  verifier: string;
  redirectUri: string;
}

export interface GoogleProvider {
  config(): Promise<GoogleConfig>;
  exchange(input: ExchangeInput): Promise<{ idToken: string }>;
}

const DISCOVERY_URL =
  "https://accounts.google.com/.well-known/openid-configuration";

type Fetcher = typeof fetch;

/**
 * Real Google provider. Reads the live discovery document + JWKS rather than
 * hard-coding endpoints, and performs the Authorization Code + PKCE token
 * exchange. `fetchFn` is injectable so the network boundary can be stubbed in
 * tests while exercising this parsing/exchange code.
 */
export function createGoogleProvider(
  clientId: string,
  clientSecret: string,
  fetchFn: Fetcher = fetch,
): GoogleProvider {
  // Memoized per provider instance (one per request) so discovery + JWKS are
  // fetched once even though both config() and exchange() need them.
  let cached: Promise<GoogleConfig> | undefined;
  return {
    config(): Promise<GoogleConfig> {
      return (cached ??= loadConfig(fetchFn));
    },
    async exchange(input: ExchangeInput): Promise<{ idToken: string }> {
      const { tokenEndpoint } = await this.config();
      const body = new URLSearchParams({
        grant_type: "authorization_code",
        code: input.code,
        redirect_uri: input.redirectUri,
        client_id: clientId,
        client_secret: clientSecret,
        code_verifier: input.verifier,
      });
      const res = await fetchFn(tokenEndpoint, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body,
      });
      if (!res.ok) throw new Error("token exchange failed");
      const json = (await res.json()) as { id_token?: string };
      if (typeof json.id_token !== "string") throw new Error("no id_token");
      return { idToken: json.id_token };
    },
  };
}

async function loadConfig(fetchFn: Fetcher): Promise<GoogleConfig> {
  const discRes = await fetchFn(DISCOVERY_URL);
  if (!discRes.ok) throw new Error("oidc discovery failed");
  const disc = (await discRes.json()) as {
    authorization_endpoint: string;
    token_endpoint: string;
    jwks_uri: string;
  };
  const jwksRes = await fetchFn(disc.jwks_uri);
  if (!jwksRes.ok) throw new Error("jwks fetch failed");
  const jwks = (await jwksRes.json()) as JwkSet;
  return {
    authorizationEndpoint: disc.authorization_endpoint,
    tokenEndpoint: disc.token_endpoint,
    jwks,
  };
}

// `openid` gives the stable `sub` (the identity key); `email` is requested per
// spike config. Identity is still derived from `sub` only — email is never used
// as the account key. No profile/offline/refresh or unrelated scopes.
const OIDC_SCOPE = "openid email";

/** Builds the Google authorization redirect URL (no secrets, no room code). */
export function buildAuthUrl(input: {
  authorizationEndpoint: string;
  clientId: string;
  redirectUri: string;
  state: string;
  nonce: string;
  challenge: string;
}): string {
  const url = new URL(input.authorizationEndpoint);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", input.clientId);
  url.searchParams.set("redirect_uri", input.redirectUri);
  url.searchParams.set("scope", OIDC_SCOPE);
  url.searchParams.set("state", input.state);
  url.searchParams.set("nonce", input.nonce);
  url.searchParams.set("code_challenge", input.challenge);
  url.searchParams.set("code_challenge_method", "S256");
  return url.toString();
}
