import { describe, expect, it } from "vitest";
import {
  handleCallback,
  roomPath,
  sanitizeRoomCode,
  startAuth,
  type FlowDeps,
} from "./auth-flow";
import { createSqlTxnStore } from "./auth-store";
import { sha256B64url } from "./oidc";
import {
  createStubProvider,
  createTestSigner,
  googleClaims,
  memorySqlExec,
  type StubProvider,
} from "./oidc.testkit";

const AUD = "client-123.apps.googleusercontent.com";
const SECRET = "unit-test-session-secret";
const NOW = 1_700_000_000_000;
const NOW_SEC = Math.floor(NOW / 1000);
const ORIGIN = "https://app.example";

interface Harness {
  deps: FlowDeps;
  provider: StubProvider;
  setIdToken: (t: string) => void;
  signer: ReturnType<typeof createTestSigner>;
}

function harness(): Harness {
  const signer = createTestSigner();
  let idToken = "";
  const provider = createStubProvider(signer.jwks, () => idToken);
  const deps: FlowDeps = {
    store: createSqlTxnStore(memorySqlExec()),
    google: provider,
    clientId: AUD,
    sessionSecret: SECRET,
    now: () => NOW,
    sessionTtlSec: 3600,
    txnTtlSec: 600,
  };
  return { deps, provider, signer, setIdToken: (t) => (idToken = t) };
}

function cookieValue(setCookie: string): string {
  return (setCookie.split(";")[0] ?? "").split("=")[1] ?? "";
}

/** Drives startAuth and returns the state/nonce/binding it minted. */
async function start(
  h: Harness,
  room = "abcd",
): Promise<{ res: Response; state: string; nonce: string; binding: string }> {
  const res = await startAuth(room, null, ORIGIN, h.deps);
  const loc = new URL(res.headers.get("Location") ?? "");
  const binding = cookieValue(res.headers.getSetCookie()[0] ?? "");
  return {
    res,
    state: loc.searchParams.get("state") ?? "",
    nonce: loc.searchParams.get("nonce") ?? "",
    binding,
  };
}

