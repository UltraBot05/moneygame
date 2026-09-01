/**
 * Test-only helpers (excluded from the Worker build via tsconfig). Uses Node
 * built-ins (`node:crypto`, `node:sqlite`) to sign real RS256 ID tokens and back
 * the transaction store with real SQLite, so tests exercise the actual
 * verification/consume logic rather than mocked return values.
 */

import { createSign, generateKeyPairSync, type KeyObject } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type {
  ExchangeInput,
  GoogleProvider,
  Jwk,
  JwkSet,
} from "./oidc";
import type { SqlExec } from "./auth-store";

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

export interface TestSigner {
  kid: string;
  jwks: JwkSet;
  privateKey: KeyObject;
  /** Signs a JWT with the given header kid (defaults to this signer's kid). */
  sign(claims: Record<string, unknown>, kidOverride?: string): string;
}

export function createTestSigner(kid = "test-key-1"): TestSigner {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
  });
  const jwk = publicKey.export({ format: "jwk" }) as Jwk;
  jwk.kid = kid;
  jwk.alg = "RS256";
  jwk.use = "sig";
  return {
    kid,
    jwks: { keys: [jwk] },
    privateKey,
    sign(claims: Record<string, unknown>, kidOverride?: string): string {
      const header = { alg: "RS256", kid: kidOverride ?? kid, typ: "JWT" };
      const h = b64url(JSON.stringify(header));
      const p = b64url(JSON.stringify(claims));
      const sig = createSign("RSA-SHA256").update(`${h}.${p}`).sign(privateKey);
      return `${h}.${p}.${b64url(sig)}`;
    },
  };
}

/** Standard Google ID-token claims for `sub`, valid at `nowSec`. */
export function googleClaims(
  sub: string,
  audience: string,
  nowSec: number,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    iss: "https://accounts.google.com",
    aud: audience,
    sub,
    iat: nowSec,
    exp: nowSec + 3600,
    nonce: undefined,
    ...overrides,
  };
}

export interface StubProvider extends GoogleProvider {
  exchanges: ExchangeInput[];
  configCalls: number;
}

/** In-memory GoogleProvider: real JWKS, canned id_token, records calls. */
export function createStubProvider(
  jwks: JwkSet,
  idToken: string | ((input: ExchangeInput) => string),
): StubProvider {
  const provider: StubProvider = {
    exchanges: [],
    configCalls: 0,
    config() {
      provider.configCalls++;
      return Promise.resolve({
        authorizationEndpoint: "https://accounts.google.com/o/oauth2/v2/auth",
        tokenEndpoint: "https://oauth2.googleapis.com/token",
        jwks,
      });
    },
    exchange(input: ExchangeInput) {
      provider.exchanges.push(input);
      const token = typeof idToken === "function" ? idToken(input) : idToken;
      return Promise.resolve({ idToken: token });
    },
  };
  return provider;
}

/** A `SqlExec` backed by a fresh in-memory SQLite database. */
export function memorySqlExec(): SqlExec {
  const db = new DatabaseSync(":memory:");
  return {
    run(query: string, ...params: (string | number)[]): number {
      return Number(db.prepare(query).run(...params).changes);
    },
    all<T>(query: string, ...params: (string | number)[]): T[] {
      return db.prepare(query).all(...params) as T[];
    },
  };
}
