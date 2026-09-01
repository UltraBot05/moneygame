import { describe, expect, it } from "vitest";
import {
  buildAuthUrl,
  createGoogleProvider,
  createPkce,
  OidcError,
  sha256B64url,
  verifyIdToken,
  type OidcErrorCode,
} from "./oidc";
import { createTestSigner, googleClaims } from "./oidc.testkit";

const AUD = "client-123.apps.googleusercontent.com";
const NOW = 1_700_000_000_000; // fixed ms
const NOW_SEC = Math.floor(NOW / 1000);

async function expectReject(
  token: string,
  code: OidcErrorCode,
  opts: Partial<Parameters<typeof verifyIdToken>[1]> = {},
): Promise<void> {
  const signer = opts.jwks;
  await expect(
    verifyIdToken(token, {
      jwks: signer ?? { keys: [] },
      audience: AUD,
      now: NOW,
      ...opts,
    }),
  ).rejects.toMatchObject({ code });
}

describe("PKCE", () => {
  it("produces an S256 challenge that matches the verifier", async () => {
    const pkce = await createPkce();
    expect(pkce.verifier.length).toBeGreaterThan(20);
    expect(pkce.challenge).not.toBe(pkce.verifier);
    expect(pkce.challenge).toBe(await sha256B64url(pkce.verifier));
  });
});

describe("verifyIdToken", () => {
  it("accepts a correctly signed Google token and returns sub", async () => {
    const signer = createTestSigner();
    const token = signer.sign(googleClaims("google-sub-1", AUD, NOW_SEC));
    const claims = await verifyIdToken(token, {
      jwks: signer.jwks,
      audience: AUD,
      now: NOW,
    });
    expect(claims.sub).toBe("google-sub-1");
  });

  it("checks the nonce when one is expected", async () => {
    const signer = createTestSigner();
    const token = signer.sign(
      googleClaims("s", AUD, NOW_SEC, { nonce: "expected-nonce" }),
    );
    const claims = await verifyIdToken(token, {
      jwks: signer.jwks,
      audience: AUD,
      nonce: "expected-nonce",
      now: NOW,
    });
    expect(claims.sub).toBe("s");
  });

  it("rejects a token whose payload was tampered after signing", async () => {
    const signer = createTestSigner();
    const token = signer.sign(googleClaims("s", AUD, NOW_SEC));
    const [h, , sig] = token.split(".");
    const forged = Buffer.from(
      JSON.stringify(googleClaims("attacker", AUD, NOW_SEC)),
    ).toString("base64url");
    await expectReject(`${h}.${forged}.${sig}`, "BAD_SIGNATURE", {
      jwks: signer.jwks,
    });
  });

  it("rejects a wrong audience", async () => {
    const signer = createTestSigner();
    const token = signer.sign(googleClaims("s", "someone-else", NOW_SEC));
    await expectReject(token, "WRONG_AUDIENCE", { jwks: signer.jwks });
  });

  it("rejects a token minted for multiple audiences", async () => {
    const signer = createTestSigner();
    const token = signer.sign(
      googleClaims("s", AUD, NOW_SEC, { aud: [AUD, "untrusted-client"] }),
    );
    await expectReject(token, "WRONG_AUDIENCE", { jwks: signer.jwks });
  });

  it("rejects a valid audience with a mismatched azp", async () => {
    const signer = createTestSigner();
    const token = signer.sign(
      googleClaims("s", AUD, NOW_SEC, { azp: "untrusted-client" }),
    );
    await expectReject(token, "WRONG_AZP", { jwks: signer.jwks });
  });

  it("accepts a token whose azp matches the client id", async () => {
    const signer = createTestSigner();
    const token = signer.sign(googleClaims("s", AUD, NOW_SEC, { azp: AUD }));
    const claims = await verifyIdToken(token, {
      jwks: signer.jwks,
      audience: AUD,
      now: NOW,
    });
    expect(claims.sub).toBe("s");
  });

  it("rejects a wrong issuer", async () => {
    const signer = createTestSigner();
    const token = signer.sign(
      googleClaims("s", AUD, NOW_SEC, { iss: "https://evil.example" }),
    );
    await expectReject(token, "WRONG_ISSUER", { jwks: signer.jwks });
  });

  it("rejects an expired token", async () => {
    const signer = createTestSigner();
    const token = signer.sign(
      googleClaims("s", AUD, NOW_SEC, { exp: NOW_SEC - 10 }),
    );
    await expectReject(token, "TOKEN_EXPIRED", { jwks: signer.jwks });
  });

  it("rejects a mismatched nonce", async () => {
    const signer = createTestSigner();
    const token = signer.sign(
      googleClaims("s", AUD, NOW_SEC, { nonce: "actual" }),
    );
    await expectReject(token, "WRONG_NONCE", {
      jwks: signer.jwks,
      nonce: "expected",
    });
  });

  it("rejects a token with no sub", async () => {
    const signer = createTestSigner();
    const token = signer.sign(googleClaims("", AUD, NOW_SEC));
    await expectReject(token, "MISSING_SUB", { jwks: signer.jwks });
  });

  it("rejects an unknown signing key id", async () => {
    const signer = createTestSigner();
    const token = signer.sign(googleClaims("s", AUD, NOW_SEC), "other-kid");
    await expectReject(token, "UNKNOWN_KID", { jwks: signer.jwks });
  });

  it("rejects a non-RS256 algorithm", async () => {
    const header = Buffer.from(
      JSON.stringify({ alg: "HS256", kid: "x" }),
    ).toString("base64url");
    const payload = Buffer.from(JSON.stringify({ sub: "s" })).toString(
      "base64url",
    );
    await expectReject(`${header}.${payload}.sig`, "UNSUPPORTED_ALG");
  });

  it("rejects a structurally invalid JWT", async () => {
    await expectReject("not-a-jwt", "INVALID_JWT");
  });

  it("throws OidcError instances", async () => {
    await expect(verifyIdToken("bad", { jwks: { keys: [] }, audience: AUD, now: NOW }))
      .rejects.toBeInstanceOf(OidcError);
  });
});