describe("invite-first auth flow", () => {
  it("preserves room context through a full login and issues an app session", async () => {
    const h = harness();
    const { res: startRes, state, nonce, binding } = await start(h, "abcd");

    expect(startRes.status).toBe(302);
    // state is opaque and is NOT the room code.
    expect(state).not.toBe("abcd");
    expect(state).not.toBe("ABCD");
    expect(state.length).toBeGreaterThan(20);

    h.setIdToken(h.signer.sign(googleClaims("sub-xyz", AUD, NOW_SEC, { nonce })));
    const cbUrl = new URL(`${ORIGIN}/auth/callback?code=auth-code&state=${state}`);
    const cbRes = await handleCallback(cbUrl, `mg_txn=${binding}`, ORIGIN, h.deps);

    // Returned straight to the original (sanitized) room.
    expect(cbRes.status).toBe(302);
    expect(cbRes.headers.get("Location")).toBe(roomPath("ABCD"));

    const cookies = cbRes.headers.getSetCookie();
    const session = cookies.find((c) => c.startsWith("mg_session="));
    expect(session).toContain("HttpOnly");
    expect(session).toContain("Secure");
  });

  it("sends the PKCE verifier matching the challenge in the auth URL", async () => {
    const h = harness();
    const { res: startRes, state, nonce, binding } = await start(h);
    const challenge =
      new URL(startRes.headers.get("Location") ?? "").searchParams.get(
        "code_challenge",
      ) ?? "";

    h.setIdToken(h.signer.sign(googleClaims("s", AUD, NOW_SEC, { nonce })));
    await handleCallback(
      new URL(`${ORIGIN}/auth/callback?code=c&state=${state}`),
      `mg_txn=${binding}`,
      ORIGIN,
      h.deps,
    );

    const sent = h.provider.exchanges[0]?.verifier ?? "";
    expect(await sha256B64url(sent)).toBe(challenge);
  });

  it("lets a valid app session skip Google", async () => {
    const h = harness();
    const { state, nonce, binding } = await start(h);
    h.setIdToken(h.signer.sign(googleClaims("sub-xyz", AUD, NOW_SEC, { nonce })));
    const cbRes = await handleCallback(
      new URL(`${ORIGIN}/auth/callback?code=c&state=${state}`),
      `mg_txn=${binding}`,
      ORIGIN,
      h.deps,
    );
    const session = (cbRes.headers.getSetCookie().find((c) =>
      c.startsWith("mg_session="),
    ) ?? "");
    const sessionValue = cookieValue(session);

    const before = h.provider.configCalls;
    const skip = await startAuth("abcd", `mg_session=${sessionValue}`, ORIGIN, h.deps);

    expect(skip.status).toBe(200);
    expect(await skip.text()).toContain("google:sub-xyz");
    // No new Google round-trip.
    expect(h.provider.configCalls).toBe(before);
  });

  it("does not leak any Google token to the browser", async () => {
    const h = harness();
    const { state, nonce, binding } = await start(h);
    const idToken = h.signer.sign(googleClaims("s", AUD, NOW_SEC, { nonce }));
    h.setIdToken(idToken);
    const cbRes = await handleCallback(
      new URL(`${ORIGIN}/auth/callback?code=c&state=${state}`),
      `mg_txn=${binding}`,
      ORIGIN,
      h.deps,
    );

    const body = await cbRes.text();
    const cookies = cbRes.headers.getSetCookie();
    expect(body).toBe("");
    // Only the app session + cleared txn cookie are set; no id/access token.
    expect(cookies.join(" ")).not.toContain(idToken);
    expect(cookieValue(cookies.find((c) => c.startsWith("mg_session=")) ?? "")).not.toBe(
      idToken,
    );
  });

  it("rejects an unsafe room code before any Google call", async () => {
    const h = harness();
    for (const bad of ["../evil", "https://evil.com", "ab", "z".repeat(33)]) {
      const res = await startAuth(bad, null, ORIGIN, h.deps);
      expect(res.status).toBe(400);
    }
    expect(h.provider.configCalls).toBe(0);
  });

  it("rejects a callback with missing state or code", async () => {
    const h = harness();
    const noState = await handleCallback(
      new URL(`${ORIGIN}/auth/callback?code=c`),
      "mg_txn=x",
      ORIGIN,
      h.deps,
    );
    expect(noState.status).toBe(400);
    const noCode = await handleCallback(
      new URL(`${ORIGIN}/auth/callback?state=s`),
      "mg_txn=x",
      ORIGIN,
      h.deps,
    );
    expect(noCode.status).toBe(400);
  });

  it("rejects a callback with no binding cookie", async () => {
    const h = harness();
    const { state } = await start(h);
    const res = await handleCallback(
      new URL(`${ORIGIN}/auth/callback?code=c&state=${state}`),
      null,
      ORIGIN,
      h.deps,
    );
    expect(res.status).toBe(401);
  });

  it("rejects a replayed callback", async () => {
    const h = harness();
    const { state, nonce, binding } = await start(h);
    h.setIdToken(h.signer.sign(googleClaims("s", AUD, NOW_SEC, { nonce })));
    const url = new URL(`${ORIGIN}/auth/callback?code=c&state=${state}`);
    const first = await handleCallback(url, `mg_txn=${binding}`, ORIGIN, h.deps);
    expect(first.status).toBe(302);
    const replay = await handleCallback(url, `mg_txn=${binding}`, ORIGIN, h.deps);
    expect(replay.status).toBe(400);
  });

  it("rejects a callback from a different browser (wrong binding)", async () => {
    const h = harness();
    const { state, nonce } = await start(h);
    h.setIdToken(h.signer.sign(googleClaims("s", AUD, NOW_SEC, { nonce })));
    const res = await handleCallback(
      new URL(`${ORIGIN}/auth/callback?code=c&state=${state}`),
      "mg_txn=attacker-binding",
      ORIGIN,
      h.deps,
    );
    expect(res.status).toBe(401);
  });

  it("rejects an ID token with the wrong nonce", async () => {
    const h = harness();
    const { state, binding } = await start(h);
    // Sign with a nonce that does not match the transaction's nonce.
    h.setIdToken(h.signer.sign(googleClaims("s", AUD, NOW_SEC, { nonce: "wrong" })));
    const res = await handleCallback(
      new URL(`${ORIGIN}/auth/callback?code=c&state=${state}`),
      `mg_txn=${binding}`,
      ORIGIN,
      h.deps,
    );
    expect(res.status).toBe(401);
  });
});

describe("sanitizeRoomCode", () => {
  it("accepts alphanumeric codes and rejects unsafe input", () => {
    expect(sanitizeRoomCode("abcd")).toBe("ABCD");
    expect(sanitizeRoomCode("ROOM99")).toBe("ROOM99");
    expect(sanitizeRoomCode("SPIKE003TEST")).toBe("SPIKE003TEST");
    expect(sanitizeRoomCode("z".repeat(33))).toBeNull();
    expect(sanitizeRoomCode("../evil")).toBeNull();
    expect(sanitizeRoomCode("a b")).toBeNull();
    expect(sanitizeRoomCode("https://x")).toBeNull();
    expect(sanitizeRoomCode("")).toBeNull();
  });
});