describe("buildAuthUrl", () => {
  it("requests only the openid scope and S256 challenge", () => {
    const url = new URL(
      buildAuthUrl({
        authorizationEndpoint: "https://accounts.google.com/o/oauth2/v2/auth",
        clientId: AUD,
        redirectUri: "https://app.example/auth/callback",
        state: "opaque-state",
        nonce: "n",
        challenge: "c",
      }),
    );
    expect(url.searchParams.get("scope")).toBe("openid email");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("state")).toBe("opaque-state");
    // No offline access / refresh token requested.
    expect(url.searchParams.get("access_type")).toBeNull();
  });
});

describe("createGoogleProvider", () => {
  it("reads discovery + jwks and exchanges the code with PKCE", async () => {
    const signer = createTestSigner();
    let tokenBody: URLSearchParams | undefined;
    const fetchStub = ((input: RequestInfo | URL, init?: RequestInit) => {
      const u = typeof input === "string" ? input : input.toString();
      if (u.includes(".well-known")) {
        return Promise.resolve(
          Response.json({
            authorization_endpoint: "https://auth",
            token_endpoint: "https://token",
            jwks_uri: "https://jwks",
          }),
        );
      }
      if (u === "https://jwks") {
        return Promise.resolve(Response.json(signer.jwks));
      }
      if (u === "https://token") {
        tokenBody = init?.body as URLSearchParams;
        return Promise.resolve(Response.json({ id_token: "signed.id.token" }));
      }
      return Promise.resolve(new Response("no", { status: 404 }));
    }) as typeof fetch;

    const provider = createGoogleProvider("cid", "csecret", fetchStub);
    const config = await provider.config();
    expect(config.tokenEndpoint).toBe("https://token");
    expect(config.jwks.keys[0]?.kid).toBe(signer.kid);

    const { idToken } = await provider.exchange({
      code: "auth-code",
      verifier: "the-verifier",
      redirectUri: "https://app/auth/callback",
    });
    expect(idToken).toBe("signed.id.token");
    expect(tokenBody?.get("grant_type")).toBe("authorization_code");
    expect(tokenBody?.get("code")).toBe("auth-code");
    expect(tokenBody?.get("code_verifier")).toBe("the-verifier");
    expect(tokenBody?.get("client_secret")).toBe("csecret");
  });
});
